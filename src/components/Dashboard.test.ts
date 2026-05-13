import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeBaseCashFlow } from './Dashboard';
import type { BankAccountStatement } from '../services/jde';
import type { Budget } from '../domain/budget';
import type { Provider } from '../domain/types';

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
    fileName: 'legacy.csv',
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

describe('computeBaseCashFlow — horizonte y proyección operativa', () => {
  it('cubre el histórico disponible y 12 meses rodantes de operación', () => {
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
    // 4 meses históricos (ene–abr) + 11 meses proyectados (may–mar) = 15
    expect(base).toHaveLength(15);
    expect(base[0].yearMonth).toBe('2026-01');
    expect(base[base.length - 1].yearMonth).toBe('2027-03');
  });

  it('usa el presupuesto como piso de egreso cuando supera al gasto operativo futuro', () => {
    const statements = [mkStmt('2026-04', 0, 0)];
    const budget = mkBudget({
      // Ingresos presupuestados no sustituyen la cobranza operativa, pero el
      // gasto sí funciona como piso para evitar subproyección.
      incomeTotal: [0, 0, 0, 0, 7777, 7777, 7777, 7777, 7777, 7777, 7777, 7777],
      expenseTotal: [0, 0, 0, 0, 3333, 3333, 3333, 3333, 3333, 3333, 3333, 3333],
    });
    const { base } = computeBaseCashFlow({
      ...BASE_INPUTS,
      bankStatements: statements,
      budget,
    });
    const may = base.find((m) => m.yearMonth === '2026-05');
    expect(may?.income).toBe(0);
    expect(may?.expense).toBe(3333);
    expect(may?.isHistorical).toBe(false);
  });

  it('sin datos operativos futuros, los meses futuros quedan en cero (no hay fallback de regresión)', () => {
    const statements = [
      mkStmt('2026-01', 500, 0),
      mkStmt('2026-02', 500, 0),
      mkStmt('2026-03', 500, 0),
      mkStmt('2026-04', 500, 0),
    ];
    const { base } = computeBaseCashFlow({
      ...BASE_INPUTS,
      bankStatements: statements,
      budget: null,
    });
    // Sigue cubriendo el horizonte rodante pero con income/expense en cero.
    expect(base).toHaveLength(15);
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

  it('proyecta egresos futuros desde el piso operativo de proveedores críticos', () => {
    const { base, projection } = computeBaseCashFlow({
      ...BASE_INPUTS,
      bankStatements: [mkStmt('2026-04', 0, 0)],
      providers: [
        provider({
          id: 'p-critical',
          name: 'Proveedor Critico',
          type: 'OPERACION',
          clasificacionAutomatica: 'CRITICO',
          gastoMinimoMensual: 19_000,
        }),
      ],
    });

    const may = base.find((m) => m.yearMonth === '2026-05');
    const nextMarch = base.find((m) => m.yearMonth === '2027-03');
    const mayProjection = projection.months.find((m) => m.yearMonth === '2026-05');
    expect(may?.expense).toBe(19_000);
    expect(nextMarch?.expense).toBe(19_000);
    expect(mayProjection?.expense.providerLines[0]?.providerName).toBe('Proveedor Critico');
    expect(mayProjection?.expense.providerLines[0]?.parts.recurring).toBe(19_000);
  });
});

function provider(patch: Partial<Provider>): Provider {
  return {
    id: patch.id ?? 'p-1',
    name: patch.name ?? 'Proveedor',
    type: patch.type ?? 'OPERACION',
    risk: patch.risk ?? 'Medio',
    paymentPeriod: patch.paymentPeriod ?? '30 días',
    ...patch,
  };
}
