import { useCallback, useEffect, useRef, useState } from 'react';
import { projectionRunCache } from '../../financial-projection/services/projectionCache';
import {
  buildScenarioForecastRun,
  type BuildScenarioForecastRunArgs,
  type ScenarioForecastRun,
} from '../../financial-planning/services/scenarioForecastRun';
import type {
  HeavySourceBundle,
  LightRunArgs,
  ScenarioForecastRunWorkerRequest,
  ScenarioForecastRunWorkerResponse,
} from '../../../workers/scenarioForecastRunWorkerTypes';

// Module-level "last good run of any scenario" — the universal placeholder so
// runCached never has to computeSync() on the main thread (the 225k-movement
// pipeline = a multi-second freeze / OOM, the "no abrió" crash) just because a
// specific scenario has no per-scenario stale yet. Seeded by the projection
// warmup (a worker-built BASE run) before the dashboard mounts, then kept
// fresh as real results land. Survives unmount on purpose (cheap: one ref).
let universalPlaceholder: ScenarioForecastRun | null = null;

// ─────────────────────────────────────────────────────────────────────────
// Shared singleton worker (2026-05-20).
//
// Before: each hook instance spawned its own Worker, so when Planning and
// Projection were both KeepAlive-mounted (the default in App.tsx) we had TWO
// scenarioForecastRun.worker.ts instances running simultaneously, each
// caching its own heavy bundle (~88k payroll records + cobranza + compras).
// Heap snapshots confirmed ~190MB × 2 = ~400MB wasted in duplicated worker
// memory. Promote worker + heavy-version state to module-level so the second
// hook reuses the first one. Each hook still owns its own pendingKeys /
// stale map / persist callbacks; the shared listener fan-outs by jobId.
let sharedWorker: Worker | null = null;
let sharedWorkerHeavyVersion = -1;
let sharedHeavyVersion = 0;
let sharedPrevHeavy: HeavySourceBundle | null = null;
let sharedJobSeq = 0;
const sharedMessageListeners = new Set<(data: ScenarioForecastRunWorkerResponse) => void>();

function getSharedWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (sharedWorker) return sharedWorker;
  try {
    const worker = new Worker(
      new URL('../../../workers/scenarioForecastRun.worker.ts', import.meta.url),
      { type: 'module' },
    );
    sharedWorkerHeavyVersion = -1;
    worker.onmessage = (event: MessageEvent<ScenarioForecastRunWorkerResponse>) => {
      for (const listener of sharedMessageListeners) listener(event.data);
    };
    worker.onerror = (event) => {
      // eslint-disable-next-line no-console
      console.warn('[scenarioRun] worker exception', event.message);
      sharedWorkerHeavyVersion = -1;
    };
    sharedWorker = worker;
    return worker;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[scenarioRun] worker spawn failed', err);
    return null;
  }
}

/** Seed the universal placeholder from the warmup (worker-built BASE run). */
export function setScenarioRunPlaceholder(run: ScenarioForecastRun): void {
  universalPlaceholder = run;
}

export interface ScenarioRunController {
  /** Bumps when a worker result lands so consuming useMemos re-read the cache. */
  runVersion: number;
  /**
   * Worker-backed replacement for `cachedRun`. Behaviour:
   *  - cache hit            → return cached run synchronously (unchanged)
   *  - miss + prior run     → post to worker, return the previous run for that
   *                           scenario (stale) so the UI never freezes; a
   *                           `runVersion` bump re-renders with the fresh run
   *  - miss + no prior run  → compute synchronously once (first paint is
   *                           already gated off the critical path upstream)
   *  - no Worker (jsdom/SSR)→ compute synchronously (identical to old path)
   */
  runCached: <T>(
    cacheKey: string,
    scenarioId: string,
    makeArgs: () => BuildScenarioForecastRunArgs,
    persist?: (key: string, result: ScenarioForecastRun) => void,
    /**
     * Gran-independent cache key. When two requests share the same pipelineKey
     * (same scenario+inputs, different granularity), the worker reuses the
     * cached pipeline output and only re-runs the cheap aggregator. Defaults
     * to `cacheKey` (no pipeline reuse) for back-compat.
     */
    pipelineKey?: string,
  ) => T;
}

const HEAVY_KEYS = [
  'sourceMovements',
  'clients',
  'providers',
  'cxpRecords',
  'purchaseReceipts',
  'payrollCosts',
  'cobranzaPayments',
  'bajioStatements',
] as const;

function splitArgs(a: BuildScenarioForecastRunArgs): { heavy: HeavySourceBundle; light: LightRunArgs } {
  const {
    sourceMovements, clients, providers, cxpRecords,
    purchaseReceipts, payrollCosts, cobranzaPayments, bajioStatements,
    ...light
  } = a;
  return {
    heavy: { sourceMovements, clients, providers, cxpRecords, purchaseReceipts, payrollCosts, cobranzaPayments, bajioStatements },
    light: light as LightRunArgs,
  };
}

// Heavy inputs are referentially stable across renders until a real data
// refresh, so identity comparison detects "the source changed" cheaply.
function heavyChanged(p: HeavySourceBundle, n: HeavySourceBundle): boolean {
  for (const k of HEAVY_KEYS) {
    if (p[k] !== n[k]) return true;
  }
  return false;
}

/**
 * Offloads `buildScenarioForecastRun` to a Web Worker. The per-scenario
 * treasury pipeline (applyAdjustments + taxView + scheduleSupplierPayments +
 * calculateBaseProjection + cell overrides) used to run synchronously on the
 * main thread inside the dashboards' useMemos on every cell edit, freezing the
 * tab for hundreds of ms with real data (looked like a crash). This keeps the
 * synchronous useMemo graph intact: it always returns *a* valid run (cached,
 * stale-while-recompute, or a one-time sync compute), never null.
 *
 * The heavy session-invariant inputs (~100k movements + catalogs) are sent to
 * the worker once per version and cached there; per-run posts only ship the
 * small deltas, so no giant structured-clone runs on the main thread per edit.
 */
export function useScenarioRunWorker(): ScenarioRunController {
  const [runVersion, setRunVersion] = useState(0);
  /** cacheKey -> latest jobId posted (dedupe + stale-result guard). */
  const pendingKeys = useRef<Map<string, number>>(new Map());
  /** scenarioId -> last good run (stale-while-recompute source). */
  const lastResultByScenario = useRef<Map<string, ScenarioForecastRun>>(new Map());
  /** cacheKey -> persist callback to invoke when the worker result lands. */
  const persistByKey = useRef<Map<string, (k: string, r: ScenarioForecastRun) => void>>(new Map());

  // Bound the stale-while-recompute map: each entry is a fat ScenarioForecastRun
  // (full movements INCLUDING expanded payroll ~88k records, big driver of
  // boot heap). Lowered 4 → 2 (2026-05-20) after the nominaRecords retainer
  // chain in heap snapshots showed STALE_CAP × projectionRunCache × source
  // cache compounding into multi-GB at first paint. 2 retains the active +
  // approved pair (the only ones the comparison surfaces need synchronously);
  // a dropped scenario falls back to one sync compute, which is acceptable.
  const STALE_CAP = 2;
  const rememberStale = useCallback((scenarioId: string, result: ScenarioForecastRun) => {
    universalPlaceholder = result; // keep the cross-scenario fallback fresh
    const m = lastResultByScenario.current;
    m.delete(scenarioId);
    m.set(scenarioId, result);
    while (m.size > STALE_CAP) {
      const oldest = m.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }, []);

  // Mounted flag: prevents setState on an unmounted hook (the shared worker
  // is module-level so a stale message could land after this hook unmounted,
  // and React 18 throws an "Should have a queue" internal error if the
  // dispatch hits a hook whose fiber has already been torn down).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    // Subscribe to the shared worker's onmessage. Each hook instance filters
    // by its own pendingKeys so it only reacts to its own posts. We don't
    // terminate the shared worker on unmount — other hook instances may
    // still need it, and re-spawning costs the heavy-bundle resend.
    const listener = (data: ScenarioForecastRunWorkerResponse): void => {
      if (!mountedRef.current) return;
      const { jobId, cacheKey, scenarioId, result, error, needsHeavy } = data;
      const pendingJob = pendingKeys.current.get(cacheKey);
      // Filter: this hook didn't post this job (or it was already superseded
      // by a newer job from this hook for the same key).
      if (pendingJob === undefined) return;
      if (pendingJob !== jobId) return;
      pendingKeys.current.delete(cacheKey);
      if (needsHeavy) {
        // Worker lost the heavy bundle for this version (worker respawned or
        // version drifted). Force resend on next post.
        sharedWorkerHeavyVersion = -1;
        persistByKey.current.delete(cacheKey);
        setRunVersion((v) => v + 1);
        return;
      }
      if (error || !result) {
        // eslint-disable-next-line no-console
        console.warn(`[scenarioRun] worker error key=${cacheKey}`, error);
        persistByKey.current.delete(cacheKey);
        return; // keep showing stale; an identical later request retries
      }
      projectionRunCache.set(cacheKey, result as unknown);
      rememberStale(scenarioId, result);
      const persist = persistByKey.current.get(cacheKey);
      if (persist) {
        persistByKey.current.delete(cacheKey);
        try { persist(cacheKey, result); } catch { /* ignore */ }
      }
      setRunVersion((v) => v + 1);
    };
    sharedMessageListeners.add(listener);
    return () => {
      mountedRef.current = false;
      sharedMessageListeners.delete(listener);
      pendingKeys.current.clear();
      lastResultByScenario.current.clear();
      persistByKey.current.clear();
    };
  }, [rememberStale]);

  const ensureWorker = useCallback((): Worker | null => getSharedWorker(), []);

  const runCached = useCallback(<T,>(
    cacheKey: string,
    scenarioId: string,
    makeArgs: () => BuildScenarioForecastRunArgs,
    persist?: (key: string, result: ScenarioForecastRun) => void,
    pipelineKey?: string,
  ): T => {
    const cached = projectionRunCache.get(cacheKey) as T | undefined;
    if (cached !== undefined) return cached;

    const computeSync = (): T => {
      const result = buildScenarioForecastRun(makeArgs());
      projectionRunCache.set(cacheKey, result as unknown);
      rememberStale(scenarioId, result);
      if (persist) { try { persist(cacheKey, result); } catch { /* ignore */ } }
      return result as unknown as T;
    };

    const worker = ensureWorker();
    // Per-scenario stale first; else the cross-scenario universal placeholder
    // (warmup-seeded BASE run / last good run). Only when there is genuinely
    // nothing to show AND no worker (jsdom/tests) do we pay the synchronous
    // 225k-movement pipeline — in production the warmup seeds the placeholder
    // so the first mount never freezes the main thread.
    const stale = lastResultByScenario.current.get(scenarioId) ?? universalPlaceholder ?? undefined;
    if (!worker || stale === undefined) {
      return computeSync();
    }
    // Post once per key (dedupe); show the previous run meanwhile.
    if (!pendingKeys.current.has(cacheKey)) {
      const jobId = ++sharedJobSeq;
      pendingKeys.current.set(cacheKey, jobId);
      if (persist) persistByKey.current.set(cacheKey, persist);
      try {
        const { heavy, light } = splitArgs(makeArgs());
        if (!sharedPrevHeavy || heavyChanged(sharedPrevHeavy, heavy)) {
          sharedHeavyVersion += 1;
          sharedPrevHeavy = heavy;
        }
        const version = sharedHeavyVersion;
        const sendHeavy = sharedWorkerHeavyVersion !== version;
        const req: ScenarioForecastRunWorkerRequest = {
          jobId,
          cacheKey,
          scenarioId,
          sourceVersion: version,
          // Default pipelineKey to the full cacheKey when caller doesn't
          // provide one — back-compat: behaves like no pipeline reuse.
          pipelineKey: pipelineKey ?? cacheKey,
          heavy: sendHeavy ? heavy : undefined,
          light,
        };
        worker.postMessage(req);
        // Optimistic: worker caches `heavy` on receipt (messages are FIFO, so
        // a later light-only post for the same version arrives after this).
        if (sendHeavy) sharedWorkerHeavyVersion = version;
      } catch (err) {
        pendingKeys.current.delete(cacheKey);
        persistByKey.current.delete(cacheKey);
        // eslint-disable-next-line no-console
        console.warn('[scenarioRun] postMessage failed, sync fallback', err);
        return computeSync();
      }
    }
    return stale as unknown as T;
  }, [ensureWorker, rememberStale]);

  return { runVersion, runCached };
}
