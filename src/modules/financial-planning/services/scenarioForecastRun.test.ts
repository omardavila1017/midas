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
    expect(run.rows.some((row) => row.conceptKey === 'INFLOW:AR_COLLECTION:cliente-a')).toBe(true);
    expect(run.overrides).toEqual(overrides);
  });

  it('builds Base from real movements and explicit operational pending items only', () => {
    const run = buildScenarioForecastRun({
      scenarioId: 'base',
      scenarioName: 'Base',
      scenarioKind: 'BASE',
      sourceMovements: [
        movement('bank-real', 'INFLOW', 'TRANSFER', 'Banco real', 400, { status: 'REAL' }),
        movement('cxc:pending-1', 'INFLOW', 'AR_COLLECTION', 'Cliente pendiente', 700),
        movement('federal-forecast:2026-05', 'INFLOW', 'AR_COLLECTION', 'Forecast federal', 900),
      ],
      adjustments: [{
        id: 'adj-base-add',
        name: 'No debe tocar Base',
        scenarioIds: ['base'],
        type: 'ADD_MOVEMENT',
        targetType: 'DATE_RANGE',
        targetExpression: '2026-05-01..2026-05-31',
        adjustedValue: {
          id: 'manual-added',
          type: 'INFLOW',
          category: 'MANUAL',
          projectedAmount: 5_000,
          projectedDate: '2026-05-20',
        },
        reasonCode: 'LIQUIDITY',
        justification: 'test',
        status: 'APPROVED',
        createdBy: 'x',
        createdAt: '2026-01-01T00:00:00Z',
      }],
      manualEntries: [],
      customRows: [],
      overrides: [],
      clients: [],
      providers: [],
      assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
      cxpRecords: [],
      budget: null,
      companyCode: 'all',
      taxStore: defaultTaxStore(),
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      today: '2026-05-18',
      initialCash: 100,
      supplierInitialCash: 100,
      minimumCash: 0,
      granularity: 'monthly',
    });

    expect(run.movements.map((item) => item.id).sort()).toEqual(['bank-real', 'cxc:pending-1']);
    expect(run.summary.finalCash).toBe(1_200);
  });

  it('includes ROL movements in Base even when their projected date is in the future', () => {
    const run = buildScenarioForecastRun({
      scenarioId: 'base',
      scenarioName: 'Base',
      scenarioKind: 'BASE',
      sourceMovements: [
        movement('bank-real', 'INFLOW', 'TRANSFER', 'Banco real', 400, { status: 'REAL', projectedDate: '2026-05-10' }),
        movement('rol:client-x:2026-06-15', 'INFLOW', 'AR_COLLECTION', 'Senda Citi', 500, { projectedDate: '2026-06-15' }),
        // client: is rule-based, must stay out of Base even with a same-window date.
        movement('client:client-x:2026-05-25', 'INFLOW', 'AR_COLLECTION', 'Cliente proyectado', 999, { projectedDate: '2026-05-25' }),
      ],
      adjustments: [],
      manualEntries: [],
      customRows: [],
      overrides: [],
      clients: [],
      providers: [],
      assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
      cxpRecords: [],
      budget: null,
      companyCode: 'all',
      taxStore: defaultTaxStore(),
      startDate: '2026-05-01',
      endDate: '2026-12-31',
      today: '2026-05-20',
      initialCash: 100,
      supplierInitialCash: 100,
      minimumCash: 0,
      granularity: 'monthly',
    });

    const ids = run.movements.map((item) => item.id).sort();
    expect(ids).toEqual(['bank-real', 'rol:client-x:2026-06-15']);
    // Bucket window extends through the latest rol: date instead of being truncated at today.
    expect(run.buckets[run.buckets.length - 1].date >= '2026-06-01').toBe(true);
    // The future ROL inflow contributes to final cash: 100 + 400 + 500 = 1000.
    expect(run.summary.finalCash).toBe(1_000);
  });
});

function movement(
  id: string,
  type: FinancialMovement['type'],
  category: FinancialMovement['category'],
  counterpartyName: string,
  amount: number,
  patch: Partial<FinancialMovement> = {},
): FinancialMovement {
  return {
    id,
    sourceSystem: patch.sourceSystem ?? 'FORECAST',
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
    projectedDate: patch.projectedDate ?? '2026-05-15',
    confidenceScore: 80,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: patch.status ?? 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}
