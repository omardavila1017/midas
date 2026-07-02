import { describe, it, expect } from 'vitest';
import {
  extractPaymentEvents,
  computeDailyFlow,
  aggregateWeekly,
  aggregateMonthly,
  computeSummary,
  findExtremeWeeks,
} from './netCashFlowEngine';
import type { PaymentEvent, DailyFlow } from './netCashFlowEngine';
import type { BankAccountStatement, BankStatementLine } from '../services/jdeTypes';
import type { CXPRecord } from './persistence';
import type { CollectionEvent, ConfirmedPayment } from './types';
import { eventKey } from './types';

function cxp(patch: Partial<CXPRecord> = {}): CXPRecord {
  return {
    cia: '00011',
    noProveedor: '5001',
    nombre: 'PROVEEDOR ACME',
    noFactura: 'F-100',
    fechaFactura: '2026-03-01',
    fechaVence: '2026-03-31',
    fechaProgramacionPago: '2026-03-25',
    diasVencida: 0,
    importeBrutoPesos: 1000,
    importePendientePesos: 400,
    importeSubtotalPesos: 862,
    importeImpuestosPesos: 138,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30',
    clasifica: '',
    clasificacionProveedor: 'REFACCIONES',
    edoPago: 'A',
    tipoCambio: 1,
    porVencer: 400,
    v1_30: 0,
    v31_60: 0,
    v61_90: 0,
    v91_120: 0,
    v121_150: 0,
    v151_180: 0,
    mas180: 0,
    ...patch,
  };
}

function mov(partial: Partial<BankStatementLine>): BankStatementLine {
  return {
    cia: partial.cia ?? '00011',
    banco: partial.banco ?? '002',
    cuenta: partial.cuenta ?? '0190047839',
    moneda: partial.moneda ?? 'MXN',
    fechaOperacion: partial.fechaOperacion ?? '2026-03-10',
    referencia: partial.referencia ?? 'REF1',
    concepto: partial.concepto ?? 'PAGO PROVEEDOR ACME',
    tipoMovimiento: partial.tipoMovimiento ?? 'CARGO',
    importe: partial.importe ?? 1000,
    fechaValor: partial.fechaValor,
    saldo: partial.saldo,
  };
}

function acc(mvs: BankStatementLine[]): BankAccountStatement {
  return {
    cia: '00011',
    banco: '002',
    cuenta: '0190047839',
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-03-31',
    movimientos: mvs,
  };
}

function collection(patch: Partial<CollectionEvent> = {}): CollectionEvent {
  return {
    clientId: 'c-1',
    invoiceDate: '2026-03-01',
    theoreticalDate: '2026-03-31',
    realDate: '2026-04-06',
    amount: 5000,
    lagDays: 6,
    isoWeek: 15,
    ...patch,
  };
}

function confirm(e: CollectionEvent, amount = e.amount): ConfirmedPayment {
  return {
    key: eventKey(e),
    clientId: e.clientId,
    realDate: e.realDate,
    invoiceDate: e.invoiceDate,
    amount,
    confirmedAt: '2026-04-06T12:00:00.000Z',
  };
}

const payment = (date: string, amount: number, kind: 'paid' | 'pending' = 'pending'): PaymentEvent => ({
  date,
  amount,
  supplier: 'PROV',
  classification: 'X',
  kind,
  flexibility: 'unknown',
  criticidad: null,
});

describe('extractPaymentEvents (CXP only, legacy path)', () => {
  it('splits a partially paid invoice into paid + pending events', () => {
    const events = extractPaymentEvents([cxp()]);

    expect(events).toHaveLength(2);
    const paid = events.find((e) => e.kind === 'paid')!;
    const pending = events.find((e) => e.kind === 'pending')!;
    // paid = bruto − pendiente, dated on fechaProgramacionPago
    expect(paid.amount).toBe(600);
    expect(paid.date).toBe('2026-03-25');
    expect(pending.amount).toBe(400);
    expect(pending.date).toBe('2026-03-25');
    expect(paid.supplier).toBe('PROVEEDOR ACME');
  });

  it('falls back to fechaVence for pending when no scheduled date', () => {
    const events = extractPaymentEvents([
      cxp({ fechaProgramacionPago: '', importeBrutoPesos: 400 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('pending');
    expect(events[0].date).toBe('2026-03-31');
  });

  it('emits nothing for a fully collected zero-pending record without dates', () => {
    const events = extractPaymentEvents([
      cxp({ importeBrutoPesos: 0, importePendientePesos: 0 }),
    ]);
    expect(events).toHaveLength(0);
  });
});

describe('extractPaymentEvents (with bank statements)', () => {
  it('uses bank CARGOs as the paid source and skips CXP paid portions', () => {
    const bank = [acc([
      mov({ fechaOperacion: '2026-03-10', importe: 700, concepto: 'PAGO PROVEEDOR ACME' }),
      mov({ tipoMovimiento: 'ABONO', importe: 999, concepto: 'DEPOSITO CLIENTE' }),
    ])];

    const events = extractPaymentEvents([cxp()], bank);

    const paid = events.filter((e) => e.kind === 'paid');
    const pending = events.filter((e) => e.kind === 'pending');
    // CXP paid (600) suppressed; the only paid event is the bank CARGO.
    expect(paid).toHaveLength(1);
    expect(paid[0].amount).toBe(700);
    expect(paid[0].classification).toBe('Banco (real)');
    expect(paid[0].source?.origin).toBe('bank');
    // CXP pending survives (future projection not yet in the bank).
    expect(pending).toHaveLength(1);
    expect(pending[0].amount).toBe(400);
  });

  it('excludes internal transfers and non-positive amounts from bank paid events', () => {
    const bank = [acc([
      mov({ concepto: 'TRASPASO REF 123', importe: 5_000 }),
      mov({ concepto: 'PAGO REAL', importe: 0 }),
      mov({ concepto: 'PAGO REAL 2', importe: 300 }),
    ])];

    const events = extractPaymentEvents([], bank);

    expect(events).toHaveLength(1);
    expect(events[0].amount).toBe(300);
  });

  it('sorts events by date', () => {
    const bank = [acc([
      mov({ fechaOperacion: '2026-03-20', importe: 1 }),
      mov({ fechaOperacion: '2026-03-05', importe: 2 }),
    ])];
    const events = extractPaymentEvents([cxp()], bank);
    const dates = events.map((e) => e.date);
    expect(dates).toEqual([...dates].sort());
  });
});

describe('computeDailyFlow', () => {
  it('nets collections against payments per day and accumulates from the starting balance', () => {
    const c1 = collection({ realDate: '2026-04-06', amount: 5000 });
    const flows = computeDailyFlow(
      [c1],
      [payment('2026-04-06', 2000), payment('2026-04-08', 1000)],
      [],
      2026,
      10_000,
    );

    expect(flows).toHaveLength(2);
    expect(flows[0]).toMatchObject({
      date: '2026-04-06',
      inflows: 5000,
      outflows: 2000,
      net: 3000,
      cumulative: 13_000,
      confirmedIn: 0,
      projectedIn: 5000,
    });
    expect(flows[1]).toMatchObject({
      date: '2026-04-08',
      inflows: 0,
      outflows: 1000,
      net: -1000,
      cumulative: 12_000,
    });
  });

  it('splits confirmed vs projected inflows using confirmed payments (confirmed amount wins)', () => {
    const c1 = collection({ realDate: '2026-04-06', amount: 5000 });
    const c2 = collection({ clientId: 'c-2', realDate: '2026-04-06', amount: 700 });
    const flows = computeDailyFlow([c1, c2], [], [confirm(c1, 4800)], 2026, 0);

    expect(flows).toHaveLength(1);
    expect(flows[0].confirmedIn).toBe(4800);
    expect(flows[0].projectedIn).toBe(700);
    // Gross inflows still use the projected event amounts
    expect(flows[0].inflows).toBe(5700);
  });

  it('filters events outside the target year', () => {
    const flows = computeDailyFlow(
      [collection({ realDate: '2025-12-31' })],
      [payment('2027-01-01', 100)],
      [],
      2026,
      0,
    );
    expect(flows).toHaveLength(0);
  });
});

describe('aggregateWeekly / aggregateMonthly', () => {
  // 2026-01-05 is a Monday; 2026-01-12 starts the next ISO week.
  const daily: DailyFlow[] = [
    { date: '2026-01-05', inflows: 100, outflows: 40, net: 60, cumulative: 60, confirmedIn: 30, projectedIn: 70 },
    { date: '2026-01-07', inflows: 50, outflows: 10, net: 40, cumulative: 100, confirmedIn: 0, projectedIn: 50 },
    { date: '2026-01-12', inflows: 0, outflows: 25, net: -25, cumulative: 75, confirmedIn: 0, projectedIn: 0 },
    { date: '2026-02-02', inflows: 10, outflows: 0, net: 10, cumulative: 85, confirmedIn: 10, projectedIn: 0 },
  ];

  it('groups by ISO week keeping the last cumulative of the week', () => {
    const weeks = aggregateWeekly(daily);

    expect(weeks).toHaveLength(3);
    expect(weeks[0]).toMatchObject({
      weekStart: '2026-01-05',
      inflows: 150,
      outflows: 50,
      net: 100,
      cumulative: 100,
    });
    expect(weeks[1]).toMatchObject({ weekStart: '2026-01-12', net: -25, cumulative: 75 });
    expect(weeks.map((w) => w.weekStart)).toEqual([...weeks.map((w) => w.weekStart)].sort());
  });

  it('groups by calendar month, summing confirmed/projected and keeping last cumulative', () => {
    const months = aggregateMonthly(daily);

    expect(months).toHaveLength(2);
    expect(months[0]).toMatchObject({
      month: 0,
      inflows: 150,
      outflows: 75,
      net: 75,
      cumulative: 75,
      confirmedIn: 30,
      projectedIn: 120,
    });
    expect(months[1]).toMatchObject({ month: 1, net: 10, cumulative: 85 });
  });
});

describe('computeSummary', () => {
  it('totals monthly flows and flags negative months', () => {
    const months = aggregateMonthly([
      { date: '2026-01-05', inflows: 100, outflows: 250, net: -150, cumulative: -150, confirmedIn: 0, projectedIn: 100 },
      { date: '2026-02-02', inflows: 500, outflows: 100, net: 400, cumulative: 250, confirmedIn: 0, projectedIn: 500 },
    ]);

    const summary = computeSummary(months, [], []);

    expect(summary.totalInflows).toBe(600);
    expect(summary.totalOutflows).toBe(350);
    expect(summary.netFlow).toBe(250);
    expect(summary.monthsNegative).toEqual([0]);
    expect(summary.avgDailyNet).toBeCloseTo(250 / (2 * 30));
  });

  it('computes collection efficiency only over past-or-today collections', () => {
    const past1 = collection({ realDate: '2020-01-10', amount: 800 });
    const past2 = collection({ clientId: 'c-2', realDate: '2020-01-15', amount: 200 });
    const future = collection({ clientId: 'c-3', realDate: '2999-01-01', amount: 1_000_000 });

    const summary = computeSummary([], [past1, past2, future], [confirm(past1)]);

    expect(summary.collectionEfficiency).toBeCloseTo(0.8);
  });

  it('returns zero efficiency when there is nothing collectable', () => {
    const summary = computeSummary([], [], []);
    expect(summary.collectionEfficiency).toBe(0);
    expect(summary.avgDailyNet).toBe(0);
  });
});

describe('findExtremeWeeks', () => {
  it('finds worst and best weeks', () => {
    const weeks = aggregateWeekly([
      { date: '2026-01-05', inflows: 0, outflows: 100, net: -100, cumulative: -100, confirmedIn: 0, projectedIn: 0 },
      { date: '2026-01-12', inflows: 500, outflows: 0, net: 500, cumulative: 400, confirmedIn: 0, projectedIn: 500 },
      { date: '2026-01-19', inflows: 50, outflows: 0, net: 50, cumulative: 450, confirmedIn: 0, projectedIn: 50 },
    ]);

    const { worstWeek, bestWeek } = findExtremeWeeks(weeks);

    expect(worstWeek).toEqual({ weekStart: '2026-01-05', net: -100 });
    expect(bestWeek).toEqual({ weekStart: '2026-01-12', net: 500 });
  });

  it('returns nulls on empty input', () => {
    expect(findExtremeWeeks([])).toEqual({ worstWeek: null, bestWeek: null });
  });
});
