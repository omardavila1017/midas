import { describe, expect, it } from 'vitest';
import { calculateBaseProjection } from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialMovement, TaxObligation } from '../../shared-finance/types';
import {
  addTaxPaymentPlanItem,
  buildApprovedTaxPaymentMovements,
  buildTaxDashboardView,
  createManualTaxObligation,
  createTaxManualAdjustment,
  defaultTaxStore,
  upsertTaxObligation,
} from './taxModuleService';

describe('taxModuleService', () => {
  it('calculates IVA by 16% and 8% rates, creditable VAT, favor balance and unclassified movements', () => {
    const projection = projectionFor([
      movement('ar-16', 'INFLOW', 'AR_COLLECTION', '2026-05-05', 1160, {
        taxTreatment: 'IVA_CAUSED',
        taxRate: 16,
      }),
      movement('ar-8', 'INFLOW', 'AR_COLLECTION', '2026-05-06', 1080, {
        taxTreatment: 'IVA_CAUSED',
        taxRate: 8,
      }),
      movement('ap-16', 'OUTFLOW', 'AP_PAYMENT', '2026-05-07', 580, {
        taxTreatment: 'IVA_CREDITABLE',
        taxRate: 16,
      }),
      movement('manual-in', 'INFLOW', 'MANUAL', '2026-05-08', 500, {
        taxTreatment: 'UNCLASSIFIED',
      }),
    ]);

    const view = buildTaxDashboardView({
      projection,
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.incomeBase16).toBeCloseTo(1000);
    expect(may.iva.incomeBase8).toBeCloseTo(1000);
    expect(may.iva.ivaCaused).toBeCloseTo(240);
    expect(may.iva.ivaCreditable).toBeCloseTo(80);
    expect(may.iva.payable).toBeCloseTo(160);
    expect(may.iva.unclassifiedIncome).toBe(500);
  });

  it('calculates ISN as 3% of payroll and supports manual override', () => {
    const projection = projectionFor([
      movement('payroll', 'OUTFLOW', 'PAYROLL', '2026-06-15', 1000, {
        taxTreatment: 'IVA_EXEMPT',
      }),
    ]);
    const store = {
      adjustments: [
        createTaxManualAdjustment({
          taxType: 'ISN',
          period: '2026-06',
          kind: 'ISN_OVERRIDE',
          amount: 45,
        }),
      ],
      obligations: [],
      overdueBalance: 0,
    };

    const view = buildTaxDashboardView({ projection, store, today: '2026-06-01' });
    expect(view.periods[0].payrollBase).toBe(1000);
    expect(view.periods[0].isn).toBe(45);
  });

  it('detects IMSS from JDE-like movements and includes manual pending obligations', () => {
    const projection = projectionFor([
      movement('imss-jde', 'OUTFLOW', 'AP_PAYMENT', '2026-07-17', 300, {
        counterpartyName: 'INSTITUTO MEXICANO DEL SEGURO SOCIAL',
        sourceSystem: 'JDE',
      }),
    ]);
    const obligation = createManualTaxObligation({
      taxType: 'IMSS',
      period: '2026-07',
      amount: 200,
      label: 'IMSS ajuste manual',
    });

    const view = buildTaxDashboardView({
      projection,
      store: upsertTaxObligation(defaultTaxStore(), obligation),
      today: '2026-07-01',
    });

    expect(view.periods[0].imss).toBe(300);
    expect(view.periods[0].obligations.some((item) => item.label === 'IMSS ajuste manual')).toBe(false);
    expect(view.periods[0].imssLines[0].counterpartyName).toContain('INSTITUTO');
  });

  it('creates approved tax payment movements for scenario cash impact', () => {
    const obligation: TaxObligation = addTaxPaymentPlanItem({
      obligation: createManualTaxObligation({
        taxType: 'IVA',
        period: '2026-08',
        amount: 1000,
        dueDate: '2026-09-17',
      }),
      date: '2026-09-20',
      amount: 400,
      status: 'APPROVED',
      scenarioId: 'liquidity',
    });

    const movements = buildApprovedTaxPaymentMovements({
      obligations: [obligation],
      scenarioId: 'liquidity',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      asOfDate: '2026-08-01',
    });

    expect(movements).toHaveLength(1);
    expect(movements[0].category).toBe('TAX');
    expect(movements[0].projectedAmount).toBe(400);
    expect(movements[0].status).toBe('APPROVED');
  });
});

function projectionFor(movements: FinancialMovement[]) {
  return calculateBaseProjection(movements, {
    startDate: '2026-05-01',
    endDate: '2026-12-31',
    initialCash: 10_000,
    minimumCash: 1000,
    granularity: 'monthly',
  });
}

function movement(
  id: string,
  type: FinancialMovement['type'],
  category: FinancialMovement['category'],
  projectedDate: string,
  amount: number,
  patch: Partial<FinancialMovement> = {},
): FinancialMovement {
  return {
    id,
    sourceSystem: patch.sourceSystem ?? 'FORECAST',
    type,
    category,
    counterpartyName: patch.counterpartyName,
    counterpartyType: patch.counterpartyType,
    concept: patch.concept ?? id,
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate,
    confidenceScore: 80,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    taxTreatment: patch.taxTreatment,
    taxRate: patch.taxRate,
    status: 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}
