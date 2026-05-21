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
  const workerRef = useRef<Worker | null>(null);
  const jobSeq = useRef(0);
  /** cacheKey -> latest jobId posted (dedupe + stale-result guard). */
  const pendingKeys = useRef<Map<string, number>>(new Map());
  /** scenarioId -> last good run (stale-while-recompute source). */
  const lastResultByScenario = useRef<Map<string, ScenarioForecastRun>>(new Map());
  /** cacheKey -> persist callback to invoke when the worker result lands. */
  const persistByKey = useRef<Map<string, (k: string, r: ScenarioForecastRun) => void>>(new Map());
  /** Heavy-bundle version (bumps when the source/catalogs change identity). */
  const heavyVersion = useRef(0);
  const prevHeavy = useRef<HeavySourceBundle | null>(null);
  /** Heavy version the live worker is known to hold (-1 = none / fresh worker). */
  const workerHeavyVersion = useRef(-1);

  // Bound the stale-while-recompute map: each entry is a fat ScenarioForecastRun
  // (full movements). Unbounded by scenario count it accumulated retained
  // memory across a session (a contributor to the real-data "idle OOM"). Keep
  // only the most-recently-used few (LRU); a dropped scenario just computes
  // once synchronously next time instead of showing stale — acceptable.
  const STALE_CAP = 4;
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

  useEffect(() => {
    return () => {
      // Terminating the worker + clearing pendingKeys already prevents any
      // post-unmount setState (no message can land, and the jobId guard
      // rejects stragglers), so no mounted flag is needed.
      workerRef.current?.terminate();
      workerRef.current = null;
      pendingKeys.current.clear();
      lastResultByScenario.current.clear();
      persistByKey.current.clear();
      workerHeavyVersion.current = -1;
    };
  }, []);

  const ensureWorker = useCallback((): Worker | null => {
    if (typeof Worker === 'undefined') return null;
    if (workerRef.current) return workerRef.current;
    try {
      const worker = new Worker(
        new URL('../../../workers/scenarioForecastRun.worker.ts', import.meta.url),
        { type: 'module' },
      );
      // Fresh worker holds no heavy bundle — the next post must include it.
      workerHeavyVersion.current = -1;
      worker.onmessage = (event: MessageEvent<ScenarioForecastRunWorkerResponse>) => {
        const { jobId, cacheKey, scenarioId, result, error, needsHeavy } = event.data;
        // Stale guard refinado: un resultado "obsoleto" porque el cacheKey ya
        // cambió (boot tardío que sigue empujando movements → sharedInputsKey
        // rota) sigue siendo válido como stale per-scenario — lo que el
        // dashboard usa para salir del placeholder universal (BASE warmup) y
        // mostrar al menos una proyección del scenario activo. Solo
        // descartamos si hay un job MÁS NUEVO para EL MISMO cacheKey.
        const pendingJob = pendingKeys.current.get(cacheKey);
        const supersededByNewerJobForSameKey = pendingJob !== undefined && pendingJob !== jobId;
        if (supersededByNewerJobForSameKey) return;
        const isCurrentJobForKey = pendingJob === jobId;
        if (isCurrentJobForKey) pendingKeys.current.delete(cacheKey);
        if (needsHeavy) {
          // Worker lacks the heavy bundle for this version. Force the next
          // post to include it and let the re-render re-issue the job.
          workerHeavyVersion.current = -1;
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
        if (isCurrentJobForKey) {
          const persist = persistByKey.current.get(cacheKey);
          if (persist) {
            persistByKey.current.delete(cacheKey);
            try { persist(cacheKey, result); } catch { /* ignore */ }
          }
        }
        setRunVersion((v) => v + 1);
      };
      worker.onerror = (event) => {
        // eslint-disable-next-line no-console
        console.warn('[scenarioRun] worker exception', event.message);
        // Future requests fall back to sync compute / fresh heavy.
        pendingKeys.current.clear();
        persistByKey.current.clear();
        workerHeavyVersion.current = -1;
      };
      workerRef.current = worker;
      return worker;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[scenarioRun] worker spawn failed', err);
      return null;
    }
  }, [rememberStale]);

  const runCached = useCallback(<T,>(
    cacheKey: string,
    scenarioId: string,
    makeArgs: () => BuildScenarioForecastRunArgs,
    persist?: (key: string, result: ScenarioForecastRun) => void,
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
      const jobId = ++jobSeq.current;
      pendingKeys.current.set(cacheKey, jobId);
      if (persist) persistByKey.current.set(cacheKey, persist);
      try {
        const { heavy, light } = splitArgs(makeArgs());
        if (!prevHeavy.current || heavyChanged(prevHeavy.current, heavy)) {
          heavyVersion.current += 1;
          prevHeavy.current = heavy;
        }
        const version = heavyVersion.current;
        const sendHeavy = workerHeavyVersion.current !== version;
        const req: ScenarioForecastRunWorkerRequest = {
          jobId,
          cacheKey,
          scenarioId,
          sourceVersion: version,
          heavy: sendHeavy ? heavy : undefined,
          light,
        };
        worker.postMessage(req);
        // Optimistic: worker caches `heavy` on receipt (messages are FIFO, so
        // a later light-only post for the same version arrives after this).
        if (sendHeavy) workerHeavyVersion.current = version;
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
