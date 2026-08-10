import { describe, expect, it } from 'vitest';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CxpPaymentCoverage, PaymentMatch } from '../../../domain/paymentReconciliationEngine';
import type { AuxiliarReconLine, AuxiliarReconResult } from '../../../domain/auxiliarReconciliationEngine';
import type { CashFlowAssumptions, Client } from '../../../domain/types';
import type { AuxiliarContableRecord, BankAccountStatement, BankStatementLine, CobranzaPayment, CobranzaRecord, PagoProveedorRecord } from '../../../services/jdeTypes';
import { calculateBaseProjection } from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialMovement, PurchaseReceiptRecord, TaxObligation } from '../../shared-finance/types';
import {
  addTaxPaymentPlanItem,
  buildAutomaticTaxReserveMovements,
  buildApprovedTaxPaymentMovements,
  buildTaxByCompany,
  buildTaxByCoordinado,
  buildTaxDashboardView,
  createManualTaxObligation,
  createTaxManualAdjustment,
  defaultTaxStore,
  upsertTaxObligation,
  type TaxCompanyBreakdown,
} from './taxModuleService';

describe('taxModuleService', () => {
  it('detects real historic IVA paid from bank statements and reduces payable', () => {
    const view = buildTaxDashboardView({
      cobranzaPayments: [
        cobranzaPayment({
          idPago: 'PAY-IVA',
          fechaCobro: '2026-05-08',
          importeRecibo: 1160,
          applications: [{
            noFactura: 'C-IVA',
            importeCobrado: 1160,
            importeOriginalFactura: 1160,
            importeIvaFacturaOriginal: 160,
            tasaIva: '16',
          }],
        }),
      ],
      bankStatements: [bank([bankLine({
        fechaOperacion: '2026-05-20',
        concepto: 'PAGO IVA MAYO',
        importe: 100,
      })])],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCaused).toBeCloseTo(160);
    expect(may.realIva.ivaPaid).toBeCloseTo(100);
    expect(may.realIva.payable).toBeCloseTo(60);
    expect(may.realIva.paidLines[0]).toMatchObject({
      concept: 'Pago IVA · PAGO IVA MAYO',
      counterpartyName: 'SAT — IVA',
      sourceSystem: 'BANK',
      taxAmount: 100,
    });
  });

  it('does not treat bank fee IVA as historic IVA paid', () => {
    const view = buildTaxDashboardView({
      bankStatements: [bank([bankLine({
        fechaOperacion: '2026-05-20',
        concepto: 'IVA COMISION SPEI',
        importe: 50,
      })])],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    expect(view.periods).toHaveLength(0);
  });

  it('reflects real IVA payments already classified in projection movements', () => {
    const view = buildTaxDashboardView({
      movements: [
        movement('tax-iva-bank', 'OUTFLOW', 'TAX', '2026-05-18', 250, {
          sourceSystem: 'BANK',
          counterpartyName: 'SAT — IVA',
          concept: 'PAGO REFERENCIADO IVA',
          subcategory: 'IVA',
          status: 'REAL',
        }),
      ],
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaPaid).toBe(250);
    expect(may.realIva.balanceInFavor).toBe(250);
    expect(may.realIva.paidLines[0]).toMatchObject({
      concept: 'Pago IVA · PAGO REFERENCIADO IVA',
      sourceSystem: 'BANK',
    });
  });

  it('reads REAL IVA acreditable from the ledger and causado from real cobranza (not the ledger trasladado accounts)', () => {
    const view = buildTaxDashboardView({
      // El acreditable sale del ledger (autoritativo, los estimadores CXP/OC se
      // omiten). El causado sale de la cobranza aplicada (base-cobro), NO de la
      // cuenta de IVA trasladado del ledger: ese lado mezcla devengado/no-cobrado
      // e infla el causado.
      cobranzaPayments: [
        cobranzaPayment({
          idPago: 'PAY-X',
          fechaCobro: '2026-05-08',
          importeRecibo: 1160,
          applications: [{
            noFactura: 'C-X',
            importeCobrado: 1160,
            importeOriginalFactura: 1160,
            importeIvaFacturaOriginal: 160,
            tasaIva: '16',
          }],
        }),
      ],
      cxpRecords: [
        cxpRecord({
          noFactura: 'F-X',
          fechaProgramacionPago: '2026-05-07',
          importeSubtotalPesos: 50000,
          importeImpuestosPesos: 8000,
          importeBrutoPesos: 58000,
          importePendientePesos: 58000,
        }),
      ],
      auxiliarIvaRecords: [
        auxIvaRecord({ nombreCuenta: 'IVA ACREDITABLE PAGADO', cuentaObjeto: '1180', importe: 1600, fechaContable: '2026-05-10' }),
        // La cuenta de IVA trasladado del ledger NO debe alimentar el causado.
        auxIvaRecord({ nombreCuenta: 'IVA TRASLADADO', cuentaObjeto: '2160', importe: 3200, fechaContable: '2026-05-12' }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(1600);
    // Causado = IVA de la cobranza (160), NO el 3200 de la cuenta trasladado.
    expect(may.realIva.ivaCaused).toBeCloseTo(160);
    expect(may.realIva.payable).toBeCloseTo(0);
    expect(may.realIva.balanceInFavor).toBeCloseTo(1440);
    expect(may.realIva.expenseLines[0].concept).toContain('libro mayor');
    expect(may.realIva.incomeLines[0].concept).toContain('Cobro PAY-X');
    // El lado de egresos/ingresos se surface a los totales del rango (Taller 8-jul).
    expect(view.totals.ivaCaused).toBeCloseTo(160);
    expect(view.totals.ivaCreditable).toBeCloseTo(1600);
  });

  it('takes caused IVA from real cobranza while reading creditable from the ledger', () => {
    const view = buildTaxDashboardView({
      cobranzaPayments: [
        cobranzaPayment({
          idPago: 'PAY-IVA-CAUSED',
          fechaCobro: '2026-05-12',
          importeRecibo: 1160,
          applications: [{
            noFactura: 'C-IVA',
            importeCobrado: 1160,
            importeOriginalFactura: 1160,
            importeIvaFacturaOriginal: 160,
            tasaIva: '16',
          }],
        }),
      ],
      auxiliarIvaRecords: [
        auxIvaRecord({ nombreCuenta: 'IVA ACREDITABLE PAGADO', cuentaObjeto: '1180', importe: 1600, fechaContable: '2026-05-10' }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(1600);
    expect(may.realIva.ivaCaused).toBeCloseTo(160);
    expect(may.realIva.expenseLines).toHaveLength(1);
    expect(may.realIva.incomeLines[0].concept).toContain('Cobro PAY-IVA-CAUSED');
  });

  it('falls back to estimators when there is no IVA ledger coverage', () => {
    const view = buildTaxDashboardView({
      cobranzaPayments: [
        cobranzaPayment({
          idPago: 'PAY-IVA',
          fechaCobro: '2026-05-08',
          importeRecibo: 1160,
          applications: [{
            noFactura: 'C-IVA',
            importeCobrado: 1160,
            importeOriginalFactura: 1160,
            importeIvaFacturaOriginal: 160,
            tasaIva: '16',
          }],
        }),
      ],
      auxiliarIvaRecords: [],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCaused).toBeCloseTo(160);
  });

  it('calculates forecast IVA from projected CXC and scheduled JDE CXP invoice fields', () => {
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
      ivaMode: 'FORECAST',
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

  it('excludes Fiscal-listed concepts (nómina/vales/…) from creditable IVA', () => {
    const view = buildTaxDashboardView({
      cxpRecords: [
        // Proveedor legítimo → SÍ acredita.
        cxpRecord({
          nombre: 'Diesel del Norte SA',
          noFactura: 'F-OK',
          fechaProgramacionPago: '2026-05-07',
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 160,
          importeBrutoPesos: 1160,
          importePendientePesos: 1160,
        }),
        // Nómina → NO acredita (concepto excluido por Fiscal).
        cxpRecord({
          nombre: 'Nomina Operadores',
          noFactura: 'F-NOM',
          fechaProgramacionPago: '2026-05-08',
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 160,
          importeBrutoPesos: 1160,
          importePendientePesos: 1160,
        }),
        // Vales de despensa → NO acredita.
        cxpRecord({
          nombre: 'Proveedor de Vales',
          noFactura: 'F-VAL',
          fechaProgramacionPago: '2026-05-09',
          importeSubtotalPesos: 2000,
          importeImpuestosPesos: 320,
          importeBrutoPesos: 2320,
          importePendientePesos: 2320,
        }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // Sólo el proveedor legítimo (160) — nómina y vales quedan fuera.
    expect(may.iva.ivaCreditable).toBeCloseTo(160);
    expect(may.iva.expenseLines).toHaveLength(1);
    expect(may.iva.expenseLines[0].concept).toContain('F-OK');
  });

  it('prorates forecast CXP invoices and leaves invoices without fiscal fields unclassified', () => {
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
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.expenseBase16).toBeCloseTo(500);
    expect(may.iva.ivaCreditable).toBeCloseTo(80);
    expect(may.iva.unclassifiedExpense).toBe(500);
    expect(may.iva.unclassifiedLines.some((line) => line.concept.includes('F-UNCLEAR'))).toBe(true);
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

  it('keeps paid CXP IVA in real and projected remainder in forecast when BOTH mode is used', () => {
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
      ivaMode: 'BOTH',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    const jun = view.periods.find((period) => period.period === '2026-06')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(80);
    expect(may.forecastIva.ivaCreditable).toBe(0);
    expect(jun.realIva.ivaCreditable).toBe(0);
    expect(jun.forecastIva.ivaCreditable).toBeCloseTo(80);
    expect(jun.forecastIva.expenseLines[0].concept).toContain('Remanente proyectado');
  });

  it('uses AuxiliarContable as the paid CXP coverage source while keeping IVA from CXP invoice fields', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noProveedor: 'P-AUX',
      nombre: 'Proveedor Auxiliar',
      noFactura: 'F-AUX',
      fechaProgramacionPago: '2026-06-10',
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importeBrutoPesos: 1160,
      importePendientePesos: 1160,
    });
    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({
          cia: '00011',
          noFactura: 'F-AUX',
          contraparte: 'Proveedor Auxiliar',
          bankDate: '2026-05-12',
          importe: -580,
          bankAmount: -580,
        }),
      ]),
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-06-30',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'BOTH',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    const jun = view.periods.find((period) => period.period === '2026-06')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(80);
    expect(may.realIva.expenseLines[0]).toMatchObject({
      concept: 'Pago Auxiliar PV 2026-05-12 · Factura F-AUX · Proveedor Auxiliar',
      taxAmount: 80,
      rateSource: 'JDE',
    });
    expect(jun.realIva.ivaCreditable).toBe(0);
    expect(jun.forecastIva.ivaCreditable).toBeCloseTo(80);
    expect(jun.forecastIva.expenseLines[0].concept).toContain('Remanente proyectado');
  });

  it('keeps PagoProveedor CXP coverage when AuxiliarContable has non-invoice egreso lines', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noProveedor: 'P-PAGO',
      nombre: 'Proveedor PagoProveedor',
      noFactura: 'F-PAGO',
      fechaProgramacionPago: '2026-06-10',
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
        payments: [{ noPago: 'PP-1', fechaPago: '2026-05-12', importe: 1160, tier: 'invoice-amount' }],
      })]]),
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({
          cia: '00011',
          noFactura: 'PV-ONLY',
          contraparte: 'Proveedor PagoProveedor',
          bankDate: '2026-05-12',
          importe: -1160,
          bankAmount: -1160,
          sourceKind: 'pago',
        }),
      ]),
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-06-30',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    expect(may.realIva.expenseLines[0]).toMatchObject({
      concept: 'Pago PP-1 · Factura F-PAGO · Proveedor PagoProveedor',
      taxAmount: 160,
      rateSource: 'JDE',
    });
  });

  it('uses Auxiliar pago plus PaymentMatch CXP fields as real creditable IVA', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noProveedor: 'P-PAGO-CXP',
      nombre: 'Proveedor pago CXP',
      noFactura: 'F-PAGO-CXP',
      fechaProgramacionPago: '2026-06-10',
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importeBrutoPesos: 1160,
      importePendientePesos: 1160,
    });
    const payment = pagoProveedor({
      cia: '00011',
      tipoPago: 'PT',
      noPago: '900',
      claveProveedor: 'P-PAGO-CXP',
      nombreProveedor: 'Proveedor pago CXP',
      fechaPago: '2026-05-12',
      importePesos: 1160,
      comentarioPago: 'Pago factura F-PAGO-CXP',
    });

    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      paymentMatches: [paymentMatch(payment, [{ cxp, tier: 'invoice-amount', confidence: 0.96 }])],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({
          cia: '00011',
          noFactura: 'PT900',
          contraparte: 'Proveedor pago CXP',
          bankDate: '2026-05-12',
          importe: -1160,
          bankAmount: -1160,
          sourceKind: 'pago',
        }),
      ]),
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-06-30',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    expect(may.realIva.expenseLines[0]).toMatchObject({
      concept: 'Pago PT900 · Factura F-PAGO-CXP · Proveedor pago CXP',
      taxBase: 1000,
      taxAmount: 160,
      rateSource: 'JDE',
    });
  });

  it('uses Auxiliar pago plus PagoProveedor to find paid Compras receipts when CXP is gone', () => {
    const payment = pagoProveedor({
      cia: '00011',
      tipoPago: 'PV',
      noPago: '901',
      claveProveedor: 'P-COMPRA',
      nombreProveedor: 'Proveedor Compra pagada',
      fechaPago: '2026-05-18',
      importePesos: 1160,
      comentarioPago: 'Pago factura F-COMPRA-901 OC-901',
    });

    const view = buildTaxDashboardView({
      purchaseReceipts: [
        purchaseReceipt({
          cia: '00011',
          noProveedor: 'P-COMPRA',
          supplierName: 'Proveedor Compra pagada',
          invoiceNo: 'F-COMPRA-901',
          purchaseOrderNo: 'OC-901',
          amountMxn: 1160,
          totalAmount: 1160,
          taxRate: 16,
          taxRateCode: 'IVA16',
          taxTreatment: 'IVA_CREDITABLE',
          taxBaseAmount: 1000,
          taxAmount: 160,
        }),
      ],
      paymentMatches: [paymentMatch(payment, [])],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({
          cia: '00011',
          noFactura: 'PV901',
          contraparte: 'Proveedor Compra pagada',
          bankDate: '2026-05-18',
          importe: -1160,
          bankAmount: -1160,
          sourceKind: 'pago',
        }),
      ]),
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    expect(may.realIva.expenseLines[0]).toMatchObject({
      concept: 'OC pagada F-COMPRA-901 · Proveedor Compra pagada',
      taxBase: 1000,
      taxAmount: 160,
      estimated: false,
    });
  });

  it('estimates real IVA from confirmed Auxiliar income and operational expense flows when no fiscal document resolved them', () => {
    const view = buildTaxDashboardView({
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({
          cia: '00011',
          noFactura: 'RI-AUX-ONLY',
          contraparte: 'Cliente Auxiliar',
          bankDate: '2026-05-10',
          importe: 1160,
          bankAmount: 1160,
          flujo: 'ingreso',
          sourceKind: 'factura',
          tipoDoctoDesc: 'Recibo factura',
        }),
        auxiliarLine({
          cia: '00011',
          noFactura: 'SERV-AUX-ONLY',
          contraparte: 'Proveedor Servicio Diesel',
          bankDate: '2026-05-12',
          importe: -1160,
          bankAmount: -1160,
          sourceKind: 'otro',
          tipoDoctoDesc: 'Servicio operativo',
        }),
      ]),
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCaused).toBeCloseTo(160);
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    expect(may.realIva.incomeLines[0]).toMatchObject({
      concept: 'IVA estimado Auxiliar · Recibo factura · RI-AUX-ONLY · Cliente Auxiliar',
      estimated: true,
    });
    expect(may.realIva.incomeLines[0].taxBase).toBeCloseTo(1000);
    expect(may.realIva.incomeLines[0].taxAmount).toBeCloseTo(160);
    expect(may.realIva.expenseLines[0]).toMatchObject({
      concept: 'IVA estimado Auxiliar · Servicio operativo · SERV-AUX-ONLY · Proveedor Servicio Diesel',
      estimated: true,
    });
    expect(may.realIva.expenseLines[0].taxBase).toBeCloseTo(1000);
    expect(may.realIva.expenseLines[0].taxAmount).toBeCloseTo(160);
  });

  it('does not estimate Auxiliar IVA for SAT, payroll or debt-like flows', () => {
    const view = buildTaxDashboardView({
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({
          cia: '00011',
          noFactura: 'PAGO-IVA',
          contraparte: 'SAT',
          bankDate: '2026-05-17',
          importe: -1160,
          bankAmount: -1160,
          sourceKind: 'otro',
          tipoDoctoDesc: 'Pago IVA SAT',
        }),
        auxiliarLine({
          cia: '00011',
          noFactura: 'NOMINA',
          contraparte: 'Nomina semanal',
          bankDate: '2026-05-18',
          importe: -1160,
          bankAmount: -1160,
          sourceKind: 'otro',
          tipoDoctoDesc: 'Nomina',
        }),
      ]),
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    expect(view.periods).toHaveLength(0);
  });

  it('keeps Auxiliar pago without fiscal document unclassified instead of inventing IVA', () => {
    const payment = pagoProveedor({
      cia: '00011',
      tipoPago: 'PV',
      noPago: '902',
      claveProveedor: 'P-NO-CFDI',
      nombreProveedor: 'Proveedor sin CFDI',
      fechaPago: '2026-05-19',
      importePesos: 1160,
      comentarioPago: 'Pago sin CFDI fiscal',
    });
    const view = buildTaxDashboardView({
      paymentMatches: [paymentMatch(payment, [])],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({
          cia: '00011',
          noFactura: 'PV902',
          contraparte: 'Proveedor sin CFDI',
          bankDate: '2026-05-19',
          importe: -1160,
          bankAmount: -1160,
          sourceKind: 'pago',
        }),
      ]),
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBe(0);
    expect(may.realIva.unclassifiedExpense).toBe(1160);
    expect(may.realIva.unclassifiedLines[0]).toMatchObject({
      concept: 'Pago proveedor sin desglose fiscal PV902',
      taxAmount: 0,
      estimated: false,
    });
  });

  it('calculates real creditable IVA from paid purchase receipts when CXP is no longer open', () => {
    const view = buildTaxDashboardView({
      purchaseReceipts: [
        purchaseReceipt({
          cia: '00011',
          noProveedor: 'P-OC',
          supplierName: 'Proveedor OC pagada',
          invoiceNo: 'F-OC-PAID',
          purchaseOrderNo: 'OC-PAID',
          amountMxn: 1160,
          totalAmount: 1160,
          taxRate: 16,
          taxRateCode: 'IVA16',
          taxTreatment: 'IVA_CREDITABLE',
          taxBaseAmount: 1000,
          taxAmount: 160,
        }),
      ],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({
          cia: '00011',
          noFactura: 'OC-PAID',
          contraparte: 'Proveedor OC pagada',
          bankDate: '2026-05-22',
          importe: -1160,
          bankAmount: -1160,
          sourceKind: 'oc',
        }),
      ]),
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    expect(may.realIva.expenseLines[0]).toMatchObject({
      concept: 'OC pagada F-OC-PAID · Proveedor OC pagada',
      taxBase: 1000,
      taxAmount: 160,
      rateSource: 'JDE',
      estimated: false,
    });
  });

  it('REAL mode skips projected IVA from open CXP, clients, purchase receipts, budget and generic movements', () => {
    const view = buildTaxDashboardView({
      clients: [client({ id: 'projected', name: 'Cliente proyectado', ivaRate: 16, mayBilling: 1000 })],
      assumptions,
      cxpRecords: [
        cxpRecord({
          noFactura: 'F-ONLY',
          fechaProgramacionPago: '2026-05-07',
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 160,
          importeBrutoPesos: 1160,
          importePendientePesos: 1160,
        }),
      ],
      purchaseReceipts: [
        purchaseReceipt({
          invoiceNo: 'OC-IVA',
          amountMxn: 1160,
          totalAmount: 1160,
          taxRate: 16,
          taxTreatment: 'IVA_CREDITABLE',
        }),
      ],
      budget: budget({ expenseConcepts: [{ concept: 'Diésel', may: 1160 }] }),
      movements: [
        movement('movement-iva', 'OUTFLOW', 'OPEX', '2026-05-20', 1160, {
          taxTreatment: 'IVA_CREDITABLE',
          taxRate: 16,
        }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.ivaCaused).toBe(0);
    expect(may.iva.ivaCreditable).toBe(0);
    expect(may.iva.expenseLines).toHaveLength(0);
  });

  it('does not invent forecast CXP IVA when the invoice has no fiscal fields', () => {
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
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.ivaCreditable).toBe(0);
    expect(may.iva.unclassifiedExpense).toBe(1080);
    expect(may.iva.expenseLines).toHaveLength(0);
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
      ivaMode: 'FORECAST',
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
      ivaMode: 'FORECAST',
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
      ivaMode: 'FORECAST',
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
      ivaMode: 'FORECAST',
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
      ivaMode: 'FORECAST',
    });

    const feb = view.periods.find((period) => period.period === '2026-02')!;
    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(feb.iva.ivaCreditable).toBeCloseTo(160);
    expect(feb.iva.expenseLines[0]).toMatchObject({ estimated: true, taxRate: 16 });
    expect(may.iva.ivaCreditable).toBeCloseTo(160);
    expect(may.iva.expenseLines).toHaveLength(1);
  });

  it('keeps invoice fiscal fields authoritative over provider IVA overrides for CXP', () => {
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
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.expenseBase16).toBeCloseTo(1000);
    expect(may.iva.ivaCreditable16).toBeCloseTo(160);
    expect(may.iva.expenseLines[0]).toMatchObject({
      taxRate: 16,
      rateSource: 'JDE',
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
      ivaMode: 'FORECAST',
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
      ivaMode: 'FORECAST',
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

  it('derives caused IVA from deposit-only collections at 16% (default) and 8% (frontera resolver)', () => {
    const deposit = (importeCobrado: number) => cobranzaPayment({
      idPago: 'PAY-DEP',
      fechaCobro: '2026-05-12',
      importeRecibo: importeCobrado,
      applications: [{
        noFactura: 'RI-DEP',
        importeCobrado,
        importeOriginalFactura: 0,
        importeIvaFacturaOriginal: 0, // sólo el depósito, sin desglose de factura
        tasaIva: 'IVA',               // gravable, sin tasa explícita
      }],
    });

    // 16% por defecto (catálogo fronterizo vacío): base = depósito/1.16.
    const view16 = buildTaxDashboardView({
      cobranzaPayments: [deposit(1160)],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
    });
    const may16 = view16.periods.find((period) => period.period === '2026-05')!;
    expect(may16.iva.incomeBase16).toBeCloseTo(1000);
    expect(may16.iva.ivaCaused16).toBeCloseTo(160);
    expect(may16.iva.ivaCaused8).toBe(0);

    // 8% cuando el resolver marca la empresa como fronteriza: base = depósito/1.08.
    const view8 = buildTaxDashboardView({
      cobranzaPayments: [deposit(1080)],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      incomeIvaRateResolver: () => 8,
    });
    const may8 = view8.periods.find((period) => period.period === '2026-05')!;
    expect(may8.iva.incomeBase8).toBeCloseTo(1000);
    expect(may8.iva.ivaCaused8).toBeCloseTo(80);
    expect(may8.iva.ivaCaused16).toBe(0);
  });

  it('does NOT over-tax exempt / zero-rate / indicator-less deposit collections', () => {
    const mk = (tasaIva: string) => cobranzaPayment({
      idPago: `PAY-${tasaIva || 'BLANK'}`,
      fechaCobro: '2026-05-12',
      importeRecibo: 1000,
      applications: [{
        noFactura: 'RI',
        importeCobrado: 1000,
        importeOriginalFactura: 1000,
        importeIvaFacturaOriginal: 0,
        tasaIva,
      }],
    });
    const view = buildTaxDashboardView({
      // Aun con resolver fronterizo activo, los exentos NO se gravan.
      cobranzaPayments: [mk('EXENTO'), mk('TASA 0'), mk('')],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      incomeIvaRateResolver: () => 8,
    });
    const may = view.periods.find((period) => period.period === '2026-05');
    expect(may?.iva.ivaCaused ?? 0).toBe(0);
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

  it('counts manual IVA adjustments ONCE in totals (period.iva.ivaCaused already includes them)', () => {
    const store = {
      ...defaultTaxStore(),
      adjustments: [
        createTaxManualAdjustment({
          taxType: 'IVA',
          period: '2026-05',
          kind: 'IVA_CAUSED',
          amount: 100,
        }),
        createTaxManualAdjustment({
          taxType: 'IVA',
          period: '2026-05',
          kind: 'IVA_CREDITABLE',
          amount: 40,
        }),
      ],
    };
    const view = buildTaxDashboardView({
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store,
      today: '2026-05-01',
    });
    const may = view.periods.find((period) => period.period === '2026-05')!;
    // El detalle del periodo ya trae el manual sumado…
    expect(may.iva.ivaCaused).toBe(100);
    expect(may.iva.ivaCreditable).toBe(40);
    // …y los totales del dashboard NO lo vuelven a sumar (antes reportaban 200/80).
    expect(view.totals.ivaCaused).toBe(100);
    expect(view.totals.ivaCreditable).toBe(40);
  });

  it('calculates ISN as 3% of payroll and supports manual override', () => {
    const projection = projectionFor([
      movement('payroll', 'OUTFLOW', 'PAYROLL', '2026-06-15', 1000, {
        taxTreatment: 'IVA_EXEMPT',
      }),
    ]);
    const store = {
      ...defaultTaxStore(),
      adjustments: [
        createTaxManualAdjustment({
          taxType: 'ISN',
          period: '2026-06',
          kind: 'ISN_OVERRIDE',
          amount: 45,
        }),
      ],
    };

    const view = buildTaxDashboardView({ projection, store, today: '2026-06-01' });
    expect(view.periods[0].payrollBase).toBe(1000);
    expect(view.periods[0].isn).toBe(45);
  });

  // ISR se retiró del módulo (Taller 8-jul-2026): los tests de ISR provisional
  // y ISR pagado desde banco se eliminaron. IVA/IMSS/ISN siguen cubiertos.

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

    const movements = buildAutomaticTaxReserveMovements({
      obligations: [obligation],
      scenarioId: 'approved',
      startDate: '2026-09-01',
      endDate: '2026-09-30',
      asOfDate: '2026-08-01',
    });

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      category: 'TAX',
      projectedAmount: 600,
      projectedDate: '2026-09-17',
      lockState: 'RESTRICTED',
    });
  });

  it('separates taxes by internal company (buildTaxByCompany)', () => {
    const withCia = (payment: CobranzaPayment, cia: string): CobranzaPayment => ({
      ...payment,
      cia,
      applications: payment.applications.map((app) => ({ ...app, cia })),
    });
    const payA = withCia(cobranzaPayment({
      idPago: 'PA',
      fechaCobro: '2026-05-08',
      importeRecibo: 1160,
      applications: [{ noFactura: 'A1', importeCobrado: 1160, importeOriginalFactura: 1160, importeIvaFacturaOriginal: 160, tasaIva: '16' }],
    }), '00011');
    const payB = withCia(cobranzaPayment({
      idPago: 'PB',
      fechaCobro: '2026-05-08',
      importeRecibo: 580,
      applications: [{ noFactura: 'B1', importeCobrado: 580, importeOriginalFactura: 580, importeIvaFacturaOriginal: 80, tasaIva: '16' }],
    }), '00022');

    const params = {
      cobranzaPayments: [payA, payB],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL' as const,
    };

    const breakdown = buildTaxByCompany(params, [
      { cia: '00011', nombre: 'Empresa A' },
      { cia: '00022', nombre: 'Empresa B' },
    ]);

    expect(breakdown).toHaveLength(2);
    // Sorted by total desc — Empresa A (more income) leads.
    expect(breakdown[0].cia).toBe('00011');
    const a = breakdown.find((row) => row.cia === '00011')!;
    const b = breakdown.find((row) => row.cia === '00022')!;
    expect(a.nombre).toBe('Empresa A');
    expect(b.nombre).toBe('Empresa B');
    expect(a.totals.ivaNet).toBeCloseTo(160);
    expect(b.totals.ivaNet).toBeCloseTo(80);

    // The per-company split reconciles to the consolidated view.
    const consolidated = buildTaxDashboardView(params);
    expect(a.totals.ivaNet + b.totals.ivaNet).toBeCloseTo(consolidated.totals.ivaNet);
  });

  it('keeps a company with ONLY ledger creditable IVA in the breakdown (ivaNet=0, grossIncome=0)', () => {
    // Cia con puro gasto (acreditable del ledger, sin cobranza): payable se
    // clampa a 0 y grossIncome es 0 — antes el predicado hasData la omitía y
    // el acreditable del grupo quedaba subestimado.
    const breakdown = buildTaxByCompany({
      auxiliarIvaRecords: [
        auxIvaRecord({ nombreCuenta: 'IVA ACREDITABLE PAGADO', cuentaObjeto: '1180', importe: 1600, fechaContable: '2026-05-10', cia: '00042' }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL' as const,
    }, []);

    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].cia).toBe('00042');
    expect(breakdown[0].totals.ivaCreditable).toBeCloseTo(1600);
    expect(breakdown[0].totals.ivaNet).toBe(0);
  });

  it('omits companies without tax movement and falls back to cia as name', () => {
    const payA = cobranzaPayment({
      idPago: 'PA',
      fechaCobro: '2026-05-08',
      importeRecibo: 1160,
      applications: [{ noFactura: 'A1', importeCobrado: 1160, importeOriginalFactura: 1160, importeIvaFacturaOriginal: 160, tasaIva: '16' }],
    });

    const breakdown = buildTaxByCompany({
      cobranzaPayments: [payA],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL' as const,
    }, []);

    expect(breakdown).toHaveLength(1);
    // cobranzaPayment defaults cia '00011'; no catalog entry → name falls back to cia.
    expect(breakdown[0].cia).toBe('00011');
    expect(breakdown[0].nombre).toBe('00011');
  });

  it('rolls up the per-company breakdown by coordinado fiscal (buildTaxByCoordinado)', () => {
    const row = (cia: string, nombre: string, ivaNet: number): TaxCompanyBreakdown => ({
      cia,
      nombre,
      totals: {
        ivaCaused: ivaNet + 10,
        ivaCreditable: 10,
        ivaNet,
        isn: 0,
        imss: 0,
        total: ivaNet,
        totalWithOverdue: ivaNet,
        cashImpact: 0,
        unclassified: 0,
        grossIncome: ivaNet * 6,
      },
    });
    const breakdown = [
      row('00001', 'Transportes CIR', 100),
      row('00002', 'Servicio Industrial Potosino', 50),
      row('00010', 'Transportes Tamaulipas', 200),
      row('00099', 'Empresa Genérica', 30),
    ];

    const resolver = (_cia: string, nombre: string) => {
      if (/CIR|potosin/i.test(nombre)) return 'SIRES';
      if (/tamaulipas/i.test(nombre)) return 'Federal';
      return 'Sin coordinado';
    };
    const groups = buildTaxByCoordinado(breakdown, resolver);

    // Tres grupos, ordenados por total desc: Federal (200) > SIRES (150) > Sin coordinado (30).
    expect(groups.map((g) => g.coordinado)).toEqual(['Federal', 'SIRES', 'Sin coordinado']);
    const sires = groups.find((g) => g.coordinado === 'SIRES')!;
    expect(sires.companies.map((c) => c.cia)).toEqual(['00001', '00002']);
    expect(sires.totals.ivaNet).toBe(150);
    expect(sires.totals.ivaCaused).toBe(170); // (100+10) + (50+10)
    expect(sires.totals.ivaCreditable).toBe(20);
    // El consolidado de los grupos reconcilia con la suma de todas las cias.
    const grand = groups.reduce((sum, g) => sum + g.totals.ivaNet, 0);
    expect(grand).toBe(380);
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
      tasaIva: app.tasaIva,
      importeIvaFacturaOriginal: app.importeIvaFacturaOriginal,
    })),
  };
}

function bank(movimientos: BankStatementLine[] = []): BankAccountStatement {
  return {
    cia: '00011',
    banco: 'BANAMEX',
    cuenta: '123',
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-05-31',
    movimientos,
  };
}

function bankLine(patch: Partial<BankStatementLine> = {}): BankStatementLine {
  return {
    cia: patch.cia ?? '00011',
    banco: patch.banco ?? 'BANAMEX',
    nombreBanco: patch.nombreBanco ?? 'BANAMEX',
    cuenta: patch.cuenta ?? '123',
    moneda: patch.moneda ?? 'MXN',
    fechaOperacion: patch.fechaOperacion ?? '2026-05-20',
    referencia: patch.referencia ?? 'REF-IVA',
    concepto: patch.concepto ?? 'PAGO IVA',
    tipoMovimiento: patch.tipoMovimiento ?? 'CARGO',
    importe: patch.importe ?? 100,
    infAdi1: patch.infAdi1,
    infAdi2: patch.infAdi2,
    infAdi3: patch.infAdi3,
    gsaid: patch.gsaid,
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

function pagoProveedor(patch: Partial<PagoProveedorRecord> = {}): PagoProveedorRecord {
  return {
    tipoPago: patch.tipoPago ?? 'PV',
    noPago: patch.noPago ?? '900',
    cia: patch.cia ?? '00011',
    nombreCia: patch.nombreCia ?? 'Senda',
    cuentaBancaria: patch.cuentaBancaria ?? 'BANAMEX',
    cuentaBanco: patch.cuentaBanco ?? '123',
    fechaPago: patch.fechaPago ?? '2026-05-12',
    importePesos: patch.importePesos ?? 1160,
    moneda: patch.moneda ?? 'MXN',
    batchPago: patch.batchPago ?? 'B-PP',
    claveProveedor: patch.claveProveedor ?? 'P-1',
    rfcProveedor: patch.rfcProveedor ?? 'RFC010101',
    nombreProveedor: patch.nombreProveedor ?? 'Proveedor IVA',
    tipoBusqueda: patch.tipoBusqueda ?? '',
    clasificacionProveedor: patch.clasificacionProveedor ?? '',
    clasificacionProveedorFinanciera: patch.clasificacionProveedorFinanciera ?? '',
    comentarioPago: patch.comentarioPago ?? '',
  };
}

function paymentMatch(
  payment: PagoProveedorRecord,
  cxpMatches: PaymentMatch['cxpMatches'],
): PaymentMatch {
  return {
    payment,
    status: cxpMatches.length > 0 ? 'MATCHED_CXP_ONLY' : 'MATCHED_BANK_ONLY',
    bankCoverage: 'covered',
    cxpMatches,
    reason: 'test match',
  };
}

function auxiliarResult(lines: AuxiliarReconLine[]): AuxiliarReconResult {
  return {
    lines,
    bankOrphans: [],
    inconsistencies: [],
    sourceConfirmation: new Map(),
    reconciledByCompanyMonth: new Map(),
    summary: {
      totalLineas: lines.length,
      ingresoLineas: 0,
      ingresoCruzadas: 0,
      ingresoMonto: 0,
      ingresoMontoCruzado: 0,
      pctIngresoCruzado: 0,
      egresoLineas: lines.length,
      egresoCruzadas: lines.length,
      egresoMonto: lines.reduce((sum, line) => sum + Math.abs(line.importe), 0),
      egresoMontoCruzado: lines.reduce((sum, line) => sum + Math.abs(line.importe), 0),
      pctEgresoCruzado: lines.length > 0 ? 100 : 0,
      conciliadasJde: 0,
      cruzadasSinR: 0,
      cajaLineas: 0,
      cajaMonto: 0,
      internoLineas: 0,
      internoMonto: 0,
      asientoInternoLineas: 0,
      asientoInternoMonto: 0,
      asientoContableLineas: 0,
      asientoContableMonto: 0,
      pendienteRevisionLineas: 0,
      pendienteRevisionMonto: 0,
      sinBancoLineas: 0,
      sinBancoMonto: 0,
      sinCuentaAuxLineas: 0,
      sinCuentaAuxMonto: 0,
      cuentaNoEnBancoLineas: 0,
      cuentaNoEnBancoMonto: 0,
      timingPendienteLineas: 0,
      timingPendienteMonto: 0,
      glOrphanLineas: 0,
      glOrphanMonto: 0,
      bankOrphanLineas: 0,
      bankOrphanMonto: 0,
      bankOrphanOutOfWindowLineas: 0,
      bankOrphanOutOfWindowMonto: 0,
      auxWindow: { min: null, max: null },
      ciaBreakdown: [],
      inconsistencyCounts: {
        'non-bank-batch-in-1020': 0,
      },
      matchTierBreakdown: [],
    },
  };
}

function auxiliarLine(patch: {
  cia: string;
  noFactura: string;
  contraparte: string;
  bankDate: string;
  importe: number;
  bankAmount?: number;
  flujo?: AuxiliarReconLine['flujo'];
  sourceKind?: AuxiliarReconLine['source']['kind'];
  tipoDoctoDesc?: string;
}): AuxiliarReconLine {
  return {
    glKey: `${patch.cia}::aux::PV::${patch.noFactura}`,
    cia: patch.cia,
    cuentaBanco: '70144758151',
    nombreCuenta: 'BANAMEX CTA',
    cuentaContable: '42.1020.0010409',
    cuentaObjeto: '1020',
    idCuenta: '0010409',
    flujo: patch.flujo ?? 'egreso',
    esCaja: false,
    fechaContable: patch.bankDate,
    importe: patch.importe,
    moneda: 'MXP',
    tipoDocto: 'PV',
    tipoDoctoDesc: patch.tipoDoctoDesc ?? 'Pago',
    estatusConciliado: '',
    matchTier: 'exact',
    confidence: 0.97,
    bankMovementKey: `bank:${patch.noFactura}`,
    bankDate: patch.bankDate,
    bankAmount: patch.bankAmount,
    source: {
      kind: patch.sourceKind ?? 'factura',
      cia: patch.cia,
      ref: patch.noFactura,
      contraparte: patch.contraparte,
    },
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
    subcategory: patch.subcategory,
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
    status: patch.status ?? 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

function auxIvaRecord(patch: Partial<AuxiliarContableRecord>): AuxiliarContableRecord {
  return {
    cia: '00011',
    cuentaContable: '11.1180.0000',
    idCuenta: `id-${Math.random().toString(36).slice(2, 8)}`,
    cuentaObjeto: '1180',
    nombreCuenta: 'IVA ACREDITABLE PAGADO',
    cuentaBanco: '',
    tipoDocto: 'PV',
    noDocto: Math.floor(Math.random() * 1e6),
    noFactura: '',
    noOrdenCompra: '',
    fechaContable: '2026-05-10',
    tipoLibro: 'AA',
    noBatch: 0,
    tipoBatch: 'V',
    estatusConciliado: '',
    importe: 1600,
    moneda: 'MXP',
    tipoCambio: 1,
    posteo: 'P',
    reversa: '',
    concepto: '',
    explicacion: '',
    nombre: '',
    tipoPago: '',
    noPago: '',
    fechaPago: '',
    documentoOriginal: '',
    importeOriginal: 0,
    ...patch,
  };
}

// La cobertura del causado se mide contra las facturas de cobranza, que NO
// alimentan ningún importe fiscal. Cifras reales de db_Artefactos (2026-08-10):
// marzo 2026 tenía 139 aplicaciones capturadas contra 2 272 facturas pagadas.
describe('cobertura del IVA causado (causedIvaGaps)', () => {
  const invoice = (fechaCobro: string, importeIVA: number): CobranzaRecord =>
    ({ cia: '00011', fechaCobro, importeIVA }) as unknown as CobranzaRecord;

  const build = (cobranzaRecords: CobranzaRecord[], cobranzaPayments: CobranzaPayment[] = []) =>
    buildTaxDashboardView({
      cobranzaPayments,
      cobranzaRecords,
      companyCode: 'all',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      store: defaultTaxStore(),
      today: '2026-08-10',
    });

  it('confiesa el periodo cerrado cuya cobranza aplicada viene incompleta', () => {
    const view = build([invoice('2026-03-12', 35_362_508)]);
    expect(view.causedIvaGaps).toHaveLength(1);
    expect(view.causedIvaGaps[0]).toMatchObject({
      period: '2026-03',
      expectedIva: 35_362_508,
      reportedIva: 0,
      implausible: true,
    });
  });

  it('no confiesa el periodo en curso: sus dos lados están parciales', () => {
    const view = build([invoice('2026-08-03', 8_116_019)]);
    expect(view.causedIvaGaps).toHaveLength(0);
  });

  it('sin facturas de referencia no emite veredicto', () => {
    expect(build([]).causedIvaGaps).toHaveLength(0);
  });

  it('la medición no altera el IVA causado publicado', () => {
    const withReference = build([invoice('2026-03-12', 35_362_508)]);
    const withoutReference = build([]);
    expect(withReference.totals.ivaCaused).toBe(withoutReference.totals.ivaCaused);
    expect(withReference.totals.ivaNet).toBe(withoutReference.totals.ivaNet);
  });
});
