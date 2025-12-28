import * as net from 'net';
import * as process from 'process';
import { X360Controller } from 'vigemclient/lib/X360Controller';

// Type definitions for vigemclient since it might not have full @types
// We use 'require' broadly because vigemclient exports a class structure that can be tricky with ES imports if not typed.
let ViGEmClient: any;
try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ViGEmClient = require('vigemclient');
} catch (e) {
    console.error('Error: vigemclient not found. This script requires vigemclient for Joystick support.');
    console.error('Please run: npm install vigemclient');
    process.exit(1);
}

const USBMUXD_PORT = 27015;
const USBMUXD_HOST = '127.0.0.1';
const DEVICE_PORT = 1337;

console.log('Starting Polaris Relay (TypeScript Edition)...');

// ------------- Virtual Controller Setup -------------
let controller: X360Controller | null = null;

if (ViGEmClient) {
    try {
        const client = new ViGEmClient();
        const err = client.connect();
        if (err) {
            console.error('Failed to connect to ViGEmBus:', err.message);
        } else {
            controller = client.createX360Controller();
            const connErr = controller?.connect();
            if (connErr) {
                console.error('Failed to connect Virtual Controller:', connErr.message);
                controller = null;
            } else {
                console.log('Virtual Xbox 360 Controller Connected!');
            }
        }
    } catch (e: any) {
        console.error('ViGEm Init Error:', e.message);
    }
}

// Helper to update D-Pad directly to allow SOCD (Simultaneous Opposite Cardinal Directions)
function updateDpadDirectly(name: string, pressed: boolean) {
    if (controller) {
        // Access private _report object to set button bits directly
        // Bypassing the standard .axis.dpadHorz/Vert helper which enforces mutual exclusivity
        if ((controller as any)._report) {
            (controller as any)._report.updateButton(name, pressed);
            // Force update to send the report to the driver immediately
            (controller as any).update();
        }
    }
}

// Helper to update controller
function updateController(name: string, value: number) {
    if (!controller) return;

    // Check if it's a fader (Analog)
    if (name.startsWith('Fader')) {
        // vigemclient expects -1.0 to 1.0 for Stick Axes
        // Input is likely 0.0 to 1.0
        let normalized = value;
        if (value > 1.0) normalized = value / 255.0; // Fallback if 8-bit int

        // Map 0..1 to -1..1
        const axisVal = (normalized * 2.0) - 1.0;

        // Safety clamp
        const clampedVal = Math.max(-1.0, Math.min(1.0, axisVal));

        switch (name) {
            case 'Fader-L': controller.axis.leftX.setValue(clampedVal); break;
            case 'Fader-R': controller.axis.rightX.setValue(clampedVal); break;
        }
        return;
    }

    // Mapping: 
    // Buttons 1-4 -> A, B, X, Y
    // Buttons 5-8 -> D-Pad (Left, Right, Up, Down) mapped directly as buttons
    // Buttons 9-12 -> Back, Start, LSB, RSB

    const isPressed = (value === 1);

    switch (name) {
        case 'Button 1': controller.button.A.setValue(isPressed); break;
        case 'Button 2': controller.button.B.setValue(isPressed); break;
        case 'Button 3': controller.button.X.setValue(isPressed); break;
        case 'Button 4': controller.button.Y.setValue(isPressed); break;

        // D-Pad Mapping (Direct Report manipulation for SOCD support)
        case 'Button 5': updateDpadDirectly('DPAD_LEFT', isPressed); break;
        case 'Button 6': updateDpadDirectly('DPAD_RIGHT', isPressed); break;
        case 'Button 7': updateDpadDirectly('DPAD_UP', isPressed); break;
        case 'Button 8': updateDpadDirectly('DPAD_DOWN', isPressed); break;

        case 'Button 9': controller.button.LEFT_SHOULDER.setValue(isPressed); break;
        case 'Button 10': controller.button.RIGHT_SHOULDER.setValue(isPressed); break;
        case 'Button 11': controller.button.LEFT_THUMB.setValue(isPressed); break;
        case 'Button 12': controller.button.RIGHT_THUMB.setValue(isPressed); break;

        default: break;
    }
}


// Interfaces for Plist logic
interface UsbmuxPacket {
    MessageType: string;
    ClientVersionString?: string;
    ProgName?: string;
    DeviceID?: number;
    PortNumber?: number;
    [key: string]: any;
}

// Helper to create a packet with plist payload
function createPacket(payloadObj: UsbmuxPacket): Buffer {
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
function createPlist(obj: UsbmuxPacket): string {
    let xml = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n';
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            xml += `    <key>${key}</key>\n`;
            const val = obj[key];
            if (typeof val === 'string') {
                xml += `    <string>${val}</string>\n`;
            } else if (typeof val === 'number') {
                xml += `    <integer>${val}</integer>\n`;
            }
        }
    }
    xml += '</dict>\n</plist>';
    return xml;
}

// Global state
const attachedDevices = new Set<number>();

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

listenerSocket.on('data', (data: Buffer) => {
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

listenerSocket.on('error', (err: any) => {
    console.error('Listener Socket Error:', err.message);
    if (err.code === 'ECONNREFUSED') {
        console.error('Is iTunes installed and running?');
    }
});

listenerSocket.on('close', () => {
    console.log('Listener Socket disconnected. Retrying in 3s...');
    setTimeout(() => {
        listenerSocket.connect(USBMUXD_PORT, USBMUXD_HOST);
    }, 3000);
});

// ------------- Payload Parser -------------
function parsePayload(xml: string) {
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
        }
    }
}

// ------------- Device Connection Loop -------------
async function manageDeviceConnection(id: number) {
    while (attachedDevices.has(id)) {
        console.log(`Attempting connection to Device ${id}...`);

        try {
            await connectToDevice(id);
        } catch (err: any) {
            console.error(`Connection attempt failed for Device ${id}:`, err.message);
        }

        // Check again if still attached before waiting to retry
        if (attachedDevices.has(id)) {
            console.log(`Device ${id} still attached. Retrying connection in 1s...`);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    console.log(`Device ${id} connection loop ended.`);
}


function connectToDevice(id: number): Promise<void> {
    return new Promise((resolve) => {
        tryConnect(id, true, (err: Error | null, tunnel?: net.Socket, remainingData?: Buffer) => {
            if (!err && tunnel) {
                console.log(`Tunnel Established (Swapped Port)!`);
                startSession(tunnel, remainingData, resolve);
            } else {
                console.log('Swapped port failed, trying non-swapped...');
                tryConnect(id, false, (err2, tunnel2, remainingData2) => {
                    if (!err2 && tunnel2) {
                        console.log(`Tunnel Established (Little Endian)!`);
                        startSession(tunnel2, remainingData2, resolve);
                    } else {
                        resolve();
                    }
                });
            }
        });
    });
}

function tryConnect(id: number, swap: boolean, callback: (err: Error | null, tunnel?: net.Socket, remaining?: Buffer) => void) {
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

    tunnel.once('data', (data: Buffer) => {
        const str = data.toString();
        if (str.includes('<integer>0</integer>')) {
            connected = true;
            const len = data.readUInt32LE(0);
            const remaining = data.slice(len);
            toggleTunnelListeners(tunnel, false);
            callback(null, tunnel, remaining);
        } else {
            tunnel.end();
            callback(new Error('Connect refused'), undefined, undefined);
        }
    });

    tunnel.on('error', (err: Error) => {
        if (!connected) callback(err, undefined, undefined);
    });

    tunnel.on('close', () => {
        if (!connected) callback(new Error('Closed before connect'), undefined, undefined);
    });
}

function toggleTunnelListeners(tunnel: net.Socket, enable: boolean) {
    if (!enable) {
        tunnel.removeAllListeners('data');
        tunnel.removeAllListeners('error');
        tunnel.removeAllListeners('close');
    }
}

// ------------- Session Logic (No WebSocket) -------------
function startSession(tunnel: net.Socket, initialData: Buffer | undefined, onTunnelClose: () => void) {
    const state = {
        tunnel: tunnel,
        buffer: Buffer.alloc(0)
    };

    if (initialData && initialData.length > 0) {
        processIncomingData(state, initialData);
    }

    // Process incoming data for JSON parsing -> Controller
    function processIncomingData(currState: typeof state, data: Buffer) {
        if (data.length === 0) return;

        // Joystick Logic
        if (controller) {
            currState.buffer = Buffer.concat([currState.buffer, data]);

            let nullIdx;
            while ((nullIdx = currState.buffer.indexOf(0x00)) !== -1) {
                const messageBuf = currState.buffer.slice(0, nullIdx);
                currState.buffer = currState.buffer.slice(nullIdx + 1); // Advance buffer

                if (messageBuf.length > 0) {
                    try {
                        const jsonStr = messageBuf.toString('utf8');
                        const msg = JSON.parse(jsonStr);

                        // Parse Buttons
                        if (msg.module === 'buttons' && msg.function === 'write' && Array.isArray(msg.params)) {
                            msg.params.forEach((param: any) => {
                                if (Array.isArray(param) && param.length === 2) {
                                    updateController(param[0], param[1]);
                                }
                            });
                        }
                        // Parse Analogs (Faders)
                        else if (msg.module === 'analogs' && msg.function === 'write' && Array.isArray(msg.params)) {
                            msg.params.forEach((param: any) => {
                                if (Array.isArray(param) && param.length === 2) {
                                    updateController(param[0], param[1]);
                                }
                            });
                        }

                    } catch (e) {
                        // Ignore parse errors (partial data)
                    }
                }
            }
        }
    }

    tunnel.on('data', (data: Buffer) => {
        processIncomingData(state, data);
    });

    tunnel.on('close', () => {
        console.log('Tunnel closed.');
        if (onTunnelClose) onTunnelClose();
    });

    tunnel.on('error', (err: Error) => {
        console.error('Tunnel Error:', err.message);
    });
}
