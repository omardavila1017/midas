import { describe, expect, it } from 'vitest';
import type { BankAccountStatement, BankStatementLine, CobranzaRecord } from '../services/jdeTypes';
import type { CashFlowAssumptions, Client } from './types';
import { reconcileRealCollections } from './realReconciliationEngine';
import {
  buildCollectionCalendar,
  calendarEventMatchesSourceFilter,
  recomputeClientCreditDaysFromCobranza,
} from './collectionCalendarEngine';

const ASSUMPTIONS: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: overrides.id ?? '9001',
    name: overrides.name ?? 'CLIENTE ALFA',
    paymentDay: overrides.paymentDay ?? { kind: 'ANY' },
    frequency: overrides.frequency ?? 'Mensual',
    creditDays: overrides.creditDays ?? 0,
    monthlyBilling: overrides.monthlyBilling ?? new Array(12).fill(1000),
    ...overrides,
  };
}

function makeFactura(
  overrides: Partial<CobranzaRecord> & Pick<CobranzaRecord, 'cia' | 'noFactura' | 'noCliente' | 'nombreCliente' | 'importeBrutoPesos'>,
): CobranzaRecord {
  return {
    fechaFactura: '2026-01-01',
    fechaVence: '2026-01-31',
    fechaCobro: '',
    diasVencida: 0,
    importePendientePesos: overrides.importePendientePesos ?? overrides.importeBrutoPesos,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30',
    estatus: 'PENDIENTE',
    tipoCambio: 1,
    ...overrides,
  };
}

function makeAbono(
  overrides: Partial<BankStatementLine> & Pick<BankStatementLine, 'cia' | 'cuenta' | 'fechaOperacion' | 'importe'>,
): BankStatementLine {
  return {
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    moneda: 'MXN',
    fechaValor: undefined,
    referencia: 'REF',
    concepto: 'PAGO CLIENTE ALFA',
    tipoMovimiento: 'ABONO',
    saldo: undefined,
    ...overrides,
  };
}

function makeAccount(params: {
  cia: string;
  cuenta: string;
  movimientos: BankStatementLine[];
}): BankAccountStatement {
  return {
    cia: params.cia,
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    cuenta: params.cuenta,
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-01-31',
    saldoInicial: 0,
    saldoFinal: 0,
    movimientos: params.movimientos,
  };
}

describe('buildCollectionCalendar', () => {
  it('usa fecha de banco cuando una factura CXC cruza con un ABONO', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-100',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 1000,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '123',
      fechaOperacion: '2026-01-30',
      importe: 1000,
      referencia: 'DEP-100',
    });
    const reconciliation = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '123', movimientos: [abono] })],
    );
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation,
    });

    const event = calendar.events.find(e => e.source === 'BANK_MATCHED');
    expect(event?.date).toBe('2026-01-30');
    expect(event?.noFactura).toBe('F-100');
    expect(event?.bank?.referencia).toBe('DEP-100');
    expect(calendar.events.some(e => e.noFactura === 'F-100' && e.source === 'JDE_OPEN_PROJECTED')).toBe(false);
  });

  it('muestra JDE cobrado sin bankStatements como JDE_PAID_UNMATCHED', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-JDE',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 2500,
      importePendientePesos: 0,
      fechaCobro: '2026-02-03',
      estatus: 'PAGADA',
    });
    const reconciliation = reconcileRealCollections([factura], []);
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation,
    });

    const event = calendar.events.find(e => e.source === 'JDE_PAID_UNMATCHED');
    expect(event?.date).toBe('2026-02-03');
    expect(event?.amount).toBe(2500);
    expect(event?.statusLabel).toContain('JDE');
  });

  it('calendariza una factura JDE pendiente con regla de cliente', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-RULE',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 1000,
      fechaFactura: '2026-01-01',
      fechaVence: '2026-01-31',
    });
    const client = makeClient({
      creditDays: 30,
      paymentDay: { kind: 'DOW', days: [5] },
      paymentDayRaw: 'Viernes',
    });
    const calendar = buildCollectionCalendar({
      clients: [client],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: reconcileRealCollections([factura], []),
    });

    const event = calendar.events.find(e => e.source === 'JDE_OPEN_PROJECTED' && e.noFactura === 'F-RULE');
    expect(event?.date).toBe('2026-02-06');
    expect(event?.ruleApplied).toContain('Viernes');
    expect(event?.dateReason).toContain('30 dias');
    expect(event?.statusLabel).toContain('JDE');
  });

  it('usa la regla del API (Nombre_Dia_Pago_CC13 + Dias_Credito) sobre el catálogo', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-API',
      noCliente: '9001',
      nombreCliente: 'IMPULSORA INDUSTRIAL MONTERREY',
      importeBrutoPesos: 1000,
      fechaFactura: '2026-01-01',
      fechaVence: '2026-01-31',
      diaPagoNombre: 'Viernes',
      diasCredito: 30,
    });
    // Catálogo viejo/incorrecto: lunes, 999 días. El API debe ganar.
    const client = makeClient({
      creditDays: 999,
      paymentDay: { kind: 'DOW', days: [1] },
      paymentDayRaw: 'Lunes',
    });
    const calendar = buildCollectionCalendar({
      clients: [client],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: reconcileRealCollections([factura], []),
    });

    const event = calendar.events.find(e => e.source === 'JDE_OPEN_PROJECTED' && e.noFactura === 'F-API');
    expect(event?.date).toBe('2026-02-06');
    expect(event?.dateReason).toContain('30 dias');
    expect(event?.dateReason).toContain('dia pago API');
  });

  it('no proyecta facturas intercompañía (RFC de empresa propia del grupo)', () => {
    const interna = makeFactura({
      cia: '00011',
      noFactura: 'F-INTER',
      noCliente: '9001',
      nombreCliente: 'TRANSPORTES TAMAULIPAS',
      rfc: 'TTA4906038F4',
      importeBrutoPesos: 5000,
      fechaFactura: '2026-01-01',
      fechaVence: '2026-01-31',
    });
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [interna],
      reconciliation: reconcileRealCollections([interna], []),
    });

    expect(calendar.events.some(e => e.noFactura === 'F-INTER')).toBe(false);
  });

  it('calendariza factura JDE pendiente sin regla en fecha de vencimiento', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-NORULE',
      noCliente: '777',
      nombreCliente: 'CLIENTE SIN CATALOGO',
      importeBrutoPesos: 1200,
      fechaVence: '2026-03-15',
    });
    const calendar = buildCollectionCalendar({
      clients: [makeClient({ id: '9001', name: 'CLIENTE ALFA' })],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: reconcileRealCollections([factura], []),
    });

    const event = calendar.events.find(e => e.source === 'JDE_OPEN_PROJECTED');
    expect(event?.date).toBe('2026-03-15');
    expect(event?.ruleApplied).toBe('Sin regla confiable');
    expect(calendarEventMatchesSourceFilter(event!, 'unruled')).toBe(true);
  });

  it('genera proyecciones futuras aunque exista factura JDE pendiente y evita duplicar ese ciclo emitido', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-JAN',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 1000,
      fechaFactura: '2026-01-01',
    });
    const client = makeClient({
      creditDays: 0,
      monthlyBilling: new Array(12).fill(1000),
    });
    const calendar = buildCollectionCalendar({
      clients: [client],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: reconcileRealCollections([factura], []),
    });
    const projections = calendar.events.filter(e => e.source === 'CLIENT_PROJECTED');

    expect(projections.some(e => e.projected?.invoiceDate === '2026-01-01')).toBe(false);
    expect(projections.some(e => e.projected?.invoiceDate === '2026-02-01')).toBe(true);
    expect(calendar.events.some(e => e.source === 'JDE_OPEN_PROJECTED' && e.noFactura === 'F-JAN')).toBe(true);
  });

  it('filtra eventos por fuente del calendario', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-JDE',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 2500,
      importePendientePesos: 0,
      fechaCobro: '2026-02-03',
    });
    const unmatchedAbono = makeAbono({
      cia: '00011',
      cuenta: '123',
      fechaOperacion: '2026-02-10',
      importe: 9999,
      concepto: 'ANTICIPO SIN FACTURA',
    });
    const reconciliation = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '123', movimientos: [unmatchedAbono] })],
    );
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation,
    });
    const bank = calendar.events.find(e => e.source === 'BANK_UNMATCHED');
    const jde = calendar.events.find(e => e.source === 'JDE_PAID_UNMATCHED');
    const projected = calendar.events.find(e => e.source === 'CLIENT_PROJECTED');

    expect(bank && calendarEventMatchesSourceFilter(bank, 'bank')).toBe(false);
    expect(bank && calendarEventMatchesSourceFilter(bank, 'bank_unmatched')).toBe(true);
    expect(bank && calendarEventMatchesSourceFilter(bank, 'jde')).toBe(false);
    expect(jde && calendarEventMatchesSourceFilter(jde, 'jde')).toBe(true);
    expect(projected && calendarEventMatchesSourceFilter(projected, 'projected')).toBe(true);
  });
});

describe('recomputeClientCreditDaysFromCobranza · frecuencia de facturación', () => {
  it('la frecuencia del API (CC17) sobre-escribe el catálogo y prende frequencyFromApi', () => {
    const client = makeClient({ id: '9001', name: 'CLIENTE ALFA', frequency: 'Mensual' });
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'RI-1',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 1000,
      frecuenciaFacturacionClave: '1',
      frecuenciaFacturacionNombre: 'SEMANAL                       ',
    });
    const [patched] = recomputeClientCreditDaysFromCobranza([client], [factura]);
    expect(patched.frequency).toBe('Semanal');
    expect(patched.frequencyFromApi).toBe(true);
  });

  it('una frecuencia no clasificable NO pisa el catálogo (no cae a Mensual)', () => {
    const client = makeClient({ id: '9001', name: 'CLIENTE ALFA', frequency: 'Quincenal' });
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'RI-2',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 1000,
      frecuenciaFacturacionNombre: 'ESPECIAL CONVENIO',
    });
    const [patched] = recomputeClientCreditDaysFromCobranza([client], [factura]);
    expect(patched.frequency).toBe('Quincenal');
    expect(patched.frequencyFromApi).not.toBe(true);
  });
});
