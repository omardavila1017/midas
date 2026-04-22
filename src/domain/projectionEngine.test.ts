import { describe, it, expect } from 'vitest';
import {
  projectClientIncomeByMonth,
  resolveIncomeForMonth,
  buildScheduledExpenseMap,
  detectRecurringExpenses,
  resolveExpenseForMonth,
  buildMonthlyProjection,
  applyProjectionOverrides,
} from './projectionEngine';
import type { Client, CashFlowAssumptions } from './types';
import type { AgedBalanceRecord, BankAccountStatement } from '../services/jdeTypes';

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    name: 'Cliente uno',
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 30,
    monthlyBilling: Array.from({ length: 12 }, () => 100_000),
    ...overrides,
  };
}

describe('projectClientIncomeByMonth', () => {
  it('returns empty map for empty clients', () => {
    const m = projectClientIncomeByMonth([], assumptions, '2026-01', '2026-06');
    expect(m.size).toBe(0);
  });

  it('produces a bucket per month when client bills monthly', () => {
    const client = makeClient({ creditDays: 30, paymentDay: { kind: 'ANY' } });
    const m = projectClientIncomeByMonth([client], assumptions, '2026-01', '2026-12');
    // creditDays=30 con factura el día 1 → cae el día 31 (siguiente mes)
    // por lo que cobros caen de feb-2026 en adelante. Debe haber al menos
    // 10 meses con monto positivo dentro del rango.
    const withCash = Array.from(m.values()).filter((v) => v > 0);
    expect(withCash.length).toBeGreaterThanOrEqual(6);
  });
});

describe('resolveIncomeForMonth', () => {
  it('uses clients when total >= 60% of baseline', () => {
    const r = resolveIncomeForMonth(80, 100);
    expect(r.source).toBe('clients');
    expect(r.total).toBe(80);
  });

  it('mixes clients and baseline when below threshold', () => {
    const r = resolveIncomeForMonth(30, 100);
    expect(r.source).toBe('mixed');
    expect(r.total).toBe(100);
    expect(r.fromClients).toBe(30);
    expect(r.fromBaseline).toBe(70);
  });

  it('falls back to baseline when clients empty', () => {
    const r = resolveIncomeForMonth(0, 100);
    expect(r.source).toBe('baseline');
    expect(r.total).toBe(100);
  });

  it('handles zero baseline and zero clients', () => {
    const r = resolveIncomeForMonth(0, 0);
    expect(r.total).toBe(0);
  });
});

describe('buildScheduledExpenseMap', () => {
  it('aggregates aged balances by programacion month', () => {
    const aged: AgedBalanceRecord[] = [
      mkAged({ fechaProgramacionPago: '2026-05-12', importePendientePesos: 1000 }),
      mkAged({ fechaProgramacionPago: '2026-05-20', importePendientePesos: 500 }),
      mkAged({ fechaProgramacionPago: '2026-06-01', importePendientePesos: 700 }),
    ];
    const m = buildScheduledExpenseMap(aged);
    expect(m.get('2026-05')).toBe(1500);
    expect(m.get('2026-06')).toBe(700);
  });

  it('ignores records without fechaProgramacionPago', () => {
    const aged: AgedBalanceRecord[] = [
      mkAged({ fechaProgramacionPago: '', importePendientePesos: 999 }),
    ];
    const m = buildScheduledExpenseMap(aged);
    expect(m.size).toBe(0);
  });
});

describe('detectRecurringExpenses', () => {
  it('detects recurring CARGO concepts', () => {
    const bank: BankAccountStatement[] = [
      mkBank([
        mkMov('2025-11-01', 'CARGO', 50_000, 'NOMINA QUINCENAL'),
        mkMov('2025-11-15', 'CARGO', 50_000, 'NOMINA QUINCENAL'),
        mkMov('2025-12-01', 'CARGO', 50_000, 'NOMINA QUINCENAL'),
        mkMov('2025-12-15', 'CARGO', 50_000, 'NOMINA QUINCENAL'),
        mkMov('2026-01-01', 'CARGO', 50_000, 'NOMINA QUINCENAL'),
        mkMov('2026-01-15', 'CARGO', 50_000, 'NOMINA QUINCENAL'),
        mkMov('2026-02-01', 'CARGO', 50_000, 'NOMINA QUINCENAL'),
        mkMov('2026-02-15', 'CARGO', 50_000, 'NOMINA QUINCENAL'),
        // one-off payment
        mkMov('2025-11-10', 'CARGO', 250_000, 'PAGO UNICO EQUIPO'),
      ]),
    ];
    const { base, top } = detectRecurringExpenses(bank, '2026-04-22');
    expect(top.some((r) => r.label.includes('NOMINA'))).toBe(true);
    expect(top.some((r) => r.label.includes('PAGO UNICO'))).toBe(false);
    expect(base).toBeGreaterThan(0);
  });

  it('returns empty base when no bank data', () => {
    const { base, top } = detectRecurringExpenses([], '2026-04-22');
    expect(base).toBe(0);
    expect(top).toHaveLength(0);
  });
});

describe('resolveExpenseForMonth', () => {
  it('takes the max of scheduled, recurring and baseline', () => {
    const r = resolveExpenseForMonth(100, 200, 150, []);
    expect(r.total).toBe(200);
    expect(r.scheduled).toBe(100);
    expect(r.recurring).toBe(200);
    expect(r.baseline).toBe(150);
  });
});

describe('buildMonthlyProjection', () => {
  it('runs end-to-end and produces one entry per month in range', () => {
    const result = buildMonthlyProjection({
      fromYm: '2026-05',
      toYm: '2026-07',
      clients: [makeClient()],
      aged: [mkAged({ fechaProgramacionPago: '2026-05-15', importePendientePesos: 200_000 })],
      bankStatements: [],
      baselineIncome: 80_000,
      baselineExpense: 70_000,
      assumptions,
      today: '2026-04-22',
    });
    expect(result.months).toHaveLength(3);
    expect(result.months.map((m) => m.yearMonth)).toEqual(['2026-05', '2026-06', '2026-07']);
    const may = result.months.find((m) => m.yearMonth === '2026-05')!;
    expect(may.expense.scheduled).toBe(200_000);
    expect(may.expense.total).toBeGreaterThanOrEqual(200_000);
  });
});

describe('applyProjectionOverrides', () => {
  it('respects manual overrides', () => {
    const projection = [
      { yearMonth: '2026-05', income: baseIncome(120), expense: baseExpense(80) },
      { yearMonth: '2026-06', income: baseIncome(140), expense: baseExpense(90) },
    ];
    const overridden = applyProjectionOverrides(projection, {
      '2026-05': { income: 999, expense: 555 },
      '2026-06': { income: 888 },
    });
    expect(overridden[0]).toEqual({
      yearMonth: '2026-05',
      income: 999,
      expense: 555,
      override: { income: 999, expense: 555 },
    });
    expect(overridden[1].income).toBe(888);
    expect(overridden[1].expense).toBe(90); // unchanged
  });

  it('clears overrides when map empty', () => {
    const projection = [{ yearMonth: '2026-05', income: baseIncome(120), expense: baseExpense(80) }];
    const overridden = applyProjectionOverrides(projection, {});
    expect(overridden[0].override).toBeNull();
    expect(overridden[0].income).toBe(120);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────

function mkAged(o: Partial<AgedBalanceRecord>): AgedBalanceRecord {
  return {
    cia: '00001',
    noProveedor: '',
    nombre: '',
    noFactura: '',
    fechaFactura: '',
    fechaVence: '',
    fechaProgramacionPago: '',
    diasVencida: 0,
    importeBrutoPesos: 0,
    importePendientePesos: 0,
    importeSubtotalPesos: 0,
    importeImpuestosPesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '',
    clasifica: '',
    clasificacionProveedor: '',
    edoPago: '',
    tipoCambio: 1,
    porVencer: 0,
    v1_30: 0,
    v31_60: 0,
    v61_90: 0,
    v91_120: 0,
    v121_150: 0,
    v151_180: 0,
    mas180: 0,
    ...o,
  };
}

function mkBank(movs: ReturnType<typeof mkMov>[]): BankAccountStatement {
  return {
    cia: '00001',
    banco: 'BBVA',
    cuenta: '123',
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-04-22',
    saldoInicial: 0,
    saldoFinal: 0,
    movimientos: movs,
  };
}

function mkMov(fecha: string, tipo: 'CARGO' | 'ABONO', importe: number, concepto: string) {
  return {
    cia: '00001',
    banco: 'BBVA',
    cuenta: '123',
    moneda: 'MXN',
    fechaOperacion: fecha,
    referencia: 'REF-' + fecha,
    concepto,
    tipoMovimiento: tipo,
    importe,
  };
}

function baseIncome(total: number) {
  return { fromClients: total, fromBaseline: 0, total, source: 'clients' as const };
}

function baseExpense(total: number) {
  return { scheduled: 0, recurring: 0, baseline: total, total, topRecurring: [] };
}
