import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer, Server as HttpsServer } from 'https';
import fs from 'fs';
import os from 'os';
import { WebSocketServer } from 'ws';
import qrcode from 'qrcode-terminal';
import app from './app.js';
import { config } from './config.js';
import { initDb, closeDb } from './db/index.js';
import { setupWebSocket } from './ws/handler.js';
import { cleanupAll } from './services/jobService.js';
import { cleanupUploadDir } from './services/imageStore.js';
import * as teamWatcher from './services/teamWatcher.js';
import * as persistentOrchestrator from './services/persistentOrchestrator.js';
import * as channelOrchestrator from './services/channelOrchestrator.js';

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

// SIGTERM any orphan persistent orchestrators left over from a prior server
// instance (e.g. after kill -9). Lets Claude's own graceful shutdown clean
// up team config so the next ensure() spawns into a fresh state.
persistentOrchestrator.cleanupOrphans();

// Reap orphan channel (ccctl-*) tmux sessions from a prior server instance.
// After restart the in-memory channel session map is empty, so any leftover
// session is an untracked orphan holding a claude/bun process and port; the
// next send recreates the session via --resume.
void channelOrchestrator.reapOrphanSessions().catch((err) => {
  console.warn(`[startup] channel orphan reap failed: ${(err as Error).message}`);
});

// Create HTTP(S) server
const server = config.ssl
  ? createHttpsServer({
      cert: fs.readFileSync(config.ssl.certPath),
      key: fs.readFileSync(config.ssl.keyPath),
    }, app)
  : createHttpServer(app);
const protocol = config.ssl ? 'https' : 'http';
const wsProtocol = config.ssl ? 'wss' : 'ws';

// Create WebSocket server on the same HTTP server
const wss = new WebSocketServer({ server, path: '/ws' });
setupWebSocket(wss);

// Start polling team inbox files for active team-mode projects
teamWatcher.start();

// Start listening
server.listen(config.port, '0.0.0.0', () => {
  console.log(`Server listening on ${protocol}://0.0.0.0:${config.port}${config.ssl ? ' (SSL)' : ''}`);
  console.log(`WebSocket available at ${wsProtocol}://0.0.0.0:${config.port}/ws`);
  console.log('');

  let baseUrl: string;
  if (config.hostUrl) {
    baseUrl = config.hostUrl.replace(/\/$/, '');
    console.log(`Using configured HOST_URL: ${baseUrl}`);
  } else {
    const ip = getLocalIp();
    baseUrl = `${protocol}://${ip}:${config.port}`;
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
  teamWatcher.stop();
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

// Reload SSL certificates on SIGHUP (e.g., after certbot renew)
if (config.ssl) {
  process.on('SIGHUP', () => {
    try {
      const cert = fs.readFileSync(config.ssl!.certPath);
      const key = fs.readFileSync(config.ssl!.keyPath);
      (server as HttpsServer).setSecureContext({ cert, key });
      console.log('[SSL] Certificates reloaded');
    } catch (err) {
      console.error('[SSL] Failed to reload certificates:', (err as Error).message);
    }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
