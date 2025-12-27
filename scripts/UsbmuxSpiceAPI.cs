using Godot;
using System;
using System.Buffers;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

class UsbmuxSpiceAPI : ISpiceAPI
{
    private TcpListener _listener;
    private TcpClient _client;
    private NetworkStream _stream;
    
    private CancellationTokenSource _stopThread = new();
    private object _sessionLock = new();
    private RC4 _rc4;

    private readonly ConcurrentQueue<string> _pendingOutputs = new();
    private readonly ConcurrentQueue<TaskCompletionSource<RentedBuffer>> _recvQueue = new();
    private readonly Thread _thread;

    private bool _disposed = false;
    private ulong _lastActive = 0;

    public bool Connected { get; private set; }
    public string SpiceHost { get; private set; }
    public int Latency { get; private set; }

    private List<int> _latencies = new(50);

    public UsbmuxSpiceAPI(int port, string password = "")
    {
        if (!string.IsNullOrEmpty(password))
            _rc4 = new RC4(password);

        SpiceHost = $"USB Listener :{port}";

        try 
        {
            _listener = new TcpListener(IPAddress.Any, port);
            _listener.Start();
            GD.Print($"UsbmuxSpiceAPI listening on port {port}");
        }
        catch (Exception e)
        {
            GD.PrintErr($"Failed to start TCP listener: {e.Message}");
        }

        _thread = new Thread(UpdateThread);
        _thread.Start();

        RunSendTasks();
        RunAcceptTask();
    }

    private async void RunAcceptTask()
    {
        while (_stopThread?.IsCancellationRequested == false)
        {
            try 
            {
                if (_listener != null && (_client == null || !_client.Connected))
                {
                    var client = await _listener.AcceptTcpClientAsync();
                    lock (_sessionLock)
                    {
                        _client?.Dispose();
                        _client = client;
                        _stream = _client.GetStream();
                        _lastActive = Time.GetTicksMsec();
                        Connected = true;
                        GD.Print("Client connected via USB/TCP");
                        
                        // Reset RC4 on new connection
                        _rc4?.Reset();
                        
                        // Clear queues
                        while (_recvQueue.TryDequeue(out var tcs)) tcs.SetCanceled();
                        _pendingOutputs.Clear();
                    }
                }
                else
                {
                    await Task.Delay(100);
                }
            }
            catch (Exception ex)
            {
                if (!_disposed)
                    GD.PrintErr($"Accept error: {ex.Message}");
                await Task.Delay(1000);
            }
        }
    }

    // Read Loop: Reads [Length][EncryptedData] -> Decrypt -> RecvQueue
    private async void RunReadLoop()
    {
         var lenBuf = new byte[4];
         while (!_disposed)
         {
             try 
             {
                 if (_client == null || !_client.Connected || _stream == null) {
                     await Task.Delay(100);
                     continue;
                 }
                 
                 // Read Length
                 int read = 0; 
                 while (read < 4) {
                     int r = await _stream.ReadAsync(lenBuf, read, 4 - read, _stopThread.Token);
                     if (r == 0) throw new EndOfStreamException();
                     read += r;
                 }
                 
                 int len = BitConverter.ToInt32(lenBuf, 0);
                 if (len > 65535 || len < 0) {
                     GD.PrintErr($"Invalid frame length {len}, disconnecting");
                     _client.Close();
                     continue;
                 }
                 
                 using var buffer = new RentedBuffer(len);
                 read = 0;
                 while (read < len) {
                     int r = await _stream.ReadAsync(buffer.Span.Slice(read), _stopThread.Token);
                     if (r == 0) throw new EndOfStreamException();
                     read += r;
                 }

                 // We have a full packet.
                 // Decrypt logic? Wait, where do we decrypt?
                 // Original logic passed to _recvQueue.
                 
                 // We need to copy to a new RentedBuffer for the queue consumer
                 var packet = new RentedBuffer(len);
                 buffer.Span.Slice(0, len).CopyTo(packet.Span);
                 
                 // We push to recvQueue?
                 // The original architecture used TaskCompletionSource queue for request-response matching?
                 // Check SendAsync approach.
                 // SendAsync enqueues a TaskCompletionSource.
                 // WaitForResponse waits for it.
                 // KcpRecv dequeued TCS and SetResult.
                 
                 // So we must match incoming packets to pending requests?
                 // Or is it just a stream?
                 // UDP/SpiceAPI is usually Request -> Response.
                 // So we should dequeue the pending TCS.
                 
                 lock (_sessionLock) {
                     if (_recvQueue.TryDequeue(out var tcs)) {
                         tcs.SetResult(packet);
                         Connected = true;
                         _lastActive = Time.GetTicksMsec();
                     } else {
                         // Unsolicited packet? Or queue empty.
                         packet.Dispose();
                     }
                 }
             }
             catch (Exception)
             {
                 Connected = false;
                 _client?.Close();
                 _client = null;
                 await Task.Delay(1000);
             }
         }
    }

    void UpdateThread()
    { 
        RunReadLoop();
        
        while (_stopThread?.IsCancellationRequested == false)
        {
            Thread.Sleep(100);
        }
    }

    async ValueTask<bool> WaitForResponse(ulong startTime, TaskCompletionSource<RentedBuffer> taskSource)
    {
        var completedTask = await Task.WhenAny(taskSource.Task, Task.Delay(2000));
        if (completedTask != taskSource.Task)
            return false;

        if (taskSource.Task.IsCanceled)
            return false;

        using var response = taskSource.Task.Result;
        if (response == null)
            return false;

        // Decrypt Response HERE
        _rc4?.Crypt(response.Span);

        var dur = Time.GetTicksMsec() - startTime;
        _latencies.Add((int)dur);

        if (_latencies.Count >= 30)
        {
            Latency = (int)_latencies.Average();
            _latencies.Clear();
        }

        return true;
    }

    async ValueTask<bool> SendAsync(string data)
    {
        var byteLen = Encoding.UTF8.GetByteCount(data);
        // Framing: [Len:4][Data]
        // But we just need the Data buffer here, framing happens in Write
        
        using var buffer = new RentedBuffer(byteLen + 1);
        Encoding.ASCII.GetBytes(data, buffer.Span);
        buffer.Span[byteLen] = 0;

        _rc4?.Crypt(buffer.Span);

        var start = Time.GetTicksMsec();
        
        // Enqueue waiter BEFORE sending to race correctly
        var taskSource = new TaskCompletionSource<RentedBuffer>();
        _recvQueue.Enqueue(taskSource);

        try {
            if (_client != null && _client.Connected) {
                // Send Length
                var lenBytes = BitConverter.GetBytes(byteLen + 1);
                 await _stream.WriteAsync(lenBytes, 0, 4);
                 // Send Data
                 await _stream.WriteAsync(buffer.Span.Slice(0, byteLen + 1).ToArray());
            } else {
                return false;
            }
        } catch {
            return false;
        }

        if (_rc4 is not null)
        {
            return await WaitForResponse(start, taskSource);
        }

        _ = WaitForResponse(start, taskSource);
        return true;
    }

    private async void RunSendTasks()
    {
        while (_stopThread?.IsCancellationRequested == false)
        {
            while (_pendingOutputs.Count > 10)
                _pendingOutputs.TryDequeue(out _);

            if (!_pendingOutputs.TryDequeue(out var data))
            {
                await Task.Delay(1);
                continue;
            }

            try
            {
                var success = await SendAsync(data);
                if (!success && Time.GetTicksMsec() - _lastActive > 2000)
                {
                     // Timeout
                }
            }
            catch (TaskCanceledException)
            {
                break;
            }
        }
    }

    public void Send(string data)
    {
        _pendingOutputs.Enqueue(data);
    }

    public void GuardConnection()
    {
        if (!Connected)
            return;
        Send("");
    }

    int _lastId = 0;
    string[] packetParamsBuffer = new string[12];
    bool[] _oldStates = new bool[12];

    public void SendButtonsState(ReadOnlySpan<int> state)
    {
        if (state.Length > 12) return;

        int paramCount = 0;
        for (int i = 0; i < state.Length; i++)
        {
            var on = state[i] > 0;
            if (!Connected || _oldStates[i] != on)
                packetParamsBuffer[paramCount++] = $"[\"Button {i + 1}\",{(on ? "1" : "0")}]";
            _oldStates[i] = on;
        }

        if (paramCount == 0) return;

        var paramStr = string.Join(',', packetParamsBuffer.Take(paramCount));
        Send($"{{\"id\":{_lastId++},\"module\":\"buttons\",\"function\":\"write\",\"params\":[{paramStr}]}}");
    }

    float _lastLeftFader = -1;
    float _lastRightFader = -1;

    public void SendAnalogsState(float left, float right)
    {
        int paramCount = 0;
        if (!Connected || MathF.Abs(left - _lastLeftFader) > 0.01f) {
            _lastLeftFader = left;
            packetParamsBuffer[paramCount++] = $"[\"Fader-L\",{left:F2}]";
        }
        if (!Connected || MathF.Abs(right - _lastRightFader) > 0.01f) {
            _lastRightFader = right;
            packetParamsBuffer[paramCount++] = $"[\"Fader-R\",{right:F2}]";
        }

        if (paramCount == 0) return;

        var paramStr = string.Join(',', packetParamsBuffer.Take(paramCount));
        Send($"{{\"id\":{_lastId++},\"module\":\"analogs\",\"function\":\"write\",\"params\":[{paramStr}]}}");
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _stopThread.Cancel();
        _thread.Join();
        
        _listener.Stop();
        _client?.Close();

        _pendingOutputs.Clear();
        _stopThread.Dispose();
    }
}
