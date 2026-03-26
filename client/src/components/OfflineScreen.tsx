import { useState, useEffect, useCallback } from 'preact/hooks';

export const WOL_URL_KEY = 'cc-wol-url';

interface Props {
  onOnline: () => void;
}

type State = 'idle' | 'waking' | 'polling';

export function OfflineScreen({ onOnline }: Props) {
  const wolUrl = localStorage.getItem(WOL_URL_KEY) || '';
  const [state, setState] = useState<State>('idle');

  const startPolling = useCallback(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch('/api/projects', { signal: AbortSignal.timeout(3000) });
        // Any HTTP response = server is up (401 is fine)
        if (res.status > 0) {
          clearInterval(id);
          onOnline();
        }
      } catch {
        // still unreachable — keep polling
      }
    }, 3000);
    return () => clearInterval(id);
  }, [onOnline]);

  useEffect(() => {
    if (state === 'polling') return startPolling();
  }, [state, startPolling]);

  const handleWake = async () => {
    setState('waking');
    try {
      // mode: 'no-cors' avoids CORS preflight issues with local relay servers
      await fetch(wolUrl, { method: 'POST', mode: 'no-cors' });
    } catch {
      // no-cors suppresses network errors; the WoL packet is likely sent regardless
    }
    setState('polling');
  };

  return (
    <div class="offline-screen">
      <div class="offline-card">
        <svg viewBox="0 0 20 14" width="112" height="80" shape-rendering="crispEdges" class="offline-icon">
          <rect x="0" y="4" width="3" height="4" fill="#c07a50" opacity="0.4" />
          <rect x="17" y="4" width="3" height="4" fill="#c07a50" opacity="0.4" />
          <rect x="3" y="0" width="14" height="11" fill="#c07a50" opacity="0.4" />
          <rect x="6" y="4" width="2" height="3" fill="#2c1810" opacity="0.4" />
          <rect x="13" y="4" width="2" height="3" fill="#2c1810" opacity="0.4" />
          <rect x="5" y="11" width="2" height="3" fill="#c07a50" opacity="0.4" />
          <rect x="8" y="11" width="2" height="3" fill="#c07a50" opacity="0.4" />
          <rect x="11" y="11" width="2" height="3" fill="#c07a50" opacity="0.4" />
          <rect x="14" y="11" width="2" height="3" fill="#c07a50" opacity="0.4" />
        </svg>

        <h2 class="offline-title">Server Unreachable</h2>

        {state === 'idle' && (
          wolUrl ? (
            <>
              <button class="btn-icon wake-btn" onClick={handleWake} aria-label="Wake PC">
                <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64" />
                  <line x1="12" y1="2" x2="12" y2="12" />
                </svg>
              </button>
              <p class="offline-desc">PC may be powered off or not reachable on the network.</p>
            </>
          ) : (
            <p class="offline-hint">
              Configure a Wake-on-LAN URL in{' '}
              <strong>Settings</strong> to enable remote wake.
            </p>
          )
        )}

        {(state === 'waking' || state === 'polling') && (
          <div class="offline-polling">
            <div class="offline-dots">
              <span /><span /><span />
            </div>
            <p class="offline-polling-label">
              {state === 'waking' ? 'Sending wake signal…' : 'Waiting for server…'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
