import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { config } from '../config.js';
import { safeCompare } from '../utils/crypto.js';
import { WsClientMessage, WsServerMessage } from '../types.js';

// projectId → Set of subscribed WebSocket clients
const subscriptions = new Map<string, Set<WebSocket>>();
// All authenticated clients
const allClients = new Set<WebSocket>();

export function setupWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Authenticate via Sec-WebSocket-Protocol subprotocol header.
    // Client sends: new WebSocket(url, ['v1', 'auth.<token>'])
    // This avoids exposing the token in URL query strings (logged by proxies/browsers).
    const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
    const authProto = protocols.find(p => p.startsWith('auth.'));
    const token = authProto ? authProto.slice(5) : null;

    if (!token || !safeCompare(token, config.authToken)) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    allClients.add(ws);
    const clientSubscriptions = new Set<string>();

    ws.on('message', (data) => {
      try {
        const msg: WsClientMessage = JSON.parse(data.toString());

        if (msg.type === 'subscribe') {
          clientSubscriptions.add(msg.projectId);
          if (!subscriptions.has(msg.projectId)) {
            subscriptions.set(msg.projectId, new Set());
          }
          subscriptions.get(msg.projectId)!.add(ws);
        } else if (msg.type === 'unsubscribe') {
          clientSubscriptions.delete(msg.projectId);
          subscriptions.get(msg.projectId)?.delete(ws);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      allClients.delete(ws);
      for (const projectId of clientSubscriptions) {
        subscriptions.get(projectId)?.delete(ws);
        if (subscriptions.get(projectId)?.size === 0) {
          subscriptions.delete(projectId);
        }
      }
    });
  });
}

/**
 * Broadcast a message to all authenticated clients.
 */
export function broadcastAll(message: WsServerMessage): void {
  const payload = JSON.stringify(message);
  for (const ws of allClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

/**
 * Broadcast a message to all clients subscribed to a given projectId.
 */
export function broadcast(projectId: string, message: WsServerMessage): void {
  const clients = subscriptions.get(projectId);
  if (!clients) return;

  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}
