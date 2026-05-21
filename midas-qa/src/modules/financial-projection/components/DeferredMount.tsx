import { useEffect, useState, type ReactNode } from 'react';

interface IdleCallbackHandle {
  cancel: () => void;
}

function scheduleIdle(callback: () => void, fallbackDelayMs: number): IdleCallbackHandle {
  if (typeof window === 'undefined') {
    return { cancel: () => {} };
  }
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  }).requestIdleCallback;
  if (typeof ric === 'function') {
    const id = ric(callback, { timeout: fallbackDelayMs });
    return {
      cancel: () => {
        const cic = (window as unknown as {
          cancelIdleCallback?: (handle: number) => void;
        }).cancelIdleCallback;
        if (typeof cic === 'function') cic(id);
      },
    };
  }
  const id = window.setTimeout(callback, fallbackDelayMs);
  return { cancel: () => window.clearTimeout(id) };
}

export interface DeferredMountProps {
  /**
   * Approx delay (ms) before the children mount. The browser may mount earlier
   * via `requestIdleCallback` once the main thread is free. Default 80ms keeps
   * the chart out of the first commit but still feels instant.
   */
  delayMs?: number;
  /** Optional skeleton to display while the children are deferred. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Defers mounting an expensive subtree until after the page's first paint.
 * Used for the Cash Flow chart and other heavyweight sections so the KPI row
 * and scenario tabs render instantly while Recharts / large tables warm up
 * during idle time.
 */
export function DeferredMount({ delayMs = 80, fallback = null, children }: DeferredMountProps) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const handle = scheduleIdle(() => setReady(true), delayMs);
    return () => handle.cancel();
  }, [delayMs]);
  return <>{ready ? children : fallback}</>;
}
