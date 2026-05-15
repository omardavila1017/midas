import { describe, expect, it } from 'vitest';
import { applyCellOverridesToBuckets } from './financialProjectionEngine';
import type {
  CellOverride,
  FinancialMovement,
  PlanningRow,
  ProjectionBucket,
} from '../types';

const movements: FinancialMovement[] = [
  {
    id: 'm1',
    sourceSystem: 'JDE',
    type: 'INFLOW',
    category: 'AR_COLLECTION',
    counterpartyName: 'CFE',
    concept: 'Cobranza CFE',
    currency: 'MXN',
    originalAmount: 1_000_000,
    baseAmount: 1_000_000,
    projectedAmount: 1_000_000,
    adjustedAmount: 1_000_000,
    projectedDate: '2026-05-15',
    confidenceScore: 80,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'm2',
    sourceSystem: 'JDE',
    type: 'OUTFLOW',
    category: 'PAYROLL',
    concept: 'Nómina',
    currency: 'MXN',
    originalAmount: 800_000,
    baseAmount: 800_000,
    projectedAmount: 800_000,
    adjustedAmount: 800_000,
    projectedDate: '2026-05-15',
    confidenceScore: 90,
    confidenceBand: 'CONFIRMED',
    forecastMethod: 'DRIVER',
    status: 'PROJECTED_BASE',
    lockState: 'LOCKED',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const rows: PlanningRow[] = [
  {
    conceptKey: 'INFLOW:AR_COLLECTION:cfe',
    label: 'CFE',
    group: 'Ingresos · AR_COLLECTION',
    bucketLabel: 'Otros ingresos',
    type: 'INFLOW',
    category: 'AR_COLLECTION',
  },
  {
    conceptKey: 'OUTFLOW:PAYROLL:general',
    label: 'Nómina',
    group: 'Egresos · PAYROLL',
    bucketLabel: 'Nómina',
    type: 'OUTFLOW',
    category: 'PAYROLL',
  },
];

function conceptKeyForMovement(movement: FinancialMovement): string {
  const tail = movement.counterpartyName ?? movement.subcategory ?? 'general';
  return `${movement.type}:${movement.category}:${tail.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

const bucket: ProjectionBucket = {
  date: '2026-05-01',
  label: '2026-05',
  openingCash: 5_000_000,
  inflows: 1_000_000,
  outflows: 800_000,
  net: 200_000,
  closingCash: 5_200_000,
  minimumCash: 1_000_000,
  deficit: 0,
  confidenceScore: 85,
  movementIds: ['m1', 'm2'],
  alertIds: [],
};

describe('applyCellOverridesToBuckets', () => {
  it('replaces the inflow aggregate when an override is present', () => {
    const overrides: CellOverride[] = [{
      id: 'co-1',
      scenarioId: 'draft-1',
      conceptKey: 'INFLOW:AR_COLLECTION:cfe',
      granularity: 'monthly',
      bucketKey: '2026-05-01',
      type: 'INFLOW',
      mode: 'REPLACE',
      value: 1_500_000,
      createdBy: 'x',
      createdAt: '2026-04-29T00:00:00Z',
      updatedAt: '2026-04-29T00:00:00Z',
    }];

    const result = applyCellOverridesToBuckets({
      buckets: [bucket],
      overrides,
      movements,
      rows,
      granularity: 'monthly',
      conceptKeyForMovement,
      asOfDate: '2026-04-29',
      initialCash: 5_000_000,
    });

    expect(result[0].inflows).toBe(1_500_000);
    expect(result[0].outflows).toBe(800_000);
    expect(result[0].net).toBe(700_000);
    expect(result[0].closingCash).toBe(5_700_000);
  });

  it('ignores overrides whose granularity does not match', () => {
    const overrides: CellOverride[] = [{
      id: 'co-2',
      scenarioId: 'draft-1',
      conceptKey: 'INFLOW:AR_COLLECTION:cfe',
      granularity: 'weekly',
      bucketKey: '2026-05-01',
      type: 'INFLOW',
      mode: 'REPLACE',
      value: 9_999,
      createdBy: 'x',
      createdAt: '2026-04-29T00:00:00Z',
      updatedAt: '2026-04-29T00:00:00Z',
    }];

    const result = applyCellOverridesToBuckets({
      buckets: [bucket],
      overrides,
      movements,
      rows,
      granularity: 'monthly',
      conceptKeyForMovement,
      asOfDate: '2026-04-29',
      initialCash: 5_000_000,
    });

    expect(result[0].inflows).toBe(1_000_000);
  });

  it('skips overrides on past buckets', () => {
    const overrides: CellOverride[] = [{
      id: 'co-3',
      scenarioId: 'draft-1',
      conceptKey: 'INFLOW:AR_COLLECTION:cfe',
      granularity: 'monthly',
      bucketKey: '2026-05-01',
      type: 'INFLOW',
      mode: 'REPLACE',
      value: 9_999,
      createdBy: 'x',
      createdAt: '2026-04-29T00:00:00Z',
      updatedAt: '2026-04-29T00:00:00Z',
    }];

    const result = applyCellOverridesToBuckets({
      buckets: [bucket],
      overrides,
      movements,
      rows,
      granularity: 'monthly',
      conceptKeyForMovement,
      asOfDate: '2026-07-15', // bucket 2026-05-01 is in the past relative to this
      initialCash: 5_000_000,
    });

    expect(result[0].inflows).toBe(1_000_000);
  });
});
