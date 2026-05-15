import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildFinancialProjectionSourceData,
  tryGetCachedFinancialProjectionSourceData,
  type FinancialProjectionSourceData,
  type FinancialProjectionSourceInput,
} from '../../financial-projection/services/financialProjectionService';
import type { FinancialProjectionSourceWorkerResponse } from '../../../workers/financialProjectionSourceWorkerTypes';

/**
 * Offloads `buildFinancialProjectionSourceData` (the 142k-record canonical
 * build) to a Web Worker so the heavy compute never blocks the main thread.
 * Returns `null` while the worker computes; callers render a loading shell.
 *
 * This is the pattern proven in FinancialPlanningDashboard /
 * FinancialProjectionDashboard (PERF 2026-05-14: running the build sync on
 * the main thread pinned the renderer for seconds with real data and looked
 * like a crash). TaxDashboard ran it sync in a useMemo and froze the same
 * way — this hook fixes that without changing the engine output.
 *
 * `cacheProbeInput` must be referentially stable across renders (memoize it
 * in the caller); the worker effect re-runs whenever it changes.
 */
export function useFinancialProjectionSource(
  cacheProbeInput: FinancialProjectionSourceInput,
): FinancialProjectionSourceData | null {
  const cachedSource = useMemo(
    () => tryGetCachedFinancialProjectionSourceData(cacheProbeInput),
    [cacheProbeInput],
  );

  const [source, setSource] = useState<FinancialProjectionSourceData | null>(cachedSource);

  const workerRef = useRef<Worker | null>(null);
  const jobRef = useRef(0);

  useEffect(() => {
    if (cachedSource) {
      setSource(cachedSource);
      return;
    }
    let cancelled = false;
    const jobId = ++jobRef.current;

    const runSyncFallback = () => {
      try {
        const built = buildFinancialProjectionSourceData(cacheProbeInput);
        if (!cancelled && jobRef.current === jobId) setSource(built);
      } catch (err) {
        console.warn('[taxes.source] sync fallback failed', err);
      }
    };

    if (typeof Worker === 'undefined') {
      runSyncFallback();
      return () => { cancelled = true; };
    }

    try {
      if (!workerRef.current) {
        workerRef.current = new Worker(
          new URL('../../../workers/financialProjectionSource.worker.ts', import.meta.url),
          { type: 'module' },
        );
      }
      const worker = workerRef.current;
      worker.onmessage = (event: MessageEvent<FinancialProjectionSourceWorkerResponse>) => {
        if (cancelled || event.data.jobId !== jobRef.current) return;
        if (event.data.result) {
          setSource(event.data.result);
        } else if (event.data.error) {
          console.warn('[taxes.source] worker error, fallback', event.data.error);
          runSyncFallback();
        }
      };
      worker.onerror = (event) => {
        if (cancelled) return;
        console.warn('[taxes.source] worker exception, fallback', event.message);
        runSyncFallback();
      };
      worker.postMessage({ jobId, input: cacheProbeInput });
    } catch (err) {
      console.warn('[taxes.source] worker spawn failed, fallback', err);
      runSyncFallback();
    }

    return () => { cancelled = true; };
  }, [cachedSource, cacheProbeInput]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  return source;
}
