import { useEffect, useRef } from 'preact/hooks';

export function usePageVisibility(onVisible: () => void): void {
  const callbackRef = useRef(onVisible);
  callbackRef.current = onVisible;

  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'visible') {
        callbackRef.current();
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);
}
