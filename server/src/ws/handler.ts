import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { config } from '../config.js';
import { WsClientMessage, WsServerMessage } from '../types.js';

// projectId → Set of subscribed WebSocket clients
const subscriptions = new Map<string, Set<WebSocket>>();

export function setupWebSocket(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Authenticate via query param
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (token !== config.authToken) {
      ws.close(4001, 'Unauthorized');
      return;
    }

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
