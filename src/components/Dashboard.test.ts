import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeBaseCashFlow } from './Dashboard';
import type { BankAccountStatement } from '../services/jde';
import type { Budget } from '../domain/budget';

// Fijamos la fecha "hoy" para que el horizonte sea determinista.
const TODAY = '2026-04-22';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(TODAY + 'T12:00:00'));
});
afterEach(() => {
  vi.useRealTimers();
});

function mkStmt(ym: string, income: number, expense: number): BankAccountStatement {
  const [y, m] = ym.split('-').map(Number);
  const day = '15';
  const date = `${y}-${String(m).padStart(2, '0')}-${day}`;
  return {
    cia: '00011',
    banco: 'BANAMEX',
    cuenta: `019${y}${m}`,
    moneda: 'MXN',
    fechaEstadoCuenta: date,
    saldoInicial: 0,
    saldoFinal: 0,
    movimientos: [
      { cia: '00011', banco: 'BANAMEX', cuenta: `019${y}${m}`, moneda: 'MXN',
        fechaOperacion: date, referencia: 'R', concepto: 'PAGO CLIENTE',
        tipoMovimiento: 'ABONO', importe: income },
      { cia: '00011', banco: 'BANAMEX', cuenta: `019${y}${m}`, moneda: 'MXN',
        fechaOperacion: date, referencia: 'R', concepto: 'PAGO PROVEEDOR',
        tipoMovimiento: 'CARGO', importe: expense },
    ],
  };
}

function mkBudget(overrides: Partial<Budget> = {}): Budget {
  return {
    year: 2026,
    fileName: 'presupuesto.csv',
    scale: 'pesos',
    uploadedAt: '2026-01-01T00:00:00Z',
    incomeByConcept: [],
    incomeTotal: [10, 10, 10, 10, 20, 20, 20, 20, 30, 30, 30, 30],
    expenseByConcept: [],
    expenseTotal: [5, 5, 5, 5, 10, 10, 10, 10, 15, 15, 15, 15],
    openingCash: [1000],
    ...overrides,
  };
}

const BASE_INPUTS = {
  bankStatements: [] as BankAccountStatement[],
  aged: [],
  clients: [],
  providers: [],
  cxpRecords: [],
  assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
  companyCode: 'all',
  today: TODAY,
  overrides: {},
  budget: null as Budget | null,
};

describe('computeBaseCashFlow — horizonte y proyección budget-only', () => {
  it('cubre de enero a diciembre del año en curso con budget cargado', () => {
    const statements = [
      mkStmt('2026-01', 100, 40),
      mkStmt('2026-02', 100, 40),
      mkStmt('2026-03', 100, 40),
      mkStmt('2026-04', 100, 40),
    ];
    const { base } = computeBaseCashFlow({
      ...BASE_INPUTS,
      bankStatements: statements,
      budget: mkBudget(),
    });
    // 4 meses históricos (ene–abr) + 8 meses proyectados (may–dic) = 12
    expect(base).toHaveLength(12);
    expect(base[0].yearMonth).toBe('2026-01');
    expect(base[base.length - 1].yearMonth).toBe('2026-12');
  });

  it('los meses proyectados salen DIRECTO del CSV de presupuesto, sin regresión', () => {
    const statements = [mkStmt('2026-04', 0, 0)];
    const budget = mkBudget({
      // Año deliberadamente inflado para que regresión/moving-avg del histórico
      // jamás lo produciría — esto prueba que no se mezcla.
      incomeTotal: [0, 0, 0, 0, 7777, 7777, 7777, 7777, 7777, 7777, 7777, 7777],
      expenseTotal: [0, 0, 0, 0, 3333, 3333, 3333, 3333, 3333, 3333, 3333, 3333],
    });
    const { base } = computeBaseCashFlow({
      ...BASE_INPUTS,
      bankStatements: statements,
      budget,
    });
    const may = base.find((m) => m.yearMonth === '2026-05');
    expect(may?.income).toBe(7777);
    expect(may?.expense).toBe(3333);
    expect(may?.isHistorical).toBe(false);
  });

  it('sin presupuesto cargado, los meses futuros quedan en cero (no hay fallback de regresión)', () => {
    const statements = [
      mkStmt('2026-01', 500, 200),
      mkStmt('2026-02', 500, 200),
      mkStmt('2026-03', 500, 200),
      mkStmt('2026-04', 500, 200),
    ];
    const { base } = computeBaseCashFlow({
      ...BASE_INPUTS,
      bankStatements: statements,
      budget: null,
    });
    // Sigue llegando a diciembre pero con income/expense en cero.
    expect(base).toHaveLength(12);
    const future = base.filter((m) => !m.isHistorical);
    expect(future.length).toBeGreaterThan(0);
    for (const m of future) {
      expect(m.income).toBe(0);
      expect(m.expense).toBe(0);
    }
  });

  it('baseline deja de exponer avgIncome/avgExpense (ya no hay regresión lineal)', () => {
    const statements = [
      mkStmt('2026-01', 9999, 8888),
      mkStmt('2026-02', 9999, 8888),
    ];
    const { baseline } = computeBaseCashFlow({
      ...BASE_INPUTS,
      bankStatements: statements,
      budget: mkBudget(),
    });
    expect(baseline.avgIncome).toBe(0);
    expect(baseline.avgExpense).toBe(0);
  });
});
