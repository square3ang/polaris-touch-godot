const net = require('net');
const WebSocket = require('ws');

const USBMUXD_PORT = 27015;
const USBMUXD_HOST = '127.0.0.1';
const DEVICE_PORT = 1337;
const GAME_PORT = 25568;
const GAME_HOST = '127.0.0.1';

console.log('Starting Polaris Relay (Robust WebSocket + Auto-Retry)...');

// Helper to create a packet with plist payload
function createPacket(payloadObj) {
    const plist = createPlist(payloadObj);
    const len = 16 + plist.length;
    const header = Buffer.alloc(16);
    header.writeUInt32LE(len, 0);
    header.writeUInt32LE(1, 4);
    header.writeUInt32LE(8, 8); // MESSAGE_PLIST
    header.writeUInt32LE(1, 12);
    return Buffer.concat([header, Buffer.from(plist)]);
}

// Simple Plist Generator (XML)
function createPlist(obj) {
    let xml = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n';
    for (const key in obj) {
        xml += `    <key>${key}</key>\n`;
        const val = obj[key];
        if (typeof val === 'string') {
            xml += `    <string>${val}</string>\n`;
        } else if (typeof val === 'number') {
            xml += `    <integer>${val}</integer>\n`;
        }
    }
    xml += '</dict>\n</plist>';
    return xml;
}

// Global state
const attachedDevices = new Set(); // IDs of devices currently attached via USB
const activeTunnels = new Map();   // Map<dummyKey, proxyState> - simplistic tracking

// ------------- Main Listener Connection -------------
const listenerSocket = net.createConnection({ port: USBMUXD_PORT, host: USBMUXD_HOST }, () => {
    console.log('Connected to usbmuxd. Sending Listen packet...');
    const packet = createPacket({
        'MessageType': 'Listen',
        'ClientVersionString': 'polaris-relay-1.0',
        'ProgName': 'polaris-relay'
    });
    listenerSocket.write(packet);
});

listenerSocket.on('data', (data) => {
    let offset = 0;
    while (offset < data.length) {
        if (data.length - offset < 16) break;
        const len = data.readUInt32LE(offset);
        if (data.length - offset < len) break;

        const payload = data.slice(offset + 16, offset + len).toString();
        parsePayload(payload);
        offset += len;
    }
});

listenerSocket.on('error', (err) => {
    console.error('Listener Socket Error:', err.message);
});

listenerSocket.on('close', () => {
    console.log('Listener Socket disconnected. Retrying in 3s...');
    setTimeout(() => {
        listenerSocket.connect(USBMUXD_PORT, USBMUXD_HOST);
    }, 3000);
});

// ------------- Payload Parser -------------
function parsePayload(xml) {
    const messageTypeMatch = xml.match(/<key>MessageType<\/key>\s*<string>(\w+)<\/string>/);
    if (!messageTypeMatch) return;

    const messageType = messageTypeMatch[1];

    if (messageType === 'Attached') {
        const deviceIdMatch = xml.match(/<key>DeviceID<\/key>\s*<integer>(\d+)<\/integer>/);
        const productIdMatch = xml.match(/<key>ProductID<\/key>\s*<integer>(\d+)<\/integer>/);

        if (deviceIdMatch) {
            const newId = parseInt(deviceIdMatch[1]);
            if (!attachedDevices.has(newId)) {
                console.log(`Device Attached! ID: ${newId} (Product: ${productIdMatch ? productIdMatch[1] : '?'})`);
                attachedDevices.add(newId);
                manageDeviceConnection(newId);
            }
        }
    } else if (messageType === 'Detached') {
        const deviceIdMatch = xml.match(/<key>DeviceID<\/key>\s*<integer>(\d+)<\/integer>/);
        if (deviceIdMatch) {
            const detachedId = parseInt(deviceIdMatch[1]);
            console.log(`Device Detached: ${detachedId}`);
            attachedDevices.delete(detachedId);
            // The active tunnel socket close event will clean up the proxy
        }
    }
}

// ------------- Device Connection Loop -------------
async function manageDeviceConnection(id) {
    // Keep trying to connect as long as the device is attached
    while (attachedDevices.has(id)) {
        console.log(`Attempting connection to Device ${id}...`);

        try {
            await connectToDevice(id);
            // If connectToDevice resolves, it means the connection finished (closed).
            // We loop back and try again appropriately.
        } catch (err) {
            console.error(`Connection attempt failed for Device ${id}:`, err.message);
        }

        if (attachedDevices.has(id)) {
            console.log(`Device ${id} still attached. Retrying connection in 1s...`);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    console.log(`Device ${id} connection loop ended.`);
}


function connectToDevice(id) {
    return new Promise((resolve, reject) => {
        // Try Swapped Port First
        tryConnect(id, true, (err, tunnel, remainingData) => {
            if (!err) {
                // Success
                console.log(`Tunnel Established (Swapped Port)!`);
                startProxy(tunnel, remainingData, resolve);
            } else {
                console.log('Swapped port failed, trying non-swapped...');
                // Try Non-Swapped
                tryConnect(id, false, (err2, tunnel2, remainingData2) => {
                    if (!err2) {
                        console.log(`Tunnel Established (Little Endian)!`);
                        startProxy(tunnel2, remainingData2, resolve);
                    } else {
                        // Both failed
                        resolve(); // Resolve to trigger retry loop
                    }
                });
            }
        });
    });
}

function tryConnect(id, swap, callback) {
    const tunnel = net.createConnection({ port: USBMUXD_PORT, host: USBMUXD_HOST });
    let connected = false;

    tunnel.on('connect', () => {
        const portNum = swap
            ? ((DEVICE_PORT << 8) & 0xFF00) | ((DEVICE_PORT >> 8) & 0x00FF)
            : DEVICE_PORT;

        const packet = createPacket({
            'MessageType': 'Connect',
            'ClientVersionString': 'polaris-relay-1.0',
            'ProgName': 'polaris-relay',
            'DeviceID': id,
            'PortNumber': portNum
        });
        tunnel.write(packet);
    });

    tunnel.once('data', (data) => {
        const str = data.toString();
        if (str.includes('<integer>0</integer>')) {
            connected = true;
            const len = data.readUInt32LE(0);
            const remaining = data.slice(len);
            toggleTunnelListeners(tunnel, false); // Remove setup listeners
            callback(null, tunnel, remaining);
        } else {
            tunnel.end();
            callback(new Error('Connect refused'));
        }
    });

    tunnel.on('error', (err) => {
        if (!connected) callback(err);
    });

    tunnel.on('close', () => {
        if (!connected) callback(new Error('Closed before connect'));
    });
}

function toggleTunnelListeners(tunnel, enable) {
    if (!enable) {
        tunnel.removeAllListeners('data');
        tunnel.removeAllListeners('error');
        tunnel.removeAllListeners('close');
    }
}

// ------------- Proxy Logic -------------
function startProxy(tunnel, initialData, onTunnelClose) {
    const state = {
        tunnel: tunnel,
        ws: null,
        reconnectTimer: null,
        initialData: initialData
    };

    // tunnel is the key for now, though we don't strictly need global map if we use closure properly
    // keeping it simple.

    function connectGameServer() {
        if (state.ws) {
            try { state.ws.terminate(); } catch { }
            state.ws = null;
        }

        const url = `ws://${GAME_HOST}:${GAME_PORT}`;
        // console.log(`Connecting to Game Server ${url}...`);

        const ws = new WebSocket(url);
        state.ws = ws;

        ws.on('open', () => {
            console.log('Connected to Game Server (WebSocket)!');
            if (state.initialData && state.initialData.length > 0) {
                ws.send(state.initialData);
                state.initialData = null;
            }
        });

        ws.on('message', (data) => {
            if (!tunnel.destroyed) {
                // Convert WS data (Buffer/ArrayBuffer) to Buffer if needed
                if (data instanceof ArrayBuffer) {
                    tunnel.write(Buffer.from(data));
                } else {
                    tunnel.write(data);
                }
            }
        });

        ws.on('close', () => {
            // console.log('Game Server disconnected. Retrying immediately...');
            scheduleReconnect();
        });

        ws.on('error', (err) => {
            console.error('Game Server WebSocket error:', err.message);
        });
    }

    function scheduleReconnect() {
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        // User requested 0s interval
        state.reconnectTimer = setTimeout(connectGameServer, 0);
    }

    // Tunnel Events - re-attach
    tunnel.on('data', (data) => {
        if (data.length === 0) return;

        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(data);
        }
    });

    tunnel.on('close', () => {
        console.log('Tunnel closed.');
        if (state.ws) state.ws.terminate();
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        if (onTunnelClose) onTunnelClose();
    });

    tunnel.on('error', (err) => {
        console.error('Tunnel Error:', err.message);
        // Close event will invoke onTunnelClose
    });

    // Start
    connectGameServer();
}
