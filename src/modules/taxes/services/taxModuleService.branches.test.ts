/**
 * Cobertura de RAMAS (branches) de `taxModuleService.ts`.
 *
 * `taxModuleService.test.ts` + `taxModuleService.gaps.test.ts` ya dejan las
 * LÍNEAS en ~99%; lo que faltaba eran las ramas defensivas: `??` / `||` con el
 * lado derecho nunca evaluado, ternarios con una sola salida ejercitada,
 * guards de rango/monto/cia y los `continue`/early-return de cada acumulador.
 *
 * Este archivo SÓLO pinea el comportamiento REAL del módulo — cero cambios de
 * fuente. Donde el valor esperado es dinero (IVA causado/acreditable/pagado),
 * la aserción se calcula a mano contra la regla documentada, no contra lo que
 * "salga".
 *
 * RAMAS QUE QUEDAN SIN CUBRIR (inalcanzables desde los call sites del módulo,
 * no por falta de test):
 *   - `cxpTaxBreakdown` con `allowEstimated` (líneas 2609/2640-2668): los DOS
 *     call sites de `accumulateCxpIva` pasan `allowEstimatedBreakdown: false`,
 *     así que el override de tasa, la tasa del catálogo de proveedor y la de
 *     la OC cruzada nunca se aplican al IVA de CXP. Camino muerto hoy.
 *   - `accumulateIvaFromLedger` con `includeCaused` (2279/2289/2296): el único
 *     call site pasa `includeCaused: false` a propósito (el causado NUNCA sale
 *     del libro mayor — ver el comentario del motor).
 *   - `accumulateDirectionalAuxiliarIvaEstimate` con `includeCaused` /
 *     `includeCreditable` en false (2073/2074): el único call site pasa ambos
 *     en true.
 *   - `accumulateProjectedClientIva` con `skipPeriods` (1582) y con tasa no
 *     8|16 (1592/1595/1601): ningún caller pasa `skipPeriods` y
 *     `resolveTaxRate` siempre devuelve 8 ó 16.
 *   - `addCxpIvaLine` devolviendo false (1779) y sus `|| emitted` (1687/1706):
 *     el monto que recibe siempre es > 0, así que siempre emite.
 *   - `allocatePaymentAmount` (1304/1308) y los guards 1087/1158/1168: los
 *     callers ya garantizan monto > 0 y `totalMatchedAmount >= cxpAmount`.
 *   - `cxpCoverageStatus`/`strongestCoverageStatus` devolviendo 'OPEN'
 *     (1384/1238): las coberturas derivadas siempre entran con monto > 0.
 *   - `paymentLabel` cayendo a `line.source.ref` (1288/1290): un pago con
 *     `tipoPago` y `noPago` vacíos no se indexa, así que nunca hay match.
 *   - OC con status CANCELLED o monto <= 0 (1841/1843) y sin
 *     `taxBaseAmount`/`taxAmount` (1856/1858): `buildPurchaseReceiptMovements`
 *     ya filtra canceladas/monto 0 y `purchaseTaxMeta` siempre puebla el
 *     desglose cuando el tratamiento es IVA_CREDITABLE.
 *   - `movementCreditableIvaBreakdown` `?? 0` de retorno (2742/2743): el guard
 *     previo exige ambos > 0.
 *   - `typicalDayForConcept` para nómina/impuestos (2812/2813): esas
 *     categorías presupuestales se filtran antes por
 *     `isRegimen601CreditableCategory`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CxpPaymentCoverage, PaymentMatch } from '../../../domain/paymentReconciliationEngine';
import type {
  AuxiliarReconLine,
  AuxiliarReconResult,
  AuxiliarSourceConfirmation,
} from '../../../domain/auxiliarReconciliationEngine';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type {
  AuxiliarContableRecord,
  BankAccountStatement,
  BankStatementLine,
  CobranzaPayment,
  PagoProveedorRecord,
} from '../../../services/jdeTypes';
import type { FinancialMovement, PurchaseReceiptRecord, TaxObligation } from '../../shared-finance/types';
import {
  TAX_STORE_KEY,
  addTaxPaymentPlanItem,
  auxiliarTaxCoverageFingerprint,
  buildApprovedTaxPaymentMovements,
  buildAutomaticTaxReserveMovements,
  buildTaxByCompany,
  buildTaxDashboardView,
  createManualTaxObligation,
  createTaxManualAdjustment,
  defaultTaxStore,
  loadTaxStore,
  saveTaxStore,
  updateTaxPaymentPlanItem,
  upsertTaxObligation,
  upsertTaxRateOverride,
  type TaxStore,
} from './taxModuleService';

const LEGACY_IVA_KEY = 'midas.financialProjection.taxAdjustments.v1';
const LEGACY_OPERATING_KEY = 'midas.operating.scenarios.v1';

const MAY = {
  companyCode: 'all',
  startDate: '2026-05-01',
  endDate: '2026-05-31',
  today: '2026-05-01',
} as const;

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

describe('branches — fingerprints', () => {
  it('tolera campos ausentes en la línea (foldHash con undefined, bankAmount ?? importe)', () => {
    const line = auxiliarLine({
      cia: '00011',
      noFactura: 'F-1',
      contraparte: 'Prov',
      bankDate: '2026-05-12',
      importe: -580,
    });
    // Sin bankDate ni bankAmount: foldHash sale por el early-return y el
    // fingerprint cae al importe crudo.
    const sinDatos: AuxiliarReconLine = { ...line, bankDate: undefined, bankAmount: undefined };
    const conImporte: AuxiliarReconLine = { ...line, bankDate: undefined, bankAmount: -580 };
    expect(auxiliarTaxCoverageFingerprint(auxiliarResult([sinDatos]))).toBe(
      auxiliarTaxCoverageFingerprint(auxiliarResult([conImporte])),
    );
    expect(auxiliarTaxCoverageFingerprint(auxiliarResult([sinDatos]))).toMatch(/^aux:1:/);
  });
});

// ---------------------------------------------------------------------------
// API exportada del store
// ---------------------------------------------------------------------------

describe('branches — API del TaxStore', () => {
  it('valida periodo y monto al crear un ajuste manual', () => {
    expect(() => createTaxManualAdjustment({ taxType: 'IVA', period: '2026-5', kind: 'IVA_CAUSED', amount: 1 }))
      .toThrow('Periodo fiscal inválido.');
    expect(() => createTaxManualAdjustment({ taxType: 'IVA', period: '2026-05', kind: 'IVA_CAUSED', amount: Number.NaN }))
      .toThrow('Monto fiscal inválido.');
  });

  it('valida periodo/monto y respeta status + comentario al crear una obligación manual', () => {
    expect(() => createManualTaxObligation({ taxType: 'IVA', period: '202605', amount: 10 }))
      .toThrow('Periodo fiscal inválido.');
    expect(() => createManualTaxObligation({ taxType: 'IVA', period: '2026-05', amount: -1 }))
      .toThrow('Monto fiscal inválido.');

    const pagada = createManualTaxObligation({
      taxType: 'IVA',
      period: '2026-05',
      amount: 500,
      status: 'PAID',
      comment: '  liquidada  ',
      label: '  ',
      dueDate: 'no-iso',
    });
    expect(pagada.paidAmount).toBe(500);
    expect(pagada.pendingAmount).toBe(0);
    expect(pagada.comment).toBe('liquidada');
    // label en blanco → etiqueta derivada; dueDate no-ISO → vencimiento del periodo.
    expect(pagada.label).toBe('IVA 2026-05');
    expect(pagada.dueDate).toBe('2026-06-17');

    // Monto 0 sin status → PROJECTED (no PENDING).
    const cero = createManualTaxObligation({ taxType: 'ISN', period: '2026-05', amount: 0 });
    expect(cero.status).toBe('PROJECTED');
    expect(cero.comment).toBeUndefined();
  });

  it('upsertTaxObligation reemplaza por id sin tocar las demás obligaciones', () => {
    const base = createManualTaxObligation({ taxType: 'IVA', period: '2026-05', amount: 100 });
    const otra = createManualTaxObligation({ taxType: 'ISN', period: '2026-05', amount: 30 });
    const store = upsertTaxObligation(upsertTaxObligation(defaultTaxStore(), otra), base);
    expect(store.obligations).toHaveLength(2);

    const editada = { ...base, totalAmount: 250 };
    const store2 = upsertTaxObligation(store, editada);
    expect(store2.obligations).toHaveLength(2);
    expect(store2.obligations.find((item) => item.id === base.id)!.totalAmount).toBe(250);
    expect(store2.obligations.find((item) => item.id === otra.id)!.totalAmount).toBe(30);
  });

  it('valida fecha/monto del plan de pagos y sólo pisa la fecha con un ISO válido', () => {
    const obligation = createManualTaxObligation({ taxType: 'IVA', period: '2026-05', amount: 100 });
    expect(() => addTaxPaymentPlanItem({ obligation, date: '17/06/2026', amount: 10 }))
      .toThrow('Fecha de pago fiscal inválida.');
    expect(() => addTaxPaymentPlanItem({ obligation, date: '2026-06-17', amount: 0 }))
      .toThrow('Monto de pago fiscal inválido.');

    const conPago = addTaxPaymentPlanItem({ obligation, date: '2026-06-17', amount: 40, note: '  abono  ' });
    const paymentId = conPago.paymentPlan[0].id;
    expect(conPago.paymentPlan[0].note).toBe('abono');

    const reFechado = updateTaxPaymentPlanItem(conPago, paymentId, { date: '2026-06-20', amount: 55 });
    expect(reFechado.paymentPlan[0].date).toBe('2026-06-20');
    expect(reFechado.paymentPlan[0].amount).toBe(55);

    const fechaInvalida = updateTaxPaymentPlanItem(reFechado, paymentId, { date: '20-06-2026' });
    expect(fechaInvalida.paymentPlan[0].date).toBe('2026-06-20');
  });

  it('no revienta al notificar cambios sin `window` (entorno no-DOM)', () => {
    vi.stubGlobal('window', undefined);
    expect(() => saveTaxStore(defaultTaxStore())).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Normalización / migración del store persistido
// ---------------------------------------------------------------------------

describe('branches — normalización del store persistido', () => {
  it('cae al fallback cuando el payload no es un objeto', () => {
    localStorage.setItem(TAX_STORE_KEY, JSON.stringify('no-soy-un-store'));
    const fallback = defaultTaxStore();
    expect(loadTaxStore(fallback)).toBe(fallback);
  });

  it('normaliza overrides, ajustes, obligaciones y pagos con formas parciales', () => {
    const persisted = {
      migratedAt: '2026-01-01T00:00:00.000Z',
      taxRateOverrides: [
        null,
        { targetType: 'BAD', targetKey: 'x', rate: 16 },
        { targetType: 'PROVIDER', targetKey: '   ', rate: 16 },
        { targetType: 'PROVIDER', targetKey: 'Prov Uno', rate: 8, updatedAt: '2026-01-02T00:00:00.000Z' },
      ],
      adjustments: [
        null,
        { taxType: 'IVA', period: '2026-5', kind: 'IVA_CAUSED', amount: 1 },
        { taxType: 'IVA', period: '2026-05', kind: 'IVA_CAUSED', amount: 10 },
      ],
      obligations: [
        null,
        { taxType: 'IVA', period: '2026-5', dueDate: '2026-06-17', totalAmount: 1 },
        { taxType: 'IVA', period: '2026-05', dueDate: 'no-iso', totalAmount: 1 },
        {
          taxType: 'IVA',
          period: '2026-05',
          dueDate: '2026-06-17',
          totalAmount: 100,
          comment: '   ',
          paymentPlan: [
            null,
            { date: '2026-06-17', amount: 10, status: 'RARO' },
            { date: '2026-06-17', amount: 10, status: 'PAID', scenarioId: '   ', note: '   ', id: '   ' },
          ],
        },
      ],
    };
    localStorage.setItem(TAX_STORE_KEY, JSON.stringify(persisted));

    const store = loadTaxStore();
    expect(store.migratedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(store.taxRateOverrides).toHaveLength(1);
    expect(store.taxRateOverrides[0]).toMatchObject({ targetType: 'PROVIDER', rate: 8 });
    expect(store.adjustments).toHaveLength(1);
    expect(store.obligations).toHaveLength(1);
    const [obligation] = store.obligations;
    expect(obligation.comment).toBeUndefined();
    expect(obligation.paymentPlan).toHaveLength(1);
    // id / scenarioId / note en blanco → id derivado y campos opcionales fuera.
    expect(obligation.paymentPlan[0].id).toBe('tax-payment-2026-06-17');
    expect(obligation.paymentPlan[0].scenarioId).toBeUndefined();
    expect(obligation.paymentPlan[0].note).toBeUndefined();
  });

  it('conserva id/nota/fecha propios al normalizar obligaciones y pagos completos', () => {
    localStorage.setItem(TAX_STORE_KEY, JSON.stringify({
      obligations: [{
        id: '  obl-1  ',
        taxType: 'IMSS',
        period: '2026-05',
        dueDate: '2026-06-17',
        totalAmount: 100,
        comment: '  revisar  ',
        paymentPlan: [{
          id: '  pay-1  ',
          date: '2026-06-17',
          amount: 30,
          status: 'APPROVED',
          scenarioId: '  esc-1  ',
          note: '  parcial  ',
        }],
      }],
    }));

    const [obligation] = loadTaxStore().obligations;
    expect(obligation.id).toBe('obl-1');
    expect(obligation.comment).toBe('revisar');
    expect(obligation.paymentPlan[0]).toMatchObject({
      id: 'pay-1',
      scenarioId: 'esc-1',
      note: 'parcial',
    });
  });

  it('migra ajustes y deudas legacy con campos mínimos (ids derivados)', () => {
    localStorage.setItem(LEGACY_IVA_KEY, JSON.stringify([
      null,
      { period: '2026-05', kind: 'IVA_CAUSED', amount: 500 },
    ]));
    localStorage.setItem(LEGACY_OPERATING_KEY, JSON.stringify([
      { taxDebts: [null, { taxType: 'IVA', dueDate: '2026-06-17', originalAmount: 900 }] },
    ]));

    const store = loadTaxStore();
    expect(store.adjustments).toHaveLength(1);
    expect(store.adjustments[0].id).toBe('legacy-tax-adjustment-2026-05-IVA_CAUSED');
    expect(store.adjustments[0].note).toBeUndefined();
    expect(store.obligations).toHaveLength(1);
    expect(store.obligations[0].id).toBe('legacy-tax-obligation-IVA-2026-06');
    // outstandingAmount ausente → cae a originalAmount.
    expect(store.obligations[0].pendingAmount).toBe(900);
  });

  it('descarta deudas legacy sin fecha y pagos legacy inválidos, y deriva el id del pago', () => {
    localStorage.setItem(LEGACY_OPERATING_KEY, JSON.stringify([
      {
        taxDebts: [
          { taxType: 'IVA', outstandingAmount: 100 },
          {
            taxType: 'ISN',
            dueDate: '2026-06-17',
            outstandingAmount: 200,
            plannedPayments: [null, { date: 'ayer', amount: 5 }, { date: '2026-06-01', amount: 5 }],
          },
        ],
      },
    ]));

    const store = loadTaxStore();
    expect(store.obligations).toHaveLength(1);
    expect(store.obligations[0].taxType).toBe('ISN');
    expect(store.obligations[0].paymentPlan).toHaveLength(1);
    expect(store.obligations[0].paymentPlan[0].id).toBe('legacy-payment-2026-06-01');
    expect(store.obligations[0].paymentPlan[0].note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Movimientos fiscales (pagos aprobados + reserva automática)
// ---------------------------------------------------------------------------

describe('branches — movimientos de pago y reserva fiscal', () => {
  it('emite pagos PAGADOS de IMSS/ISN con autoridad, confianza y candado propios', () => {
    const imss: TaxObligation = {
      ...createManualTaxObligation({ taxType: 'IMSS', period: '2026-05', amount: 100, comment: 'cuota' }),
      paymentPlan: [{ id: 'p1', date: '2026-06-17', amount: 100, status: 'PAID', note: 'liquidado' }],
    };
    const isn: TaxObligation = {
      ...createManualTaxObligation({ taxType: 'ISN', period: '2026-05', amount: 50 }),
      paymentPlan: [{ id: 'p2', date: '2026-06-17', amount: 50, status: 'APPROVED' }],
    };

    const movements = buildApprovedTaxPaymentMovements({
      obligations: [imss, isn],
      scenarioId: 'esc-1',
      startDate: '2026-05-01',
      endDate: '2026-12-31',
      asOfDate: '2026-05-01',
    });

    expect(movements).toHaveLength(2);
    const [pagoImss, pagoIsn] = movements;
    expect(pagoImss).toMatchObject({
      counterpartyName: 'IMSS',
      confidenceScore: 96,
      status: 'EXECUTED',
      lockState: 'LOCKED',
    });
    expect(pagoImss.ruleApplied).toBe('Plan fiscal pagado');
    expect(pagoImss.comments).toEqual(['liquidado', 'cuota']);
    expect(pagoIsn).toMatchObject({
      counterpartyName: 'Tesorería estatal',
      confidenceScore: 82,
      status: 'APPROVED',
      lockState: 'RESTRICTED',
    });
  });

  it('reserva: descuenta pagos PAGADOS, omite saldo 0 y recorre el vencimiento pasado a hoy', () => {
    const cubierta: TaxObligation = {
      ...createManualTaxObligation({ taxType: 'IVA', period: '2026-04', amount: 100 }),
      paymentPlan: [{ id: 'p1', date: '2026-05-17', amount: 100, status: 'PAID' }],
    };
    const vencida: TaxObligation = {
      ...createManualTaxObligation({ taxType: 'IVA', period: '2026-03', amount: 300 }),
      dueDate: '2026-04-17',
      source: 'CALCULATED',
      status: 'PAID',
    };

    const movements = buildAutomaticTaxReserveMovements({
      obligations: [cubierta, vencida],
      scenarioId: 'esc-1',
      startDate: '2026-05-01',
      endDate: '2026-12-31',
      asOfDate: '2026-05-10',
    });

    // La obligación totalmente cubierta no emite reserva.
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      projectedDate: '2026-05-10',
      confidenceScore: 74,
      forecastMethod: 'RULE',
      status: 'EXECUTED',
      lockState: 'RESTRICTED',
    });
    expect(movements[0].projectedAmount).toBe(300);
  });

  it('reserva: descarta la que cae fuera de la ventana y bloquea la de riesgo LEGAL', () => {
    const fuera = createManualTaxObligation({ taxType: 'IVA', period: '2026-12', amount: 100 });
    const legal: TaxObligation = {
      ...createManualTaxObligation({ taxType: 'ISN', period: '2026-05', amount: 80 }),
      risk: 'LEGAL',
    };

    const movements = buildAutomaticTaxReserveMovements({
      obligations: [fuera, legal],
      scenarioId: 'esc-1',
      startDate: '2026-05-01',
      endDate: '2026-06-30',
      asOfDate: '2026-05-10',
    });

    expect(movements).toHaveLength(1);
    expect(movements[0].lockState).toBe('LOCKED');
    expect(movements[0].counterpartyName).toBe('Tesorería estatal');
  });
});

// ---------------------------------------------------------------------------
// buildTaxDashboardView — rango por defecto, ajustes y obligaciones
// ---------------------------------------------------------------------------

describe('branches — rango, ajustes manuales y obligaciones', () => {
  it('deriva el rango de `today` cuando no llegan fechas ni proyección', () => {
    const view = buildTaxDashboardView({
      cobranzaPayments: [cobranzaPayment({
        idPago: 'PAY-DEF',
        fechaCobro: '2026-05-08',
        importeRecibo: 1160,
        applications: [{
          noFactura: 'C-DEF',
          importeCobrado: 1160,
          importeOriginalFactura: 1160,
          importeIvaFacturaOriginal: 160,
          tasaIva: '16',
        }],
      })],
      store: defaultTaxStore(),
      today: '2026-05-20',
      ivaMode: 'REAL',
    });

    // startDate = 2026-05-01 (mes de today), endDate = 2026-12-31 (año de today).
    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCaused).toBeCloseTo(160);
  });

  it('ignora movimientos fuera del rango en el acumulador ISN/IMSS y aplica IVA_PAID + IMSS_MANUAL', () => {
    const store = defaultTaxStore();
    store.adjustments = [
      { ...createTaxManualAdjustment({ taxType: 'IVA', period: '2026-05', kind: 'IVA_PAID', amount: 90 }) },
      { ...createTaxManualAdjustment({ taxType: 'IMSS', period: '2026-05', kind: 'IMSS_MANUAL', amount: 700 }) },
    ];

    const view = buildTaxDashboardView({
      movements: [
        // Fuera de la ventana → no debe tocar payrollBase.
        movement('payroll-fuera', 'OUTFLOW', 'PAYROLL', '2026-07-15', 1000),
        // INFLOW → ni ISN ni IMSS.
        movement('ingreso-imss', 'INFLOW', 'OPEX', '2026-05-15', 500, { concept: 'REEMBOLSO IMSS' }),
      ],
      ...MAY,
      store,
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.payrollBase).toBe(0);
    expect(may.isn).toBe(0);
    expect(may.imss).toBe(700);
    expect(may.iva.ivaPaid).toBe(90);
    expect(may.iva.balanceInFavor).toBe(90);
    const imssObligation = may.obligations.find((item) => item.taxType === 'IMSS')!;
    expect(imssObligation.source).toBe('MANUAL');
  });

  it('arrastra el pendiente de obligaciones de periodos anteriores al rango', () => {
    const store = defaultTaxStore();
    store.obligations = [
      { ...createManualTaxObligation({ taxType: 'IVA', period: '2026-01', amount: 400 }) },
      // Mismo periodo previo pero ya sin pendiente → no suma.
      { ...createManualTaxObligation({ taxType: 'ISN', period: '2026-02', amount: 100, status: 'PAID' }) },
    ];

    const view = buildTaxDashboardView({ ...MAY, store, ivaMode: 'REAL' });
    expect(view.overdueBalance).toBe(400);
    expect(view.totals.totalWithOverdue).toBe(400);
  });

  it('marca el periodo como PAGADO cuando el plan cubre el IVA calculado', () => {
    const store = defaultTaxStore();
    store.obligations = [{
      ...createManualTaxObligation({ taxType: 'IVA', period: '2026-05', amount: 0 }),
      id: 'tax-calculated:IVA:2026-05',
      paymentPlan: [{ id: 'p1', date: '2026-06-17', amount: 500, status: 'PAID' }],
    }];

    const view = buildTaxDashboardView({
      cobranzaPayments: [cobranzaPayment({
        idPago: 'PAY-PAID',
        fechaCobro: '2026-05-08',
        importeRecibo: 1160,
        applications: [{
          noFactura: 'C-PAID',
          importeCobrado: 1160,
          importeOriginalFactura: 1160,
          importeIvaFacturaOriginal: 160,
          tasaIva: '16',
        }],
      })],
      ...MAY,
      store,
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.iva.payable).toBeCloseTo(160);
    expect(may.iva.status).toBe('PAID');
    expect(may.status).toBe('PAID');
    // El pago PAGADO cuenta como impacto en caja.
    expect(may.cashImpact).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// buildTaxByCompany
// ---------------------------------------------------------------------------

describe('branches — desglose por empresa', () => {
  it('descubre cias desde nómina y descarta las vacías / "all"', () => {
    const rows = buildTaxByCompany({
      cobranzaPayments: [{
        ...cobranzaPayment({
          idPago: 'PAY-CIA',
          fechaCobro: '2026-05-08',
          importeRecibo: 1160,
          applications: [{
            noFactura: 'C-CIA',
            importeCobrado: 1160,
            importeOriginalFactura: 1160,
            importeIvaFacturaOriginal: 160,
            tasaIva: '16',
          }],
        }),
        cia: '00011',
      }],
      // cia vacía / undefined / "all" no generan renglón.
      payrollCosts: [
        { cia: '00011' },
        { cia: undefined },
        { cia: '   ' },
        { cia: 'all' },
      ] as never,
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    }, [{ cia: '00011', nombre: 'Senda Once' }]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cia: '00011', nombre: 'Senda Once' });
    expect(rows[0].totals.ivaCaused).toBeCloseTo(160);
  });
});

// ---------------------------------------------------------------------------
// Cobranza aplicada (IVA causado REAL)
// ---------------------------------------------------------------------------

describe('branches — IVA causado desde cobranza aplicada', () => {
  it('descarta cobros fuera de rango, sin importe y con fecha no ISO (cae a fechaAplicacion)', () => {
    const view = buildTaxDashboardView({
      cobranzaPayments: [
        // fechaCobro no ISO → usa fechaAplicacion (dentro del rango).
        {
          ...cobranzaPayment({
            idPago: 'PAY-ALT',
            fechaCobro: '08/05/2026',
            importeRecibo: 1160,
            applications: [{
              noFactura: 'C-ALT',
              importeCobrado: 1160,
              importeOriginalFactura: 1160,
              importeIvaFacturaOriginal: 160,
              tasaIva: '16',
            }],
          }),
          applications: [{
            idPago: 'PAY-ALT',
            cia: '00011',
            fechaAplicacion: '2026-05-09',
            noCliente: 'C-9001',
            cliente: 'Cliente IVA',
            tipoDocto: 'RI',
            noFactura: 'C-ALT',
            noFacturaNormalizada: 'C-ALT',
            fechaFactura: '2026-05-01',
            fechaVencimiento: '2026-05-31',
            diasAntiguedadFafv: 0,
            importeCobrado: 1160,
            importeOriginalFactura: 1160,
            tasaIva: '16',
            importeIvaFacturaOriginal: 160,
          }],
        },
        // Fuera del rango.
        cobranzaPayment({
          idPago: 'PAY-FUERA',
          fechaCobro: '2026-07-08',
          importeRecibo: 1160,
          applications: [{
            noFactura: 'C-FUERA',
            importeCobrado: 1160,
            importeOriginalFactura: 1160,
            importeIvaFacturaOriginal: 160,
            tasaIva: '16',
          }],
        }),
        // Importe cobrado 0.
        cobranzaPayment({
          idPago: 'PAY-CERO',
          fechaCobro: '2026-05-10',
          importeRecibo: 0,
          applications: [{
            noFactura: 'C-CERO',
            importeCobrado: 0,
            importeOriginalFactura: 1160,
            importeIvaFacturaOriginal: 160,
            tasaIva: '16',
          }],
        }),
      ],
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    expect(view.periods.map((period) => period.period)).toEqual(['2026-05']);
    expect(view.periods[0].realIva.ivaCaused).toBeCloseTo(160);
  });

  it('cobro gravable sin IVA de factura: tasa de la factura (JDE) o de la región', () => {
    const view = buildTaxDashboardView({
      cobranzaPayments: [
        // tasaIva "16" pero SIN IVA de factura → método por depósito, tasa JDE.
        cobranzaPayment({
          idPago: 'PAY-JDE',
          fechaCobro: '2026-05-08',
          importeRecibo: 1160,
          applications: [{
            noFactura: '',
            importeCobrado: 1160,
            importeOriginalFactura: 0,
            importeIvaFacturaOriginal: 0,
            tasaIva: '16',
          }],
        }),
        // Indicador gravable sin tasa → tasa de la región (resolver inyectado).
        cobranzaPayment({
          idPago: 'PAY-REG',
          fechaCobro: '2026-05-09',
          importeRecibo: 1080,
          applications: [{
            noFactura: 'C-REG',
            importeCobrado: 1080,
            importeOriginalFactura: 0,
            importeIvaFacturaOriginal: 0,
            tasaIva: 'GRAVADO',
          }],
        }),
      ],
      incomeIvaRateResolver: () => 8,
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods[0];
    // 1160/1.16 = 1000 base + 160 IVA (16%); 1080/1.08 = 1000 base + 80 IVA (8%).
    expect(may.realIva.ivaCaused16).toBeCloseTo(160);
    expect(may.realIva.ivaCaused8).toBeCloseTo(80);
    const [jde, region] = may.realIva.incomeLines;
    expect(jde.rateSource).toBe('JDE');
    expect(jde.concept).toContain('Factura s/n');
    expect(region.rateSource).toBe('REGION');
    // `app.cliente` vacío cae al cliente del recibo.
    expect(region.counterpartyName).toBe('Cliente IVA');
  });

  it('cae a 16% cuando el resolver de región no devuelve tasa', () => {
    const view = buildTaxDashboardView({
      cobranzaPayments: [cobranzaPayment({
        idPago: 'PAY-SINRES',
        fechaCobro: '2026-05-08',
        importeRecibo: 1160,
        applications: [{
          noFactura: 'C-SINRES',
          importeCobrado: 1160,
          importeOriginalFactura: 0,
          importeIvaFacturaOriginal: 0,
          tasaIva: 'GRAVADO',
        }],
      })],
      // Resolver defensivo que no resuelve — el motor cae al 16% del régimen 601.
      incomeIvaRateResolver: (() => undefined) as unknown as (cia?: string, nombre?: string) => 8 | 16,
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    expect(view.periods[0].realIva.ivaCaused16).toBeCloseTo(160);
  });

  it('cobro con IVA pero tasa no resoluble va a no clasificado', () => {
    const view = buildTaxDashboardView({
      cobranzaPayments: [cobranzaPayment({
        idPago: 'PAY-RARO',
        fechaCobro: '2026-05-08',
        importeRecibo: 100,
        applications: [{
          noFactura: 'C-RARO',
          // Cobro == IVA → base 0 → la tasa no se puede derivar.
          importeCobrado: 100,
          importeOriginalFactura: 100,
          importeIvaFacturaOriginal: 100,
          tasaIva: 'GRAVADO',
        }],
      })],
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods[0];
    expect(may.realIva.ivaCaused).toBe(0);
    expect(may.realIva.unclassifiedIncome).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// IVA pagado histórico (bancos + movimientos)
// ---------------------------------------------------------------------------

describe('branches — IVA pagado histórico', () => {
  it('filtra ABONOs, fechas fuera de rango e importes 0 del estado de cuenta', () => {
    const view = buildTaxDashboardView({
      bankStatements: [bank([
        bankLine({ concepto: 'PAGO IVA', tipoMovimiento: 'ABONO', importe: 500 }),
        bankLine({ concepto: 'PAGO IVA', fechaOperacion: '2026-07-20', importe: 500 }),
        bankLine({ concepto: 'PAGO IVA', fechaOperacion: 'sin-fecha', importe: 500 }),
        bankLine({ concepto: 'PAGO IVA', importe: 0 }),
        // Concepto vacío: la clasificación sale de infAdi1 y la etiqueta de la referencia.
        bankLine({ concepto: '', infAdi1: 'PAGO REFERENCIADO IVA', referencia: 'REF-777', importe: 200 }),
        // Sin concepto ni referencia → etiqueta genérica.
        bankLine({ concepto: '', referencia: '', infAdi1: 'IVA DEL MES', importe: 300, gsaid: 'G-1' }),
      ])],
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods[0];
    expect(may.realIva.ivaPaid).toBe(500);
    expect(may.realIva.paidLines.map((line) => line.concept)).toEqual([
      'Pago IVA · REF-777',
      'Pago IVA · Movimiento bancario',
    ]);
  });

  it('filtra INFLOW, status proyectado, fecha inválida e importe 0 en el fallback por movimientos', () => {
    const view = buildTaxDashboardView({
      movements: [
        movement('iva-inflow', 'INFLOW', 'TAX', '2026-05-10', 100, { subcategory: 'IVA', status: 'REAL' }),
        movement('iva-proyectado', 'OUTFLOW', 'TAX', '2026-05-10', 100, { subcategory: 'IVA', status: 'PROJECTED_BASE' }),
        movement('iva-fuera', 'OUTFLOW', 'TAX', '2026-07-10', 100, { subcategory: 'IVA', status: 'REAL' }),
        movement('iva-cero', 'OUTFLOW', 'TAX', '2026-05-10', 0, { subcategory: 'IVA', status: 'REAL' }),
        // Concepto y contraparte vacíos → etiqueta y contraparte por defecto.
        {
          ...movement('iva-sin-texto', 'OUTFLOW', 'TAX', '2026-05-12', 250, { subcategory: 'IVA', status: 'EXECUTED' }),
          concept: '',
          counterpartyName: undefined,
        },
      ],
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaPaid).toBe(250);
    expect(may.realIva.paidLines[0]).toMatchObject({
      concept: 'Pago IVA · Movimiento fiscal',
      counterpartyName: 'SAT — IVA',
    });
  });

  it('usa el concepto vacío pero la contraparte presente como etiqueta', () => {
    const view = buildTaxDashboardView({
      movements: [{
        ...movement('iva-contraparte', 'OUTFLOW', 'TAX', '2026-05-12', 120, {
          subcategory: 'IVA',
          status: 'REAL',
          counterpartyName: 'SAT — IVA MAYO',
        }),
        concept: '',
      }],
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    expect(view.periods[0].realIva.paidLines[0].concept).toBe('Pago IVA · SAT — IVA MAYO');
  });
});

// ---------------------------------------------------------------------------
// Libro mayor de IVA
// ---------------------------------------------------------------------------

describe('branches — IVA acreditable desde el libro mayor', () => {
  it('agrupa por tasa (8% detectado en el nombre), netea reversos y salta periodos sin acreditable', () => {
    const view = buildTaxDashboardView({
      auxiliarIvaRecords: [
        // Periodo con acreditable real al 8%.
        auxIvaRecord({ nombreCuenta: 'IVA ACREDITABLE 8', cuentaObjeto: '1181', importe: 800, fechaContable: '2026-05-10' }),
        // Reverso completo en el mismo periodo/tasa → neto 0, no emite línea.
        auxIvaRecord({ nombreCuenta: 'IVA ACREDITABLE PAGADO', cuentaObjeto: '1180', importe: 500, fechaContable: '2026-05-11' }),
        auxIvaRecord({ nombreCuenta: 'IVA ACREDITABLE PAGADO', cuentaObjeto: '1180', importe: -500, fechaContable: '2026-05-12' }),
        // Periodo que SÓLO trae causado → el lado acreditable sale vacío.
        auxIvaRecord({ nombreCuenta: 'IVA TRASLADADO', cuentaObjeto: '2160', importe: 3000, fechaContable: '2026-06-10' }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-06-30',
      store: defaultTaxStore(),
      today: '2026-05-01',
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable8).toBeCloseTo(800);
    expect(may.realIva.ivaCreditable16).toBe(0);
    // 800 / 0.08 = 10 000 de base.
    expect(may.realIva.expenseBase8).toBeCloseTo(10_000);

    const june = view.periods.find((period) => period.period === '2026-06');
    // El causado NUNCA sale del ledger: junio no aporta IVA.
    expect(june?.realIva.ivaCaused ?? 0).toBe(0);
    expect(june?.realIva.ivaCreditable ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cobertura de pagos CXP derivada del Auxiliar
// ---------------------------------------------------------------------------

describe('branches — cobertura CXP vía Auxiliar (líneas de factura)', () => {
  it('salta CXP sin folio, líneas no confirmadas, sin candidato, sin monto y sin fecha', () => {
    const conFolio = cxpRecord({
      cia: '00011',
      noFactura: 'F-OK',
      noProveedor: 'P-1',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });
    const sinFolio = cxpRecord({ cia: '00011', noFactura: '', noProveedor: 'P-2' });

    const view = buildTaxDashboardView({
      cxpRecords: [sinFolio, conFolio],
      auxiliarReconciliation: auxiliarResult([
        // No confirmada (gl-orphan) → se ignora.
        auxiliarLine({ cia: '00011', noFactura: 'F-OK', contraparte: 'Proveedor IVA', bankDate: '2026-05-12', importe: -1160, matchTier: 'gl-orphan' }),
        // Sin CXP candidato para ese folio.
        auxiliarLine({ cia: '00011', noFactura: 'F-DESCONOCIDA', contraparte: 'Otro', bankDate: '2026-05-12', importe: -500 }),
        // Flujo ingreso → fuera de esta cobertura.
        auxiliarLine({ cia: '00011', noFactura: 'F-OK', contraparte: 'Proveedor IVA', bankDate: '2026-05-12', importe: 1160, flujo: 'ingreso' }),
        // Importe 0 → sin monto que asignar.
        auxiliarLine({ cia: '00011', noFactura: 'F-OK', contraparte: 'Proveedor IVA', bankDate: '2026-05-13', importe: 0, bankAmount: 0 }),
        // Sin bankDate ni fechaContable ISO → sin fecha.
        {
          ...auxiliarLine({ cia: '00011', noFactura: 'F-OK', contraparte: 'Proveedor IVA', bankDate: '2026-05-14', importe: -1160 }),
          bankDate: undefined,
          fechaContable: '14/05/2026',
        },
        // Válida: sin bankAmount (cae al importe), sin bankDate (cae a fechaContable),
        // sin tipoDocto (etiqueta "GL").
        {
          ...auxiliarLine({ cia: '00011', noFactura: 'F-OK', contraparte: 'Proveedor IVA', bankDate: '2026-05-15', importe: -1160 }),
          bankDate: undefined,
          bankAmount: undefined,
          tipoDocto: '',
        },
      ]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // Un solo pago cubierto por la CXP: 1160 bruto → 160 de IVA acreditable.
    const desdeCxp = may.realIva.expenseLines.filter((line) => line.movementId.startsWith('cxp:'));
    expect(desdeCxp).toHaveLength(1);
    expect(desdeCxp[0].taxAmount).toBeCloseTo(160);
    expect(desdeCxp[0].concept).toContain('Auxiliar GL 2026-05-15');
    // El resto del acreditable es la estimación direccional de la factura
    // desconocida (500 bruto), y el ingreso confirmado estima el causado.
    expect(may.realIva.ivaCreditable).toBeCloseTo(160 + (500 - 500 / 1.16), 4);
    // La línea de ingreso NO estima: su contraparte "Proveedor IVA" cae en el
    // filtro de conceptos no gravables (texto con "IVA" ⇒ impuesto, no venta).
    expect(may.realIva.ivaCaused).toBe(0);
  });

  it('usa las confirmaciones por fuente y descarta las que no aplican', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noFactura: 'F-CONF',
      noProveedor: 'P-1',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });
    // Dos CXP con el mismo folio → candidato ambiguo, la confirmación se descarta.
    const ambigua1 = cxpRecord({ cia: '00011', noFactura: 'F-AMB', noProveedor: 'P-A', nombre: 'Uno', importeBrutoPesos: 100 });
    const ambigua2 = cxpRecord({ cia: '00011', noFactura: 'F-AMB', noProveedor: 'P-B', nombre: 'Dos', importeBrutoPesos: 100 });

    const confirmations = new Map<string, AuxiliarSourceConfirmation>([
      ['factura:00011::F-CONF', { confirmed: true, flujo: 'egreso', importe: -1160, bankDate: '2026-05-18', fechaContable: '2026-05-18' }],
      // No confirmada.
      ['factura:00011::F-NO', { confirmed: false, flujo: 'egreso', importe: -100, fechaContable: '2026-05-18' }],
      // Flujo ingreso.
      ['factura:00011::F-IN', { confirmed: true, flujo: 'ingreso', importe: 100, fechaContable: '2026-05-18' }],
      // Prefijo distinto de "factura:".
      ['pago:00011::PV900', { confirmed: true, flujo: 'egreso', importe: -100, fechaContable: '2026-05-18' }],
      // Payload sin cia/ref.
      ['factura:soloCia', { confirmed: true, flujo: 'egreso', importe: -100, fechaContable: '2026-05-18' }],
      // Candidatos ambiguos.
      ['factura:00011::F-AMB', { confirmed: true, flujo: 'egreso', importe: -100, fechaContable: '2026-05-18' }],
      // Sin fecha ISO.
      ['factura:00011::F-CONF2', { confirmed: true, flujo: 'egreso', importe: -100, fechaContable: '18/05/2026' }],
      // Importe 0.
      ['factura:00011::F-CONF3', { confirmed: true, flujo: 'egreso', importe: 0, fechaContable: '2026-05-18' }],
    ]);

    const view = buildTaxDashboardView({
      cxpRecords: [cxp, ambigua1, ambigua2],
      auxiliarReconciliation: auxiliarResult(
        [auxiliarLine({ cia: '00011', noFactura: 'F-OTRA', contraparte: 'X', bankDate: '2026-05-18', importe: -1, matchTier: 'gl-orphan' })],
        confirmations,
      ),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    expect(may.realIva.expenseLines[0].concept).toContain('Auxiliar factura F-CONF');
  });

  it('elige el CXP por contraparte cuando hay varios con el mismo folio y descarta si no hay pista', () => {
    const uno = cxpRecord({
      cia: '00011',
      noFactura: 'F-DUP',
      noProveedor: 'P-1',
      nombre: 'ACEROS DEL NORTE',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });
    const dos = cxpRecord({ cia: '00011', noFactura: 'F-DUP', noProveedor: 'P-2', nombre: 'OTRO PROVEEDOR', importeBrutoPesos: 500 });

    const view = buildTaxDashboardView({
      cxpRecords: [uno, dos],
      auxiliarReconciliation: auxiliarResult([
        // Sin contraparte → no se puede desempatar.
        {
          ...auxiliarLine({ cia: '00011', noFactura: 'F-DUP', contraparte: '', bankDate: '2026-05-11', importe: -1160 }),
          source: { kind: 'factura', cia: '00011', ref: 'F-DUP', contraparte: undefined },
        },
        // Con contraparte → cruza con ACEROS DEL NORTE.
        auxiliarLine({ cia: '00011', noFactura: 'F-DUP', contraparte: 'ACEROS DEL NORTE', bankDate: '2026-05-12', importe: -1160 }),
      ]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
  });
});

// ---------------------------------------------------------------------------
// Cobertura CXP vía PagoProveedor (líneas de pago) + merge
// ---------------------------------------------------------------------------

describe('branches — cobertura CXP vía pagos y merge de coberturas', () => {
  it('descarta líneas de pago no confirmadas, sin referencia, sin match, sin monto y sin fecha', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noFactura: 'F-PAGO',
      noProveedor: 'P-1',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });
    const pago = pagoProveedor({ cia: '00011', tipoPago: '', noPago: '900', importePesos: 0, fechaPago: '2026-05-12' });

    const pagoLine = (patch: Partial<AuxiliarReconLine> & { ref: string; bankDate: string; importe: number }): AuxiliarReconLine => ({
      ...auxiliarLine({ cia: '00011', noFactura: patch.ref, contraparte: 'Proveedor IVA', bankDate: patch.bankDate, importe: patch.importe, sourceKind: 'pago' }),
      ...patch,
      source: { kind: 'pago', cia: '00011', ref: patch.ref, contraparte: 'Proveedor IVA' },
    });

    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      paymentMatches: [paymentMatch(pago, [{ cxp, tier: 'folio-exact', confidence: 0.99 }])],
      auxiliarReconciliation: auxiliarResult([
        // No confirmada.
        { ...pagoLine({ ref: '900', bankDate: '2026-05-12', importe: -1160 }), matchTier: 'gl-orphan' },
        // Flujo ingreso.
        { ...pagoLine({ ref: '900', bankDate: '2026-05-12', importe: 1160 }), flujo: 'ingreso' },
        // Referencia vacía → sin llave de búsqueda.
        pagoLine({ ref: '', bankDate: '2026-05-12', importe: -1160 }),
        // Referencia desconocida → sin match.
        pagoLine({ ref: '999', bankDate: '2026-05-12', importe: -1160 }),
        // Importe 0.
        { ...pagoLine({ ref: '900', bankDate: '2026-05-13', importe: 0 }), bankAmount: 0 },
        // Sin fechas ISO en la línea → cae a la fecha del pago.
        {
          ...pagoLine({ ref: '900', bankDate: '2026-05-14', importe: -1160 }),
          bankDate: undefined,
          bankAmount: undefined,
          fechaContable: '14/05/2026',
        },
      ]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    // El pago sin importePesos etiqueta con `${tipoPago}${noPago}` = "900".
    expect(may.realIva.expenseLines[0].concept).toContain('Pago 900');
  });

  it('deduplica pagos idénticos entre la cobertura provista y la derivada, y conserva el estado más fuerte', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noFactura: 'F-MERGE',
      noProveedor: 'P-1',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });
    // Misma llave de dedupe que produce la cobertura del Auxiliar.
    const provista = new Map<string, CxpPaymentCoverage>([[
      '00011::F-MERGE::P-1',
      {
        cxpKey: '00011::F-MERGE::P-1',
        status: 'PAID',
        totalPaidPesos: 1160,
        payments: [{ noPago: 'Auxiliar PV 2026-05-12', fechaPago: '2026-05-12', importe: 1160, tier: 'folio-exact' }],
      },
    ]]);

    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      cxpPaymentCoverage: provista,
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({ cia: '00011', noFactura: 'F-MERGE', contraparte: 'Proveedor IVA', bankDate: '2026-05-12', importe: -1160, bankAmount: -1160 }),
      ]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // El pago duplicado NO se cuenta dos veces: sigue siendo 160 de IVA.
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    expect(may.realIva.expenseLines).toHaveLength(1);
  });

  it('suma pagos distintos del mismo CXP entre coberturas (estado PARCIAL → PAGADO)', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noFactura: 'F-SUMA',
      noProveedor: 'P-1',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });
    const provista = new Map<string, CxpPaymentCoverage>([[
      '00011::F-SUMA::P-1',
      {
        cxpKey: '00011::F-SUMA::P-1',
        status: 'OPEN',
        totalPaidPesos: 580,
        payments: [{ noPago: 'MANUAL-1', fechaPago: '2026-05-05', importe: 580, tier: 'invoice-amount' }],
      },
    ]]);

    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      cxpPaymentCoverage: provista,
      auxiliarReconciliation: auxiliarResult([
        auxiliarLine({ cia: '00011', noFactura: 'F-SUMA', contraparte: 'Proveedor IVA', bankDate: '2026-05-12', importe: -580, bankAmount: -580 }),
      ]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // 580 + 580 = 1160 → IVA acreditable total de la factura.
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
    expect(may.realIva.expenseLines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// accumulateCxpIva
// ---------------------------------------------------------------------------

describe('branches — IVA acreditable desde CXP', () => {
  it('filtra por cia y descarta CXP sin ninguna fecha utilizable', () => {
    const view = buildTaxDashboardView({
      cxpRecords: [
        cxpRecord({
          cia: '00099',
          noFactura: 'F-OTRA-CIA',
          importeBrutoPesos: 1160,
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 160,
          importePendientePesos: 1160,
        }),
        cxpRecord({
          cia: '00011',
          noFactura: 'F-SIN-FECHA',
          fechaProgramacionPago: '',
          fechaVence: '',
          fechaFactura: '',
          importeBrutoPesos: 1160,
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 160,
          importePendientePesos: 1160,
        }),
        cxpRecord({
          cia: '00011',
          noFactura: 'F-VALIDA',
          fechaProgramacionPago: '2026-05-17',
          importeBrutoPesos: 1160,
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 160,
          importePendientePesos: 1160,
        }),
      ],
      companyCode: '00011',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      today: '2026-05-01',
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.forecastIva.ivaCreditable).toBeCloseTo(160);
    expect(may.forecastIva.expenseLines).toHaveLength(1);
  });

  it('descarta CXP abierto fuera de rango, sin pendiente y sin folio (etiqueta "sin folio")', () => {
    const view = buildTaxDashboardView({
      cxpRecords: [
        cxpRecord({ cia: '00011', noFactura: 'F-FUERA', fechaProgramacionPago: '2026-08-17', importeBrutoPesos: 1160, importeSubtotalPesos: 1000, importeImpuestosPesos: 160, importePendientePesos: 1160 }),
        cxpRecord({ cia: '00011', noFactura: 'F-CERO', fechaProgramacionPago: '2026-05-17', importeBrutoPesos: 1160, importeSubtotalPesos: 1000, importeImpuestosPesos: 160, importePendientePesos: 0 }),
        cxpRecord({ cia: '00011', noFactura: '', noProveedor: '', nombre: 'PROVEEDOR SIN FOLIO', fechaProgramacionPago: '2026-05-17', importeBrutoPesos: 1080, importeSubtotalPesos: 1000, importeImpuestosPesos: 80, importePendientePesos: 1080 }),
      ],
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // Sólo el CXP sin folio entra: 1080 con 80 de impuesto ⇒ tasa 8%.
    expect(may.forecastIva.ivaCreditable8).toBeCloseTo(80);
    expect(may.forecastIva.expenseLines[0].concept).toContain('Factura sin folio');
    expect(may.forecastIva.expenseLines[0].rateTarget).toEqual({ targetType: 'PROVIDER', targetKey: 'PROVEEDOR SIN FOLIO' });
  });

  it('prorratea varios pagos de cobertura, tope al bruto, fecha inválida y pago fuera de rango', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noFactura: 'F-MULTI',
      noProveedor: 'P-1',
      fechaProgramacionPago: '2026-05-17',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });
    const coverage = new Map<string, CxpPaymentCoverage>([[
      '00011::F-MULTI::P-1',
      {
        cxpKey: '00011::F-MULTI::P-1',
        status: 'PARTIAL',
        totalPaidPesos: 1160,
        payments: [
          // Fecha no ISO → cae a la fecha de programación del CXP; sin noPago → índice.
          { noPago: '', fechaPago: '12/05/2026', importe: 600, tier: 'invoice-amount' },
          // Fuera del rango → emitida pero no acumulada.
          { noPago: 'PV-2', fechaPago: '2026-08-01', importe: 300, tier: 'invoice-amount' },
          // Excede el bruto restante → se recorta a 260.
          { noPago: 'PV-3', fechaPago: '2026-05-20', importe: 900, tier: 'invoice-amount' },
          // Sin capacidad restante → se salta.
          { noPago: 'PV-4', fechaPago: '2026-05-21', importe: 100, tier: 'invoice-amount' },
        ],
      },
    ]]);

    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      cxpPaymentCoverage: coverage,
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // Acumulan 600 + 260 = 860 de bruto ⇒ 860/1.16 → IVA de 118.62.
    expect(may.realIva.ivaCreditable).toBeCloseTo(860 - 860 / 1.16, 4);
    expect(may.realIva.expenseLines.map((line) => line.concept.split(' · ')[0])).toEqual(['Pago 1', 'Pago PV-3']);
  });

  it('marca la CXP como atendida en FORECAST aunque la cobertura no emita líneas', () => {
    const pagada = cxpRecord({
      cia: '00011',
      noFactura: 'F-PAGADA',
      noProveedor: 'P-1',
      fechaProgramacionPago: '2026-05-17',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });
    const parcialSinBruto = cxpRecord({
      cia: '00011',
      noFactura: 'F-PARCIAL',
      noProveedor: 'P-2',
      fechaProgramacionPago: '2026-05-17',
      importeBrutoPesos: 0,
      importePendientePesos: 0,
      importeSubtotalPesos: 0,
      importeImpuestosPesos: 0,
    });
    const coverage = new Map<string, CxpPaymentCoverage>([
      ['00011::F-PAGADA::P-1', {
        cxpKey: '00011::F-PAGADA::P-1',
        status: 'PAID',
        totalPaidPesos: 1160,
        payments: [{ noPago: 'PV-1', fechaPago: '2026-05-12', importe: 1160, tier: 'invoice-amount' }],
      }],
      ['00011::F-PARCIAL::P-2', {
        cxpKey: '00011::F-PARCIAL::P-2',
        status: 'PARTIAL',
        totalPaidPesos: 500,
        payments: [{ noPago: 'PV-2', fechaPago: '2026-05-12', importe: 500, tier: 'invoice-amount' }],
      }],
    ]);

    const view = buildTaxDashboardView({
      cxpRecords: [pagada, parcialSinBruto],
      cxpPaymentCoverage: coverage,
      ...MAY,
      store: defaultTaxStore(),
      // FORECAST no acredita pagos ya realizados (includePaidCoverage = false).
      ivaMode: 'FORECAST',
    });

    expect(view.periods).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Órdenes de compra (FORECAST) y OCs pagadas (REAL)
// ---------------------------------------------------------------------------

describe('branches — IVA de órdenes de compra', () => {
  it('descarta OCs fuera de rango y manda a no clasificado las de tratamiento sin tasa', () => {
    const view = buildTaxDashboardView({
      purchaseReceipts: [
        purchaseReceipt({ cia: '00011', invoiceNo: 'OC-FUERA', purchaseOrderNo: 'P-FUERA', estimatedDueDate: '2026-09-30', taxRate: 16, amountMxn: 1160 }),
        // Tratamiento acreditable declarado pero SIN tasa → no clasificado.
        purchaseReceipt({ cia: '00011', invoiceNo: 'OC-SINTASA', purchaseOrderNo: 'P-SINTASA', estimatedDueDate: '2026-05-20', taxTreatment: 'IVA_CREDITABLE', amountMxn: 500 }),
        purchaseReceipt({ cia: '00011', invoiceNo: 'OC-OK', purchaseOrderNo: 'P-OK', estimatedDueDate: '2026-05-20', taxRate: 16, amountMxn: 1160 }),
      ],
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.forecastIva.unclassifiedExpense).toBe(500);
    expect(may.forecastIva.ivaCreditable).toBeCloseTo(1160 - 1160 / 1.16, 4);
  });

  it('OCs pagadas: filtra por cia, canceladas, fecha fuera de rango y deduplica por documento', () => {
    const pago = pagoProveedor({ cia: '00011', tipoPago: 'PV', noPago: '900', claveProveedor: '59570032', importePesos: 1160, comentarioPago: 'OC-PAGADA' });
    const line = (ref: string, bankDate: string, importe: number, extra: Partial<AuxiliarReconLine> = {}): AuxiliarReconLine => ({
      ...auxiliarLine({ cia: '00011', noFactura: ref, contraparte: 'NEW WORLD FUEL SA DE CV', bankDate, importe, sourceKind: 'oc' }),
      ...extra,
      source: { kind: 'oc', cia: '00011', ref, contraparte: 'NEW WORLD FUEL SA DE CV' },
    });

    const view = buildTaxDashboardView({
      paymentMatches: [paymentMatch(pago, [])],
      purchaseReceipts: [
        // Otra cia → fuera del scope.
        purchaseReceipt({ cia: '00099', invoiceNo: 'OC-CIA', purchaseOrderNo: 'OC-1', taxRate: 16, taxTreatment: 'IVA_CREDITABLE', amountMxn: 1160 }),
        // Cancelada.
        purchaseReceipt({ cia: '00011', invoiceNo: 'OC-CANCEL', purchaseOrderNo: 'OC-2', isCancelled: true, taxRate: 16, taxTreatment: 'IVA_CREDITABLE', amountMxn: 1160 }),
        // Sin cruce de pago → sin fecha → fuera.
        purchaseReceipt({ cia: '00011', invoiceNo: 'OC-SINPAGO', purchaseOrderNo: 'OC-3', taxRate: 16, taxTreatment: 'IVA_CREDITABLE', amountMxn: 1160 }),
        // Pagada dos veces (misma llave) → una sola acreditación, con la fecha más antigua.
        purchaseReceipt({ cia: '00011', invoiceNo: 'OC-PAGADA', purchaseOrderNo: 'OC-4', taxRate: 16, taxTreatment: 'IVA_CREDITABLE', amountMxn: 1160 }),
        // Sin desglose fiscal → no clasificado.
        purchaseReceipt({ cia: '00011', invoiceNo: '', receiptNo: 'REC-9', purchaseOrderNo: 'OC-5', amountMxn: 800 }),
      ],
      auxiliarReconciliation: auxiliarResult([
        line('OC-4', '2026-05-20', -1160),
        line('OC-4', '2026-05-12', -1160),
        line('OC-5', '2026-05-13', -800),
        // Fuera de rango: registra la OC pero la acreditación se descarta al fechar.
        line('OC-9', '2026-08-13', -100),
        // No confirmada.
        { ...line('OC-4', '2026-05-14', -1160), matchTier: 'gl-orphan' },
        // Sin fecha utilizable.
        { ...line('OC-4', '2026-05-15', -1160), bankDate: undefined, fechaContable: '15/05/2026' },
      ]),
      companyCode: '00011',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      today: '2026-05-01',
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.ivaCreditable).toBeCloseTo(1160 - 1160 / 1.16, 4);
    expect(may.realIva.expenseLines[0]).toMatchObject({
      date: '2026-05-12',
      rateTarget: { targetType: 'PROVIDER', targetKey: '59570032' },
    });
    expect(may.realIva.unclassifiedExpense).toBe(800);
    expect(may.realIva.unclassifiedLines[0].concept).toContain('OC pagada OC-5');
  });

  it('no duplica la OC pagada cuando su CXP ya tiene cobertura de pago', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noProveedor: '59570032',
      noFactura: 'OC-DUP',
      nombre: 'NEW WORLD FUEL SA DE CV',
      fechaFactura: '2026-05-01',
      fechaProgramacionPago: '2026-05-17',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });
    const coverage = new Map<string, CxpPaymentCoverage>([[
      '00011::OC-DUP::59570032',
      {
        cxpKey: '00011::OC-DUP::59570032',
        status: 'PAID',
        totalPaidPesos: 1160,
        payments: [{ noPago: 'PV-1', fechaPago: '2026-05-12', importe: 1160, tier: 'invoice-amount' }],
      },
    ]]);

    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      cxpPaymentCoverage: coverage,
      purchaseReceipts: [purchaseReceipt({
        cia: '00011',
        noProveedor: '59570032',
        invoiceNo: 'OC-DUP',
        purchaseOrderNo: 'OC-DUP',
        receiptDate: '2026-05-01',
        taxRate: 16,
        taxTreatment: 'IVA_CREDITABLE',
        amountMxn: 1160,
        totalAmount: 1160,
      })],
      auxiliarReconciliation: auxiliarResult([{
        ...auxiliarLine({ cia: '00011', noFactura: 'OC-DUP', contraparte: 'NEW WORLD FUEL SA DE CV', bankDate: '2026-05-12', importe: -1160, sourceKind: 'oc' }),
        source: { kind: 'oc', cia: '00011', ref: 'OC-DUP', contraparte: 'NEW WORLD FUEL SA DE CV' },
      }]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // Una sola acreditación (la de la cobertura CXP), no dos.
    expect(may.realIva.expenseLines).toHaveLength(1);
    expect(may.realIva.ivaCreditable).toBeCloseTo(160);
  });

  it('cruza el recibo de compra por comentario+importe cuando el pago no trae CXP', () => {
    const pago = pagoProveedor({
      cia: '00011',
      tipoPago: 'PV',
      noPago: '901',
      claveProveedor: '59570032',
      importePesos: 1160,
      comentarioPago: 'PAGO REC-1',
    });
    const view = buildTaxDashboardView({
      paymentMatches: [paymentMatch(pago, [])],
      purchaseReceipts: [
        // Otro proveedor → descartado.
        purchaseReceipt({ cia: '00011', noProveedor: '111', invoiceNo: 'OTRO', receiptNo: 'REC-X', amountMxn: 1160, taxRate: 16, taxTreatment: 'IVA_CREDITABLE' }),
        // Cancelado → descartado.
        purchaseReceipt({ cia: '00011', invoiceNo: 'CANC', receiptNo: 'REC-C', isCancelled: true, amountMxn: 1160, taxRate: 16, taxTreatment: 'IVA_CREDITABLE' }),
        // Coincide por comentario e importe.
        purchaseReceipt({ cia: '00011', invoiceNo: 'FAC-1', receiptNo: 'REC-1', purchaseOrderNo: '', amountMxn: 1160, totalAmount: 1160, taxRate: 16, taxTreatment: 'IVA_CREDITABLE' }),
        // Mismo comentario pero importe distinto → desempata por monto.
        purchaseReceipt({ cia: '00011', invoiceNo: 'FAC-2', receiptNo: 'REC-1', purchaseOrderNo: '', amountMxn: 99, totalAmount: 99, taxRate: 16, taxTreatment: 'IVA_CREDITABLE' }),
      ],
      auxiliarReconciliation: auxiliarResult([
        {
          ...auxiliarLine({ cia: '00011', noFactura: 'PV901', contraparte: 'NEW WORLD FUEL SA DE CV', bankDate: '2026-05-20', importe: -1160, sourceKind: 'pago' }),
          source: { kind: 'pago', cia: '00011', ref: 'PV901', contraparte: 'NEW WORLD FUEL SA DE CV' },
        },
        // Segundo cargo del MISMO recibo, más antiguo → manda la fecha temprana.
        {
          ...auxiliarLine({ cia: '00011', noFactura: 'PV901', contraparte: 'NEW WORLD FUEL SA DE CV', bankDate: '2026-05-12', importe: -1160, sourceKind: 'pago' }),
          source: { kind: 'pago', cia: '00011', ref: 'PV901', contraparte: 'NEW WORLD FUEL SA DE CV' },
        },
      ]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.expenseLines).toHaveLength(1);
    expect(may.realIva.expenseLines[0].concept).toContain('FAC-1');
    expect(may.realIva.expenseLines[0].date).toBe('2026-05-12');
  });

  it('descarta recibos de otra cia y de otra empresa que la del pago', () => {
    const pago = pagoProveedor({ cia: '00022', tipoPago: 'PV', noPago: '903', claveProveedor: '59570032', importePesos: 1160, comentarioPago: 'PAGO REC-1' });
    const view = buildTaxDashboardView({
      paymentMatches: [paymentMatch(pago, [])],
      purchaseReceipts: [
        // Fuera del `companyCode` filtrado.
        purchaseReceipt({ cia: '00099', invoiceNo: 'FAC-99', receiptNo: 'REC-1', amountMxn: 1160, taxRate: 16, taxTreatment: 'IVA_CREDITABLE' }),
        // Dentro del scope pero de otra empresa que la del pago.
        purchaseReceipt({ cia: '00011', invoiceNo: 'FAC-11', receiptNo: 'REC-1', amountMxn: 1160, taxRate: 16, taxTreatment: 'IVA_CREDITABLE' }),
      ],
      auxiliarReconciliation: auxiliarResult([{
        ...auxiliarLine({ cia: '00011', noFactura: 'PV903', contraparte: 'NEW WORLD FUEL SA DE CV', bankDate: '2026-05-12', importe: -1160, sourceKind: 'pago' }),
        // La llave de búsqueda del pago sale de la cia del documento fuente.
        source: { kind: 'pago', cia: '00022', ref: 'PV903', contraparte: 'NEW WORLD FUEL SA DE CV' },
      }]),
      companyCode: '00011',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      today: '2026-05-01',
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // Ningún recibo cruza → el cargo cae completo a no clasificado.
    expect(may.realIva.expenseLines).toHaveLength(0);
    expect(may.realIva.unclassifiedExpense).toBe(1160);
  });

  it('sin comentario ni importe del pago no se puede desempatar el recibo', () => {
    const pago: PagoProveedorRecord = {
      ...pagoProveedor({ cia: '00011', noPago: '904', claveProveedor: '59570032', importePesos: 0 }),
      tipoPago: undefined as unknown as string,
      comentarioPago: undefined as unknown as string,
    };

    const view = buildTaxDashboardView({
      paymentMatches: [paymentMatch(pago, [])],
      purchaseReceipts: [
        purchaseReceipt({ cia: '00011', invoiceNo: 'FAC-A', receiptNo: 'REC-A', amountMxn: 1160, taxRate: 16, taxTreatment: 'IVA_CREDITABLE' }),
        purchaseReceipt({ cia: '00011', invoiceNo: 'FAC-B', receiptNo: 'REC-B', amountMxn: 1160, taxRate: 16, taxTreatment: 'IVA_CREDITABLE' }),
      ],
      auxiliarReconciliation: auxiliarResult([
        {
          ...auxiliarLine({ cia: '00011', noFactura: '904', contraparte: 'NEW WORLD FUEL SA DE CV', bankDate: '2026-05-12', importe: -1160, sourceKind: 'pago' }),
          source: { kind: 'pago', cia: '00011', ref: '904', contraparte: 'NEW WORLD FUEL SA DE CV' },
        },
        // Sin referencia ni tipo de documento → etiqueta genérica.
        {
          ...auxiliarLine({ cia: '00011', noFactura: 'X', contraparte: 'PROVEEDOR X', bankDate: '2026-05-13', importe: -400, sourceKind: 'pago' }),
          tipoDocto: '',
          source: { kind: 'pago', cia: '00011', ref: '', contraparte: 'PROVEEDOR X' },
        },
      ]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.unclassifiedExpense).toBe(1560);
    expect(may.realIva.unclassifiedLines.map((line) => line.concept)).toEqual([
      'Pago proveedor sin desglose fiscal 904',
      'Pago proveedor sin desglose fiscal',
    ]);
  });

  it('deduplica OCs pagadas idénticas y arma la llave con recibo/OC/proveedor vacíos', () => {
    const base = {
      cia: '00011',
      purchaseOrderNo: 'OC-A',
      invoiceNo: '',
      receiptNo: '',
      noProveedor: '',
      supplierName: 'PROVEEDOR ALFA',
      taxRate: 16 as const,
      taxTreatment: 'IVA_CREDITABLE' as const,
      amountMxn: 1160,
      totalAmount: 1160,
    };

    const view = buildTaxDashboardView({
      purchaseReceipts: [purchaseReceipt(base), purchaseReceipt(base)],
      auxiliarReconciliation: auxiliarResult([{
        ...auxiliarLine({ cia: '00011', noFactura: 'OC-A', contraparte: 'PROVEEDOR ALFA', bankDate: '2026-05-12', importe: -1160, sourceKind: 'oc' }),
        source: { kind: 'oc', cia: '00011', ref: 'OC-A', contraparte: 'PROVEEDOR ALFA' },
      }]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // Dos recibos con la MISMA llave → una sola acreditación.
    expect(may.realIva.expenseLines).toHaveLength(1);
    expect(may.realIva.expenseLines[0]).toMatchObject({
      concept: 'OC pagada OC-A · PROVEEDOR ALFA',
      rateTarget: { targetType: 'PROVIDER', targetKey: 'PROVEEDOR ALFA' },
    });
    expect(may.realIva.ivaCreditable).toBeCloseTo(1160 - 1160 / 1.16, 4);
  });

  it('pago sin comentario ni recibo cruzable cae a "pago proveedor sin desglose fiscal"', () => {
    const pago = pagoProveedor({
      cia: '00011',
      tipoPago: 'PV',
      noPago: '902',
      claveProveedor: 'DESCONOCIDO',
      importePesos: 700,
      comentarioPago: '',
    });
    const line: AuxiliarReconLine = {
      ...auxiliarLine({ cia: '00011', noFactura: 'PV902', contraparte: 'PROVEEDOR RARO', bankDate: '2026-05-12', importe: -700, sourceKind: 'pago' }),
      bankAmount: undefined,
      tipoDocto: '',
      source: { kind: 'pago', cia: '00011', ref: '', contraparte: 'PROVEEDOR RARO' },
    };

    const view = buildTaxDashboardView({
      paymentMatches: [paymentMatch(pago, [])],
      purchaseReceipts: [purchaseReceipt({ cia: '00011', noProveedor: '59570032', amountMxn: 1160 })],
      auxiliarReconciliation: auxiliarResult([
        { ...line, source: { kind: 'pago', cia: '00011', ref: 'PV902', contraparte: 'PROVEEDOR RARO' } },
        // Duplicada exacta → dedupe por glKey+fecha+importe.
        { ...line, source: { kind: 'pago', cia: '00011', ref: 'PV902', contraparte: 'PROVEEDOR RARO' } },
        // Fuera de rango.
        { ...line, bankDate: '2026-08-12', fechaContable: '2026-08-12', source: { kind: 'pago', cia: '00011', ref: 'PV902', contraparte: 'PROVEEDOR RARO' } },
        // Importe 0.
        { ...line, importe: 0, source: { kind: 'pago', cia: '00011', ref: 'PV902', contraparte: 'PROVEEDOR RARO' } },
      ]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.unclassifiedExpense).toBe(700);
    expect(may.realIva.unclassifiedLines).toHaveLength(1);
    expect(may.realIva.unclassifiedLines[0].concept).toBe('Pago proveedor sin desglose fiscal PV902');
  });
});

// ---------------------------------------------------------------------------
// Estimador direccional del Auxiliar
// ---------------------------------------------------------------------------

describe('branches — estimador direccional del Auxiliar', () => {
  it('salta líneas no confirmadas, de otra cia, sin fecha, sin monto, internas y ya conocidas', () => {
    const conocidaCxp = cxpRecord({ cia: '00011', noFactura: 'F-CONOCIDA', importeBrutoPesos: 0, importePendientePesos: 0 });
    // Misma línea repetida (mismo glKey) para ejercitar el dedupe del estimador.
    const nueva = auxLine('00011', 'F-NUEVA', 'PROVEEDOR FLETES', '2026-05-11', -1160);

    const view = buildTaxDashboardView({
      cxpRecords: [conocidaCxp],
      purchaseReceipts: [purchaseReceipt({ cia: '00011', invoiceNo: 'F-COMPRA', receiptNo: 'REC-COMPRA', purchaseOrderNo: 'OC-CONOCIDA', amountMxn: 0, totalAmount: 0 })],
      cobranzaPayments: [{
        ...cobranzaPayment({
          idPago: 'PAY-CONOCIDO',
          fechaCobro: '2026-05-02',
          importeRecibo: 100,
          applications: [{
            noFactura: 'F-COBRO',
            importeCobrado: 100,
            importeOriginalFactura: 100,
            importeIvaFacturaOriginal: 0,
            tasaIva: 'EXENTO',
          }],
        }),
        applications: [{
          idPago: 'PAY-CONOCIDO',
          // cia vacía en la aplicación → cae a la del recibo.
          cia: '',
          fechaAplicacion: '2026-05-02',
          noCliente: 'C-9001',
          cliente: 'Cliente IVA',
          tipoDocto: 'RI',
          noFactura: 'F-COBRO',
          noFacturaNormalizada: 'F-COBRO-N',
          fechaFactura: '2026-05-01',
          fechaVencimiento: '2026-05-31',
          diasAntiguedadFafv: 0,
          importeCobrado: 100,
          importeOriginalFactura: 100,
          tasaIva: 'EXENTO',
          importeIvaFacturaOriginal: 0,
        }],
      }],
      auxiliarReconciliation: auxiliarResult([
        { ...auxLine('00011', 'F-X', 'PROVEEDOR FLETES', '2026-05-10', -1160), matchTier: 'gl-orphan' },
        auxLine('00099', 'F-Y', 'PROVEEDOR FLETES', '2026-05-10', -1160),
        { ...auxLine('00011', 'F-Z', 'PROVEEDOR FLETES', '2026-05-10', -1160), bankDate: undefined, fechaContable: '10/05/2026' },
        { ...auxLine('00011', 'F-W', 'PROVEEDOR FLETES', '2026-05-10', 0), bankAmount: 0 },
        // Ya conocidas (CXP, compras y cobranza) → no se estiman de nuevo.
        auxLine('00011', 'F-CONOCIDA', 'PROVEEDOR FLETES', '2026-05-10', -1160),
        auxLine('00011', 'F-COMPRA', 'PROVEEDOR FLETES', '2026-05-10', -1160),
        { ...auxLine('00011', 'F-COBRO', 'CLIENTE', '2026-05-10', 1160), flujo: 'ingreso' },
        { ...auxLine('00011', 'OC-CONOCIDA', 'PROVEEDOR FLETES', '2026-05-10', -1160), source: { kind: 'oc', cia: '00011', ref: 'OC-CONOCIDA', contraparte: 'PROVEEDOR FLETES' } },
        // Concepto no gravable (traspaso interno) → fuera.
        { ...auxLine('00011', 'TRASPASO-1', 'INTERCOMPANIA', '2026-05-10', -1160), tipoDoctoDesc: 'TRASPASO' },
        // Nueva y válida (factura de egreso desconocida) → sí estima.
        nueva,
        // Duplicada exacta → dedupe.
        { ...nueva },
      ]),
      companyCode: '00011',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      today: '2026-05-01',
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    const estimadas = may.realIva.expenseLines.filter((line) => line.movementId.startsWith('aux-iva-estimate:'));
    expect(estimadas).toHaveLength(1);
    expect(estimadas[0].taxAmount).toBeCloseTo(1160 - 1160 / 1.16, 4);
  });

  it('etiqueta con la cuenta cuando la línea no trae contraparte ni tipo de documento', () => {
    const view = buildTaxDashboardView({
      auxiliarReconciliation: auxiliarResult([{
        ...auxLine('00011', 'F-SINDATOS', '', '2026-05-11', -1160),
        tipoDocto: '',
        tipoDoctoDesc: '',
        source: { kind: 'factura', cia: '00011', ref: 'F-SINDATOS', contraparte: undefined },
      }]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    const [linea] = may.realIva.expenseLines;
    expect(linea.counterpartyName).toBe('BANAMEX CTA');
    expect(linea.concept).toContain('GL · F-SINDATOS · BANAMEX CTA');
    expect(linea.rateTarget).toEqual({ targetType: 'CONCEPT', targetKey: 'GL · F-SINDATOS · BANAMEX CTA' });
  });

  it('descarta la línea sin ningún texto identificable', () => {
    const view = buildTaxDashboardView({
      auxiliarReconciliation: auxiliarResult([{
        ...auxLine('00011', '', '', '2026-05-11', -1160),
        tipoDocto: '',
        tipoDoctoDesc: '',
        nombreCuenta: '',
        source: { kind: '' as never, cia: '00011', ref: '', contraparte: '' },
      }]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    expect(view.periods).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Presupuesto (FORECAST)
// ---------------------------------------------------------------------------

describe('branches — complemento de IVA presupuestal', () => {
  it('acepta presupuestos sin conceptos y salta meses vacíos o fuera del rango', () => {
    const vacio = buildTaxDashboardView({
      budget: { year: 2026, scale: 'pesos', incomeTotal: [], incomeByConcept: [], expenseTotal: [], uploadedAt: '2026-01-01T00:00:00.000Z' } as unknown as Budget,
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });
    expect(vacio.periods).toHaveLength(0);

    const view = buildTaxDashboardView({
      budget: budget({
        // PAYROLL / TAX / DEBT no son acreditables → no entran.
        expenseConcepts: [
          { concept: 'NOMINA', monthly: { may: 1000 } },
          { concept: 'IMPUESTOS', monthly: { may: 1000 } },
          { concept: 'PRESTAMO BANCARIO', monthly: { may: 1000 } },
          { concept: 'INVERSION EN FLOTA', monthly: { may: 1160 } },
          // Mes fuera del rango + mes en 0.
          { concept: 'RENTA DE PATIOS', monthly: { feb: 5000 } },
        ],
      }),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.forecastIva.ivaCreditable).toBeCloseTo(1160 - 1160 / 1.16, 4);
    // CAPEX se fecha con el día típico rotativo del mes (índice 4 → día 22).
    expect(may.forecastIva.expenseLines[0].date).toBe('2026-05-22');
  });

  it('fecha renta/seguros el día 5 y respeta el override de tasa por concepto', () => {
    let store: TaxStore = defaultTaxStore();
    store = upsertTaxRateOverride(store, { targetType: 'CONCEPT', targetKey: 'RENTA DE PATIOS', rate: 8, updatedAt: '2026-01-01T00:00:00.000Z' });

    const view = buildTaxDashboardView({
      budget: budget({ expenseConcepts: [{ concept: 'RENTA DE PATIOS', monthly: { may: 1080 } }] }),
      ...MAY,
      store,
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.forecastIva.expenseLines[0]).toMatchObject({ date: '2026-05-05', rateSource: 'OVERRIDE', taxRate: 8 });
    expect(may.forecastIva.ivaCreditable8).toBeCloseTo(1080 - 1080 / 1.08, 4);
  });
});

// ---------------------------------------------------------------------------
// Fallback por movimientos (FORECAST)
// ---------------------------------------------------------------------------

describe('branches — fallback de IVA por movimientos', () => {
  it('salta INFLOW, movimientos ya atendidos por OC/CXP y fuera de rango', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noProveedor: 'P-1',
      noFactura: 'F-1',
      fechaProgramacionPago: '2026-05-17',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });

    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      movements: [
        movement('inflow-1', 'INFLOW', 'OPEX', '2026-05-10', 1160, { taxTreatment: 'IVA_CREDITABLE', taxRate: 16 }),
        // Mismo id que la llave `id:` que marca la CXP atendida.
        movement('cxp:00011:P-1:F-1:0', 'OUTFLOW', 'AP_PAYMENT', '2026-05-10', 1160, { sourceSystem: 'JDE', taxTreatment: 'IVA_CREDITABLE', taxRate: 16 }),
        // Mismo folio de factura, con empresa declarada → atendido por folio.
        movement('cxp:otro:P-9:F-1:7', 'OUTFLOW', 'AP_PAYMENT', '2026-05-10', 500, { sourceSystem: 'JDE', companyId: '00011', taxTreatment: 'IVA_CREDITABLE', taxRate: 16 }),
        // Id `cxp:` sin folio → no se puede deducir la factura.
        movement('cxp:00011:P-1:', 'OUTFLOW', 'AP_PAYMENT', '2026-05-10', 232, { sourceSystem: 'JDE', taxTreatment: 'IVA_CREDITABLE', taxRate: 16 }),
        movement('fuera-1', 'OUTFLOW', 'OPEX', '2026-09-10', 1160, { taxTreatment: 'IVA_CREDITABLE', taxRate: 16 }),
        // Monto 0 → sin desglose.
        movement('cero-1', 'OUTFLOW', 'OPEX', '2026-05-10', 0, { taxTreatment: 'IVA_CREDITABLE', taxRate: 16 }),
        // Exento explícito.
        movement('exento-1', 'OUTFLOW', 'OPEX', '2026-05-10', 1160, { taxTreatment: 'IVA_EXEMPT' }),
      ],
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // CXP (160) + el movimiento `cxp:` sin folio (232/1.16 → 32).
    expect(may.forecastIva.ivaCreditable).toBeCloseTo(160 + (232 - 232 / 1.16), 4);
  });

  it('resuelve la tasa por catálogo de proveedor, por defecto y por concepto presupuestal', () => {
    const view = buildTaxDashboardView({
      providers: [
        provider({ name: 'PROVEEDOR OCHO', ivaRate: 8 }),
        // Sin tasa en el catálogo → se ignora al indexar.
        provider({ name: 'PROVEEDOR SIN TASA' }),
      ],
      movements: [
        // Tratamiento acreditable sin tasa + proveedor de catálogo → CATALOG 8%.
        movement('cat-1', 'OUTFLOW', 'AP_PAYMENT', '2026-05-10', 1080, {
          taxTreatment: 'IVA_CREDITABLE',
          counterpartyName: 'PROVEEDOR OCHO',
          counterpartyType: 'SUPPLIER',
        }),
        // Sin tratamiento y sin catálogo → DEFAULT 16% (régimen 601).
        movement('def-1', 'OUTFLOW', 'AP_PAYMENT', '2026-05-11', 1160, {
          counterpartyName: 'PROVEEDOR DESCONOCIDO',
          counterpartyType: 'SUPPLIER',
        }),
        // Sin tratamiento pero con proveedor de catálogo → CATALOG 8%.
        movement('cat-2', 'OUTFLOW', 'AP_PAYMENT', '2026-05-12', 1080, {
          counterpartyName: 'PROVEEDOR OCHO',
          counterpartyType: 'SUPPLIER',
        }),
        // Movimiento presupuestal → target por concepto.
        movement('budget:opex:renta', 'OUTFLOW', 'OPEX', '2026-05-13', 1160, {
          taxTreatment: 'IVA_CREDITABLE',
          taxRate: 16,
          concept: 'RENTA PRESUPUESTADA',
        }),
        // JDE sin contraparte → sin target de tasa.
        movement('gasto-jde', 'OUTFLOW', 'OPEX', '2026-05-14', 1160, {
          sourceSystem: 'JDE',
          taxTreatment: 'IVA_CREDITABLE',
          taxRate: 16,
          concept: 'GASTO SIN CONTRAPARTE',
        }),
      ],
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    const byId = new Map(may.forecastIva.expenseLines.map((line) => [line.movementId, line]));
    expect(byId.get('cat-1')).toMatchObject({ rateSource: 'CATALOG', taxRate: 8 });
    expect(byId.get('def-1')).toMatchObject({ rateSource: 'DEFAULT', taxRate: 16 });
    expect(byId.get('cat-2')).toMatchObject({ rateSource: 'CATALOG', taxRate: 8 });
    expect(byId.get('budget:opex:renta')).toMatchObject({
      rateSource: 'JDE',
      estimated: true,
      rateTarget: { targetType: 'CONCEPT', targetKey: 'RENTA PRESUPUESTADA' },
    });
    expect(byId.get('gasto-jde')?.rateTarget).toBeUndefined();
  });

  it('usa el desglose fiscal del movimiento y cae al bruto cuando falta el impuesto', () => {
    const view = buildTaxDashboardView({
      movements: [
        movement('desglosado', 'OUTFLOW', 'OPEX', '2026-05-10', 1160, {
          taxTreatment: 'IVA_CREDITABLE',
          taxRate: 16,
          taxBaseAmount: 1000,
          taxAmount: 160,
          concept: 'GASTO DESGLOSADO',
        }),
        movement('sin-impuesto', 'OUTFLOW', 'OPEX', '2026-05-11', 1160, {
          taxTreatment: 'IVA_CREDITABLE',
          taxRate: 16,
          taxBaseAmount: 1000,
          concept: 'GASTO SIN IMPUESTO',
        }),
      ],
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    const byId = new Map(may.forecastIva.expenseLines.map((line) => [line.movementId, line]));
    expect(byId.get('desglosado')).toMatchObject({ taxBase: 1000, taxAmount: 160 });
    // Sin `taxAmount` el motor deriva el desglose del bruto.
    expect(byId.get('sin-impuesto')!.taxAmount).toBeCloseTo(1160 - 1160 / 1.16, 4);
  });

  it('aplica la exclusión de acreditable sobre líneas sin concepto', () => {
    const view = buildTaxDashboardView({
      movements: [{
        ...movement('sin-concepto', 'OUTFLOW', 'AP_PAYMENT', '2026-05-10', 1160, {
          taxTreatment: 'IVA_CREDITABLE',
          taxRate: 16,
          counterpartyName: 'PROVEEDOR ANONIMO',
          counterpartyType: 'SUPPLIER',
        }),
        concept: undefined as unknown as string,
      }],
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.forecastIva.ivaCreditable).toBeCloseTo(1160 - 1160 / 1.16, 4);
  });
});

// ---------------------------------------------------------------------------
// Proyección de clientes (FORECAST)
// ---------------------------------------------------------------------------

describe('branches — IVA causado proyectado por cliente', () => {
  it('aplica el override de tasa por cliente sobre la proyección', () => {
    let store: TaxStore = defaultTaxStore();
    store = upsertTaxRateOverride(store, { targetType: 'CLIENT', targetKey: 'CLI-1', rate: 8, updatedAt: '2026-01-01T00:00:00.000Z' });

    const view = buildTaxDashboardView({
      clients: [client({ id: 'CLI-1', name: 'Cliente Frontera', mayBilling: 10_000 })],
      assumptions,
      ...MAY,
      store,
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.forecastIva.ivaCaused8).toBeCloseTo(800);
    expect(may.forecastIva.incomeLines[0].rateSource).toBe('OVERRIDE');
  });
});

// ---------------------------------------------------------------------------
// Ramas remanentes (fechado de cobertura, folios vacíos, ids atendidos)
// ---------------------------------------------------------------------------

describe('branches — remanentes de fechado y llaves', () => {
  it('etiqueta el pago con la fecha bancaria cuando la contable viene vacía', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noFactura: 'F-SINCONT',
      noProveedor: 'P-1',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });

    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      auxiliarReconciliation: auxiliarResult([{
        ...auxiliarLine({ cia: '00011', noFactura: 'F-SINCONT', contraparte: 'Proveedor IVA', bankDate: '2026-05-12', importe: -1160 }),
        fechaContable: '',
      }]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.expenseLines[0].concept).toContain('Auxiliar PV 2026-05-12');
  });

  it('confirmaciones: usa la fecha contable si no hay bancaria y descarta fecha/monto inválidos', () => {
    const mk = (noFactura: string) => cxpRecord({
      cia: '00011',
      noFactura,
      noProveedor: `P-${noFactura}`,
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });

    const view = buildTaxDashboardView({
      cxpRecords: [mk('F-OK'), mk('F-FECHA'), mk('F-MONTO')],
      auxiliarReconciliation: auxiliarResult(
        [auxiliarLine({ cia: '00011', noFactura: 'F-IGNORADA', contraparte: 'X', bankDate: '2026-05-18', importe: -1, matchTier: 'gl-orphan' })],
        new Map<string, AuxiliarSourceConfirmation>([
          // Sin bankDate → usa fechaContable.
          ['factura:00011::F-OK', { confirmed: true, flujo: 'egreso', importe: -1160, fechaContable: '2026-05-18' }],
          // Fecha no ISO en ambos campos.
          ['factura:00011::F-FECHA', { confirmed: true, flujo: 'egreso', importe: -1160, bankDate: '18/05/2026', fechaContable: '18/05/2026' }],
          // Importe 0.
          ['factura:00011::F-MONTO', { confirmed: true, flujo: 'egreso', importe: 0, fechaContable: '2026-05-18' }],
        ]),
      ),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.expenseLines).toHaveLength(1);
    expect(may.realIva.expenseLines[0].concept).toContain('Auxiliar factura F-OK');
    expect(may.realIva.expenseLines[0].date).toBe('2026-05-18');
  });

  it('etiqueta "sin folio" la línea de pago de una CXP sin número de factura', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noFactura: '',
      noProveedor: 'P-9',
      nombre: 'PROVEEDOR NUEVE',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });
    const coverage = new Map<string, CxpPaymentCoverage>([[
      '00011::::P-9',
      {
        cxpKey: '00011::::P-9',
        status: 'PAID',
        totalPaidPesos: 1160,
        payments: [{ noPago: 'PV-9', fechaPago: '2026-05-12', importe: 1160, tier: 'invoice-amount' }],
      },
    ]]);

    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      cxpPaymentCoverage: coverage,
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.realIva.expenseLines[0].concept).toBe('Pago PV-9 · Factura sin folio · PROVEEDOR NUEVE');
  });

  it('descarta el egreso de OC cuya fecha proyectada cae antes del rango', () => {
    const view = buildTaxDashboardView({
      purchaseReceipts: [
        purchaseReceipt({ cia: '00011', invoiceNo: 'OC-ANTES', purchaseOrderNo: 'P-ANTES', estimatedDueDate: '2026-04-10', taxRate: 16, amountMxn: 1160 }),
        purchaseReceipt({ cia: '00011', invoiceNo: 'OC-DENTRO', purchaseOrderNo: 'P-DENTRO', estimatedDueDate: '2026-05-20', taxRate: 16, amountMxn: 1160 }),
      ],
      companyCode: 'all',
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      today: '2026-04-01',
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    expect(may.forecastIva.expenseLines).toHaveLength(1);
    expect(may.forecastIva.expenseLines[0].concept).toContain('OC-DENTRO');
  });

  it('no re-acredita en el fallback el movimiento que ya emitió la OC ni el CXP cruzado por folio', () => {
    const cxp = cxpRecord({
      cia: '00011',
      noProveedor: 'P-1',
      noFactura: 'F-FOLIO',
      fechaProgramacionPago: '2026-05-17',
      importeBrutoPesos: 1160,
      importeSubtotalPesos: 1000,
      importeImpuestosPesos: 160,
      importePendientePesos: 1160,
    });

    const view = buildTaxDashboardView({
      cxpRecords: [cxp],
      purchaseReceipts: [purchaseReceipt({
        cia: '00011',
        noProveedor: '59570032',
        invoiceNo: 'OC-INV',
        purchaseOrderNo: 'OC-INV',
        estimatedDueDate: '2026-05-20',
        taxRate: 16,
        amountMxn: 1160,
        totalAmount: 1160,
      })],
      movements: [
        // Mismo id que genera la OC → ya atendido.
        movement('purchase:00011:59570032:OC-INV', 'OUTFLOW', 'AP_PAYMENT', '2026-05-20', 1160, {
          sourceSystem: 'JDE',
          taxTreatment: 'IVA_CREDITABLE',
          taxRate: 16,
        }),
        // Sin `companyId`: el folio se busca con la llave comodín.
        movement('cxp:zzz:P-9:F-FOLIO:3', 'OUTFLOW', 'AP_PAYMENT', '2026-05-10', 500, {
          sourceSystem: 'JDE',
          taxTreatment: 'IVA_CREDITABLE',
          taxRate: 16,
        }),
      ],
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    const may = view.periods.find((period) => period.period === '2026-05')!;
    // Sólo la CXP (160) y la OC (160) — ningún movimiento se re-acredita.
    expect(may.forecastIva.ivaCreditable).toBeCloseTo(160 + (1160 - 1160 / 1.16), 4);
    expect(may.forecastIva.expenseLines).toHaveLength(2);
  });

  it('tolera conceptos presupuestales sin serie mensual completa', () => {
    const view = buildTaxDashboardView({
      budget: {
        year: 2026,
        scale: 'pesos',
        incomeTotal: [],
        incomeByConcept: [],
        expenseTotal: [],
        expenseByConcept: [{ concept: 'RENTA DE PATIOS', monthly: [] }],
        uploadedAt: '2026-01-01T00:00:00.000Z',
      } as unknown as Budget,
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'FORECAST',
    });

    expect(view.periods).toHaveLength(0);
  });

  it('ignora líneas del Auxiliar con un flujo fuera del contrato', () => {
    const view = buildTaxDashboardView({
      auxiliarReconciliation: auxiliarResult([{
        ...auxLine('00011', 'F-RARA', 'PROVEEDOR FLETES', '2026-05-11', -1160),
        flujo: 'interno' as never,
      }]),
      ...MAY,
      store: defaultTaxStore(),
      ivaMode: 'REAL',
    });

    expect(view.periods).toHaveLength(0);
  });

  it('conserva la fecha de creación del ajuste legacy migrado', () => {
    localStorage.setItem(LEGACY_IVA_KEY, JSON.stringify([{
      id: 'adj-legacy',
      period: '2026-05',
      kind: 'IVA_PAID',
      amount: 100,
      note: '  pago legacy  ',
      createdAt: '2025-12-31T00:00:00.000Z',
    }]));

    const store = loadTaxStore();
    expect(store.adjustments[0]).toMatchObject({
      id: 'legacy:adj-legacy',
      note: 'pago legacy',
      createdAt: '2025-12-31T00:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

function client(input: { id: string; name: string; ivaRate?: 8 | 16; mayBilling: number }): Client {
  const monthlyBilling = Array.from({ length: 12 }, () => 0);
  monthlyBilling[4] = input.mayBilling;
  return {
    id: input.id,
    name: input.name,
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 0,
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
      cliente: '',
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

function auxiliarResult(
  lines: AuxiliarReconLine[],
  sourceConfirmation: Map<string, AuxiliarSourceConfirmation> = new Map(),
): AuxiliarReconResult {
  return {
    lines,
    bankOrphans: [],
    inconsistencies: [],
    sourceConfirmation,
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
    tipoDoctoDesc: patch.tipoDoctoDesc ?? 'Compra de flete',
    estatusConciliado: '',
    matchTier: patch.matchTier ?? 'exact',
    confidence: 0.97,
    bankMovementKey: `bank:${patch.noFactura}:${auxLineSeq}`,
    bankDate: patch.bankDate,
    bankAmount: patch.bankAmount ?? patch.importe,
    source: {
      kind: patch.sourceKind ?? 'factura',
      cia: patch.cia,
      ref: patch.noFactura,
      contraparte: patch.contraparte,
    },
  };
}

/** Atajo posicional para las pruebas del estimador direccional. */
function auxLine(
  cia: string,
  ref: string,
  contraparte: string,
  bankDate: string,
  importe: number,
): AuxiliarReconLine {
  return auxiliarLine({ cia, noFactura: ref, contraparte, bankDate, importe });
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

function budget(input: {
  expenseConcepts: Array<{ concept: string; monthly?: Partial<Record<'feb' | 'may', number>> }>;
}): Budget {
  const monthIndex: Record<'feb' | 'may', number> = { feb: 1, may: 4 };
  const rows = input.expenseConcepts.map((item) => {
    const monthly = Array.from({ length: 12 }, () => 0);
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
