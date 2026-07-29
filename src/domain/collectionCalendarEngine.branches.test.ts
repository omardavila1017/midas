/**
 * collectionCalendarEngine.branches.test.ts — cobertura de RAMAS del motor del
 * calendario de cobranza. Hermano de `collectionCalendarEngine.test.ts` (que
 * fija los caminos de negocio con el motor de conciliación real detrás); aquí
 * se ejercitan las ramas restantes usando reconciliaciones sintéticas y los
 * helpers exportados: fuentes del calendario, fallbacks de fechado, la cascada
 * de reglas (API CC13 → catálogo → estructurado → factoraje), el matcher de
 * cliente y el sincronizador `recomputeClientCreditDaysFromCobranza`.
 *
 * No toca código fuente. Las aserciones documentan el comportamiento REAL.
 */
import { describe, expect, it } from 'vitest';
import type { CobranzaRecord } from '../services/jdeTypes';
import type { CashFlowAssumptions, Client } from './types';
import type { RealReconciliationResult } from './realReconciliationEngine';
import type { RolProjectionResult } from './rolProjectionEngine';
import {
  buildClientLookup,
  buildCollectionCalendar,
  calendarEventMatchesSourceFilter,
  clientRuleLabel,
  emptyCollectionCalendarSummary,
  findClientForCobranza,
  listPromesasPago,
  recomputeClientCreditDaysFromCobranza,
  resolveClientCalendarDate,
  resolveCobranzaApiPaymentDate,
  resolveCobranzaRuleDate,
  significantTokens,
  type CollectionCalendarEvent,
  type CollectionCalendarEventSource,
} from './collectionCalendarEngine';

const ASSUMPTIONS: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: '9001',
    name: 'CLIENTE ALFA',
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 0,
    monthlyBilling: new Array(12).fill(1000),
    ...overrides,
  };
}

function makeFactura(overrides: Partial<CobranzaRecord> = {}): CobranzaRecord {
  const base: CobranzaRecord = {
    cia: '00011',
    noFactura: 'F-100',
    noCliente: '9001',
    nombreCliente: 'CLIENTE ALFA',
    fechaFactura: '2026-01-01',
    fechaVence: '2026-01-31',
    fechaCobro: '',
    diasVencida: 0,
    importeBrutoPesos: 1000,
    importePendientePesos: 1000,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30',
    estatus: 'PENDIENTE',
    tipoCambio: 1,
  } as CobranzaRecord;
  return { ...base, ...overrides } as CobranzaRecord;
}

/** Reconciliación sintética — deja aislar ramas sin correr el motor real. */
function recon(patch: Partial<RealReconciliationResult> = {}): RealReconciliationResult {
  return {
    matches: [],
    abonoEnrichments: [],
    paymentReconciliations: [],
    reviewCandidates: [],
    summary: {} as RealReconciliationResult['summary'],
    bankCoverage: {} as RealReconciliationResult['bankCoverage'],
    timingsMs: {} as RealReconciliationResult['timingsMs'],
    ...patch,
  };
}

function abono(patch: Partial<RealReconciliationResult['abonoEnrichments'][number]> = {}) {
  return {
    movementKey: 'MK-1',
    status: 'no-cobranza' as const,
    cia: '00011',
    cuenta: '123',
    fechaOperacion: '2026-01-30',
    importe: 1000,
    concepto: 'DEPOSITO',
    referencia: 'REF-1',
    ...patch,
  };
}

function rolResult(inflows: RolProjectionResult['inflows']): RolProjectionResult {
  return {
    inflows,
    coverageByClientMonth: new Map(),
    unmatchedTrips: 0,
    unmatchedAmount: 0,
  };
}

function evt(source: CollectionCalendarEventSource, patch: Partial<CollectionCalendarEvent> = {}): CollectionCalendarEvent {
  return {
    id: 'e1',
    source,
    date: '2026-01-01',
    amount: 100,
    clientName: 'X',
    statusLabel: '',
    dateReason: '',
    ruleApplied: '',
    facturas: [],
    ...patch,
  };
}

describe('calendarEventMatchesSourceFilter — matriz completa', () => {
  it('"all" acepta cualquier fuente', () => {
    for (const source of ['BANK_MATCHED', 'BANK_FEDERAL', 'BANK_UNMATCHED', 'JDE_PAID_UNMATCHED', 'JDE_OPEN_PROJECTED', 'ROL_PROJECTED'] as const) {
      expect(calendarEventMatchesSourceFilter(evt(source), 'all')).toBe(true);
    }
  });

  it('"cxc" sólo acepta facturas JDE abiertas', () => {
    expect(calendarEventMatchesSourceFilter(evt('JDE_OPEN_PROJECTED'), 'cxc')).toBe(true);
    expect(calendarEventMatchesSourceFilter(evt('ROL_PROJECTED'), 'cxc')).toBe(false);
  });

  it('"projected" sólo acepta ROL', () => {
    expect(calendarEventMatchesSourceFilter(evt('ROL_PROJECTED'), 'projected')).toBe(true);
    expect(calendarEventMatchesSourceFilter(evt('JDE_OPEN_PROJECTED'), 'projected')).toBe(false);
  });

  it('"unruled" sólo acepta facturas abiertas SIN regla de cliente', () => {
    const sinRegla = evt('JDE_OPEN_PROJECTED');
    const conRegla = evt('JDE_OPEN_PROJECTED', {
      rule: {
        clientId: '9001',
        clientName: 'CLIENTE ALFA',
        ruleApplied: 'r',
        matchConfidence: 1,
        invoiceDate: '2026-01-01',
        theoreticalDate: '2026-01-31',
      },
    });
    expect(calendarEventMatchesSourceFilter(sinRegla, 'unruled')).toBe(true);
    expect(calendarEventMatchesSourceFilter(conRegla, 'unruled')).toBe(false);
    expect(calendarEventMatchesSourceFilter(evt('ROL_PROJECTED'), 'unruled')).toBe(false);
  });

  it('"bank" acepta cruzado y federal, no el resto', () => {
    expect(calendarEventMatchesSourceFilter(evt('BANK_MATCHED'), 'bank')).toBe(true);
    expect(calendarEventMatchesSourceFilter(evt('BANK_FEDERAL'), 'bank')).toBe(true);
    expect(calendarEventMatchesSourceFilter(evt('BANK_UNMATCHED'), 'bank')).toBe(false);
  });
});

describe('emptyCollectionCalendarSummary / listPromesasPago', () => {
  it('el resumen vacío arranca en cero para las 6 fuentes', () => {
    const s = emptyCollectionCalendarSummary();
    expect(Object.keys(s)).toHaveLength(6);
    expect(Object.values(s).every((v) => v.count === 0 && v.amount === 0)).toBe(true);
  });

  it('sin promesas devuelve lista vacía', () => {
    expect(listPromesasPago([])).toEqual([]);
    expect(listPromesasPago([{ fechaPromesaPago: undefined }])).toEqual([]);
  });
});

describe('buildCollectionCalendar — eventos desde ABONOs', () => {
  it('un ABONO cruzado cuya factura NO está en el set de cobranza usa los datos del propio cruce', () => {
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [],
      reconciliation: recon({
        abonoEnrichments: [abono({
          status: 'factura-cobrada',
          confidence: 0.91,
          facturas: [{
            cia: '00011',
            noFactura: 'F-999',
            noCliente: '9001',
            nombreCliente: 'CLIENTE ALFA',
            importeBruto: 1000,
          }],
        })],
      }),
    });
    const event = calendar.events[0];
    expect(event.source).toBe('BANK_MATCHED');
    expect(event.facturas[0].importePendiente).toBe(0);
    expect(event.facturas[0].fechaFactura).toBe('');
    // Sin registro de cobranza detrás no se puede calcular la fecha esperada.
    expect(event.expectedPayDate).toBeUndefined();
    expect(event.paymentLagDays).toBeUndefined();
    // matchTier ausente → etiqueta de cruce por defecto.
    expect(event.ruleApplied).toBe('Cruce exact');
  });

  it('un ABONO cruzado con factura conocida calcula fecha esperada y lag de pago', () => {
    const factura = makeFactura({ fechaFactura: '2026-01-01', diasCredito: 30 });
    const calendar = buildCollectionCalendar({
      clients: [makeClient({ id: '9001' })],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: recon({
        abonoEnrichments: [abono({
          status: 'factura-cobrada',
          matchTier: 'invoice-reference',
          fechaOperacion: '2026-02-05',
          facturas: [{
            cia: '00011',
            noFactura: 'F-100',
            noCliente: '9001',
            nombreCliente: 'CLIENTE ALFA',
            importeBruto: 1000,
          }],
        })],
      }),
    });
    const event = calendar.events.find((e) => e.source === 'BANK_MATCHED')!;
    expect(event.ruleApplied).toBe('Cruce invoice-reference');
    // 2026-01-31 cae en sábado → la regla ANY lo corre al lunes 2026-02-02.
    expect(event.expectedPayDate).toBe('2026-02-02');
    expect(event.paymentLagDays).toBe(3);
    // La factura consumida por el banco NO se re-emite como CXC abierto.
    expect(calendar.events.some((e) => e.source === 'JDE_OPEN_PROJECTED')).toBe(false);
  });

  it('un ABONO sin facturas rinde "Abono bancario sin factura"', () => {
    const calendar = buildCollectionCalendar({
      clients: [],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [],
      reconciliation: recon({ abonoEnrichments: [abono({ facturas: [] })] }),
    });
    const event = calendar.events[0];
    expect(event.source).toBe('BANK_UNMATCHED');
    expect(event.clientName).toBe('Abono bancario sin factura');
    expect(event.statusLabel).toBe('Real banco sin factura');
    expect(event.ruleApplied).toBe('Sin factura CXC asociada');
    expect(event.noFactura).toBeUndefined();
  });

  it('un ABONO federal rinde etiquetas de Venta Federal', () => {
    const calendar = buildCollectionCalendar({
      clients: [],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [],
      reconciliation: recon({ abonoEnrichments: [abono({ status: 'federal' })] }),
    });
    const event = calendar.events[0];
    expect(event.source).toBe('BANK_FEDERAL');
    expect(event.clientName).toBe('Venta Federal');
    expect(event.statusLabel).toBe('Venta Federal directa a banco');
    expect(event.ruleApplied).toBe('Cuenta Federal del catálogo de bancos');
  });
});

describe('buildCollectionCalendar — facturas JDE', () => {
  it('una factura ya marcada "cobrada-banco" en el cruce no se re-emite', () => {
    const factura = makeFactura();
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: recon({
        matches: [{
          cia: '00011',
          noFactura: 'F-100',
          noCliente: '9001',
          nombreCliente: 'CLIENTE ALFA',
          status: 'cobrada-banco',
          importeBruto: 1000,
          importePendiente: 0,
          fechaFactura: '2026-01-01',
          fechaVence: '2026-01-31',
          diasVencida: 0,
          moneda: 'MXN',
          reviewStatus: 'auto',
        } as RealReconciliationResult['matches'][number]],
      }),
    });
    expect(calendar.events).toHaveLength(0);
  });

  it('factura cobrada en JDE sin cliente del catálogo no calcula lag ni fecha esperada', () => {
    const factura = makeFactura({
      importePendientePesos: 0,
      fechaCobro: '2026-02-10',
      nombreCliente: '',
      noCliente: '777777',
    });
    const calendar = buildCollectionCalendar({
      clients: [],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: recon(),
    });
    const event = calendar.events[0];
    expect(event.source).toBe('JDE_PAID_UNMATCHED');
    expect(event.clientName).toBe('Cliente sin nombre');
    expect(event.expectedPayDate).toBeUndefined();
    expect(event.paymentLagDays).toBeUndefined();
    expect(event.clientId).toBeUndefined();
  });

  it('factura abierta sin cliente ni regla CC13 cae a la fecha de VENCIMIENTO', () => {
    const factura = makeFactura({
      noCliente: '777777',
      nombreCliente: 'DESCONOCIDO XYZ',
      fechaVence: '2026-03-15',
    });
    const calendar = buildCollectionCalendar({
      clients: [],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: recon(),
    });
    const event = calendar.events[0];
    expect(event.source).toBe('JDE_OPEN_PROJECTED');
    expect(event.date).toBe('2026-03-15');
    expect(event.dateReason).toContain('fecha de vencimiento JDE');
    expect(event.ruleApplied).toBe('Sin regla confiable');
    expect(event.rule).toBeUndefined();
    expect(event.confidence).toBeUndefined();
  });

  it('factura abierta sin cliente, sin regla y SIN vencimiento cae a la fecha de factura', () => {
    const factura = makeFactura({
      noCliente: '777777',
      nombreCliente: 'DESCONOCIDO XYZ',
      fechaVence: '',
      fechaFactura: '2026-02-02',
    });
    const calendar = buildCollectionCalendar({
      clients: [],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: recon(),
    });
    expect(calendar.events[0].date).toBe('2026-02-02');
    expect(calendar.events[0].dateReason).toContain('se usa fecha de factura JDE');
  });

  it('factura abierta sin cliente, sin regla, sin vencimiento y sin fecha de factura cae a HOY', () => {
    const factura = makeFactura({
      noCliente: '777777',
      nombreCliente: 'DESCONOCIDO XYZ',
      fechaVence: '',
      fechaFactura: '',
    });
    const calendar = buildCollectionCalendar({
      clients: [],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: recon(),
    });
    expect(calendar.events[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('factura abierta sin cliente pero CON día de pago del API usa la regla CC13', () => {
    const factura = makeFactura({
      noCliente: '777777',
      nombreCliente: 'DESCONOCIDO XYZ',
      fechaVence: '2026-03-11', // miércoles
      diaPagoNombre: 'Viernes',
    });
    const calendar = buildCollectionCalendar({
      clients: [],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: recon(),
    });
    const event = calendar.events[0];
    expect(event.date).toBe('2026-03-13');
    expect(event.dateReason).toContain('Regla CC13 /cobranza: Viernes');
    // Sin cliente del catálogo no hay bloque `rule` aunque sí haya fecha resuelta.
    expect(event.rule).toBeUndefined();
  });

  it('factura abierta con nombre de cliente vacío cae al nombre del catálogo', () => {
    const factura = makeFactura({ nombreCliente: '', noCliente: '9001' });
    const calendar = buildCollectionCalendar({
      clients: [makeClient({ id: '9001', name: 'CLIENTE ALFA' })],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: recon(),
    });
    expect(calendar.events[0].clientName).toBe('CLIENTE ALFA');
    expect(calendar.events[0].rule?.clientId).toBe('9001');
  });

  it('factura abierta sin nombre y sin cliente cae a "Cliente sin regla"', () => {
    const factura = makeFactura({ nombreCliente: '', noCliente: '777777', fechaVence: '2026-03-15' });
    const calendar = buildCollectionCalendar({
      clients: [],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: recon(),
    });
    expect(calendar.events[0].clientName).toBe('Cliente sin regla');
  });

  it('una factura con importe pendiente 0 y SIN fecha de cobro no emite evento', () => {
    const factura = makeFactura({ importePendientePesos: 0, fechaCobro: '' });
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: recon(),
    });
    expect(calendar.events).toHaveLength(0);
  });
});

describe('buildCollectionCalendar — proyección ROL', () => {
  it('descarta viajes de un cliente intercompañía del grupo', () => {
    const calendar = buildCollectionCalendar({
      clients: [makeClient({ id: 'interno', name: 'TURIMEX DEL NORTE' })],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [],
      reconciliation: recon(),
      rolProjection: rolResult([{
        cia: '00011',
        clientId: 'interno',
        clientName: 'TURIMEX DEL NORTE',
        date: '2026-07-01',
        grossAmount: 1000,
        subTotal: 862,
        tripCount: 2,
        ruleReason: 'regla',
      }]),
    });
    expect(calendar.events).toHaveLength(0);
  });

  it('un viaje único usa singular y un cliente desconocido cae a la etiqueta genérica', () => {
    const calendar = buildCollectionCalendar({
      clients: [],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [],
      reconciliation: recon(),
      rolProjection: rolResult([{
        cia: '',
        clientId: 'no-en-catalogo',
        clientName: 'CLIENTE X',
        date: '2026-07-01',
        grossAmount: 1160,
        subTotal: 1000,
        tripCount: 1,
        ruleReason: 'regla del cliente',
      }]),
    });
    const event = calendar.events[0];
    expect(event.source).toBe('ROL_PROJECTED');
    expect(event.statusLabel).toBe('Viaje ejecutado por facturar (1 viaje)');
    expect(event.ruleApplied).toBe('Regla de cliente');
    expect(event.cia).toBeUndefined();
    expect(event.confidence).toBe(0.7);
  });

  it('varios viajes usan plural y el cliente del catálogo aporta su etiqueta de regla', () => {
    const calendar = buildCollectionCalendar({
      clients: [makeClient({ id: '9001', creditDays: 30, frequency: 'Semanal' })],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [],
      reconciliation: recon(),
      rolProjection: rolResult([{
        cia: '00011',
        clientId: '9001',
        clientName: 'CLIENTE ALFA',
        date: '2026-07-01',
        grossAmount: 2320,
        subTotal: 2000,
        tripCount: 3,
        ruleReason: 'regla',
      }]),
    });
    const event = calendar.events[0];
    expect(event.statusLabel).toBe('Viaje ejecutado por facturar (3 viajes)');
    expect(event.ruleApplied).toBe('Semanal · 30d credito · ANY');
    expect(event.cia).toBe('00011');
  });
});

describe('buildCollectionCalendar — orden de eventos', () => {
  it('ordena por fecha, luego por rango de fuente y luego por monto descendente', () => {
    const calendar = buildCollectionCalendar({
      clients: [],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [],
      reconciliation: recon({
        abonoEnrichments: [
          abono({ movementKey: 'A', fechaOperacion: '2026-01-02', importe: 100 }),
          abono({ movementKey: 'B', fechaOperacion: '2026-01-01', importe: 100 }),
          abono({ movementKey: 'C', fechaOperacion: '2026-01-01', importe: 500 }),
        ],
      }),
    });
    expect(calendar.events.map((e) => e.id)).toEqual(['bank:C', 'bank:B', 'bank:A']);
  });

  it('a igual fecha, el banco cruzado va antes que el ROL proyectado', () => {
    const calendar = buildCollectionCalendar({
      clients: [],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [],
      reconciliation: recon({
        abonoEnrichments: [abono({ movementKey: 'A', fechaOperacion: '2026-07-01', importe: 1 })],
      }),
      rolProjection: rolResult([{
        cia: '00011',
        clientId: 'x',
        clientName: 'X',
        date: '2026-07-01',
        grossAmount: 9999,
        subTotal: 9999,
        tripCount: 1,
        ruleReason: 'r',
      }]),
    });
    expect(calendar.events.map((e) => e.source)).toEqual(['BANK_UNMATCHED', 'ROL_PROJECTED']);
    expect(calendar.summaryBySource.ROL_PROJECTED.count).toBe(1);
  });
});

describe('resolveCobranzaRuleDate — cascada de autoridad', () => {
  it('factoraje ignora el día de pago y corre a día hábil', () => {
    const out = resolveCobranzaRuleDate(
      makeFactura({ fechaFactura: '2026-01-01' }),
      makeClient({ factoraje: true, creditDays: 5 }),
      ASSUMPTIONS,
    );
    expect(out.reason).toBe('Factoraje: factura + 30 dias.');
    // 2026-01-31 es sábado → corre al siguiente día hábil.
    expect(out.calendarDate >= '2026-02-01').toBe(true);
  });

  it('el día de pago de ESTA factura (CC13) gana sobre el catálogo', () => {
    const out = resolveCobranzaRuleDate(
      makeFactura({ fechaFactura: '2026-03-02', diasCredito: 7, diaPagoNombre: 'Viernes' }),
      makeClient({ paymentDayName: 'Lunes', creditDays: 90 }),
      ASSUMPTIONS,
    );
    expect(out.reason).toBe('Regla cliente: 7 dias credito + dia pago API Viernes.');
    expect(out.theoreticalDate).toBe('2026-03-09');
    expect(out.calendarDate).toBe('2026-03-13');
  });

  it('sin CC13 en la factura usa el paymentDayName del catálogo', () => {
    const out = resolveCobranzaRuleDate(
      makeFactura({ fechaFactura: '2026-03-02', diasCredito: 7 }),
      makeClient({ paymentDayName: 'Lunes', creditDays: 90 }),
      ASSUMPTIONS,
    );
    expect(out.reason).toBe('Regla cliente: 7 dias credito + dia pago API Lunes.');
  });

  it('sin ningún día de pago del API usa el patrón estructurado y su etiqueta cruda', () => {
    const out = resolveCobranzaRuleDate(
      makeFactura({ fechaFactura: '2026-03-02', diasCredito: 0 }),
      makeClient({ creditDays: 15, paymentDayRaw: 'Cada viernes de la semana' }),
      ASSUMPTIONS,
    );
    expect(out.reason).toBe('Regla cliente: 15 dias credito + Cada viernes de la semana.');
  });

  it('sin paymentDayRaw la etiqueta cae al kind del patrón', () => {
    const out = resolveCobranzaRuleDate(
      makeFactura({ fechaFactura: '2026-03-02' }),
      makeClient({ creditDays: 15 }),
      ASSUMPTIONS,
    );
    expect(out.reason).toBe('Regla cliente: 15 dias credito + ANY.');
  });

  it('usa nombreDiaPagoCc13 cuando diaPagoNombre viene vacío', () => {
    const out = resolveCobranzaRuleDate(
      makeFactura({ fechaFactura: '2026-03-02', diaPagoNombre: '', nombreDiaPagoCc13: 'Viernes' }),
      makeClient({ creditDays: 7 }),
      ASSUMPTIONS,
    );
    expect(out.reason).toContain('dia pago API Viernes');
  });

  it('días de crédito no positivos del API caen al catálogo', () => {
    const out = resolveCobranzaRuleDate(
      makeFactura({ fechaFactura: '2026-03-02', diasCredito: 0 }),
      makeClient({ creditDays: 45 }),
      ASSUMPTIONS,
    );
    expect(out.theoreticalDate).toBe('2026-04-16');
  });

  it('sin fechaFactura la fecha teórica es la de vencimiento (no factura + crédito)', () => {
    const out = resolveCobranzaRuleDate(
      makeFactura({ fechaFactura: '', fechaVence: '2026-05-20' }),
      makeClient({ creditDays: 90 }),
      ASSUMPTIONS,
    );
    expect(out.invoiceDate).toBe('2026-05-20');
    expect(out.theoreticalDate).toBe('2026-05-20');
  });

  it('sin fechaFactura ni vencimiento cae al día de hoy (no explota)', () => {
    const out = resolveCobranzaRuleDate(
      makeFactura({ fechaFactura: '', fechaVence: '' }),
      makeClient({ creditDays: 0 }),
      ASSUMPTIONS,
    );
    expect(out.invoiceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('una fecha de factura no parseable no rompe el resolvedor', () => {
    const out = resolveCobranzaRuleDate(
      makeFactura({ fechaFactura: 'N/D' }),
      makeClient({ creditDays: 0 }),
      ASSUMPTIONS,
    );
    expect(out.calendarDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('tolera fechas con componente de hora', () => {
    const out = resolveCobranzaRuleDate(
      makeFactura({ fechaFactura: '2026-03-02T00:00:00' }),
      makeClient({ creditDays: 7 }),
      ASSUMPTIONS,
    );
    expect(out.invoiceDate).toBe('2026-03-02');
  });
});

describe('resolveCobranzaApiPaymentDate — sólo con día de pago del API', () => {
  it('sin día de pago del API regresa null', () => {
    expect(resolveCobranzaApiPaymentDate(makeFactura({ diaPagoNombre: '' }))).toBeNull();
  });

  it('un día de pago no parseable regresa null', () => {
    expect(resolveCobranzaApiPaymentDate(makeFactura({ diaPagoNombre: 'CUANDO SE PUEDA' }))).toBeNull();
  });

  it('sin vencimiento usa fecha de factura + Dias_Credito del API', () => {
    const out = resolveCobranzaApiPaymentDate(makeFactura({
      fechaFactura: '2026-03-02',
      fechaVence: '',
      diasCredito: 7,
      diaPagoNombre: 'Viernes',
    }))!;
    expect(out.theoreticalDate).toBe('2026-03-09');
    expect(out.calendarDate).toBe('2026-03-13');
  });

  it('sin Dias_Credito usa condPago numérico', () => {
    const out = resolveCobranzaApiPaymentDate(makeFactura({
      fechaFactura: '2026-03-02',
      fechaVence: '',
      diasCredito: 0,
      condPago: '14',
      diaPagoNombre: 'Viernes',
    }))!;
    expect(out.theoreticalDate).toBe('2026-03-16');
  });

  it('condPago no numérico se trata como 0 días de crédito', () => {
    const out = resolveCobranzaApiPaymentDate(makeFactura({
      fechaFactura: '2026-03-02',
      fechaVence: '',
      diasCredito: 0,
      condPago: 'CONTADO',
      diaPagoNombre: 'Viernes',
    }))!;
    expect(out.theoreticalDate).toBe('2026-03-02');
  });

  it('sin fecha de factura ni vencimiento cae a hoy', () => {
    const out = resolveCobranzaApiPaymentDate(makeFactura({
      fechaFactura: '',
      fechaVence: '',
      diaPagoNombre: 'Viernes',
    }))!;
    expect(out.invoiceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('resolveClientCalendarDate / clientRuleLabel', () => {
  it('factoraje: base + días de factoraje corridos a día hábil', () => {
    const out = resolveClientCalendarDate(
      makeClient({ factoraje: true, creditDays: 10 }),
      '2026-06-01',
      ASSUMPTIONS,
    );
    expect(out.reason).toBe('Factoraje: base + 30 dias.');
    expect(out.theoreticalDate).toBe('2026-06-11');
  });

  it('factoraje que aterriza en fin de semana corre al siguiente día hábil', () => {
    const out = resolveClientCalendarDate(
      makeClient({ factoraje: true }),
      '2026-06-05',
      ASSUMPTIONS,
    );
    // 2026-06-05 + 30d = 2026-07-05 (domingo) → 2026-07-06.
    expect(out.theoreticalDate).toBe('2026-06-05');
    expect(out.calendarDate).toBe('2026-07-06');
  });

  it('usa el día de pago del catálogo cuando es parseable', () => {
    const out = resolveClientCalendarDate(
      makeClient({ creditDays: 7, paymentDayName: 'Viernes' }),
      '2026-03-02',
      ASSUMPTIONS,
    );
    expect(out.reason).toBe('Regla cliente: 7 dias credito + dia pago API Viernes.');
    expect(out.calendarDate).toBe('2026-03-13');
  });

  it('sin día de pago parseable usa paymentDayRaw', () => {
    const out = resolveClientCalendarDate(
      makeClient({ creditDays: 7, paymentDayRaw: 'Los martes' }),
      '2026-03-02',
      ASSUMPTIONS,
    );
    expect(out.reason).toBe('Regla cliente: 7 dias credito + Los martes.');
  });

  it('sin día de pago ni raw usa el kind del patrón', () => {
    const out = resolveClientCalendarDate(makeClient({ creditDays: 7 }), '2026-03-02', ASSUMPTIONS);
    expect(out.reason).toBe('Regla cliente: 7 dias credito + ANY.');
  });

  it('clientRuleLabel marca factoraje', () => {
    expect(clientRuleLabel(makeClient({ creditDays: 30 })))
      .toBe('Mensual · 30d credito · ANY');
    expect(clientRuleLabel(makeClient({ creditDays: 30, factoraje: true, paymentDayRaw: 'Viernes' })))
      .toBe('Mensual · 30d credito · Viernes · factoraje');
  });
});

describe('buildClientLookup / findClientForCobranza — ramas del matcher', () => {
  it('indexa por dígitos del id, por noCliente de las cuentas JDE y por tokens de nombres', () => {
    const lookup = buildClientLookup([
      makeClient({
        id: 'catalog-0-alfa',
        name: 'ALFA MANUFACTURAS',
        legalName: 'ALFA MANUFACTURAS INTEGRALES',
        commercialGroupName: 'GRUPO ALFA',
        jdeAccounts: [
          { cia: '00011', noCliente: '90210', nombreCliente: 'ALFA', matchedAt: '2026-01-01', matchedBy: 'user' },
          { cia: '00011', noCliente: '', nombreCliente: 'vacía', matchedAt: '2026-01-01', matchedBy: 'user' },
        ],
      }),
    ]);
    expect(lookup.byDigits.get('90210')).toHaveLength(1);
    expect(lookup.byDigits.get('0')).toHaveLength(1); // dígitos de "catalog-0-alfa"
    expect(lookup.byToken.get('MANUFACTURAS')).toHaveLength(1);
    expect(lookup.byToken.get('ALFA')).toHaveLength(1);
  });

  it('no duplica un cliente indexado dos veces por la misma llave', () => {
    const lookup = buildClientLookup([
      makeClient({
        id: '9001',
        name: 'ALFA',
        legalName: 'ALFA',
        commercialGroupName: 'ALFA',
        jdeAccounts: [
          { cia: '00011', noCliente: '9001', nombreCliente: 'ALFA', matchedAt: '2026-01-01', matchedBy: 'user' },
        ],
      }),
    ]);
    expect(lookup.byDigits.get('9001')).toHaveLength(1);
    expect(lookup.byToken.get('ALFA')).toHaveLength(1);
  });

  it('una entrada nula en jdeAccounts no rompe el indexado', () => {
    const lookup = buildClientLookup([
      makeClient({
        id: 'catalog-alfa',
        name: 'ALFA MANUFACTURAS',
        jdeAccounts: [null as unknown as NonNullable<Client['jdeAccounts']>[number]],
      }),
    ]);
    expect(lookup.byDigits.size).toBe(0);
    expect(lookup.byToken.get('ALFA')).toHaveLength(1);
  });

  it('un candidato del catálogo sin tokens significativos no aporta traslape', () => {
    const lookup = buildClientLookup([makeClient({ id: 'catalog-generico', name: 'GRUPO SA' })]);
    const match = findClientForCobranza(
      makeFactura({ noCliente: '', nombreCliente: 'ACEROS DEL NORTE PLANTA' }),
      lookup,
    );
    expect(match).toBeNull();
  });

  it('un id sin dígitos no se indexa por dígitos', () => {
    const lookup = buildClientLookup([makeClient({ id: 'alfa', name: 'ALFA MANUFACTURAS' })]);
    expect(lookup.byDigits.size).toBe(0);
  });

  it('match exacto por noCliente da confianza 1', () => {
    const lookup = buildClientLookup([makeClient({ id: '9001', name: 'OTRO NOMBRE TOTALMENTE' })]);
    const match = findClientForCobranza(makeFactura({ noCliente: '9001' }), lookup);
    expect(match?.confidence).toBe(1);
  });

  it('nombre idéntico normalizado da confianza 0.98', () => {
    const lookup = buildClientLookup([makeClient({ id: 'catalog-alfa', name: 'ALFA MANUFACTURAS' })]);
    const match = findClientForCobranza(
      makeFactura({ noCliente: '', nombreCliente: 'Alfa Manufacturas, S.A. de C.V.' }),
      lookup,
    );
    expect(match?.confidence).toBe(0.98);
  });

  it('el nombre del catálogo contenido en el nombre del registro da 0.9', () => {
    const lookup = buildClientLookup([makeClient({ id: 'catalog-alfa', name: 'ALFA MANUFACTURAS' })]);
    const match = findClientForCobranza(
      makeFactura({ noCliente: '', nombreCliente: 'ALFA MANUFACTURAS PLANTA NORTE UNO' }),
      lookup,
    );
    expect(match?.confidence).toBe(0.9);
  });

  it('el nombre del registro contenido en el del catálogo da 0.88', () => {
    const lookup = buildClientLookup([
      makeClient({ id: 'catalog-alfa', name: 'ALFA MANUFACTURAS PLANTA NORTE' }),
    ]);
    const match = findClientForCobranza(
      makeFactura({ noCliente: '', nombreCliente: 'MANUFACTURAS PLANTA' }),
      lookup,
    );
    expect(match?.confidence).toBe(0.88);
  });

  it('sin candidatos por dígitos ni tokens recorre TODO el catálogo y no fuerza match', () => {
    const lookup = buildClientLookup([makeClient({ id: 'catalog-alfa', name: 'ALFA MANUFACTURAS' })]);
    const match = findClientForCobranza(
      makeFactura({ noCliente: '', nombreCliente: 'ZZZ' }),
      lookup,
    );
    expect(match).toBeNull();
  });

  it('elige el candidato de MAYOR confianza cuando hay varios', () => {
    const lookup = buildClientLookup([
      makeClient({ id: 'catalog-parcial', name: 'ALFA MANUFACTURAS PLANTA NORTE ORIENTE' }),
      makeClient({ id: 'catalog-exacto', name: 'ALFA MANUFACTURAS' }),
    ]);
    const match = findClientForCobranza(
      makeFactura({ noCliente: '', nombreCliente: 'ALFA MANUFACTURAS' }),
      lookup,
    );
    expect(match?.client.id).toBe('catalog-exacto');
  });

  it('un solo token en común entre nombres largos no alcanza el umbral de 0.62', () => {
    const lookup = buildClientLookup([
      makeClient({ id: 'catalog-x', name: 'PANIFICADORA REGIONAL NORTE' }),
    ]);
    const match = findClientForCobranza(
      makeFactura({ noCliente: '', nombreCliente: 'ACEROS REGIONAL ORIENTE' }),
      lookup,
    );
    expect(match).toBeNull();
  });

  it('significantTokens descarta tokens cortos y genéricos', () => {
    expect(significantTokens('GRUPO ALFA SA DE CV MEXICO PLANTAS'))
      .toEqual(['ALFA', 'PLANTAS']);
    expect(significantTokens('')).toEqual([]);
  });
});

describe('recomputeClientCreditDaysFromCobranza — ramas de sincronización', () => {
  const base = makeClient({ id: '9001', name: 'CLIENTE ALFA', creditDays: 30 });

  it('sin registros o sin clientes devuelve la MISMA referencia', () => {
    const clients = [base];
    expect(recomputeClientCreditDaysFromCobranza(clients, [])).toBe(clients);
    expect(recomputeClientCreditDaysFromCobranza([], [makeFactura()])).toEqual([]);
  });

  it('sin ningún match cliente↔cobranza devuelve la misma referencia', () => {
    const clients = [makeClient({ id: 'catalog-zzz', name: 'ZZZ INDUSTRIAS' })];
    const out = recomputeClientCreditDaysFromCobranza(
      clients,
      [makeFactura({ noCliente: '', nombreCliente: 'QQQ OTRO' })],
    );
    expect(out).toBe(clients);
  });

  it('sin ningún cambio real devuelve la misma referencia (no clona)', () => {
    const clients = [makeClient({
      id: '9001',
      creditDays: 45,
      creditDaysFromApi: true,
    })];
    const out = recomputeClientCreditDaysFromCobranza(
      clients,
      [makeFactura({ noCliente: '9001', diasCredito: 45 })],
    );
    expect(out).toBe(clients);
  });

  it('Dias_Credito del API gana y prende creditDaysFromApi', () => {
    const out = recomputeClientCreditDaysFromCobranza(
      [base],
      [makeFactura({ noCliente: '9001', diasCredito: 60 })],
    );
    expect(out[0].creditDays).toBe(60);
    expect(out[0].creditDaysFromApi).toBe(true);
  });

  it('sin Dias_Credito usa el promedio de lag real observado y APAGA el flag', () => {
    const out = recomputeClientCreditDaysFromCobranza(
      [makeClient({ id: '9001', creditDays: 30, creditDaysFromApi: true })],
      [
        makeFactura({ noFactura: 'A', noCliente: '9001', importePendientePesos: 0, fechaFactura: '2026-01-01', fechaCobro: '2026-01-11' }),
        makeFactura({ noFactura: 'B', noCliente: '9001', importePendientePesos: 0, fechaFactura: '2026-01-01', fechaCobro: '2026-01-21' }),
      ],
    );
    expect(out[0].creditDays).toBe(15);
    expect(out[0].creditDaysFromApi).toBe(false);
  });

  it('el lag observado tiene piso de 1 día', () => {
    const out = recomputeClientCreditDaysFromCobranza(
      [base],
      [makeFactura({ noCliente: '9001', importePendientePesos: 0, fechaFactura: '2026-01-01', fechaCobro: '2026-01-01' })],
    );
    expect(out[0].creditDays).toBe(1);
  });

  it('descarta samples de lag negativos o mayores a 365 días', () => {
    const clients = [base];
    const out = recomputeClientCreditDaysFromCobranza(clients, [
      makeFactura({ noFactura: 'A', noCliente: '9001', importePendientePesos: 0, fechaFactura: '2026-03-01', fechaCobro: '2026-01-01' }),
      makeFactura({ noFactura: 'B', noCliente: '9001', importePendientePesos: 0, fechaFactura: '2024-01-01', fechaCobro: '2026-01-01' }),
      // Aún pendiente → no es sample.
      makeFactura({ noFactura: 'C', noCliente: '9001', importePendientePesos: 5, fechaFactura: '2026-01-01', fechaCobro: '2026-01-10' }),
    ]);
    expect(out).toBe(clients);
  });

  it('sincroniza grupo padre y apaga manualGroupOverride', () => {
    const out = recomputeClientCreditDaysFromCobranza(
      [makeClient({ id: '9001', manualGroupOverride: true, commercialGroupId: 'viejo', commercialGroupName: 'Viejo' })],
      [makeFactura({ noCliente: '9001', noClientePadre: '55501', nombreClientePadre: '  GRUPO REAL  ' })],
    );
    expect(out[0].commercialGroupId).toBe('client-padre-55501');
    expect(out[0].commercialGroupName).toBe('GRUPO REAL');
    expect(out[0].manualGroupOverride).toBe(false);
  });

  it('el bucket genérico "Resto Clientes" NO se propaga como grupo padre', () => {
    const clients = [base];
    const out = recomputeClientCreditDaysFromCobranza(clients, [
      makeFactura({ noCliente: '9001', noClientePadre: '49080179', nombreClientePadre: 'Resto Clientes' }),
    ]);
    expect(out).toBe(clients);
  });

  it('un padre sin NOMBRE no cambia el grupo', () => {
    const clients = [base];
    const out = recomputeClientCreditDaysFromCobranza(clients, [
      makeFactura({ noCliente: '9001', noClientePadre: '55501', nombreClientePadre: '' }),
    ]);
    expect(out).toBe(clients);
  });

  it('el PRIMER registro poblado gana para padre / crédito / día de pago', () => {
    const out = recomputeClientCreditDaysFromCobranza([base], [
      makeFactura({ noFactura: 'A', noCliente: '9001', diasCredito: 60, diaPagoNombre: 'Viernes', noClientePadre: '55501', nombreClientePadre: 'GRUPO UNO' }),
      makeFactura({ noFactura: 'B', noCliente: '9001', diasCredito: 90, diaPagoNombre: 'Lunes', noClientePadre: '77701', nombreClientePadre: 'GRUPO DOS' }),
    ]);
    expect(out[0].creditDays).toBe(60);
    expect(out[0].paymentDayName).toBe('Viernes');
    expect(out[0].commercialGroupId).toBe('client-padre-55501');
  });

  it('la frecuencia del API prende frequencyFromApi; una no clasificable no toca nada', () => {
    const conFrecuencia = recomputeClientCreditDaysFromCobranza([base], [
      makeFactura({ noCliente: '9001', frecuenciaFacturacionNombre: 'SEMANAL' }),
    ]);
    expect(conFrecuencia[0].frequency).toBe('Semanal');
    expect(conFrecuencia[0].frequencyFromApi).toBe(true);

    const clients = [base];
    const sinFrecuencia = recomputeClientCreditDaysFromCobranza(clients, [
      makeFactura({ noCliente: '9001', frecuenciaFacturacionNombre: 'CUANDO SE PUEDA' }),
    ]);
    expect(sinFrecuencia).toBe(clients);
  });

  it('un cliente sin registros de cobranza no se toca aunque otro sí cambie', () => {
    const intacto = makeClient({ id: 'catalog-zzz', name: 'ZZZ INDUSTRIAS' });
    const out = recomputeClientCreditDaysFromCobranza(
      [makeClient({ id: '9001', creditDays: 30 }), intacto],
      [makeFactura({ noCliente: '9001', diasCredito: 60 })],
    );
    expect(out[1]).toBe(intacto);
    expect(out[0].creditDays).toBe(60);
  });

  it('el día de pago del API ya presente en el catálogo no marca cambio', () => {
    const clients = [makeClient({ id: '9001', creditDays: 30, paymentDayName: 'Viernes' })];
    const out = recomputeClientCreditDaysFromCobranza(clients, [
      makeFactura({ noCliente: '9001', diaPagoNombre: 'Viernes' }),
    ]);
    expect(out).toBe(clients);
  });
});
