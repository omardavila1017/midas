import { describe, expect, it } from 'vitest';
import type { CXPRecord } from '../../../domain/persistence';
import type { CxpPaymentCoverage } from '../../../domain/paymentReconciliationEngine';
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

  it('drops projected movements dated in previous months but keeps real historical (non-base)', () => {
    const run = buildScenarioForecastRun({
      scenarioId: 'approved',
      scenarioName: 'Aprobado',
      scenarioKind: 'APPROVED',
      sourceMovements: [
        // Previous month, real → kept (real bank/cobranza historical).
        movement('bank-real-prev', 'INFLOW', 'TRANSFER', 'Banco real', 400, {
          status: 'REAL',
          projectedDate: '2026-04-10',
        }),
        // Previous month, projected → dropped (no projections before current month).
        movement('proj-prev', 'INFLOW', 'AR_COLLECTION', 'Proyectado pasado', 900, {
          status: 'PROJECTED_BASE',
          projectedDate: '2026-04-15',
        }),
        // Current month, projected → kept (actual para adelante).
        movement('proj-current', 'INFLOW', 'AR_COLLECTION', 'Proyectado actual', 700, {
          status: 'PROJECTED_BASE',
          projectedDate: '2026-05-20',
        }),
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
      startDate: '2026-04-01',
      endDate: '2026-05-31',
      today: '2026-05-12',
      initialCash: 0,
      supplierInitialCash: 0,
      minimumCash: 0,
      granularity: 'monthly',
    });

    const ids = run.movements.map((item) => item.id);
    expect(ids).toContain('bank-real-prev');
    expect(ids).toContain('proj-current');
    expect(ids).not.toContain('proj-prev');
  });

  it('passes CXP payment coverage into forecast taxes to avoid current-period IVA double counting', () => {
    const cxp = cxpRecord({
      cia: '00001',
      noProveedor: 'P-IVA',
      nombre: 'Proveedor IVA',
      noFactura: 'F-IVA',
      fechaProgramacionPago: '2026-05-20',
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importeBrutoPesos: 1160,
      importePendientePesos: 1160,
    });
    const taxStore = {
      ...defaultTaxStore(),
      adjustments: [{
        id: 'adj-iva-caused',
        taxType: 'IVA' as const,
        period: '2026-05',
        kind: 'IVA_CAUSED' as const,
        amount: 160,
        source: 'MANUAL' as const,
        createdAt: '2026-05-01T00:00:00.000Z',
      }],
    };

    const args = {
      scenarioId: 'approved',
      scenarioName: 'Aprobado',
      scenarioKind: 'APPROVED' as const,
      sourceMovements: [],
      adjustments: [],
      manualEntries: [],
      customRows: [],
      overrides: [],
      clients: [],
      providers: [],
      assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
      cxpRecords: [cxp],
      cxpPaymentCoverage: new Map([[coverageKey(cxp), coverage(cxp, {
        status: 'PAID',
        totalPaidPesos: 1160,
        payments: [{ noPago: 'Auxiliar GL', fechaPago: '2026-04-30', importe: 1160, tier: 'folio-exact' }],
      })]]),
      budget: null,
      companyCode: 'all',
      taxStore,
      startDate: '2026-05-01',
      endDate: '2026-06-30',
      today: '2026-05-01',
      initialCash: 0,
      supplierInitialCash: 0,
      minimumCash: 0,
      granularity: 'monthly' as const,
    };

    const run = buildScenarioForecastRun(args);

    const taxReserve = run.movements.find((item) => item.id === 'tax-reserve:approved:tax-calculated:IVA:2026-05');
    expect(taxReserve?.projectedAmount).toBe(160);
  });
});

function cxpRecord(patch: Partial<CXPRecord>): CXPRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? 'P-1',
    nombre: patch.nombre ?? 'Proveedor IVA',
    noFactura: patch.noFactura ?? 'F-1',
    fechaFactura: patch.fechaFactura ?? '2026-05-01',
    fechaVence: patch.fechaVence ?? '2026-05-17',
    fechaProgramacionPago: patch.fechaProgramacionPago ?? '2026-05-17',
    diasVencida: patch.diasVencida ?? 0,
    importeBrutoPesos: patch.importeBrutoPesos ?? 0,
    importePendientePesos: patch.importePendientePesos ?? 0,
    importeSubtotalPesos: patch.importeSubtotalPesos ?? 0,
    importeImpuestosPesos: patch.importeImpuestosPesos ?? 0,
    importeBrutoDolares: patch.importeBrutoDolares ?? 0,
    importePendienteDolares: patch.importePendienteDolares ?? 0,
    moneda: patch.moneda ?? 'MXN',
    condPago: patch.condPago ?? '',
    clasifica: patch.clasifica ?? '',
    clasificacionProveedor: patch.clasificacionProveedor ?? '',
    edoPago: patch.edoPago ?? '',
    tipoCambio: patch.tipoCambio ?? 1,
    porVencer: patch.porVencer ?? 0,
    v1_30: patch.v1_30 ?? 0,
    v31_60: patch.v31_60 ?? 0,
    v61_90: patch.v61_90 ?? 0,
    v91_120: patch.v91_120 ?? 0,
    v121_150: patch.v121_150 ?? 0,
    v151_180: patch.v151_180 ?? 0,
    mas180: patch.mas180 ?? 0,
  };
}

function coverageKey(record: CXPRecord): string {
  return `${record.cia}::${record.noFactura}::${record.noProveedor}`;
}

function coverage(record: CXPRecord, patch: Omit<CxpPaymentCoverage, 'cxpKey'>): CxpPaymentCoverage {
  return {
    cxpKey: coverageKey(record),
    ...patch,
  };
}

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
