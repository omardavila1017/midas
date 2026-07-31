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
  ScenarioRunPlaceholderMode,
  ScenarioRunPriority,
  ScenarioForecastRunWorkerRequest,
  ScenarioForecastRunWorkerResponse,
} from '../../../workers/scenarioForecastRunWorkerTypes';

let universalPlaceholder: ScenarioForecastRun | null = null;

let sharedWorker: Worker | null = null;
let sharedWorkerHeavyVersion = -1;
let sharedHeavyVersion = 0;
let sharedPrevHeavy: HeavySourceBundle | null = null;
let sharedJobSeq = 0;
let activeJob: SharedRunJob | null = null;
const runQueue: SharedRunJob[] = [];
const pendingJobsByKey = new Map<string, SharedRunJob>();

interface SharedRunJob {
  jobId: number;
  cacheKey: string;
  scenarioId: string;
  priority: ScenarioRunPriority;
  req: ScenarioForecastRunWorkerRequest;
  heavy: HeavySourceBundle;
  resolve: (result: ScenarioForecastRun) => void;
  reject: (error: Error) => void;
}

export interface ScenarioRunOptions {
  pipelineKey?: string;
  priority?: ScenarioRunPriority;
  placeholderMode?: ScenarioRunPlaceholderMode;
}

export interface ScenarioRunController {
  runVersion: number;
  runCached: <T>(
    cacheKey: string,
    scenarioId: string,
    makeArgs: () => BuildScenarioForecastRunArgs,
    persist?: (key: string, result: ScenarioForecastRun) => void,
    options?: ScenarioRunOptions,
  ) => T;
}

const HEAVY_KEYS = [
  'sourceMovements',
  'clients',
  'providers',
  'cxpRecords',
  'cxpPaymentCoverage',
  'auxiliarReconciliation',
  'purchaseReceipts',
  'payrollCosts',
  'cobranzaPayments',
  'bajioStatements',
] as const;

function splitArgs(a: BuildScenarioForecastRunArgs): { heavy: HeavySourceBundle; light: LightRunArgs } {
  const {
    sourceMovements, clients, providers, cxpRecords,
    cxpPaymentCoverage, auxiliarReconciliation,
    purchaseReceipts, payrollCosts, cobranzaPayments, bajioStatements,
    ...light
  } = a;
  return {
    heavy: {
      sourceMovements,
      clients,
      providers,
      cxpRecords,
      cxpPaymentCoverage,
      auxiliarReconciliation,
      purchaseReceipts,
      payrollCosts,
      cobranzaPayments,
      bajioStatements,
    },
    light: light as LightRunArgs,
  };
}

function heavyChanged(p: HeavySourceBundle, n: HeavySourceBundle): boolean {
  for (const k of HEAVY_KEYS) {
    if (p[k] !== n[k]) return true;
  }
  return false;
}

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
      handleWorkerMessage(event.data);
    };
    worker.onerror = (event) => {
      // eslint-disable-next-line no-console
      console.warn('[scenarioRun] worker exception', event.message);
      sharedWorkerHeavyVersion = -1;
      if (activeJob) {
        const job = activeJob;
        activeJob = null;
        pendingJobsByKey.delete(job.cacheKey);
        job.reject(new Error(event.message || 'scenario worker failed'));
        postNextRunJob();
      }
    };
    sharedWorker = worker;
    return worker;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[scenarioRun] worker spawn failed', err);
    return null;
  }
}

function priorityWeight(priority: ScenarioRunPriority): number {
  return priority === 'foreground' ? 0 : 1;
}

function mark(name: string): void {
  try { performance.mark?.(name); } catch { /* noop */ }
}

function measure(name: string, start: string, end: string): void {
  try { performance.measure?.(name, start, end); } catch { /* noop */ }
}

function postNextRunJob(): void {
  if (activeJob || runQueue.length === 0) return;
  const worker = getSharedWorker();
  if (!worker) {
    while (runQueue.length > 0) {
      const job = runQueue.shift()!;
      pendingJobsByKey.delete(job.cacheKey);
      job.reject(new Error('scenario worker unavailable'));
    }
    return;
  }

  let bestIndex = 0;
  for (let i = 1; i < runQueue.length; i++) {
    if (priorityWeight(runQueue[i].priority) < priorityWeight(runQueue[bestIndex].priority)) {
      bestIndex = i;
    }
  }
  const [job] = runQueue.splice(bestIndex, 1);
  activeJob = job;
  mark(`scenarioRun:${job.jobId}:post`);
  worker.postMessage(job.req);
}

function handleWorkerMessage(data: ScenarioForecastRunWorkerResponse): void {
  const job = activeJob;
  if (!job || job.jobId !== data.jobId || job.cacheKey !== data.cacheKey) return;

  if (data.needsHeavy) {
    sharedWorkerHeavyVersion = -1;
    job.req.heavy = job.heavy;
    sharedWorkerHeavyVersion = job.req.sourceVersion;
    activeJob = null;
    runQueue.unshift(job);
    postNextRunJob();
    return;
  }

  activeJob = null;
  pendingJobsByKey.delete(job.cacheKey);
  mark(`scenarioRun:${job.jobId}:result`);
  measure(`scenarioRun:${job.scenarioId}`, `scenarioRun:${job.jobId}:post`, `scenarioRun:${job.jobId}:result`);

  if (data.error || !data.result) {
    job.reject(new Error(data.error || 'scenario worker returned no result'));
  } else {
    job.resolve(data.result);
  }
  postNextRunJob();
}

/** Seed the universal placeholder from a worker-built or persisted run. */
export function setScenarioRunPlaceholder(run: ScenarioForecastRun): void {
  universalPlaceholder = run;
}

/**
 * Libera la memoria del worker de escenarios bajo presión de memoria. El worker
 * cachea el heavy bundle (sourceMovements ~100k + catálogos) y hasta 4 pipelines
 * — terminarlo suelta TODO eso de la heap del worker. En el próximo
 * `requestScenarioRun` se recrea solo (lazy) y reenvía el heavy (la versión
 * quedó en -1). Los jobs en vuelo se rechazan con un Error benigno: todos los
 * callers ya hacen `.catch` (warmup best-effort + el path interno de runCached),
 * así que no se generan unhandled rejections.
 */
export function resetScenarioRunWorker(): void {
  try {
    if (sharedWorker) {
      sharedWorker.terminate();
      sharedWorker = null;
    }
  } catch {
    /* ignore */
  }
  sharedWorkerHeavyVersion = -1;
  sharedHeavyVersion = 0;
  sharedPrevHeavy = null;
  const drain = (job: SharedRunJob | null) => {
    if (!job) return;
    pendingJobsByKey.delete(job.cacheKey);
    try { job.reject(new Error('scenario worker reset under memory pressure')); } catch { /* ignore */ }
  };
  drain(activeJob);
  activeJob = null;
  while (runQueue.length > 0) drain(runQueue.shift()!);
  pendingJobsByKey.clear();
}

export function requestScenarioRun(
  cacheKey: string,
  scenarioId: string,
  args: BuildScenarioForecastRunArgs,
  options: ScenarioRunOptions = {},
): Promise<ScenarioForecastRun> {
  const cached = projectionRunCache.get(cacheKey) as ScenarioForecastRun | undefined;
  if (cached) return Promise.resolve(cached);

  const existing = pendingJobsByKey.get(cacheKey);
  if (existing) {
    if (options.priority === 'foreground' && existing.priority !== 'foreground') {
      existing.priority = 'foreground';
    }
    return new Promise((resolve, reject) => {
      const prevResolve = existing.resolve;
      const prevReject = existing.reject;
      existing.resolve = (result) => { prevResolve(result); resolve(result); };
      existing.reject = (error) => { prevReject(error); reject(error); };
    });
  }

  const worker = getSharedWorker();
  if (!worker) {
    return Promise.resolve(buildScenarioForecastRun(args));
  }

  const { heavy, light } = splitArgs(args);
  if (!sharedPrevHeavy || heavyChanged(sharedPrevHeavy, heavy)) {
    sharedHeavyVersion += 1;
    sharedPrevHeavy = heavy;
  }
  const version = sharedHeavyVersion;
  const sendHeavy = sharedWorkerHeavyVersion !== version;
  const jobId = ++sharedJobSeq;
  const req: ScenarioForecastRunWorkerRequest = {
    jobId,
    cacheKey,
    scenarioId,
    sourceVersion: version,
    pipelineKey: options.pipelineKey ?? cacheKey,
    heavy: sendHeavy ? heavy : undefined,
    light,
  };
  if (sendHeavy) sharedWorkerHeavyVersion = version;

  return new Promise<ScenarioForecastRun>((resolve, reject) => {
    const job: SharedRunJob = {
      jobId,
      cacheKey,
      scenarioId,
      priority: options.priority ?? 'foreground',
      req,
      heavy,
      resolve,
      reject,
    };
    pendingJobsByKey.set(cacheKey, job);
    runQueue.push(job);
    postNextRunJob();
  });
}

export function useScenarioRunWorker(): ScenarioRunController {
  const [runVersion, setRunVersion] = useState(0);
  const pendingKeys = useRef<Set<string>>(new Set());
  const lastResultByScenario = useRef<Map<string, ScenarioForecastRun>>(new Map());
  const persistByKey = useRef<Map<string, (k: string, r: ScenarioForecastRun) => void>>(new Map());

  const rememberStale = useCallback((scenarioId: string, result: ScenarioForecastRun) => {
    universalPlaceholder = result;
    const m = lastResultByScenario.current;
    m.delete(scenarioId);
    m.set(scenarioId, result);
    // Cap alineado con MAX_ENTRIES de `projectionRunCache` (4). Con 2, el trío
    // base + activo + comparación no cabía y el escenario desalojado perdía su
    // stale propio → caía al `universalPlaceholder` de otro escenario y el
    // tablero se ocultaba. Los runs retenidos son los MISMOS objetos que el LRU
    // ya mantiene vivos, así que el costo de heap adicional es marginal.
    while (m.size > 4) {
      const oldest = m.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
  }, []);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingKeys.current.clear();
      lastResultByScenario.current.clear();
      persistByKey.current.clear();
    };
  }, []);

  const runCached = useCallback(<T,>(
    cacheKey: string,
    scenarioId: string,
    makeArgs: () => BuildScenarioForecastRunArgs,
    persist?: (key: string, result: ScenarioForecastRun) => void,
    options: ScenarioRunOptions = {},
  ): T => {
    const cached = projectionRunCache.get(cacheKey) as T | undefined;
    if (cached !== undefined) {
      // Registrar TAMBIÉN en el camino rápido. Antes sólo `computeSync` y el
      // `.then()` del worker alimentaban `lastResultByScenario`, así que un
      // escenario servido siempre desde cache (el caso normal: el warmup
      // pre-siembra la cache con `primeProjectionRunCache`) NUNCA dejaba un
      // stale propio. Cuando la llave cambiaba —una ola de datos mueve la
      // huella de los inputs— el fallback caía al `universalPlaceholder`, que
      // puede ser el run de OTRO escenario; el tablero lo detecta como
      // `activeRunIsPlaceholder` y OCULTA todo el cuerpo detrás de "Cargando
      // proyección de …". Con el stale propio registrado, el escenario activo
      // conserva sus cifras mientras el run nuevo se computa.
      rememberStale(scenarioId, cached as unknown as ScenarioForecastRun);
      return cached;
    }

    const computeSync = (): T => {
      const result = buildScenarioForecastRun(makeArgs());
      projectionRunCache.set(cacheKey, result as unknown);
      rememberStale(scenarioId, result);
      if (persist) { try { persist(cacheKey, result); } catch { /* ignore */ } }
      return result as unknown as T;
    };

    const sameScenarioStale = lastResultByScenario.current.get(scenarioId);
    const placeholderMode = options.placeholderMode ?? 'any';
    const stale = placeholderMode === 'none'
      ? undefined
      : sameScenarioStale ?? (placeholderMode === 'any' ? universalPlaceholder ?? undefined : undefined);
    if (typeof Worker === 'undefined' || stale === undefined) {
      return computeSync();
    }

    if (!pendingKeys.current.has(cacheKey)) {
      pendingKeys.current.add(cacheKey);
      if (persist) persistByKey.current.set(cacheKey, persist);
      try {
        requestScenarioRun(cacheKey, scenarioId, makeArgs(), options)
          .then((result) => {
            if (!mountedRef.current) return;
            pendingKeys.current.delete(cacheKey);
            projectionRunCache.set(cacheKey, result as unknown);
            rememberStale(scenarioId, result);
            const persistResult = persistByKey.current.get(cacheKey);
            if (persistResult) {
              persistByKey.current.delete(cacheKey);
              try { persistResult(cacheKey, result); } catch { /* ignore */ }
            }
            setRunVersion((v) => v + 1);
          })
          .catch((err) => {
            pendingKeys.current.delete(cacheKey);
            persistByKey.current.delete(cacheKey);
            // eslint-disable-next-line no-console
            console.warn(`[scenarioRun] worker error key=${cacheKey}`, err);
          });
      } catch (err) {
        pendingKeys.current.delete(cacheKey);
        persistByKey.current.delete(cacheKey);
        // eslint-disable-next-line no-console
        console.warn('[scenarioRun] postMessage failed, sync fallback', err);
        return computeSync();
      }
    }
    return stale as unknown as T;
  }, [rememberStale]);

  return { runVersion, runCached };
}
