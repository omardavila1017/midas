import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildProbabilisticForecast,
  buildProbabilisticForecastCacheKey,
} from '../../shared-finance/calculation-engine/probabilisticForecastEngine';
import type {
  ForecastRun,
  ProbabilisticForecastRequest,
  ProbabilisticForecastResponse,
  ProbabilisticForecastRun,
} from '../../shared-finance/types';

const FORECAST_CACHE = new Map<string, ProbabilisticForecastRun>();
const FORECAST_CACHE_LIMIT = 18;
const DEFAULT_SIMULATIONS = 1200;
const DEFAULT_HORIZON_DAYS = 365;

export interface ProbabilisticForecastState {
  run: ProbabilisticForecastRun | null;
  loading: boolean;
  error: string | null;
}

export function useProbabilisticForecast(
  baseProjection: ForecastRun | null,
  minimumCash: number,
): ProbabilisticForecastState {
  const workerRef = useRef<Worker | null>(null);
  const jobRef = useRef(0);
  const request = useMemo<ProbabilisticForecastRequest | null>(() => {
    if (!baseProjection) return null;
    return {
      baseProjection,
      minimumCash,
      simulations: DEFAULT_SIMULATIONS,
      horizonDays: DEFAULT_HORIZON_DAYS,
    };
  }, [baseProjection, minimumCash]);
  const cacheKey = useMemo(
    () => request ? buildProbabilisticForecastCacheKey(request) : '',
    [request],
  );
  const cached = cacheKey ? FORECAST_CACHE.get(cacheKey) ?? null : null;
  const [state, setState] = useState<ProbabilisticForecastState>({
    run: cached,
    loading: Boolean(request && !cached),
    error: null,
  });

  useEffect(() => {
    if (!request) {
      setState({ run: null, loading: false, error: null });
      return;
    }
    const warm = FORECAST_CACHE.get(cacheKey);
    if (warm) {
      setState({ run: warm, loading: false, error: null });
      return;
    }

    let cancelled = false;
    const jobId = ++jobRef.current;
    const requestWithJob = { ...request, jobId };
    setState((current) => ({
      run: current.run,
      loading: true,
      error: null,
    }));

    const storeAndPublish = (run: ProbabilisticForecastRun) => {
      if (cancelled || jobRef.current !== jobId) return;
      remember(cacheKey, run);
      setState({ run, loading: false, error: null });
    };
    const publishError = (message: string) => {
      if (cancelled || jobRef.current !== jobId) return;
      setState((current) => ({ ...current, loading: false, error: message }));
    };
    const runFallback = () => {
      try {
        storeAndPublish(buildProbabilisticForecast(requestWithJob));
      } catch (error) {
        publishError(error instanceof Error ? error.message : String(error));
      }
    };

    if (typeof Worker === 'undefined') {
      runFallback();
      return () => { cancelled = true; };
    }

    try {
      if (!workerRef.current) {
        workerRef.current = new Worker(
          new URL('../../../workers/probabilisticForecast.worker.ts', import.meta.url),
          { type: 'module' },
        );
      }
      const worker = workerRef.current;
      worker.onmessage = (event: MessageEvent<ProbabilisticForecastResponse>) => {
        if (cancelled || event.data.jobId !== jobId) return;
        if (event.data.result) storeAndPublish(event.data.result);
        else if (event.data.error) publishError(event.data.error);
        else runFallback();
      };
      worker.onerror = () => runFallback();
      worker.postMessage(requestWithJob);
    } catch {
      runFallback();
    }

    return () => {
      cancelled = true;
    };
  }, [cacheKey, request]);

  useEffect(() => () => {
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);

  return state;
}

export function __clearProbabilisticForecastCache(): void {
  FORECAST_CACHE.clear();
}

function remember(key: string, run: ProbabilisticForecastRun): void {
  if (FORECAST_CACHE.has(key)) FORECAST_CACHE.delete(key);
  FORECAST_CACHE.set(key, run);
  if (FORECAST_CACHE.size > FORECAST_CACHE_LIMIT) {
    const oldest = FORECAST_CACHE.keys().next().value as string | undefined;
    if (oldest) FORECAST_CACHE.delete(oldest);
  }
}
