import { describe, expect, it } from 'vitest';
import {
  applyAdjustmentsToMovements,
  calculateBaseProjection,
  calculateConfidenceBand,
  calculateMovementConfidence,
  calculateScenarioProjection,
  compareProjectionVsScenario,
} from './financialProjectionEngine';
import type { FinancialAdjustment, FinancialMovement, FinancialScenario } from '../types';

describe('financialProjectionEngine', () => {
  it('calculates daily cash balance from inflows and outflows', () => {
    const projection = calculateBaseProjection([
      movement('in-1', 'INFLOW', 'AR_COLLECTION', '2026-05-02', 1_000),
      movement('out-1', 'OUTFLOW', 'AP_PAYMENT', '2026-05-03', 400),
    ], options());

    expect(projection.buckets[0].closingCash).toBe(10_000);
    expect(projection.buckets[1].closingCash).toBe(11_000);
    expect(projection.buckets[2].closingCash).toBe(10_600);
    expect(projection.summary.finalCash).toBe(10_600);
  });

  it('keeps visible projected cash at zero while preserving the real liquidity shortfall', () => {
    const projection = calculateBaseProjection([
      movement('out-1', 'OUTFLOW', 'PAYROLL', '2026-05-02', 1_200),
      movement('out-2', 'OUTFLOW', 'TAX', '2026-05-03', 300),
    ], {
      startDate: '2026-05-01',
      endDate: '2026-05-03',
      initialCash: 1_000,
      minimumCash: 100,
      granularity: 'daily',
    });

    expect(projection.buckets[1].closingCash).toBe(0);
    expect(projection.buckets[2].closingCash).toBe(0);
    expect(projection.summary.minCash).toBe(0);
    expect(projection.summary.deficitDays).toBe(2);
    expect(projection.summary.creditRequired).toBe(600);
  });

  it('moves a movement date through a scenario adjustment without mutating the base', () => {
    const baseMovements = [movement('out-1', 'OUTFLOW', 'AP_PAYMENT', '2026-05-02', 1_000)];
    const adjusted = applyAdjustmentsToMovements(baseMovements, [
      adjustment('DATE_SHIFT', { adjustedValue: '2026-05-04' }),
    ], 'liquidity');

    expect(baseMovements[0].projectedDate).toBe('2026-05-02');
    expect(adjusted[0].adjustedDate).toBe('2026-05-04');
  });

  it('replaces movement amount through an amount override', () => {
    const adjusted = applyAdjustmentsToMovements([
      movement('in-1', 'INFLOW', 'AR_COLLECTION', '2026-05-02', 1_000),
    ], [
      adjustment('AMOUNT_OVERRIDE', { adjustedValue: 1_500 }),
    ], 'liquidity');

    expect(adjusted[0].adjustedAmount).toBe(1_500);
  });

  it('compares scenario projection against base projection', () => {
    const baseProjection = calculateBaseProjection([
      movement('in-1', 'INFLOW', 'AR_COLLECTION', '2026-05-02', 1_000),
    ], options());
    const scenario = scenarioModel('liquidity');
    const scenarioProjection = calculateScenarioProjection(baseProjection, scenario, [
      adjustment('AMOUNT_OVERRIDE', { adjustedValue: 2_000 }),
    ]);
    const comparison = compareProjectionVsScenario(baseProjection, scenarioProjection);

    expect(comparison.finalCashDelta).toBe(1_000);
    expect(comparison.totalInflowsDelta).toBe(1_000);
  });

  it('calculates confidence bands from score and inputs', () => {
    expect(calculateConfidenceBand(95)).toBe('CONFIRMED');
    expect(calculateConfidenceBand(80)).toBe('HIGH');
    expect(calculateConfidenceBand(65)).toBe('MEDIUM');
    expect(calculateConfidenceBand(45)).toBe('LOW');
    expect(calculateConfidenceBand(20)).toBe('EXPLORATORY');

    const confidence = calculateMovementConfidence({
      sourceSystem: 'JDE',
      forecastMethod: 'RULE',
      hasManualValidation: true,
      historyScore: 18,
      freshnessScore: 18,
    });
    expect(confidence.band).toBe('CONFIRMED');
  });
});

function options() {
  return {
    startDate: '2026-05-01',
    endDate: '2026-05-03',
    initialCash: 10_000,
    minimumCash: 5_000,
    granularity: 'daily' as const,
  };
}

function movement(
  id: string,
  type: FinancialMovement['type'],
  category: FinancialMovement['category'],
  projectedDate: string,
  amount: number,
): FinancialMovement {
  return {
    id,
    sourceSystem: 'FORECAST',
    type,
    category,
    concept: id,
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate,
    confidenceScore: 80,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  };
}

function adjustment(
  type: FinancialAdjustment['type'],
  overrides: Partial<FinancialAdjustment>,
): FinancialAdjustment {
  return {
    id: `adj-${type}`,
    name: type,
    scenarioIds: ['liquidity'],
    type,
    targetType: 'MOVEMENT',
    targetExpression: overrides.targetExpression ?? (type === 'AMOUNT_OVERRIDE' ? 'in-1' : 'out-1'),
    reasonCode: 'LIQUIDITY',
    justification: 'Test adjustment',
    status: 'DRAFT',
    createdBy: 'test',
    createdAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

function scenarioModel(id: string): FinancialScenario {
  return {
    id,
    name: 'Borrador test',
    kind: 'DRAFT',
    adjustmentIds: [],
    status: 'DRAFT',
    createdBy: 'test',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  };
}
