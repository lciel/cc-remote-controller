import { createServer } from 'http';
import os from 'os';
import { WebSocketServer } from 'ws';
import qrcode from 'qrcode-terminal';
import app from './app.js';
import { config } from './config.js';
import { initDb, closeDb } from './db/index.js';
import { setupWebSocket } from './ws/handler.js';
import { cleanupAll } from './services/jobService.js';
import { cleanupUploadDir } from './services/imageStore.js';

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Initialize database
initDb();

// Clean up any leftover temp images from previous runs
cleanupUploadDir();

// Create HTTP server
const server = createServer(app);

// Create WebSocket server on the same HTTP server
const wss = new WebSocketServer({ server, path: '/ws' });
setupWebSocket(wss);

// Start listening
server.listen(config.port, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${config.port}`);
  console.log(`WebSocket available at ws://0.0.0.0:${config.port}/ws`);
  console.log('');

  let baseUrl: string;
  if (config.hostUrl) {
    baseUrl = config.hostUrl.replace(/\/$/, '');
    console.log(`Using configured HOST_URL: ${baseUrl}`);
  } else {
    const ip = getLocalIp();
    baseUrl = `http://${ip}:${config.port}`;
    console.log(`Auto-detected URL: ${baseUrl}`);
    console.log('  (auto-detected IP may be incorrect in WSL2. Set HOST_URL in .env to override.)');
  }

  if (config.authTokenGenerated) {
    console.log(`Auth token (auto-generated): ${config.authToken}`);
  } else {
    console.log('Auth token: (using configured AUTH_TOKEN)');
  }

  const fullUrl = `${baseUrl}?token=${config.authToken}`;
  console.log('');
  console.log('Scan this QR code with your phone to connect:');
  qrcode.generate(fullUrl, { small: true });
  console.log(`Or open: ${fullUrl}`);
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  cleanupAll();
  closeDb();
  // Close all WebSocket connections so server.close() can complete
  for (const client of wss.clients) {
    client.close();
  }
  server.close(() => {
    process.exit(0);
  });
  // Force exit if server.close() takes too long
  setTimeout(() => {
    process.exit(1);
  }, 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
