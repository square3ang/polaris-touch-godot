const net = require('net');

const USBMUXD_PORT = 27015;
const USBMUXD_HOST = '127.0.0.1';
const DEVICE_PORT = 1337;
const GAME_PORT = 25567;
const GAME_HOST = '127.0.0.1';

console.log('Starting Polaris Relay (Raw Implementation)...');

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

// Global state
let deviceId = null;

// ------------- Main Listener Connection -------------
// This connection listens for Attached/Detached events
const listenerSocket = net.createConnection({ port: USBMUXD_PORT, host: USBMUXD_HOST }, () => {
    console.log('Connected to usbmuxd. Sending Listen packet...');

    // Send Listen Packet
    const packet = createPacket({
        'MessageType': 'Listen',
        'ClientVersionString': 'polaris-relay-1.0',
        'ProgName': 'polaris-relay'
    });
    listenerSocket.write(packet);
});

listenerSocket.on('data', (data) => {
    // Basic packet parser
    // We expect a header + XML payload
    let offset = 0;
    while (offset < data.length) {
        if (data.length - offset < 16) break; // Incomplete header

        const len = data.readUInt32LE(offset);
        const version = data.readUInt32LE(offset + 4);
        const request = data.readUInt32LE(offset + 8);
        const tag = data.readUInt32LE(offset + 12);

        if (data.length - offset < len) break; // Incomplete packet

        const payload = data.slice(offset + 16, offset + len).toString();
        // console.log('Received Payload:', payload);

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
    // Very naive XML parser to find MessageType and DeviceID
    // Robust only for the expected plist format

    const messageTypeMatch = xml.match(/<key>MessageType<\/key>\s*<string>(\w+)<\/string>/);
    if (!messageTypeMatch) return;

    const messageType = messageTypeMatch[1];
    /*console.log('Message:', messageType);*/

    if (messageType === 'Attached') {
        const deviceIdMatch = xml.match(/<key>DeviceID<\/key>\s*<integer>(\d+)<\/integer>/);
        const productIdMatch = xml.match(/<key>ProductID<\/key>\s*<integer>(\d+)<\/integer>/);

        if (deviceIdMatch) {
            const newId = parseInt(deviceIdMatch[1]);
            console.log(`Device Attached! ID: ${newId} (Product: ${productIdMatch ? productIdMatch[1] : '?'})`);

            // Connect to this device
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

    // Create a NEW socket to usbmuxd for the tunnel
    const tunnel = net.createConnection({ port: USBMUXD_PORT, host: USBMUXD_HOST }, () => {
        // Send Connect Packet
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
        // We expect a RESULT packet
        // Log raw for debugging
        console.log('Tunnel Response (Hex):', data.toString('hex'));
        console.log('Tunnel Response (Text):', data.toString());

        const str = data.toString();

        if (str.includes('<key>Number</key>') && str.includes('<integer>0</integer>')) {
            console.log('Tunnel Established! Bridging to Game Server...');

            const len = data.readUInt32LE(0);
            const remaining = data.slice(len);

            startProxy(tunnel, remaining);
        } else {
            console.error('Tunnel Connect Failed. Trying non-swapped port...');
            tunnel.end();
            // Retry with Little Endian Port?
            connectToDeviceSimple(id);
        }
    });

    tunnel.on('error', (err) => {
        console.error('Tunnel Socket Error:', err);
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
        console.log('Retry Response (Hex):', data.toString('hex'));
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
    // 1. Connect to Game Server
    const gameSocket = net.createConnection({ port: GAME_PORT, host: GAME_HOST }, () => {
        console.log(`Connected to Game Server ${GAME_HOST}:${GAME_PORT}`);

        if (initialData && initialData.length > 0) {
            gameSocket.write(initialData);
        }
    });

    // 2. Pipe
    tunnel.pipe(gameSocket);
    gameSocket.pipe(tunnel);

    // 3. Events
    gameSocket.on('close', () => {
        console.log('Game Server closed connection.');
        tunnel.end();
    });

    gameSocket.on('error', (err) => {
        console.error('Game Server Error:', err.message);
        tunnel.end();
    });

    tunnel.on('close', () => {
        console.log('Tunnel closed.');
        gameSocket.end();
    });
}
