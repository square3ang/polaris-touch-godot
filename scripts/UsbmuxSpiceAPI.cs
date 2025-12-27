using Godot;
using System;
using System.Buffers;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Net.Sockets.Kcp;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

class UsbmuxSpiceAPI : ISpiceAPI, IKcpCallback
{
    const int KCP_TIMEOUT_MSEC = 2000;

    private TcpListener _listener;
    private TcpClient _client;
    private NetworkStream _stream;
    
    private CancellationTokenSource _stopThread = new();
    private object _sessionLock = new();
    private SimpleSegManager.Kcp _kcp;
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

        RecreateKcpSession();

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

    private void RecreateKcpSession()
    {
        _pendingOutputs.Clear();

        lock (_sessionLock)
        {
            while (_recvQueue.TryDequeue(out var tcs))
                tcs.SetCanceled();

            _recvQueue.Clear();
            _kcp?.Dispose();

            _kcp = new(573, this);
            // fast mode
            _kcp.NoDelay(1, 0, 2, 1);
            _rc4?.Reset();

            _lastActive = Time.GetTicksMsec();
        }
    }

    // Buffer for reading length prefix
    private byte[] _lenBuf = new byte[4];
    // Buffer for reading payload
    private byte[] _readBuf = new byte[4096];

    private bool RawRecv()
    {
        if (_client == null || !_client.Connected || _stream == null)
            return false;

        try
        {
            if (_client.Available < 4) return false;

            // Peek length? No, just read. If we assume reliable stream.
            // But we can't block. TcpClient.Available checks readable bytes.
            
            // We need to read framing.
            // [Length (4 bytes LE)] [Data]
            
            // This is slightly complex in a non-async loop without keeping state.
            // But since this is called in a loop, we can try to read if enough data.
            
            // Ideally we need a state machine here if partial reads happen.
            // Since this is localhost/USB, fragmentation is unlikely but possible.
            
            // For simplicity in this loop logic:
            if (_client.Available >= 4)
            {
                // We shouldn't block, forcing small reads might be okay if local.
                // But better to use async read or buffering.
                // Here we are in a Thread loop.
                
                // Let's implement a simple buffering
                // Actually, let's just use blocking read with available check?
                // No, Available provides total bytes.
                
                // Read 4 bytes
                // _stream.Read is blocking. But if Available >= 4, it should return immediately.
                
                // We can't guarantee 4 bytes are together though.
                // However, let's attempt to read length header.
                // If we don't have enough for body, we wait?
                
                // To do this robustly: separate read loop pushing to a concurrent queue or buffer.
                // But `RawRecv` feeds `_kcp`.
                
                // I'll stick to a simple check:
                // Only read if we have at least 4 bytes.
                // Then peek/read length.
                // Then check if we have length bytes.
                // If so, read and input.
                
                // Note: Available is an estimate.
                
                // Peek 4 bytes? NetworkStream isn't peekable easily.
                // We'll maintain a RecvState.
                return false; // See specialized implementation below
            }
        }
        catch (Exception ex)
        {
            GD.PrintErr($"Socket error: {ex.Message}");
            Connected = false;
            _client?.Close();
            _client = null;
        }

        return false;
    }
    
    // Simplification: We will run a separate Async Read loop for the stream to handle framing
    // and push completed frames to a queue which KcpUpdate consumes.
    
    private ConcurrentQueue<byte[]> _incomingFrames = new();
    
    private async void RunReadLoop()
    {
         var lenBuf = new byte[4];
         while (!_disposed)
         {
             try 
             {
                 if (_client == null || !_client.Connected) {
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
                 
                 var buf = new byte[len];
                 read = 0;
                 while (read < len) {
                     int r = await _stream.ReadAsync(buf, read, len - read, _stopThread.Token);
                     if (r == 0) throw new EndOfStreamException();
                     read += r;
                 }
                 
                 _incomingFrames.Enqueue(buf);
                 _lastActive = Time.GetTicksMsec();
             }
             catch (Exception)
             {
                 // Lost connection
                 Connected = false;
                 _client?.Close();
                 _client = null;
                 await Task.Delay(1000);
             }
         }
    }


    private void KcpUpdate()
    {
        var now = DateTimeOffset.UtcNow;
        if (_kcp.Check(now) >= now)
            _kcp.Update(now);
    }

    private void KcpRecv()
    {
        if (_recvQueue.Count == 0)
            return;

        var (result, len) = _kcp.TryRecv();
        if (len <= 0)
            return;

        var buffer = new RentedBuffer(len);
        result.Memory.Span.CopyTo(buffer.Span);

        if (_recvQueue.TryDequeue(out var source))
            source.SetResult(buffer);

        Connected = true;
        _lastActive = Time.GetTicksMsec();
    }

    void UpdateThread()
    { 
        // Start read loop background task
        RunReadLoop();
        
        while (_stopThread?.IsCancellationRequested == false)
        {
            lock (_sessionLock)
            {
                // Process incoming frames
                while (_incomingFrames.TryDequeue(out var frame)) 
                {
                     _kcp.Input(frame);
                }
                
                KcpUpdate();
                KcpRecv();
            }
            Thread.Sleep(5);
        }
    }

    async ValueTask<bool> WaitForResponse(ulong startTime, TaskCompletionSource<RentedBuffer> taskSource)
    {
        var completedTask = await Task.WhenAny(taskSource.Task, Task.Delay(KCP_TIMEOUT_MSEC));
        if (completedTask != taskSource.Task)
            return false;

        if (taskSource.Task.IsCanceled)
            return false;

        using var response = taskSource.Task.Result;
        if (response == null)
            return false;

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
        using var buffer = new RentedBuffer(byteLen + 1);

        Encoding.ASCII.GetBytes(data, buffer.Span);
        buffer.Span[byteLen] = 0;

        _rc4?.Crypt(buffer.Span);

        var start = Time.GetTicksMsec();
        
        lock(_sessionLock) {
            _kcp.Send(buffer.Span);
        }

        var taskSource = new TaskCompletionSource<RentedBuffer>();
        _recvQueue.Enqueue(taskSource);

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
                if (!success || Time.GetTicksMsec() - _lastActive > KCP_TIMEOUT_MSEC)
                {
                     // Connection timeout or failure logic
                     // For USB, we might not want to aggressively reconnect locally, 
                     // but we should detect if PC disconnected.
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
        if (state.Length > 12)
            return;

        int paramCount = 0;
        for (int i = 0; i < state.Length; i++)
        {
            var on = state[i] > 0;
            if (!Connected || _oldStates[i] != on)
                packetParamsBuffer[paramCount++] = $"[\"Button {i + 1}\",{(on ? "1" : "0")}]";

            _oldStates[i] = on;
        }

        if (paramCount == 0)
            return;

        var paramStr = string.Join(',', packetParamsBuffer.Take(paramCount));
        Send($"{{\"id\":{_lastId++},\"module\":\"buttons\",\"function\":\"write\",\"params\":[{paramStr}]}}");
    }

    float _lastLeftFader = -1;
    float _lastRightFader = -1;

    public void SendAnalogsState(float left, float right)
    {
        int paramCount = 0;
        if (!Connected || MathF.Abs(left - _lastLeftFader) > 0.01f)
        {
            _lastLeftFader = left;
            packetParamsBuffer[paramCount++] = $"[\"Fader-L\",{left:F2}]";
        }

        if (!Connected || MathF.Abs(right - _lastRightFader) > 0.01f)
        {
            _lastRightFader = right;
            packetParamsBuffer[paramCount++] = $"[\"Fader-R\",{right:F2}]";
        }

        if (paramCount == 0)
            return;

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

        _kcp.Dispose();
    }

    // Called by KCP to send data
    public void Output(IMemoryOwner<byte> buffer, int len)
    {
        try
        {
             if (_client != null && _client.Connected)
             {
                 // Frame it: [Length:4][Data]
                 // KCP output is usually synchronous from Update.
                 // We can write to stream. TcpClient stream writing is thread-safe?
                 // NetworkStream is thread-safe for reading and writing separately.
                 
                 byte[] lenBytes = BitConverter.GetBytes(len);
                 _stream.Write(lenBytes, 0, 4);
                 _stream.Write(buffer.Memory.Span.Slice(0, len).ToArray(), 0, len);
             }
        }
        catch (Exception ex)
        {
            GD.PrintErr($"Write error: {ex.Message}");
            Connected = false;
        }
    }

}
