/**
 * El hook orquesta 3 capas de cache (memoria → IDB persistente → cómputo).
 * El motor Monte Carlo se mockea (correr 1200 simulaciones reales en jsdom no
 * prueba nada del servicio); lo que se prueba aquí es la orquestación real:
 * fallback síncrono sin Worker (jsdom), warm-hit de memoria, hit persistente
 * que evita recomputar, persistencia tras cómputo, y el path de error.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ForecastRun,
  ProbabilisticForecastRequest,
  ProbabilisticForecastRun,
} from '../../shared-finance/types';
import {
  __clearFinancialProjectionPersistentCacheForTests,
  loadProbabilisticForecastFromPersistentCache,
  saveProbabilisticForecastToPersistentCache,
} from './financialProjectionPersistentCache';
import { __clearProbabilisticForecastCache, useProbabilisticForecast } from './probabilisticForecastService';

const { buildMock } = vi.hoisted(() => ({ buildMock: vi.fn() }));

vi.mock('../../shared-finance/calculation-engine/probabilisticForecastEngine', () => ({
  buildProbabilisticForecast: (request: ProbabilisticForecastRequest) => buildMock(request),
  buildProbabilisticForecastCacheKey: (request: ProbabilisticForecastRequest) =>
    `prob:${request.baseProjection.id}:${request.minimumCash}`,
}));

function forecastRun(id: string): ForecastRun {
  return {
    id,
    name: 'Base',
    scenarioId: 'base',
    status: 'BASE',
    granularity: 'monthly',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    generatedAt: '2026-01-01T00:00:00.000Z',
    movements: [],
    buckets: [],
    alerts: [],
    summary: {
      currentCash: 0,
      projectedCash7: 0,
      projectedCash30: 0,
      projectedCash90: 0,
      minimumCashRequired: 0,
      deficitDays: 0,
      averageConfidence: 0,
      totalInflows: 0,
      totalOutflows: 0,
      finalCash: 0,
      minCash: 0,
      creditRequired: 0,
    },
  };
}

function probabilisticRun(id: string): ProbabilisticForecastRun {
  return {
    id: `prob-run-${id}`,
    baseForecastId: id,
    scenarioId: 'base',
    granularity: 'monthly',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    generatedAt: '2026-01-01T00:00:00.000Z',
    simulations: 1200,
    buckets: [],
    summary: {
      probabilityOfDeficit: 0.1,
      probabilityBelowMinimumCash: 0.2,
      expectedCreditRequired: 0,
      p90CreditRequired: 0,
      confidence: 'HIGH',
    },
    diagnostics: {
      modelKind: 'EMPIRICAL_FALLBACK',
      confidence: 'HIGH',
      sampleSize: 10,
      inflowVolatility: 0.1,
      outflowVolatility: 0.1,
      netResidualStd: 0,
      autocorrelation: 0,
    },
  };
}

describe('useProbabilisticForecast', () => {
  beforeEach(() => {
    localStorage.clear();
    __clearProbabilisticForecastCache();
    __clearFinancialProjectionPersistentCacheForTests();
    buildMock.mockReset();
  });

  it('sin proyección base regresa estado vacío y no computa nada', () => {
    const { result } = renderHook(() => useProbabilisticForecast(null, 1_000));
    expect(result.current).toEqual({ run: null, loading: false, error: null });
    expect(buildMock).not.toHaveBeenCalled();
  });

  it('sin Worker (jsdom) computa por fallback síncrono y publica el run', async () => {
    const projection = forecastRun('proj-1');
    const run = probabilisticRun('proj-1');
    buildMock.mockReturnValue(run);

    const { result } = renderHook(() => useProbabilisticForecast(projection, 5_000));
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.run).toBe(run));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(buildMock).toHaveBeenCalledTimes(1);
    const request = buildMock.mock.calls[0][0] as ProbabilisticForecastRequest;
    expect(request.baseProjection).toBe(projection);
    expect(request.minimumCash).toBe(5_000);
    expect(request.simulations).toBe(1200);
    expect(request.horizonDays).toBe(365);
  });

  it('persiste el run computado para el próximo boot', async () => {
    const projection = forecastRun('proj-persist');
    const run = probabilisticRun('proj-persist');
    buildMock.mockReturnValue(run);

    const { result } = renderHook(() => useProbabilisticForecast(projection, 0));
    await waitFor(() => expect(result.current.run).toBe(run));

    await expect(
      loadProbabilisticForecastFromPersistentCache('prob:proj-persist:0'),
    ).resolves.toEqual(run);
  });

  it('warm-hit del cache en memoria: mismo cacheKey no recomputa', async () => {
    const projection = forecastRun('proj-warm');
    const run = probabilisticRun('proj-warm');
    buildMock.mockReturnValue(run);

    const first = renderHook(() => useProbabilisticForecast(projection, 0));
    await waitFor(() => expect(first.result.current.run).toBe(run));
    first.unmount();

    const second = renderHook(() => useProbabilisticForecast(projection, 0));
    // Warm: el estado inicial ya trae el run sin pasar por loading.
    expect(second.result.current.run).toBe(run);
    expect(second.result.current.loading).toBe(false);
    await waitFor(() => expect(second.result.current.run).toBe(run));
    expect(buildMock).toHaveBeenCalledTimes(1);
  });

  it('hit del cache persistente publica sin recomputar ("carga una vez y se guarda")', async () => {
    const projection = forecastRun('proj-idb');
    const persisted = probabilisticRun('proj-idb');
    // Simula un boot previo que ya guardó el forecast:
    saveProbabilisticForecastToPersistentCache('prob:proj-idb:0', persisted);
    __clearProbabilisticForecastCache(); // memoria fría, como en un boot nuevo

    const { result } = renderHook(() => useProbabilisticForecast(projection, 0));
    await waitFor(() => expect(result.current.run).toEqual(persisted));
    expect(result.current.loading).toBe(false);
    expect(buildMock).not.toHaveBeenCalled();
  });

  it('cambiar minimumCash cambia la cacheKey y dispara un cómputo nuevo', async () => {
    const projection = forecastRun('proj-min');
    buildMock.mockImplementation((request: ProbabilisticForecastRequest) =>
      probabilisticRun(`${request.baseProjection.id}:${request.minimumCash}`));

    const { result, rerender } = renderHook(
      ({ min }: { min: number }) => useProbabilisticForecast(projection, min),
      { initialProps: { min: 0 } },
    );
    await waitFor(() => expect(result.current.run?.id).toBe('prob-run-proj-min:0'));

    rerender({ min: 9_999 });
    await waitFor(() => expect(result.current.run?.id).toBe('prob-run-proj-min:9999'));
    expect(buildMock).toHaveBeenCalledTimes(2);
  });

  it('un motor que lanza publica el error sin romper el hook', async () => {
    const projection = forecastRun('proj-err');
    buildMock.mockImplementation(() => {
      throw new Error('serie histórica insuficiente');
    });

    const { result } = renderHook(() => useProbabilisticForecast(projection, 0));
    await waitFor(() => expect(result.current.error).toBe('serie histórica insuficiente'));
    expect(result.current.loading).toBe(false);
    expect(result.current.run).toBeNull();
  });
});
