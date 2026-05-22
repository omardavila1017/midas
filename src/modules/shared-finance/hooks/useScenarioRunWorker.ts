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
    while (m.size > 2) {
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
    if (cached !== undefined) return cached;

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
