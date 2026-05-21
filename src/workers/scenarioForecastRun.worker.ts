import {
  aggregateScenarioForecastRun,
  buildScenarioPipeline,
  type BuildScenarioForecastRunArgs,
  type ScenarioPipelineResult,
} from '../modules/financial-planning/services/scenarioForecastRun';
import type {
  HeavySourceBundle,
  ScenarioForecastRunWorkerRequest,
  ScenarioForecastRunWorkerResponse,
} from './scenarioForecastRunWorkerTypes';

// Offloads the per-scenario treasury pipeline (applyAdjustments + taxView +
// scheduleSupplierPaymentsByScore + calculateBaseProjection + cell overrides)
// off the main thread. Called on cache-miss (cell edit, granularity flip,
// proposal change); the main thread keeps showing the previous run until this
// posts back.
//
// The heavy session-invariant inputs (sourceMovements ~100k, catalogs, etc.)
// are sent once per version and cached here, so subsequent runs only ship the
// small per-run deltas — no giant structured-clone on the main thread per post.
let cachedHeavy: HeavySourceBundle | null = null;
let cachedHeavyVersion = -1;

// Pipeline cache: keyed by `pipelineKey` (everything that affects the gran-
// independent pipeline, sent from main thread). Two requests differing only
// in granularity share the same pipeline → cache hit → skip the heavy
// pipeline work (~1300ms savings on grain flip).
let cachedPipeline: { key: string; result: ScenarioPipelineResult } | null = null;

self.onmessage = (event: MessageEvent<ScenarioForecastRunWorkerRequest>) => {
  const { jobId, cacheKey, scenarioId, sourceVersion, pipelineKey, heavy, light } = event.data;

  if (heavy) {
    cachedHeavy = heavy;
    cachedHeavyVersion = sourceVersion;
    // Heavy bundle changed → pipeline cache stale (movements/clients/etc differ).
    cachedPipeline = null;
  }

  if (!cachedHeavy || cachedHeavyVersion !== sourceVersion) {
    // We don't have the heavy bundle for this version — ask the main thread
    // to resend with it. (Happens only if this worker was created after a
    // heavy-version bump; the common path never hits this.)
    const response: ScenarioForecastRunWorkerResponse = {
      jobId,
      cacheKey,
      scenarioId,
      needsHeavy: true,
    };
    self.postMessage(response);
    return;
  }

  const t0 = performance.now();
  try {
    const args = { ...cachedHeavy, ...light } as BuildScenarioForecastRunArgs;
    let pipeline: ScenarioPipelineResult;
    let pipelineHit = false;
    if (cachedPipeline && cachedPipeline.key === pipelineKey) {
      pipeline = cachedPipeline.result;
      pipelineHit = true;
    } else {
      pipeline = buildScenarioPipeline(args);
      cachedPipeline = { key: pipelineKey, result: pipeline };
    }
    const result = aggregateScenarioForecastRun(pipeline, args);
    const elapsed = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.info(`[scenarioRun.worker] done jobId=${jobId} scenario=${scenarioId} ${elapsed.toFixed(0)}ms · pipelineHit=${pipelineHit} · movements=${result.movements.length}`);
    const response: ScenarioForecastRunWorkerResponse = { jobId, cacheKey, scenarioId, result };
    self.postMessage(response);
  } catch (error) {
    const elapsed = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.warn(`[scenarioRun.worker] FAILED jobId=${jobId} scenario=${scenarioId} ${elapsed.toFixed(0)}ms`, error);
    const response: ScenarioForecastRunWorkerResponse = {
      jobId,
      cacheKey,
      scenarioId,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
