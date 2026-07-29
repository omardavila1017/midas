/**
 * Cobertura de huecos de `taxModuleService.ts` (ramas no cubiertas por
 * `taxModuleService.test.ts`). Sólo pinea el comportamiento REAL del código —
 * cero cambios de fuente. Áreas: fingerprints, persistencia/normalización del
 * TaxStore (incl. migración legacy), overrides de tasa, plan de pagos,
 * cobertura de pagos CXP vía Auxiliar (dedupe/merge/prorrateo), ramas de
 * fechado y no-clasificado de CXP, OCs pagadas sin desglose, estimador
 * direccional con facturas conocidas, fallback de movimientos en FORECAST y
 * el store neutro de buildTaxByCompany.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CXPRecord } from '../../../domain/persistence';
import type { CxpPaymentCoverage, PaymentMatch } from '../../../domain/paymentReconciliationEngine';
import type { AuxiliarReconLine, AuxiliarReconResult, AuxiliarSourceConfirmation } from '../../../domain/auxiliarReconciliationEngine';
import type { Provider } from '../../../domain/types';
import type { CobranzaPayment, PagoProveedorRecord } from '../../../services/jdeTypes';
import type { FinancialMovement, PurchaseReceiptRecord } from '../../shared-finance/types';
import {
  TAX_STORE_KEY,
  addTaxPaymentPlanItem,
  auxiliarTaxCoverageFingerprint,
  buildTaxByCompany,
  buildTaxDashboardView,
  createManualTaxObligation,
  createTaxManualAdjustment,
  cxpPaymentCoverageFingerprint,
  defaultTaxStore,
  loadTaxStore,
  removeTaxPaymentPlanItem,
  saveTaxStore,
  updateTaxPaymentPlanItem,
  upsertTaxRateOverride,
} from './taxModuleService';

const LEGACY_IVA_KEY = 'midas.financialProjection.taxAdjustments.v1';
const LEGACY_OPERATING_KEY = 'midas.operating.scenarios.v1';

const MAY_RANGE = {
  companyCode: 'all',
  startDate: '2026-05-01',
  endDate: '2026-05-31',
  today: '2026-05-01',
} as const;

describe('taxModuleService — coverage fingerprints', () => {
  it('returns sentinel fingerprints for empty inputs', () => {
    expect(auxiliarTaxCoverageFingerprint(undefined)).toBe('aux:0');
    expect(auxiliarTaxCoverageFingerprint(auxiliarResult([]))).toBe('aux:0');
    expect(cxpPaymentCoverageFingerprint(undefined)).toBe('cxpCoverage:0');
    expect(cxpPaymentCoverageFingerprint(new Map())).toBe('cxpCoverage:0');
  });

  it('produces deterministic auxiliar fingerprints that change with the data', () => {
    const mk = (importe: number) => auxiliarResult([
      auxiliarLine({ cia: '00011', noFactura: 'F-1', contraparte: 'Prov', bankDate: '2026-05-12', importe, bankAmount: importe }),
    ]);
    const a = auxiliarTaxCoverageFingerprint(mk(-580));
    expect(a).toMatch(/^aux:1:/);
    expect(auxiliarTaxCoverageFingerprint(mk(-580))).toBe(a);
    expect(auxiliarTaxCoverageFingerprint(mk(-581))).not.toBe(a);
  });

  it('produces deterministic CXP coverage fingerprints that change with payments', () => {
    const mk = (importe: number): Map<string, CxpPaymentCoverage> => new Map([[
      'k1',
      {
        cxpKey: 'k1',
        status: 'PARTIAL' as const,
        totalPaidPesos: importe,
        payments: [{ noPago: 'P-1', fechaPago: '2026-05-10', importe, tier: 'folio-exact' as const }],
      },
    ]]);
    const a = cxpPaymentCoverageFingerprint(mk(580));
    expect(a).toMatch(/^cxpCoverage:1:/);
    expect(cxpPaymentCoverageFingerprint(mk(580))).toBe(a);
    expect(cxpPaymentCoverageFingerprint(mk(581))).not.toBe(a);
  });
});

describe('taxModuleService — TaxStore persistence & normalization', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('round-trips a populated store through save/load and removes the key when the store empties', () => {
    const store = upsertTaxRateOverride(
      {
        ...defaultTaxStore(),
        adjustments: [createTaxManualAdjustment({ taxType: 'IVA', period: '2026-05', kind: 'IVA_PAID', amount: 100 })],
        obligations: [createManualTaxObligation({ taxType: 'IMSS', period: '2026-05', amount: 300 })],
        overdueBalance: 50,
      },
      { targetType: 'PROVIDER', targetKey: 'Diésel Norte', rate: 8, updatedAt: '2026-05-01T00:00:00.000Z' },
    );
    saveTaxStore(store);
    expect(localStorage.getItem(TAX_STORE_KEY)).not.toBeNull();

    const loaded = loadTaxStore();
    expect(loaded.adjustments).toHaveLength(1);
    expect(loaded.adjustments[0].amount).toBe(100);
    expect(loaded.obligations).toHaveLength(1);
    expect(loaded.obligations[0].taxType).toBe('IMSS');
    // La clave del override se normaliza (mayúsculas, sin acentos).
    expect(loaded.taxRateOverrides[0]).toMatchObject({ targetType: 'PROVIDER', targetKey: 'DIESEL NORTE', rate: 8 });
    expect(loaded.overdueBalance).toBe(50);

    saveTaxStore(defaultTaxStore());
    expect(localStorage.getItem(TAX_STORE_KEY)).toBeNull();
  });

  it('swallows localStorage quota errors without throwing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const store = {
      ...defaultTaxStore(),
      adjustments: [createTaxManualAdjustment({ taxType: 'IVA', period: '2026-05', kind: 'IVA_PAID', amount: 1 })],
    };
    expect(() => saveTaxStore(store)).not.toThrow();
  });

  it('falls back to the default store on corrupt JSON and on empty storage', () => {
    expect(loadTaxStore()).toEqual(defaultTaxStore());
    localStorage.setItem(TAX_STORE_KEY, '{corrupt');
    expect(loadTaxStore()).toEqual(defaultTaxStore());
    // Objeto sin ninguna colección → cada campo cae a su fallback.
    localStorage.setItem(TAX_STORE_KEY, '{}');
    expect(loadTaxStore()).toEqual(defaultTaxStore());
  });

  it('normalizes partial / wrong-shaped persisted payloads defensively', () => {
    localStorage.setItem(TAX_STORE_KEY, JSON.stringify({
      adjustments: [
        // Monto string → parseado; kind IMSS_MANUAL válido.
        { taxType: 'IMSS', period: '2026-05', kind: 'IMSS_MANUAL', amount: '150.5' },
        // Ajuste negativo (corrección) se conserva.
        { taxType: 'IVA', period: '2026-05', kind: 'IVA_CAUSED', amount: -50, note: '  baja  ' },
        // kind desconocido → descartado.
        { taxType: 'IVA', period: '2026-05', kind: 'ISR_LEGACY', amount: 10 },
        'junk',
      ],
      obligations: [
        {
          taxType: 'IVA',
          period: '2026-05',
          dueDate: '2026-06-17',
          totalAmount: '1000',
          status: 'OVERDUE', // legacy → PENDING
          risk: 'weird',     // inválido → taxRisk('IVA') = HIGH
          paymentPlan: [
            { date: '2026-06-10', amount: 400, status: 'PAID' },
            { date: 'not-a-date', amount: 1, status: 'PAID' }, // descartado
          ],
        },
        { taxType: 'IVA', period: '2026-05', dueDate: '2026-06-17', totalAmount: -5 }, // negativo → descartado
        { taxType: 'ISR', period: '2026-05', dueDate: '2026-06-17', totalAmount: 10 }, // taxType retirado → descartado
        // Sin paymentPlan + status legacy 'PARTIAL' → plan vacío y CONFIRMED.
        { taxType: 'IMSS', period: '2026-06', dueDate: '2026-07-17', totalAmount: 200, paidAmount: 0, status: 'PARTIAL' },
        // Status desconocido → derivado del plan (sin plan, vence lejos → PROJECTED).
        { taxType: 'ISN', period: '2026-06', dueDate: '2099-07-17', totalAmount: 50, paidAmount: 0, status: 'BOGUS' },
      ],
      taxRateOverrides: [
        { targetType: 'PROVIDER', targetKey: '  Diésel  Norte ', rate: 8 },
        { targetType: 'PROVIDER', targetKey: 'X', rate: 12 }, // tasa fuera de contrato → descartado
        { targetType: 'BOGUS', targetKey: 'X', rate: 8 },     // targetType desconocido → descartado
      ],
      settings: { isrRate: 30 }, // config ISR previa → descartada (settings vacío)
      overdueBalance: 'nope',    // no numérico → fallback 0
    }));

    const loaded = loadTaxStore();
    expect(loaded.adjustments).toHaveLength(2);
    expect(loaded.adjustments[0]).toMatchObject({ taxType: 'IMSS', kind: 'IMSS_MANUAL', amount: 150.5 });
    expect(loaded.adjustments[1]).toMatchObject({ kind: 'IVA_CAUSED', amount: -50, note: 'baja' });

    expect(loaded.obligations).toHaveLength(3);
    const imssOb = loaded.obligations.find((item) => item.taxType === 'IMSS')!;
    expect(imssOb.paymentPlan).toEqual([]);
    expect(imssOb.status).toBe('CONFIRMED'); // legacy PARTIAL → CONFIRMED
    const isnOb = loaded.obligations.find((item) => item.taxType === 'ISN')!;
    expect(isnOb.status).toBe('PROJECTED'); // status inválido → derivado del plan
    const ob = loaded.obligations.find((item) => item.taxType === 'IVA')!;
    expect(ob.totalAmount).toBe(1000);
    expect(ob.status).toBe('PENDING');
    expect(ob.risk).toBe('HIGH');
    expect(ob.paymentPlan).toHaveLength(1);
    // paidAmount ausente → derivado del plan (pagos PAID).
    expect(ob.paidAmount).toBe(400);
    expect(ob.pendingAmount).toBe(600);

    expect(loaded.taxRateOverrides).toHaveLength(1);
    expect(loaded.taxRateOverrides[0].targetKey).toBe('DIESEL NORTE');
    expect(loaded.settings).toEqual({});
    expect(loaded.overdueBalance).toBe(0);
  });

  it('migrates legacy IVA adjustments + operating tax debts once and persists the result', () => {
    localStorage.setItem(LEGACY_IVA_KEY, JSON.stringify([
      { id: 'a1', period: '2026-03', kind: 'IVA_CAUSED', amount: 100, note: ' ajuste ' },
      { period: 'bad-period', kind: 'IVA_CAUSED', amount: 5 },
      { period: '2026-03', kind: 'ISR_PAID', amount: 5 }, // kind legacy no migrable → descartado
      'junk',
    ]));
    localStorage.setItem(LEGACY_OPERATING_KEY, JSON.stringify([
      {
        taxDebts: [
          {
            id: 'd1',
            taxType: 'IVA',
            dueDate: '2026-04-17',
            outstandingAmount: 500,
            paidAmount: 100,
            originalAmount: 600,
            fiscalPeriod: '2026-03',
            label: 'IVA marzo',
            comments: ' deuda ',
            plannedPayments: [
              { id: 'pp1', date: '2026-04-10', amount: 200, note: 'plan' },
              { date: 'bad-date', amount: 10 }, // descartado
            ],
          },
          // Duplicado exacto → dedupeObligations lo colapsa.
          {
            id: 'd1',
            taxType: 'IVA',
            dueDate: '2026-04-17',
            outstandingAmount: 500,
            paidAmount: 100,
            fiscalPeriod: '2026-03',
          },
          // Periodo fiscal no ISO → cae al mes del dueDate.
          { id: 'd2', taxType: 'IMSS', dueDate: '2026-05-17', outstandingAmount: 300, paidAmount: 0, fiscalPeriod: 'Q1-2026' },
          // Sin fiscalPeriod → cae al mes del dueDate.
          { id: 'd4', taxType: 'ISN', dueDate: '2026-06-17', outstandingAmount: 100, paidAmount: 0 },
          // taxType retirado → descartado.
          { id: 'd3', taxType: 'ISR', dueDate: '2026-05-17', outstandingAmount: 300, paidAmount: 0 },
        ],
      },
      { somethingElse: true },
      null,
    ]));

    const loaded = loadTaxStore();
    expect(loaded.adjustments).toHaveLength(1);
    expect(loaded.adjustments[0]).toMatchObject({ id: 'legacy:a1', taxType: 'IVA', period: '2026-03', amount: 100, note: 'ajuste' });

    expect(loaded.obligations).toHaveLength(3);
    const iva = loaded.obligations.find((ob) => ob.taxType === 'IVA')!;
    expect(iva).toMatchObject({
      id: 'legacy:d1',
      period: '2026-03',
      label: 'IVA marzo',
      totalAmount: 600, // 500 pendiente + 100 pagado
      paidAmount: 100,
      pendingAmount: 500,
      comment: 'deuda',
    });
    expect(iva.paymentPlan).toHaveLength(1);
    expect(iva.paymentPlan[0]).toMatchObject({ id: 'legacy:pp1', amount: 200, status: 'DRAFT' });

    const imss = loaded.obligations.find((ob) => ob.taxType === 'IMSS')!;
    expect(imss.period).toBe('2026-05');
    const isn = loaded.obligations.find((ob) => ob.taxType === 'ISN')!;
    expect(isn.period).toBe('2026-06');

    expect(loaded.migratedAt).toBeTruthy();
    // La migración se persiste bajo la llave nueva.
    expect(localStorage.getItem(TAX_STORE_KEY)).not.toBeNull();
  });

  it('ignores malformed legacy payloads and returns the fallback without persisting', () => {
    localStorage.setItem(LEGACY_IVA_KEY, '{not-json');
    localStorage.setItem(LEGACY_OPERATING_KEY, '{not-json');
    expect(loadTaxStore()).toEqual(defaultTaxStore());
    expect(localStorage.getItem(TAX_STORE_KEY)).toBeNull();
  });
});

describe('taxModuleService — rate overrides & payment plan editing', () => {
  it('upserts tax rate overrides by normalized target key', () => {
    const base = defaultTaxStore();
    const withOne = upsertTaxRateOverride(base, {
      targetType: 'PROVIDER',
      targetKey: 'Diésel Norte',
      rate: 16,
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    expect(withOne.taxRateOverrides).toHaveLength(1);
    expect(withOne.taxRateOverrides[0].targetKey).toBe('DIESEL NORTE');

    // Misma clave con casing/acentos distintos → reemplaza, no duplica.
    const updated = upsertTaxRateOverride(withOne, {
      targetType: 'PROVIDER',
      targetKey: '  diesel norte ',
      rate: 8,
      updatedAt: '2026-05-02T00:00:00.000Z',
    });
    expect(updated.taxRateOverrides).toHaveLength(1);
    expect(updated.taxRateOverrides[0].rate).toBe(8);

    // Target distinto → agrega.
    const added = upsertTaxRateOverride(updated, {
      targetType: 'CONCEPT',
      targetKey: 'Renta patios',
      rate: 8,
      updatedAt: '2026-05-02T00:00:00.000Z',
    });
    expect(added.taxRateOverrides).toHaveLength(2);

    // Actualizar uno de dos deja al otro intacto.
    const reUpdated = upsertTaxRateOverride(added, {
      targetType: 'PROVIDER',
      targetKey: 'Diesel Norte',
      rate: 16,
      updatedAt: '2026-05-03T00:00:00.000Z',
    });
    expect(reUpdated.taxRateOverrides).toHaveLength(2);
    expect(reUpdated.taxRateOverrides.find((o) => o.targetType === 'PROVIDER')?.rate).toBe(16);
    expect(reUpdated.taxRateOverrides.find((o) => o.targetType === 'CONCEPT')?.rate).toBe(8);
  });

  it('updates payment plan items defensively and removes them by id', () => {
    const obligation = addTaxPaymentPlanItem({
      obligation: createManualTaxObligation({ taxType: 'IVA', period: '2026-08', amount: 1000 }),
      date: '2026-09-10',
      amount: 400,
    });
    const paymentId = obligation.paymentPlan[0].id;

    const patched = updateTaxPaymentPlanItem(obligation, paymentId, {
      amount: 999,
      date: 'not-a-date', // inválida → conserva la previa
      status: 'APPROVED',
    });
    expect(patched.paymentPlan[0]).toMatchObject({ amount: 999, date: '2026-09-10', status: 'APPROVED' });

    // Monto negativo se clampa a 0; monto omitido conserva el previo.
    const clamped = updateTaxPaymentPlanItem(patched, paymentId, { amount: -5 });
    expect(clamped.paymentPlan[0].amount).toBe(0);
    const noted = updateTaxPaymentPlanItem(patched, paymentId, { note: 'ok' });
    expect(noted.paymentPlan[0].amount).toBe(999);

    // Id inexistente → sin cambios.
    const untouched = updateTaxPaymentPlanItem(patched, 'nope', { amount: 1 });
    expect(untouched.paymentPlan[0].amount).toBe(999);

    expect(removeTaxPaymentPlanItem(patched, paymentId).paymentPlan).toHaveLength(0);
    expect(removeTaxPaymentPlanItem(patched, 'nope').paymentPlan).toHaveLength(1);
  });
});

describe('taxModuleService — Auxiliar CXP payment coverage (dedupe / merge / allocation)', () => {
  it('dedupes identical Auxiliar factura lines and accumulates distinct payments on the same CXP', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noProveedor: 'P-DUP',
      nombre: 'Proveedor Dup',
      noFactura: 'F-DEDUP',
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importeBrutoPesos: 1160,
      importePendientePesos: 1160,
    });
    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({ cia: '00011', noFactura: 'F-DEDUP', contraparte: 'Proveedor Dup', bankDate: '2026-05-12', importe: -580, bankAmount: -580 }),
        // Línea idéntica → dedupe (no doble-cuenta el mismo cargo).
        auxiliarLine({ cia: '00011', noFactura: 'F-DEDUP', contraparte: 'Proveedor Dup', bankDate: '2026-05-12', importe: -580, bankAmount: -580 }),
        // Pago distinto (otra fecha/monto) → sí acumula.
        auxiliarLine({ cia: '00011', noFactura: 'F-DEDUP', contraparte: 'Proveedor Dup', bankDate: '2026-05-19', importe: -290, bankAmount: -290 }),
      ]),
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // 580 → 80 de IVA, 290 → 40. La línea duplicada no suma.
    expect(may.realIva.ivaCreditable).toBeCloseTo(120);
    expect(may.realIva.expenseLines).toHaveLength(2);
  });

  it('builds coverage from Auxiliar sourceConfirmation entries when no matched line exists', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noProveedor: 'P-SC',
      nombre: 'Proveedor SC',
      noFactura: 'F-SC',
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importeBrutoPesos: 1160,
      importePendientePesos: 1160,
    });
    const result = auxiliarResult([
      // Línea de relleno tipo 'pago' (inerte sin paymentMatches) para que
      // summary.totalLineas > 0 sin generar cobertura por línea.
      auxiliarLine({ cia: '00011', noFactura: 'PV999', contraparte: 'Otro', bankDate: '2026-05-14', importe: -10, bankAmount: -10, sourceKind: 'pago' }),
    ]);
    result.sourceConfirmation.set('factura:00011::F-SC', confirmation({
      confirmed: true,
      flujo: 'egreso',
      importe: -1160,
      bankDate: '2026-05-14',
      fechaContable: '2026-05-14',
    }));

    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      auxiliarReconciliation: result,
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    expect(may.realIva.expenseLines[0].concept).toContain('Pago Auxiliar factura F-SC');
    expect(may.realIva.expenseLines[0].date).toBe('2026-05-14');
  });

  it('merges caller-provided coverage with Auxiliar coverage for the same CXP without duplicating payments', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noProveedor: 'P-MERGE',
      nombre: 'Proveedor Merge',
      noFactura: 'F-MERGE',
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
        payments: [{ noPago: 'P-1', fechaPago: '2026-05-10', importe: 580, tier: 'invoice-amount' }],
      })]]),
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({ cia: '00011', noFactura: 'F-MERGE', contraparte: 'Proveedor Merge', bankDate: '2026-05-20', importe: -580, bankAmount: -580 }),
      ]),
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // 580 (PagoProveedor) + 580 (Auxiliar) = factura completa → 160 de IVA.
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    expect(may.realIva.expenseLines).toHaveLength(2);
    const dates = may.realIva.expenseLines.map((line) => line.date).sort();
    expect(dates).toEqual(['2026-05-10', '2026-05-20']);
  });

  it('prorates one Auxiliar pago line across multiple matched CXPs', () => {
    const cxpA = cxpRecord({
      cia: '00011',
      noProveedor: 'P-LOTE',
      nombre: 'Proveedor Lote',
      noFactura: 'F-LOTE-A',
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importeBrutoPesos: 1160,
      importePendientePesos: 1160,
    });
    const cxpB = { ...cxpA, noFactura: 'F-LOTE-B' };
    const payment = pagoProveedor({
      cia: '00011',
      tipoPago: 'PT',
      noPago: '903',
      claveProveedor: 'P-LOTE',
      nombreProveedor: 'Proveedor Lote',
      fechaPago: '2026-05-12',
      importePesos: 2320,
    });

    const view = buildTaxDashboardView({
      cxpRecords: [cxpA, cxpB],
      paymentMatches: [paymentMatch(payment, [
        { cxp: cxpA, tier: 'invoice-amount', confidence: 0.96 },
        { cxp: cxpB, tier: 'invoice-amount', confidence: 0.96 },
      ])],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({ cia: '00011', noFactura: 'PT903', contraparte: 'Proveedor Lote', bankDate: '2026-05-12', importe: -2320, bankAmount: -2320, sourceKind: 'pago' }),
      ]),
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // 1160 asignado a cada factura → 160 + 160 de IVA acreditable.
    expect(may.realIva.ivaCreditable).toBeCloseTo(320);
    expect(may.realIva.expenseLines).toHaveLength(2);
  });

  it('accumulates two Auxiliar pago lines onto the same CXP coverage entry', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noProveedor: 'P-2PAGOS',
      nombre: 'Proveedor Dos Pagos',
      noFactura: 'F-2PAGOS',
      importeSubtotalPesos: 2000,
      importeImpuestosPesos: 320,
      importeBrutoPesos: 2320,
      importePendientePesos: 2320,
    });
    const payment = pagoProveedor({
      cia: '00011',
      tipoPago: 'PT',
      noPago: '904',
      claveProveedor: 'P-2PAGOS',
      nombreProveedor: 'Proveedor Dos Pagos',
      fechaPago: '2026-05-10',
      importePesos: 2320,
    });

    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      paymentMatches: [paymentMatch(payment, [{ cxp, tier: 'invoice-amount', confidence: 0.96 }])],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({ cia: '00011', noFactura: 'PT904', contraparte: 'Proveedor Dos Pagos', bankDate: '2026-05-10', importe: -1160, bankAmount: -1160, sourceKind: 'pago' }),
        auxiliarLine({ cia: '00011', noFactura: 'PT904', contraparte: 'Proveedor Dos Pagos', bankDate: '2026-05-15', importe: -1160, bankAmount: -1160, sourceKind: 'pago' }),
      ]),
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(320);
    expect(may.realIva.expenseLines).toHaveLength(2);
  });

  it('picks the CXP by counterparty name on tolerance-tier lines with duplicated invoice folios', () => {
    const cxpAlfa = cxpRecord({
      cia: '00011',
      noProveedor: 'P-ALFA',
      nombre: 'Alfa Transportes',
      noFactura: 'F-DUP-FOLIO',
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importeBrutoPesos: 1160,
      importePendientePesos: 1160,
    });
    const cxpBeta = { ...cxpAlfa, noProveedor: 'P-BETA', nombre: 'Beta Logistica' };
    const view = buildTaxDashboardView({
      cxpRecords: [cxpAlfa, cxpBeta],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({
          cia: '00011',
          noFactura: 'F-DUP-FOLIO',
          contraparte: 'Beta Logistica',
          bankDate: '2026-05-12',
          importe: -580,
          bankAmount: -580,
          matchTier: 'tolerance',
        }),
      ]),
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(80);
    expect(may.realIva.expenseLines).toHaveLength(1);
    expect(may.realIva.expenseLines[0].counterpartyName).toBe('Beta Logistica');
  });

  it('matches paid Compras receipts by exact amount when the payment comment has no refs', () => {
    const payment = pagoProveedor({
      cia: '00011',
      tipoPago: 'PV',
      noPago: '905',
      claveProveedor: 'P-AMT',
      nombreProveedor: 'Proveedor Monto',
      fechaPago: '2026-05-18',
      importePesos: 1160,
      comentarioPago: 'Pago sin referencia',
    });
    const view = buildTaxDashboardView({
      purchaseReceipts: [purchaseReceipt({
        cia: '00011',
        noProveedor: 'P-AMT',
        supplierName: 'Proveedor Monto',
        invoiceNo: 'F-AMT',
        purchaseOrderNo: '', // sin OC → la fecha sale del índice por recibo
        amountMxn: 1160,
        totalAmount: 1160,
        taxRate: 16,
        taxRateCode: 'IVA16',
        taxTreatment: 'IVA_CREDITABLE',
        taxBaseAmount: 1000,
        taxAmount: 160,
      })],
      paymentMatches: [paymentMatch(payment, [])],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({ cia: '00011', noFactura: 'PV905', contraparte: 'Proveedor Monto', bankDate: '2026-05-18', importe: -1160, bankAmount: -1160, sourceKind: 'pago' }),
        // Pago sin PagoProveedor correspondiente (con matches presentes) →
        // queda no clasificado, no inventa IVA.
        auxiliarLine({ cia: '00011', noFactura: 'PVXXX', contraparte: 'Otro Proveedor', bankDate: '2026-05-19', importe: -10, bankAmount: -10, sourceKind: 'pago' }),
      ]),
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    expect(may.realIva.expenseLines[0].concept).toContain('OC pagada F-AMT');
    expect(may.realIva.unclassifiedExpense).toBe(10);
    expect(may.realIva.unclassifiedLines[0].concept).toContain('PVXXX');
  });

  it('leaves the payment unclassified when several receipts share the same amount (ambiguous match)', () => {
    const payment = pagoProveedor({
      cia: '00011',
      tipoPago: 'PV',
      noPago: '906',
      claveProveedor: 'P-AMB',
      nombreProveedor: 'Proveedor Ambiguo',
      fechaPago: '2026-05-18',
      importePesos: 1160,
      comentarioPago: 'Pago sin referencia',
    });
    const base = {
      cia: '00011',
      noProveedor: 'P-AMB',
      supplierName: 'Proveedor Ambiguo',
      amountMxn: 1160,
      totalAmount: 1160,
      taxRate: 16 as const,
      taxRateCode: 'IVA16',
      taxTreatment: 'IVA_CREDITABLE' as const,
    };
    const view = buildTaxDashboardView({
      purchaseReceipts: [
        purchaseReceipt({ ...base, invoiceNo: 'F-AMB-1', purchaseOrderNo: 'OC-AMB-1', receiptNo: 'R-1' }),
        purchaseReceipt({ ...base, invoiceNo: 'F-AMB-2', purchaseOrderNo: 'OC-AMB-2', receiptNo: 'R-2' }),
      ],
      paymentMatches: [paymentMatch(payment, [])],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({ cia: '00011', noFactura: 'PV906', contraparte: 'Proveedor Ambiguo', bankDate: '2026-05-18', importe: -1160, bankAmount: -1160, sourceKind: 'pago' }),
      ]),
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBe(0);
    expect(may.realIva.unclassifiedExpense).toBe(1160);
  });

  it('takes the full pago line for a matched CXP with zero amounts and leaves it unclassified', () => {
    const cxpZero = cxpRecord({
      cia: '00011',
      noProveedor: 'P-CERO',
      nombre: 'Proveedor Cero',
      noFactura: 'F-CERO',
      importeSubtotalPesos: 0,
      importeImpuestosPesos: 0,
      importeBrutoPesos: 0,
      importePendientePesos: 0,
    });
    const payment = pagoProveedor({
      cia: '00011',
      tipoPago: 'PT',
      noPago: '907',
      claveProveedor: 'P-CERO',
      nombreProveedor: 'Proveedor Cero',
      fechaPago: '2026-05-13',
      importePesos: 1160,
    });
    const view = buildTaxDashboardView({
      cxpRecords: [cxpZero],
      paymentMatches: [paymentMatch(payment, [{ cxp: cxpZero, tier: 'invoice-amount', confidence: 0.9 }])],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({ cia: '00011', noFactura: 'PT907', contraparte: 'Proveedor Cero', bankDate: '2026-05-13', importe: -1160, bankAmount: -1160, sourceKind: 'pago' }),
      ]),
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // El pago completo se asigna a la única CXP (sin montos) — sin campos
    // fiscales no se estima IVA: va a no clasificado.
    expect(may.realIva.ivaCreditable).toBe(0);
    expect(may.realIva.unclassifiedExpense).toBe(1160);
  });
});

describe('taxModuleService — CXP dating & unclassified branches', () => {
  it('falls back to fechaVence and fechaFactura when the scheduled payment date is missing', () => {
    const view = buildTaxDashboardView({
      cxpRecords: [
        cxpRecord({
          noFactura: 'F-VENCE',
          fechaProgramacionPago: '',
          fechaVence: '2026-05-20',
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 160,
          importeBrutoPesos: 1160,
          importePendientePesos: 1160,
        }),
        cxpRecord({
          noFactura: 'F-FACTURA',
          fechaProgramacionPago: '',
          fechaVence: '',
          fechaFactura: '2026-05-03',
          importeSubtotalPesos: 500,
          importeImpuestosPesos: 80,
          importeBrutoPesos: 580,
          importePendientePesos: 580,
        }),
        // Sin ninguna fecha usable → se descarta por completo.
        cxpRecord({
          noFactura: 'F-SIN-FECHA',
          fechaProgramacionPago: '',
          fechaVence: '',
          fechaFactura: '',
          importeSubtotalPesos: 100,
          importeImpuestosPesos: 16,
          importeBrutoPesos: 116,
          importePendientePesos: 116,
        }),
      ],
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.ivaCreditable).toBeCloseTo(240);
    const byInvoice = new Map(may.iva.expenseLines.map((line) => [line.concept, line.date]));
    expect([...byInvoice.entries()].find(([concept]) => concept.includes('F-VENCE'))?.[1]).toBe('2026-05-20');
    expect([...byInvoice.entries()].find(([concept]) => concept.includes('F-FACTURA'))?.[1]).toBe('2026-05-03');
    expect(may.iva.expenseLines.some((line) => line.concept.includes('F-SIN-FECHA'))).toBe(false);
  });

  it('routes covered payments on a CXP without fiscal fields to unclassified (REAL never estimates)', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noProveedor: 'P-NF',
      nombre: 'Proveedor Sin Fiscal',
      noFactura: 'F-NF',
      importeSubtotalPesos: 0,
      importeImpuestosPesos: 0,
      importeBrutoPesos: 0,
      importePendientePesos: 0,
    });
    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      cxpPaymentCoverage: new Map([[coverageKey(cxp), coverage(cxp, {
        status: 'PARTIAL',
        totalPaidPesos: 0, // grossAmount cae a 0 → el pago se toma completo
        payments: [{ noPago: 'P-Z', fechaPago: '2026-05-11', importe: 1160, tier: 'invoice-amount' }],
      })]]),
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBe(0);
    expect(may.realIva.unclassifiedExpense).toBe(1160);
    expect(may.realIva.unclassifiedLines[0].concept).toContain('Pago P-Z');
    expect(may.realIva.unclassifiedLines[0].taxAmount).toBe(0);
  });

  it('leaves CXP with an off-contract tax ratio unclassified instead of forcing 16/8', () => {
    const view = buildTaxDashboardView({
      cxpRecords: [cxpRecord({
        noFactura: 'F-RARO',
        fechaProgramacionPago: '2026-05-10',
        importeSubtotalPesos: 1000,
        importeImpuestosPesos: 50, // 5% — ni 16 ni 8
        importeBrutoPesos: 1050,
        importePendientePesos: 1050,
      })],
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.ivaCreditable).toBe(0);
    expect(may.iva.unclassifiedExpense).toBe(1050);
    const line = may.iva.unclassifiedLines.find((item) => item.concept.includes('F-RARO'))!;
    expect(line.taxAmount).toBeCloseTo(50);
    expect(line.taxRate).toBeUndefined();
  });
});

describe('taxModuleService — paid purchase receipts & directional estimator edges', () => {
  it('derives paid-OC IVA breakdown from the gross when the receipt lacks base/tax amounts, and keeps UNCLASSIFIED receipts unclassified', () => {
    const view = buildTaxDashboardView({
      purchaseReceipts: [
        purchaseReceipt({
          cia: '00011',
          noProveedor: 'P-OC-F',
          supplierName: 'Proveedor OC Sin Desglose',
          invoiceNo: 'F-OC-GROSS',
          purchaseOrderNo: 'OC-GROSS',
          amountMxn: 1160,
          totalAmount: 1160,
          taxRate: 16,
          taxRateCode: 'IVA16',
          taxTreatment: 'IVA_CREDITABLE',
          // Sin taxBaseAmount / taxAmount → grossToIvaBreakdown.
        }),
        purchaseReceipt({
          cia: '00011',
          noProveedor: 'P-OC-U',
          supplierName: 'Proveedor OC Sin Clasificar',
          invoiceNo: 'F-OC-UNCLASS',
          purchaseOrderNo: 'OC-UNCLASS',
          amountMxn: 500,
          totalAmount: 500,
          taxTreatment: 'UNCLASSIFIED',
        }),
      ],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({ cia: '00011', noFactura: 'OC-GROSS', contraparte: 'Proveedor OC Sin Desglose', bankDate: '2026-05-21', importe: -1160, bankAmount: -1160, sourceKind: 'oc' }),
        auxiliarLine({ cia: '00011', noFactura: 'OC-UNCLASS', contraparte: 'Proveedor OC Sin Clasificar', bankDate: '2026-05-22', importe: -500, bankAmount: -500, sourceKind: 'oc' }),
      ]),
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    const creditableLine = may.realIva.expenseLines.find((line) => line.concept.includes('F-OC-GROSS'))!;
    expect(creditableLine.taxBase).toBeCloseTo(1000);
    expect(creditableLine.taxAmount).toBeCloseTo(160);

    expect(may.realIva.unclassifiedExpense).toBe(500);
    expect(may.realIva.unclassifiedLines[0].concept).toContain('OC pagada F-OC-UNCLASS');
  });

  it('does not double-count invoices already covered by real cobranza in the directional Auxiliar estimator', () => {
    const view = buildTaxDashboardView({
      cobranzaPayments: [cobranzaPayment({
        idPago: 'PAY-K',
        fechaCobro: '2026-05-10',
        importeRecibo: 1160,
        applications: [{
          noFactura: 'RI-K',
          importeCobrado: 1160,
          importeOriginalFactura: 1160,
          importeIvaFacturaOriginal: 160,
          tasaIva: '16',
        }],
      })],
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({
          cia: '00011',
          noFactura: 'RI-K',
          contraparte: 'Cliente K',
          bankDate: '2026-05-10',
          importe: 1160,
          bankAmount: 1160,
          flujo: 'ingreso',
          tipoDoctoDesc: 'Recibo factura',
        }),
      ]),
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // Sólo el IVA de la cobranza real (160) — el estimador direccional se salta
    // la factura conocida (no 320).
    expect(may.realIva.ivaCaused).toBeCloseTo(160);
    expect(may.realIva.incomeLines).toHaveLength(1);
    expect(may.realIva.incomeLines[0].concept).toContain('Cobro PAY-K');
  });
});

describe('taxModuleService — FORECAST movement IVA fallback', () => {
  it('uses explicit movement base/tax at 16% and gross breakdown at 8%', () => {
    const view = buildTaxDashboardView({
      movements: [
        movement('mov-explicito', 'OUTFLOW', 'OPEX', '2026-05-10', 1160, {
          taxTreatment: 'IVA_CREDITABLE',
          taxRate: 16,
          taxBaseAmount: 1000,
          taxAmount: 160,
        }),
        movement('mov-ocho', 'OUTFLOW', 'OPEX', '2026-05-12', 1080, {
          taxTreatment: 'IVA_CREDITABLE',
          taxRate: 8,
        }),
      ],
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.expenseBase16).toBeCloseTo(1000);
    expect(may.iva.ivaCreditable16).toBeCloseTo(160);
    expect(may.iva.expenseBase8).toBeCloseTo(1000);
    expect(may.iva.ivaCreditable8).toBeCloseTo(80);
    const explicit = may.iva.expenseLines.find((line) => line.movementId === 'mov-explicito')!;
    expect(explicit).toMatchObject({ taxBase: 1000, taxAmount: 160, rateSource: 'JDE' });
  });

  it('resolves the rate from the provider catalog for AP payments without fiscal data', () => {
    const view = buildTaxDashboardView({
      providers: [provider({ name: 'Proveedor Frontera Ocho', ivaRate: 8, numProveedorJDE: '77' })],
      movements: [
        movement('mov-catalogo', 'OUTFLOW', 'AP_PAYMENT', '2026-05-14', 1080, {
          sourceSystem: 'JDE',
          counterpartyName: 'Proveedor Frontera Ocho',
        }),
      ],
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.expenseBase8).toBeCloseTo(1000);
    expect(may.iva.ivaCreditable8).toBeCloseTo(80);
    expect(may.iva.expenseLines[0]).toMatchObject({
      rateSource: 'CATALOG',
      rateTarget: { targetType: 'PROVIDER', targetKey: 'Proveedor Frontera Ocho' },
    });
  });

  it('applies CONCEPT rate overrides ahead of any other signal', () => {
    const store = upsertTaxRateOverride(defaultTaxStore(), {
      targetType: 'CONCEPT',
      targetKey: 'Renta patios',
      rate: 8,
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    const view = buildTaxDashboardView({
      movements: [
        movement('mov-renta', 'OUTFLOW', 'OPEX', '2026-05-05', 1080, { concept: 'Renta patios' }),
      ],
      ...MAY_RANGE,
      store,
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.ivaCreditable8).toBeCloseTo(80);
    expect(may.iva.expenseLines[0].rateSource).toBe('OVERRIDE');
  });

  it('defaults IVA_CREDITABLE movements without rate or catalog to 16%', () => {
    const view = buildTaxDashboardView({
      movements: [
        movement('mov-default', 'OUTFLOW', 'OPEX', '2026-05-06', 1160, { taxTreatment: 'IVA_CREDITABLE' }),
      ],
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.ivaCreditable16).toBeCloseTo(160);
    expect(may.iva.expenseLines[0].rateSource).toBe('DEFAULT');
  });

  it('skips exempt, payroll-like and non-creditable-category movements entirely', () => {
    const view = buildTaxDashboardView({
      movements: [
        movement('mov-exento', 'OUTFLOW', 'OPEX', '2026-05-07', 1000, { taxTreatment: 'IVA_EXEMPT' }),
        movement('mov-personal', 'OUTFLOW', 'OPEX', '2026-05-08', 1000, { concept: 'Pago NOMINA semanal' }),
        movement('mov-deuda', 'OUTFLOW', 'DEBT', '2026-05-09', 1000, {}),
      ],
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    // El loop compartido de ISN/IMSS crea el acumulador del periodo, pero sin
    // ningún IVA ni monto no clasificado: los tres movimientos se saltan.
    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.ivaCreditable).toBe(0);
    expect(may.iva.unclassifiedExpense).toBe(0);
    expect(may.iva.expenseLines).toHaveLength(0);
    expect(may.isn).toBe(0);
    expect(may.imss).toBe(0);
  });

  it('does not re-count a JDE movement whose CXP invoice was already handled', () => {
    const view = buildTaxDashboardView({
      cxpRecords: [cxpRecord({
        noFactura: 'F-SKIP',
        fechaProgramacionPago: '2026-05-07',
        importeSubtotalPesos: 1000,
        importeImpuestosPesos: 160,
        importeBrutoPesos: 1160,
        importePendientePesos: 1160,
      })],
      movements: [
        movement('cxp:00001:P-1:F-SKIP:99', 'OUTFLOW', 'AP_PAYMENT', '2026-05-07', 1160, {
          sourceSystem: 'JDE',
          taxTreatment: 'IVA_CREDITABLE',
          taxRate: 16,
          // Cia distinta a la del registro → el fallback aun así lo cruza por
          // la llave `invoice:any:` y no lo re-cuenta.
          companyId: '00099',
        }),
      ],
      ...MAY_RANGE,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // Una sola vez (la factura CXP), no dos.
    expect(may.iva.ivaCreditable).toBeCloseTo(160);
    expect(may.iva.expenseLines).toHaveLength(1);
    expect(may.iva.expenseLines[0].concept).toContain('F-SKIP');
  });
});

describe('taxModuleService — buildTaxByCompany neutral store', () => {
  it('excludes global manual adjustments, overdue balance and movements from per-company rows', () => {
    const params = {
      cobranzaPayments: [cobranzaPayment({
        idPago: 'PAY-CIA',
        fechaCobro: '2026-05-08',
        importeRecibo: 1160,
        applications: [{
          noFactura: 'A1',
          importeCobrado: 1160,
          importeOriginalFactura: 1160,
          importeIvaFacturaOriginal: 160,
          tasaIva: '16',
        }],
      })],
      // Fuentes con cia inválida/'all' — no deben crear renglones.
      purchaseReceipts: [purchaseReceipt({ cia: 'all', invoiceNo: 'OC-ALL' })],
      bankStatements: [{
        cia: '   ',
        banco: 'BANAMEX',
        cuenta: '1',
        moneda: 'MXN',
        fechaEstadoCuenta: '2026-05-31',
        movimientos: [],
      }],
      movements: [
        movement('payroll-global', 'OUTFLOW', 'PAYROLL', '2026-05-15', 1000, { taxTreatment: 'IVA_EXEMPT' }),
      ],
      ...MAY_RANGE,
      store: {
        ...defaultTaxStore(),
        overdueBalance: 999,
        adjustments: [createTaxManualAdjustment({ taxType: 'IVA', period: '2026-05', kind: 'IVA_CAUSED', amount: 100 })],
      },
      ivaMode: 'REAL' as const,
    };

    const consolidated = buildTaxDashboardView(params);
    expect(consolidated.totals.ivaCaused).toBeCloseTo(260); // 160 + ajuste manual 100
    expect(consolidated.totals.isn).toBeCloseTo(30);        // 3% de la nómina global
    expect(consolidated.overdueBalance).toBe(999);

    const breakdown = buildTaxByCompany(params, []);
    expect(breakdown).toHaveLength(1);
    const row = breakdown[0];
    expect(row.cia).toBe('00011');
    // Store neutro: sin ajuste manual, sin saldo vencido; movements omitidos → sin ISN.
    expect(row.totals.ivaCaused).toBeCloseTo(160);
    expect(row.totals.isn).toBe(0);
    expect(row.totals.totalWithOverdue).toBeCloseTo(row.totals.total);
  });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

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
  return { cxpKey: coverageKey(record), ...patch };
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

function confirmation(patch: AuxiliarSourceConfirmation): AuxiliarSourceConfirmation {
  return patch;
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

let auxLineSeq = 0;

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
  matchTier?: AuxiliarReconLine['matchTier'];
}): AuxiliarReconLine {
  auxLineSeq += 1;
  return {
    glKey: `${patch.cia}::aux::PV::${patch.noFactura}::${patch.bankDate}::${auxLineSeq}`,
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
    matchTier: patch.matchTier ?? 'exact',
    confidence: 0.97,
    bankMovementKey: `bank:${patch.noFactura}:${auxLineSeq}`,
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

function provider(patch: Partial<Provider> & { name: string }): Provider {
  return {
    id: patch.id ?? `prov-${patch.name}`,
    name: patch.name,
    type: patch.type ?? 'Servicios',
    risk: patch.risk ?? 'Bajo',
    paymentPeriod: patch.paymentPeriod ?? '30 días',
    ivaRate: patch.ivaRate,
    numProveedorJDE: patch.numProveedorJDE,
  };
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
    companyId: patch.companyId,
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
    taxBaseAmount: patch.taxBaseAmount,
    taxAmount: patch.taxAmount,
    status: patch.status ?? 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}
