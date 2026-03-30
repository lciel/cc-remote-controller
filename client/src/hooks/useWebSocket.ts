import { useEffect, useRef } from 'preact/hooks';
import { WsClient } from '../api/ws';

let sharedClient: WsClient | null = null;

function getWsClient(): WsClient {
  if (!sharedClient) {
    const token = localStorage.getItem('cc-auth-token') || '';
    sharedClient = new WsClient(token);
    sharedClient.connect();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && sharedClient) {
        sharedClient.forceReconnect();
      }
    });
  }
  return sharedClient;
}

export function useWebSocket(
  projectId: string | null,
  onMessage: (data: unknown) => void
): void {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    if (!projectId) return;

    const client = getWsClient();
    client.subscribe(projectId);

    const unsub = client.onMessage((data) => {
      handlerRef.current(data);
    });

    return () => {
      unsub();
      client.unsubscribe(projectId);
    };
  }, [projectId]);
}

export function useGlobalWsMessage(onMessage: (data: unknown) => void): void {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    const client = getWsClient();
    return client.onMessage((data) => handlerRef.current(data));
  }, []);
}

export function reconnectWs(): void {
  if (sharedClient) {
    sharedClient.disconnect();
    sharedClient = null;
  }
}
