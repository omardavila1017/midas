import type {
  BuildScenarioForecastRunArgs,
  ScenarioForecastRun,
} from '../modules/financial-planning/services/scenarioForecastRun';

// Big, session-invariant inputs: they only change on a real data refresh, not
// on a cell edit / proposal tweak / granularity flip. Posted to the worker
// once per version and cached there, so per-run messages don't structured-
// clone ~100k movements on the main thread every time (that clone partially
// defeated the whole point of the offload).
export type HeavySourceBundle = Pick<
  BuildScenarioForecastRunArgs,
  | 'sourceMovements'
  | 'clients'
  | 'providers'
  | 'cxpRecords'
  | 'purchaseReceipts'
  | 'payrollCosts'
  | 'cobranzaPayments'
  | 'bajioStatements'
>;

// Everything that varies per run (small): scenario id/kind, adjustments,
// manual entries, overrides, custom rows, assumptions, taxStore, window,
// scalars. Cheap to clone every post.
export type LightRunArgs = Omit<BuildScenarioForecastRunArgs, keyof HeavySourceBundle>;

export interface ScenarioForecastRunWorkerRequest {
  jobId: number;
  /** Cache key the result should be written under by the main thread. */
  cacheKey: string;
  /** Scenario id this run belongs to (used for the stale-while-recompute map). */
  scenarioId: string;
  /** Version of the heavy bundle the `light` args expect. */
  sourceVersion: number;
  /** Present only when the heavy bundle changed (or the worker lacks it). */
  heavy?: HeavySourceBundle;
  light: LightRunArgs;
}

export interface ScenarioForecastRunWorkerResponse {
  jobId: number;
  cacheKey: string;
  scenarioId: string;
  result?: ScenarioForecastRun;
  error?: string;
  /**
   * Worker has no cached heavy bundle for `sourceVersion` (e.g. it was created
   * after the version bump). Main thread must resend this job WITH `heavy`.
   */
  needsHeavy?: boolean;
}
