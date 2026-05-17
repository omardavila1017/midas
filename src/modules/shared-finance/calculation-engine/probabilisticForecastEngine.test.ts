import { describe, expect, it } from 'vitest';
import type { FinancialMovement, ForecastRun } from '../types';
import { calculateBaseProjection } from './financialProjectionEngine';
import {
  buildProbabilisticForecast,
  buildProbabilisticForecastCacheKey,
} from './probabilisticForecastEngine';

describe('probabilisticForecastEngine', () => {
  it('falls back when history is insufficient and preserves ordered percentiles', () => {
    const run = projection([
      movement('in-1', 'INFLOW', '2026-05-12', 1_000_000),
      movement('out-1', 'OUTFLOW', '2026-05-13', 200_000),
    ]);
    const result = buildProbabilisticForecast({
      baseProjection: run,
      minimumCash: 100_000,
      simulations: 240,
      seed: 42,
      horizonDays: 30,
    });

    expect(result.diagnostics.modelKind).toBe('EMPIRICAL_FALLBACK');
    expect(result.buckets.length).toBe(30);
    for (const bucket of result.buckets) {
      expect(bucket.cash.p10).toBeLessThanOrEqual(bucket.cash.p50);
      expect(bucket.cash.p50).toBeLessThanOrEqual(bucket.cash.p90);
    }
    expect(result.summary.p90CreditRequired).toBeGreaterThanOrEqual(result.summary.expectedCreditRequired);
  });

  it('selects ARIMA diagnostics when enough real history exists', () => {
    const historical = Array.from({ length: 100 }, (_, index) =>
      movement(`bank-${index}`, index % 2 === 0 ? 'INFLOW' : 'OUTFLOW', addDays('2026-01-01', index), 50_000 + index * 250, {
        sourceSystem: 'BANK',
        status: 'REAL',
        actualDate: addDays('2026-01-01', index),
      }),
    );
    const run = projection([
      ...historical,
      movement('future-1', 'INFLOW', '2026-05-12', 500_000),
    ]);
    const result = buildProbabilisticForecast({
      baseProjection: run,
      minimumCash: 100_000,
      simulations: 220,
      seed: 7,
      horizonDays: 30,
    });

    expect(result.diagnostics.modelKind).toBe('ARIMA');
    expect(result.diagnostics.confidence).toBe('HIGH');
    expect(result.diagnostics.sampleSize).toBeGreaterThanOrEqual(90);
  });

  it('raises deficit probability when outflows are materially higher', () => {
    const lowRisk = projection([
      movement('future-in', 'INFLOW', '2026-05-12', 600_000),
      movement('future-out-low', 'OUTFLOW', '2026-05-13', 100_000),
    ]);
    const highRisk = projection([
      movement('future-in', 'INFLOW', '2026-05-12', 600_000),
      movement('future-out-high', 'OUTFLOW', '2026-05-13', 1_100_000),
    ]);
    const low = buildProbabilisticForecast({
      baseProjection: lowRisk,
      minimumCash: 100_000,
      simulations: 260,
      seed: 9,
      horizonDays: 30,
    });
    const high = buildProbabilisticForecast({
      baseProjection: highRisk,
      minimumCash: 100_000,
      simulations: 260,
      seed: 9,
      horizonDays: 30,
    });

    expect(high.summary.probabilityBelowMinimumCash).toBeGreaterThan(low.summary.probabilityBelowMinimumCash);
    expect(high.summary.expectedCreditRequired).toBeGreaterThan(low.summary.expectedCreditRequired);
  });

  it('changes cache identity when the base run changes', () => {
    const base = projection([movement('in-1', 'INFLOW', '2026-05-12', 100_000)]);
    const changed = {
      ...base,
      id: `${base.id}-changed`,
      summary: { ...base.summary, totalInflows: base.summary.totalInflows + 1 },
    } satisfies ForecastRun;

    const baseKey = buildProbabilisticForecastCacheKey({
      baseProjection: base,
      minimumCash: 100_000,
    });
    const changedKey = buildProbabilisticForecastCacheKey({
      baseProjection: changed,
      minimumCash: 100_000,
    });

    expect(changedKey).not.toBe(baseKey);
  });
});

function projection(movements: FinancialMovement[]): ForecastRun {
  return calculateBaseProjection(movements, {
    startDate: '2026-05-12',
    endDate: '2026-06-10',
    initialCash: 250_000,
    minimumCash: 100_000,
    granularity: 'daily',
    scenarioId: 'base',
    name: 'Base',
  });
}

function movement(
  id: string,
  type: FinancialMovement['type'],
  date: string,
  amount: number,
  overrides: Partial<FinancialMovement> = {},
): FinancialMovement {
  return {
    id,
    sourceSystem: 'FORECAST',
    type,
    category: type === 'INFLOW' ? 'AR_COLLECTION' : 'AP_PAYMENT',
    concept: id,
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate: date,
    confidenceScore: 70,
    confidenceBand: 'MEDIUM',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    ...overrides,
  };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
