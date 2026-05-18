import { describe, expect, it } from 'vitest';
import { defaultTaxStore } from '../../taxes/services/taxModuleService';
import type {
  CellOverride,
  FinancialMovement,
  FinancialScenario,
} from '../../shared-finance/types';
import { buildScenarioForecastRun } from './scenarioForecastRun';

describe('scenarioForecastRun', () => {
  it('builds the approved run with treasury rules and scenario overrides in one shared output', () => {
    const approved: FinancialScenario = {
      id: 'approved',
      name: 'Aprobado',
      kind: 'APPROVED',
      status: 'APPROVED',
      isBase: false,
      adjustmentIds: [],
      createdBy: 'x',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const overrides: CellOverride[] = [{
      id: 'co-1',
      scenarioId: approved.id,
      conceptKey: 'INFLOW:AR_COLLECTION:cliente-a',
      granularity: 'monthly',
      bucketKey: '2026-05-01',
      type: 'INFLOW',
      mode: 'REPLACE',
      value: 1_500,
      createdBy: 'x',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }];

    const run = buildScenarioForecastRun({
      scenarioId: approved.id,
      scenarioName: approved.name,
      scenarioKind: approved.kind,
      sourceMovements: [movement('m-in', 'INFLOW', 'AR_COLLECTION', 'Cliente A', 1_000)],
      adjustments: [],
      manualEntries: [],
      customRows: [],
      overrides,
      clients: [],
      providers: [],
      assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
      cxpRecords: [],
      budget: null,
      companyCode: 'all',
      taxStore: defaultTaxStore(),
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      today: '2026-05-01',
      initialCash: 100,
      supplierInitialCash: 100,
      minimumCash: 0,
      granularity: 'monthly',
    });

    expect(run.buckets[0].inflows).toBe(1_500);
    expect(run.buckets[0].closingCash).toBe(1_600);
    expect(run.rows.some((row) => row.conceptKey === 'INFLOW:AR_COLLECTION:cliente-a')).toBe(true);
    expect(run.overrides).toEqual(overrides);
  });
});

function movement(
  id: string,
  type: FinancialMovement['type'],
  category: FinancialMovement['category'],
  counterpartyName: string,
  amount: number,
): FinancialMovement {
  return {
    id,
    sourceSystem: 'FORECAST',
    sourceObjectId: id,
    type,
    category,
    counterpartyName,
    counterpartyType: type === 'INFLOW' ? 'CUSTOMER' : 'SUPPLIER',
    concept: counterpartyName,
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate: '2026-05-15',
    confidenceScore: 80,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}
