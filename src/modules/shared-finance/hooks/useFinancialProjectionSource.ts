import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildFinancialProjectionSourceData,
  tryGetCachedFinancialProjectionSourceData,
  type FinancialProjectionSourceData,
  type FinancialProjectionSourceInput,
} from '../../financial-projection/services/financialProjectionService';
import {
  nextSourceJobId,
  postToSharedSourceWorker,
  subscribeSharedSourceWorker,
} from '../services/sharedSourceWorker';

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

  // Per-hook jobIds posted to the shared singleton worker. Listener filters.
  const myJobIds = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (cachedSource) {
      setSource(cachedSource);
      return;
    }
    let cancelled = false;
    const jobId = nextSourceJobId();
    myJobIds.current.add(jobId);

    const runSyncFallback = () => {
      try {
        const built = buildFinancialProjectionSourceData(cacheProbeInput);
        if (!cancelled) setSource(built);
      } catch (err) {
        console.warn('[taxes.source] sync fallback failed', err);
      }
    };

    if (typeof Worker === 'undefined') {
      runSyncFallback();
      return () => { cancelled = true; myJobIds.current.delete(jobId); };
    }

    const ok = postToSharedSourceWorker({ jobId, input: cacheProbeInput });
    if (!ok) runSyncFallback();

    return () => {
      cancelled = true;
      myJobIds.current.delete(jobId);
    };
  }, [cachedSource, cacheProbeInput]);

  useEffect(() => {
    // Subscribe once per hook instance; filter messages by jobIds we posted.
    const unsubscribe = subscribeSharedSourceWorker((data) => {
      if (!myJobIds.current.has(data.jobId)) return;
      myJobIds.current.delete(data.jobId);
      if (data.result) {
        setSource(data.result);
      } else if (data.error) {
        console.warn('[taxes.source] worker error, fallback', data.error);
        try {
          const built = buildFinancialProjectionSourceData(cacheProbeInput);
          setSource(built);
        } catch (err) {
          console.warn('[taxes.source] sync fallback failed', err);
        }
      }
    });
    return () => {
      unsubscribe();
      myJobIds.current.clear();
    };
    // We deliberately depend on cacheProbeInput so fallback rebuild uses the
    // current input; subscription re-binds idempotently.
  }, [cacheProbeInput]);

  return source;
}
