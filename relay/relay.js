const usbmux = require('usbmux');
const dgram = require('dgram');

const GAME_PORT = 1337;
const GAME_HOST = '127.0.0.1'; // Localhost where the game is running
const DEVICE_PORT = 1337; // Port the iOS app is listening on

const udpSocket = dgram.createSocket('udp4');

let deviceTunnel = null;
let buffer = Buffer.alloc(0);

console.log('Starting Polaris Relay...');
console.log('Waiting for iOS device...');

const listener = usbmux.createListener();

listener.on('attach', (device) => {
    console.log(`Device attached: ${device.id}`);
    
    // Attempt to connect
    connectToDevice(device.id);
});

listener.on('detach', (device) => {
    console.log(`Device detached: ${device.id}`);
    if (deviceTunnel) {
        deviceTunnel.end();
        deviceTunnel = null;
    }
});

function connectToDevice(deviceId) {
    console.log(`Connecting to port ${DEVICE_PORT} on device ${deviceId}...`);
    
    usbmux.getTunnel(deviceId, DEVICE_PORT)
        .then((tunnel) => {
            console.log('Tunnel established!');
            deviceTunnel = tunnel;
            buffer = Buffer.alloc(0);
            
            tunnel.on('data', (chunk) => {
                buffer = Buffer.concat([buffer, chunk]);
                
                while (buffer.length >= 4) {
                    const len = buffer.readInt32LE(0);
                    
                    if (len < 0 || len > 65535) {
                        console.error('Invalid length packet received, resetting buffer');
                        buffer = Buffer.alloc(0);
                        break;
                    }

                    if (buffer.length >= 4 + len) {
                        const payload = buffer.slice(4, 4 + len);
                        buffer = buffer.slice(4 + len);
                        
                        // Forward to Game
                        udpSocket.send(payload, GAME_PORT, GAME_HOST, (err) => {
                            if (err) console.error('UDP Send Error:', err);
                        });
                    } else {
                        break; // Wait for more data
                    }
                }
            });
            
            tunnel.on('close', () => {
                console.log('Tunnel closed');
                deviceTunnel = null;
                // Retry?
            });
            
            tunnel.on('error', (err) => {
                console.error('Tunnel error:', err);
                deviceTunnel = null;
            });
        })
        .catch((err) => {
            console.error('Failed to create tunnel:', err.message);
            // Retry logic could be added here
        });
}

// Handle UDP messages from Game
udpSocket.on('message', (msg, rinfo) => {
    // console.log(`Received ${msg.length} bytes from Game`);
    if (deviceTunnel) {
        try {
            const lenBuf = Buffer.alloc(4);
            lenBuf.writeInt32LE(msg.length, 0);
            deviceTunnel.write(lenBuf);
            deviceTunnel.write(msg);
        } catch (e) {
            console.error('Write error:', e);
        }
    }
});

udpSocket.on('listening', () => {
    const address = udpSocket.address();
    console.log(`UDP Relay listening on ${address.address}:${address.port} (Client Mode)`);
    // Note: We don't bind to 1337 UDP because the GAME is listening there.
    // We bind to a random port and send TO 1337.
    // The Game will reply TO our random port.
});

udpSocket.bind(0);
