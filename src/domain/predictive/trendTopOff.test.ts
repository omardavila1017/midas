import { describe, expect, it } from 'vitest';
import { buildTrendTopOffMovements } from './trendTopOff';
import type { PredictionPoint } from './types';
import type { FinancialMovement, FinancialMovementType } from '../../modules/shared-finance/types';

const ASOF = '2026-06-02';
const START = '2026-01-01';
const END = '2026-12-31';

function point(ym: string, expected: number, isHistorical = false): PredictionPoint {
  return {
    date: `${ym}-01`,
    bucket: 'monthly',
    expected,
    stdDev: 0,
    ci80Low: expected,
    ci80High: expected,
    ci95Low: expected,
    ci95High: expected,
    isHistorical,
    isPartial: false,
  };
}

function movement(type: FinancialMovementType, date: string, amount: number): FinancialMovement {
  return {
    id: `existing:${type}:${date}:${amount}`,
    sourceSystem: 'JDE',
    type,
    category: type === 'INFLOW' ? 'AR_COLLECTION' : 'AP_PAYMENT',
    concept: 'existing',
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate: date,
    confidenceScore: 100,
    confidenceBand: 'CONFIRMED',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: `${ASOF}T00:00:00.000Z`,
    updatedAt: `${ASOF}T00:00:00.000Z`,
  };
}

const baseArgs = {
  scenarioId: 'approved',
  startDate: START,
  endDate: END,
  asOfDate: ASOF,
};

function sumByDirection(movements: FinancialMovement[], type: FinancialMovementType): number {
  return movements.filter((m) => m.type === type).reduce((s, m) => s + m.projectedAmount, 0);
}

describe('buildTrendTopOffMovements', () => {
  it('emits top-off = max(0, predicho - comprometido) and conserves the monthly gap', () => {
    const result = buildTrendTopOffMovements({
      ...baseArgs,
      incomeMonthly: [point('2026-08', 100_000)],
      expenseMonthly: [],
      existingMovements: [movement('INFLOW', '2026-08-15', 30_000)],
    });
    const inflows = result.filter((m) => m.type === 'INFLOW');
    expect(inflows.length).toBeGreaterThan(0);
    // gap = 100k - 30k = 70k, distributed across anchors but conserved in total
    expect(sumByDirection(result, 'INFLOW')).toBeCloseTo(70_000, 5);
    expect(inflows.every((m) => m.id.startsWith('forecast:trend:income:'))).toBe(true);
    expect(inflows.every((m) => m.status === 'PROJECTED_BASE')).toBe(true);
    expect(inflows.every((m) => m.subcategory === 'Tendencia histórica')).toBe(true);
  });

  it('emits nothing when committed >= predicted (real flow is never reduced)', () => {
    const result = buildTrendTopOffMovements({
      ...baseArgs,
      incomeMonthly: [point('2026-08', 50_000)],
      expenseMonthly: [],
      existingMovements: [movement('INFLOW', '2026-08-10', 80_000)],
    });
    expect(result).toHaveLength(0);
  });

  it('ignores months strictly before the current month (fully real)', () => {
    const result = buildTrendTopOffMovements({
      ...baseArgs,
      incomeMonthly: [point('2026-03', 999_000, true)],
      expenseMonthly: [],
      existingMovements: [],
    });
    expect(result).toHaveLength(0);
  });

  it('clips to the projection window (drops points after endDate)', () => {
    const result = buildTrendTopOffMovements({
      ...baseArgs,
      incomeMonthly: [point('2027-02', 100_000)],
      expenseMonthly: [],
      existingMovements: [],
    });
    expect(result).toHaveLength(0);
  });

  it('tops off both income and expense', () => {
    const result = buildTrendTopOffMovements({
      ...baseArgs,
      incomeMonthly: [point('2026-09', 120_000)],
      expenseMonthly: [point('2026-09', 90_000)],
      existingMovements: [
        movement('INFLOW', '2026-09-15', 20_000),
        movement('OUTFLOW', '2026-09-15', 10_000),
      ],
    });
    expect(sumByDirection(result, 'INFLOW')).toBeCloseTo(100_000, 5);
    expect(sumByDirection(result, 'OUTFLOW')).toBeCloseTo(80_000, 5);
    expect(result.filter((m) => m.type === 'OUTFLOW').every((m) => m.category === 'OPEX')).toBe(true);
  });

  it('only places anchors strictly after asOfDate in the current partial month', () => {
    const result = buildTrendTopOffMovements({
      ...baseArgs,
      incomeMonthly: [point('2026-06', 40_000)],
      expenseMonthly: [],
      existingMovements: [],
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((m) => m.projectedDate > ASOF)).toBe(true);
    // total still conserved across surviving anchors
    expect(sumByDirection(result, 'INFLOW')).toBeCloseTo(40_000, 5);
  });

  it('returns empty when there are no predictive series', () => {
    const result = buildTrendTopOffMovements({
      ...baseArgs,
      incomeMonthly: [],
      expenseMonthly: [],
      existingMovements: [movement('INFLOW', '2026-08-15', 30_000)],
    });
    expect(result).toHaveLength(0);
  });
});
