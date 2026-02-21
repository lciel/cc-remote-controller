import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import app from './app.js';
import { config } from './config.js';
import { initDb, closeDb } from './db/index.js';
import { setupWebSocket } from './ws/handler.js';
import { cleanupAll } from './services/jobService.js';
import { cleanupUploadDir } from './services/imageStore.js';

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
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  cleanupAll();
  closeDb();
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
