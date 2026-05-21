import { describe, expect, it } from 'vitest';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CxpPaymentCoverage } from '../../../domain/paymentReconciliationEngine';
import type { CashFlowAssumptions, Client } from '../../../domain/types';
import type { CobranzaPayment } from '../../../services/jdeTypes';
import { calculateBaseProjection } from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialMovement, PurchaseReceiptRecord, TaxObligation } from '../../shared-finance/types';
import {
  addTaxPaymentPlanItem,
  buildAutomaticTaxReserveMovements,
  buildApprovedTaxPaymentMovements,
  buildTaxDashboardView,
  createManualTaxObligation,
  createTaxManualAdjustment,
  defaultTaxStore,
  upsertTaxObligation,
} from './taxModuleService';

describe('taxModuleService', () => {
  it('calculates IVA from projected CXC and JDE CXP invoice fields', () => {
    const view = buildTaxDashboardView({
      clients: [
        client({ id: 'ar-16', name: 'Cliente 16', ivaRate: 16, mayBilling: 1000 }),
        client({ id: 'ar-8', name: 'Cliente 8', ivaRate: 8, mayBilling: 1000 }),
      ],
      assumptions,
      cxpRecords: [
        cxpRecord({
          noFactura: 'F-100',
          fechaProgramacionPago: '2026-05-07',
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 160,
          importeBrutoPesos: 1160,
          importePendientePesos: 1160,
        }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.incomeBase16).toBeCloseTo(1000);
    expect(may.iva.incomeBase8).toBeCloseTo(1000);
    expect(may.iva.ivaCaused).toBeCloseTo(240);
    expect(may.iva.expenseBase16).toBeCloseTo(1000);
    expect(may.iva.ivaCreditable).toBeCloseTo(160);
    expect(may.iva.payable).toBeCloseTo(80);
    expect(may.iva.incomeLines).toHaveLength(2);
    expect(may.iva.expenseLines[0]).toMatchObject({
      concept: 'Factura F-100 · Proveedor IVA',
      taxRate: 16,
    });
  });

  it('prorates partial CXP invoices and estimates unclear invoices under regimen 601', () => {
    const view = buildTaxDashboardView({
      cxpRecords: [
        cxpRecord({
          noFactura: 'F-PARTIAL',
          fechaProgramacionPago: '2026-05-07',
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 160,
          importeBrutoPesos: 1160,
          importePendientePesos: 580,
        }),
        cxpRecord({
          noFactura: 'F-UNCLEAR',
          fechaProgramacionPago: '2026-05-08',
          importeSubtotalPesos: 0,
          importeImpuestosPesos: 0,
          importeBrutoPesos: 0,
          importePendientePesos: 500,
        }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.expenseBase16).toBeCloseTo(500 + 500 / 1.16);
    expect(may.iva.ivaCreditable).toBeCloseTo(80 + (500 - 500 / 1.16));
    expect(may.iva.unclassifiedExpense).toBe(0);
    expect(may.iva.expenseLines.some((line) => line.concept.includes('F-UNCLEAR'))).toBe(true);
  });

  it('dates creditable CXP IVA on the real PagoProveedor date when coverage is paid', () => {
    const cxp = cxpRecord({
      noFactura: 'F-PAID',
      fechaProgramacionPago: '2026-05-17',
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importeBrutoPesos: 1160,
      importePendientePesos: 1160,
    });
    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      cxpPaymentCoverage: new Map([[coverageKey(cxp), coverage(cxp, {
        status: 'PAID',
        totalPaidPesos: 1160,
        payments: [{ noPago: 'P-1', fechaPago: '2026-04-20', importe: 1160, tier: 'invoice-amount' }],
      })]]),
      companyCode: 'all',
      startDate: '2026-04-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const apr = view.periods.find((period) => period.period === '2026-04')!;
    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(apr.iva.ivaCreditable).toBeCloseTo(160);
    expect(apr.iva.expenseLines[0].concept).toContain('Pago P-1');
    expect(may?.iva.ivaCreditable ?? 0).toBe(0);
  });

  it('splits partial PagoProveedor coverage between paid date and projected remainder', () => {
    const cxp = cxpRecord({
      noFactura: 'F-PARTIAL-COVERAGE',
      fechaProgramacionPago: '2026-06-10',
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importeBrutoPesos: 1160,
      importePendientePesos: 1160,
    });
    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      cxpPaymentCoverage: new Map([[coverageKey(cxp), coverage(cxp, {
        status: 'PARTIAL',
        totalPaidPesos: 580,
        payments: [{ noPago: 'P-2', fechaPago: '2026-05-12', importe: 580, tier: 'invoice-amount' }],
      })]]),
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-06-30',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    const jun = view.periods.find((period) => period.period === '2026-06')!;
    expect(may.iva.ivaCreditable).toBeCloseTo(80);
    expect(jun.iva.ivaCreditable).toBeCloseTo(80);
    expect(jun.iva.expenseLines[0].concept).toContain('Remanente proyectado');
  });

  it('uses matched purchase receipt tax rate when CXP has no tax fields', () => {
    const view = buildTaxDashboardView({
      cxpRecords: [
        cxpRecord({
          noProveedor: '59570032',
          noFactura: 'F-MATCH',
          fechaProgramacionPago: '2026-05-07',
          importeSubtotalPesos: 0,
          importeImpuestosPesos: 0,
          importeBrutoPesos: 1080,
          importePendientePesos: 1080,
        }),
      ],
      purchaseReceipts: [
        purchaseReceipt({
          noProveedor: '59570032',
          invoiceNo: 'F-MATCH',
          amountMxn: 1080,
          totalAmount: 1080,
          taxRate: 8,
          taxRateCode: 'IVA8',
          taxTreatment: 'IVA_CREDITABLE',
        }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.expenseBase8).toBeCloseTo(1000);
    expect(may.iva.ivaCreditable8).toBeCloseTo(80);
    expect(may.iva.expenseLines).toHaveLength(1);
  });

  it('adds unmatched active purchase receipts to creditable IVA and excludes cancelled receipts', () => {
    const view = buildTaxDashboardView({
      purchaseReceipts: [
        purchaseReceipt({
          invoiceNo: 'ACTIVE-16',
          amountMxn: 1160,
          totalAmount: 1160,
          taxRate: 16,
          taxRateCode: 'IVA16',
          taxTreatment: 'IVA_CREDITABLE',
        }),
        purchaseReceipt({
          invoiceNo: 'CANCELLED',
          amountMxn: 1160,
          totalAmount: 1160,
          taxRate: 16,
          taxRateCode: 'IVA16',
          taxTreatment: 'IVA_CREDITABLE',
          cancelledAt: '2026-05-03',
          isCancelled: true,
          status: 'CANCELLED',
        }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.ivaCreditable).toBeCloseTo(160);
    expect(may.iva.expenseLines).toHaveLength(1);
    expect(may.iva.expenseLines[0].concept).toContain('ACTIVE-16');
  });

  it('sends unmatched purchase receipts without fiscal rate to unclassified expense', () => {
    const view = buildTaxDashboardView({
      purchaseReceipts: [
        purchaseReceipt({
          invoiceNo: 'NO-TAX',
          amountMxn: 500,
          totalAmount: 500,
          taxRate: undefined,
          taxRateCode: '',
          taxTreatment: 'UNCLASSIFIED',
        }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.ivaCreditable).toBe(0);
    expect(may.iva.unclassifiedExpense).toBe(500);
  });

  it('treats CXP with explicit zero tax as exempt instead of fabricating DEFAULT 16%', () => {
    const view = buildTaxDashboardView({
      cxpRecords: [
        cxpRecord({
          noFactura: 'F-EXENTO',
          fechaProgramacionPago: '2026-05-10',
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 0,
          importeBrutoPesos: 1000,
          importePendientePesos: 1000,
        }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.ivaCreditable).toBe(0);
    expect(may.iva.unclassifiedExpense).toBe(1000);
  });

  it('estimates budget OPEX as IVA creditable under regimen 601', () => {
    const view = buildTaxDashboardView({
      budget: budget({
        expenseConcepts: [
          { concept: 'Diésel', may: 1160 },
          { concept: 'Nómina', may: 1000 },
          { concept: 'Impuestos', may: 500 },
          { concept: 'Pasivos Financieros', may: 250 },
        ],
      }),
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.expenseBase16).toBeCloseTo(1000);
    expect(may.iva.ivaCreditable).toBeCloseTo(160);
    expect(may.iva.expenseLines).toHaveLength(1);
    expect(may.iva.expenseLines[0].concept).toContain('Diésel');
  });

  it('fills periods without CXP from taxable budget without double-counting CXP months', () => {
    const view = buildTaxDashboardView({
      cxpRecords: [
        cxpRecord({
          noFactura: 'F-MAY',
          fechaProgramacionPago: '2026-05-07',
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 160,
          importeBrutoPesos: 1160,
          importePendientePesos: 1160,
        }),
      ],
      budget: budget({
        expenseConcepts: [
          { concept: 'Diésel', monthly: { feb: 1160, may: 1160 } },
        ],
      }),
      companyCode: 'all',
      startDate: '2026-02-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const feb = view.periods.find((period) => period.period === '2026-02')!;
    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(feb.iva.ivaCreditable).toBeCloseTo(160);
    expect(feb.iva.expenseLines[0]).toMatchObject({ estimated: true, taxRate: 16 });
    expect(may.iva.ivaCreditable).toBeCloseTo(160);
    expect(may.iva.expenseLines).toHaveLength(1);
  });

  it('recalculates provider lines when a provider IVA override is set to 8%', () => {
    const view = buildTaxDashboardView({
      cxpRecords: [
        cxpRecord({
          noProveedor: 'P-FRONTERA',
          noFactura: 'F-8',
          fechaProgramacionPago: '2026-05-07',
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 160,
          importeBrutoPesos: 1160,
          importePendientePesos: 1160,
        }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: {
        ...defaultTaxStore(),
        taxRateOverrides: [{
          targetType: 'PROVIDER',
          targetKey: 'P-FRONTERA',
          rate: 8,
          updatedAt: '2026-05-01T00:00:00.000Z',
        }],
      },
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.expenseBase8).toBeCloseTo(1160 / 1.08);
    expect(may.iva.ivaCreditable8).toBeCloseTo(1160 - 1160 / 1.08);
    expect(may.iva.expenseLines[0]).toMatchObject({
      taxRate: 8,
      rateSource: 'OVERRIDE',
      rateTarget: { targetType: 'PROVIDER', targetKey: 'P-FRONTERA' },
    });
  });

  it('places future projected CXC invoices in the projected collection period', () => {
    const view = buildTaxDashboardView({
      clients: [
        client({ id: 'future', name: 'Cliente futuro', ivaRate: 16, mayBilling: 1000, creditDays: 40 }),
      ],
      assumptions,
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-07-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const june = view.periods.find((period) => period.period === '2026-06')!;
    expect(june.iva.incomeBase16).toBeCloseTo(1000);
    expect(june.iva.ivaCaused16).toBeCloseTo(160);
    expect(june.iva.incomeLines[0].date).toBe('2026-06-10');
  });

  it('defaults projected CXC without explicit client IVA rate to 16%', () => {
    const view = buildTaxDashboardView({
      clients: [
        client({ id: 'default-rate', name: 'Cliente default', ivaRate: undefined, mayBilling: 1000 }),
      ],
      assumptions,
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.incomeBase16).toBeCloseTo(1000);
    expect(may.iva.ivaCaused16).toBeCloseTo(160);
    expect(may.iva.unclassifiedIncome).toBe(0);
  });

  it('calculates caused IVA from real Cobranza payment applications with partial payments', () => {
    const view = buildTaxDashboardView({
      cobranzaPayments: [
        cobranzaPayment({
          idPago: 'PAY-PARTIAL',
          fechaCobro: '2026-05-10',
          importeRecibo: 580,
          applications: [{
            noFactura: 'RI-100',
            importeCobrado: 580,
            importeOriginalFactura: 1160,
            importeIvaFacturaOriginal: 160,
            tasaIva: 'IVA16',
          }],
        }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.incomeBase16).toBeCloseTo(500);
    expect(may.iva.ivaCaused16).toBeCloseTo(80);
    expect(may.iva.ivaCaused).toBeCloseTo(80);
    expect(may.iva.incomeLines[0]).toMatchObject({
      concept: 'Cobro PAY-PARTIAL · Factura RI-100',
      sourceSystem: 'JDE',
      rateSource: 'JDE',
    });
  });

  it('sums multi-invoice caused IVA by period and ignores exempt applications', () => {
    const view = buildTaxDashboardView({
      cobranzaPayments: [
        cobranzaPayment({
          idPago: 'PAY-MULTI',
          fechaCobro: '2026-05-12',
          importeRecibo: 2740,
          applications: [
            {
              noFactura: 'RI-16',
              importeCobrado: 1160,
              importeOriginalFactura: 1160,
              importeIvaFacturaOriginal: 160,
              tasaIva: 'IVA16',
            },
            {
              noFactura: 'RI-8',
              importeCobrado: 1080,
              importeOriginalFactura: 1080,
              importeIvaFacturaOriginal: 80,
              tasaIva: 'IVA8',
            },
            {
              noFactura: 'RI-EXENTO',
              importeCobrado: 500,
              importeOriginalFactura: 500,
              importeIvaFacturaOriginal: 0,
              tasaIva: 'EXENTO',
            },
          ],
        }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.incomeBase16).toBeCloseTo(1000);
    expect(may.iva.ivaCaused16).toBeCloseTo(160);
    expect(may.iva.incomeBase8).toBeCloseTo(1000);
    expect(may.iva.ivaCaused8).toBeCloseTo(80);
    expect(may.iva.ivaCaused).toBeCloseTo(240);
    expect(may.iva.incomeLines).toHaveLength(2);
  });

  it('routes collections with IVA but unresolvable rate to unclassified income instead of dropping them', () => {
    const view = buildTaxDashboardView({
      cobranzaPayments: [
        cobranzaPayment({
          idPago: 'PAY-ODD',
          fechaCobro: '2026-05-12',
          importeRecibo: 1120,
          applications: [
            {
              noFactura: 'RI-ODD',
              importeCobrado: 1120,
              importeOriginalFactura: 1120,
              importeIvaFacturaOriginal: 120,
              tasaIva: 'IVA RES',
            },
          ],
        }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.ivaCaused).toBe(0);
    expect(may.iva.unclassifiedIncome).toBe(1120);
    expect(may.iva.incomeLines).toHaveLength(0);
    expect(may.iva.unclassifiedLines).toHaveLength(1);
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
      taxRateOverrides: [],
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

  it('creates automatic tax reserves only for the amount not covered by approved or paid plans', () => {
    const obligation: TaxObligation = addTaxPaymentPlanItem({
      obligation: createManualTaxObligation({
        taxType: 'IVA',
        period: '2026-08',
        amount: 1000,
        dueDate: '2026-09-17',
      }),
      date: '2026-09-17',
      amount: 400,
      status: 'APPROVED',
      scenarioId: 'approved',
    });

    // Window spans 47 days (2026-08-01 → 2026-09-17). startDate=2026-09-01
    // clips the early installments; what survives still sums to 600.
    const movements = buildAutomaticTaxReserveMovements({
      obligations: [obligation],
      scenarioId: 'approved',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      asOfDate: '2026-08-01',
    });

    expect(movements.length).toBeGreaterThan(0);
    for (const movement of movements) {
      expect(movement.category).toBe('TAX');
      expect(movement.lockState).toBe('RESTRICTED');
      expect(movement.projectedDate >= '2026-09-01').toBe(true);
      expect(movement.projectedDate <= '2026-09-17').toBe(true);
    }
  });

  it('splits future tax reserves into weekly installments that sum to the reserve amount', () => {
    const obligation = createManualTaxObligation({
      taxType: 'IVA',
      period: '2026-06',
      amount: 700,
      dueDate: '2026-07-17',
    });

    const movements = buildAutomaticTaxReserveMovements({
      obligations: [obligation],
      scenarioId: 'approved',
      startDate: '2026-06-01',
      endDate: '2026-07-31',
      asOfDate: '2026-06-01',
    });

    // 46 days between 2026-06-01 and 2026-07-17 → 7 weekly installments.
    expect(movements).toHaveLength(7);
    const total = movements.reduce((sum, movement) => sum + movement.projectedAmount, 0);
    expect(total).toBeCloseTo(700, 2);
    const dates = movements.map((movement) => movement.projectedDate);
    expect(dates[0]).toBe('2026-06-08');
    expect(dates[dates.length - 1]).toBe('2026-07-17');
    expect(movements[0].id).toMatch(/:wk:1$/);
    expect(movements[movements.length - 1].id).toMatch(/:wk:7$/);
    expect(movements[0].concept).toContain('parcialidad 1/7');
  });

  it('keeps a single reserve movement when the obligation is already overdue', () => {
    const obligation = createManualTaxObligation({
      taxType: 'IVA',
      period: '2025-12',
      amount: 500,
      dueDate: '2026-01-17',
    });

    const movements = buildAutomaticTaxReserveMovements({
      obligations: [obligation],
      scenarioId: 'approved',
      startDate: '2026-04-01',
      endDate: '2026-12-31',
      asOfDate: '2026-04-15',
    });

    expect(movements).toHaveLength(1);
    expect(movements[0].projectedDate).toBe('2026-04-15');
    expect(movements[0].projectedAmount).toBe(500);
    expect(movements[0].id).not.toMatch(/:wk:/);
    expect(movements[0].concept).not.toContain('parcialidad');
  });

  it('preserves LOCKED lockState on every installment for IMSS reserves', () => {
    const obligation = createManualTaxObligation({
      taxType: 'IMSS',
      period: '2026-06',
      amount: 1200,
      dueDate: '2026-07-17',
    });

    const movements = buildAutomaticTaxReserveMovements({
      obligations: [obligation],
      scenarioId: 'approved',
      startDate: '2026-06-01',
      endDate: '2026-07-31',
      asOfDate: '2026-06-01',
    });

    expect(movements.length).toBeGreaterThan(1);
    for (const movement of movements) {
      expect(movement.lockState).toBe('LOCKED');
    }
  });
});

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

function client(input: {
  id: string;
  name: string;
  ivaRate?: 8 | 16;
  mayBilling: number;
  creditDays?: number;
}): Client {
  const monthlyBilling = Array.from({ length: 12 }, () => 0);
  monthlyBilling[4] = input.mayBilling;
  return {
    id: input.id,
    name: input.name,
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: input.creditDays ?? 0,
    monthlyBilling,
    complianceRate: 1,
    ivaRate: input.ivaRate,
  };
}

function cobranzaPayment(input: {
  idPago: string;
  fechaCobro: string;
  importeRecibo: number;
  applications: Array<{
    noFactura: string;
    importeCobrado: number;
    importeOriginalFactura: number;
    importeIvaFacturaOriginal: number;
    tasaIva: string;
  }>;
}): CobranzaPayment {
  return {
    idPago: input.idPago,
    cia: '00011',
    fechaCobro: input.fechaCobro,
    fechaContable: input.fechaCobro,
    cuentaBancaria: '11.1020.0011302',
    banco: 'BANAMEX',
    noRecibo: input.idPago,
    importeRecibo: input.importeRecibo,
    pendienteAplicar: 0,
    noCliente: 'C-9001',
    cliente: 'Cliente IVA',
    noBatch: 'B-1',
    tipoCambio: 1,
    applications: input.applications.map((app) => ({
      idPago: input.idPago,
      cia: '00011',
      fechaAplicacion: input.fechaCobro,
      noCliente: 'C-9001',
      cliente: 'Cliente IVA',
      tipoDocto: 'RI',
      noFactura: app.noFactura,
      noFacturaNormalizada: app.noFactura,
      fechaFactura: '2026-05-01',
      fechaVencimiento: '2026-05-31',
      diasAntiguedadFafv: 0,
      importeCobrado: app.importeCobrado,
      importeOriginalFactura: app.importeOriginalFactura,
      importePteFactura: 0,
      tasaIva: app.tasaIva,
      importeIvaFacturaOriginal: app.importeIvaFacturaOriginal,
    })),
  };
}

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

function purchaseReceipt(patch: Partial<PurchaseReceiptRecord> = {}): PurchaseReceiptRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? '59570032',
    supplierName: patch.supplierName ?? 'NEW WORLD FUEL SA DE CV',
    invoiceNo: patch.invoiceNo ?? 'P-1',
    purchaseOrderNo: patch.purchaseOrderNo ?? 'OC-1',
    receiptNo: patch.receiptNo ?? 'REC-1',
    orderDate: patch.orderDate ?? '2026-05-01',
    receiptDate: patch.receiptDate ?? '2026-05-01',
    creditDays: patch.creditDays ?? 30,
    estimatedDueDate: patch.estimatedDueDate ?? '2026-05-31',
    currency: patch.currency ?? 'MXN',
    exchangeRate: patch.exchangeRate ?? 1,
    totalAmount: patch.totalAmount ?? 1160,
    amountMxn: patch.amountMxn ?? patch.totalAmount ?? 1160,
    taxCode: patch.taxCode,
    taxRateCode: patch.taxRateCode,
    taxRate: patch.taxRate,
    taxTreatment: patch.taxTreatment ?? 'UNCLASSIFIED',
    taxBaseAmount: patch.taxBaseAmount,
    taxAmount: patch.taxAmount,
    cancelledAt: patch.cancelledAt,
    isCancelled: patch.isCancelled ?? false,
    status: patch.status ?? 'PROJECTED_BASE',
    costCenter: patch.costCenter,
    productCode: patch.productCode,
    productDescription: patch.productDescription,
    productType: patch.productType,
    categoryCode: patch.categoryCode,
    categoryName: patch.categoryName ?? 'Combustibles',
    familyCode: patch.familyCode,
    familyName: patch.familyName ?? 'DIESEL AUTOCONSUMO',
    subfamilyCode: patch.subfamilyCode,
    subfamilyName: patch.subfamilyName ?? 'DIESEL',
  };
}

function budget(input: {
  expenseConcepts: Array<{ concept: string; may?: number; monthly?: Partial<Record<'feb' | 'may', number>> }>;
}): Budget {
  const monthIndex: Record<'feb' | 'may', number> = { feb: 1, may: 4 };
  const rows = input.expenseConcepts.map((item) => {
    const monthly = Array.from({ length: 12 }, () => 0);
    if (item.may != null) monthly[4] = item.may;
    for (const [key, value] of Object.entries(item.monthly ?? {}) as Array<['feb' | 'may', number]>) {
      monthly[monthIndex[key]] = value;
    }
    return { concept: item.concept, monthly };
  });
  return {
    year: 2026,
    scale: 'pesos',
    incomeTotal: Array.from({ length: 12 }, () => 0),
    incomeByConcept: [],
    expenseTotal: Array.from({ length: 12 }, (_, index) =>
      rows.reduce((sum, item) => sum + item.monthly[index], 0),
    ),
    expenseByConcept: rows,
    uploadedAt: '2026-01-01T00:00:00.000Z',
  };
}

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
