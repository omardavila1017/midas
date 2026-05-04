import { describe, expect, it } from 'vitest';
import type { BankAccountStatement, BankStatementLine, CobranzaRecord } from '../services/jdeTypes';
import type { CashFlowAssumptions, Client } from './types';
import { reconcileRealCollections } from './realReconciliationEngine';
import {
  buildCollectionCalendar,
  calendarEventMatchesSourceFilter,
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
    expect(calendar.events.some(e => e.noFactura === 'F-100' && e.source === 'CXC_RULED_PENDING')).toBe(false);
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

  it('calendariza una CXC pendiente con regla de cliente', () => {
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

    const event = calendar.events.find(e => e.source === 'CXC_RULED_PENDING' && e.noFactura === 'F-RULE');
    expect(event?.date).toBe('2026-02-06');
    expect(event?.ruleApplied).toContain('Viernes');
    expect(event?.dateReason).toContain('30 dias');
  });

  it('calendariza CXC pendiente sin regla en fecha de vencimiento', () => {
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

    const event = calendar.events.find(e => e.source === 'CXC_UNRULED_PENDING');
    expect(event?.date).toBe('2026-03-15');
    expect(event?.ruleApplied).toBe('Sin regla confiable');
  });

  it('genera proyecciones futuras aunque exista CXC pendiente y evita duplicar ese ciclo emitido', () => {
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
    const projections = calendar.events.filter(e => e.source === 'PROJECTED_CLIENT_RULE');

    expect(projections.some(e => e.projected?.invoiceDate === '2026-01-01')).toBe(false);
    expect(projections.some(e => e.projected?.invoiceDate === '2026-02-01')).toBe(true);
    expect(calendar.events.some(e => e.source === 'CXC_RULED_PENDING' && e.noFactura === 'F-JAN')).toBe(true);
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
    const projected = calendar.events.find(e => e.source === 'PROJECTED_CLIENT_RULE');

    expect(bank && calendarEventMatchesSourceFilter(bank, 'bank')).toBe(false);
    expect(bank && calendarEventMatchesSourceFilter(bank, 'bank_unmatched')).toBe(true);
    expect(bank && calendarEventMatchesSourceFilter(bank, 'jde')).toBe(false);
    expect(jde && calendarEventMatchesSourceFilter(jde, 'jde')).toBe(true);
    expect(projected && calendarEventMatchesSourceFilter(projected, 'projected')).toBe(true);
  });
});
