const net = require('net');

const USBMUXD_PORT = 27015;
const USBMUXD_HOST = '127.0.0.1';
const DEVICE_PORT = 1337;
const GAME_PORT = 25567;
const GAME_HOST = '127.0.0.1';

console.log('Starting Polaris Relay (Robust Implementation)...');

// Protocol Constants
const USBMUX_RESULT_OK = 0;
const USBMUX_RESULT_BADCOMMAND = 1;
const USBMUX_RESULT_BADDEV = 2;
const USBMUX_RESULT_CONNREFUSED = 3;

// Helper to create a packet with plist payload
function createPacket(payloadObj) {
    const plist = createPlist(payloadObj);
    const len = 16 + plist.length;
    const header = Buffer.alloc(16);

    // Header: Length(4), Version(4), Request(4), Tag(4)
    // Version = 1, Request = 8 (PLIST), Tag = 1
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

// Global map to track active tunnels and their game sockets
const activeTunnels = new Map();

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
    console.error('Make sure iTunes/Apple Devices is running.');
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
            console.log(`Device Attached! ID: ${newId} (Product: ${productIdMatch ? productIdMatch[1] : '?'})`);
            connectToDeviceCombined(newId);
        }
    } else if (messageType === 'Detached') {
        const deviceIdMatch = xml.match(/<key>DeviceID<\/key>\s*<integer>(\d+)<\/integer>/);
        if (deviceIdMatch) {
            const detachedId = parseInt(deviceIdMatch[1]);
            console.log(`Device Detached: ${detachedId}`);
        }
    }
}


function connectToDeviceCombined(id) {
    console.log(`Initiating connection to Device ${id} Port ${DEVICE_PORT}...`);

    const tunnel = net.createConnection({ port: USBMUXD_PORT, host: USBMUXD_HOST }, () => {
        const portSwapped = ((DEVICE_PORT << 8) & 0xFF00) | ((DEVICE_PORT >> 8) & 0x00FF);
        const packet = createPacket({
            'MessageType': 'Connect',
            'ClientVersionString': 'polaris-relay-1.0',
            'ProgName': 'polaris-relay',
            'DeviceID': id,
            'PortNumber': portSwapped
        });
        tunnel.write(packet);
    });

    tunnel.once('data', (data) => {
        const str = data.toString();
        // Check success
        if (str.includes('<key>Number</key>') && str.includes('<integer>0</integer>')) {
            console.log('Tunnel Established! Bridging to Game Server...');
            const len = data.readUInt32LE(0);
            const remaining = data.slice(len); // Remaining data from iOS after handshake

            startProxy(tunnel, remaining);
        } else {
            console.error('Tunnel Connect Failed. Trying non-swapped port...');
            tunnel.end();
            connectToDeviceSimple(id);
        }
    });

    tunnel.on('error', (err) => {
        console.error('Tunnel Socket Error:', err.message);
    });
}

function connectToDeviceSimple(id) {
    console.log(`Retry: Connecting to Device ${id} Port ${DEVICE_PORT} (Little Endian)...`);
    const tunnel = net.createConnection({ port: USBMUXD_PORT, host: USBMUXD_HOST }, () => {
        const packet = createPacket({
            'MessageType': 'Connect',
            'ClientVersionString': 'polaris-relay-1.0',
            'ProgName': 'polaris-relay',
            'DeviceID': id,
            'PortNumber': DEVICE_PORT // No Swap
        });
        tunnel.write(packet);
    });

    tunnel.once('data', (data) => {
        const str = data.toString();
        if (str.includes('<integer>0</integer>')) {
            console.log('Tunnel Established (Little Endian)!');
            const len = data.readUInt32LE(0);
            startProxy(tunnel, data.slice(len));
        } else {
            console.error('Retry Failed.');
            tunnel.end();
        }
    });
}

function startProxy(tunnel, initialData) {
    if (activeTunnels.has(tunnel)) return;

    const state = {
        tunnel: tunnel,
        gameSocket: null,
        reconnectTimer: null,
        initialData: initialData
    };
    activeTunnels.set(tunnel, state);

    function connectGameServer() {
        if (state.gameSocket) {
            state.gameSocket.destroy();
            state.gameSocket = null;
        }

        console.log(`Connecting to Game Server ${GAME_HOST}:${GAME_PORT}...`);
        const gameSocket = net.createConnection({ port: GAME_PORT, host: GAME_HOST }, () => {
            console.log(`Connected to Game Server!`);

            // Send pending initial data if exists
            if (state.initialData && state.initialData.length > 0) {
                gameSocket.write(state.initialData);
                state.initialData = null;
            }
        });

        state.gameSocket = gameSocket;

        gameSocket.on('data', (data) => {
            if (!tunnel.destroyed) {
                tunnel.write(data);
            }
        });

        gameSocket.on('close', () => {
            console.log('Game Server disconnected. Reconnecting in 2s...');
            scheduleReconnect();
        });

        gameSocket.on('error', (err) => {
            console.error('Game Server connection error:', err.message);
        });
    }

    function scheduleReconnect() {
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(connectGameServer, 0);
    }

    // Tunnel Events
    tunnel.on('data', (data) => {
        // Forward Tunnel -> Game
        if (data.length === 1) return; // Ignore empty

        // If game is disconnected, we drop the data (real-time input)
        if (state.gameSocket && !state.gameSocket.connecting && !state.gameSocket.destroyed) {
            // console.log(`Forwarding ${data.length} bytes to Game Server`);
            state.gameSocket.write(data);
        }
    });

    tunnel.on('close', () => {
        console.log('Tunnel closed by Device. Stopping Proxy.');
        if (state.gameSocket) state.gameSocket.destroy();
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        activeTunnels.delete(tunnel);
    });

    tunnel.on('error', (err) => {
        console.error('Tunnel Error:', err.message);
    });

    // Start
    connectGameServer();
}
