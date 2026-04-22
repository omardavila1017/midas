import { describe, it, expect } from 'vitest';
import {
  addMonths,
  monthsBetween,
  buildHistoricalMonths,
  buildFutureExpenses,
  projectFutureIncome,
  buildExpenseProjector,
  projectMonthlyExpense,
  filterCompleteHistorical,
  applyProposalToMonth,
  evaluateCashFlow,
} from './cashFlowEngine';
import type { Proposal, CashFlowMonth } from '../types';
import type {
  BankAccountStatement,
  AgedBalanceRecord,
} from '../services/jde';

const baseProposal: Proposal = {
  id: 'p1',
  name: 'Test',
  kind: 'expense_saving',
  amount: 10_000,
  startYearMonth: '2026-01',
  frequency: 'monthly',
  enabled: true,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

describe('date helpers', () => {
  it('addMonths across year boundary', () => {
    expect(addMonths('2025-11', 3)).toBe('2026-02');
    expect(addMonths('2026-03', -5)).toBe('2025-10');
  });
  it('monthsBetween', () => {
    expect(monthsBetween('2026-01', '2026-06')).toBe(5);
    expect(monthsBetween('2026-06', '2026-01')).toBe(-5);
    expect(monthsBetween('2025-12', '2026-01')).toBe(1);
  });
});

describe('buildHistoricalMonths', () => {
  it('groups bank statements by month summing ABONO as income and CARGO as expense', () => {
    const statements: BankAccountStatement[] = [{
      cia: '00011',
      banco: 'BANAMEX',
      cuenta: '123',
      moneda: 'MXN',
      fechaEstadoCuenta: '2026-01-31',
      saldoInicial: 1000,
      saldoFinal: 1500,
      movimientos: [
        { cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
          fechaOperacion: '2026-01-05', referencia: 'R1', concepto: 'C1',
          tipoMovimiento: 'ABONO', importe: 2000 },
        { cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
          fechaOperacion: '2026-01-20', referencia: 'R2', concepto: 'C2',
          tipoMovimiento: 'CARGO', importe: 1500 },
        { cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
          fechaOperacion: '2026-02-10', referencia: 'R3', concepto: 'C3',
          tipoMovimiento: 'ABONO', importe: 500 },
      ],
    }];
    const months = buildHistoricalMonths(statements);
    expect(months).toHaveLength(2);
    expect(months[0]).toMatchObject({ yearMonth: '2026-01', isHistorical: true, income: 2000, expense: 1500 });
    expect(months[0].closingCash).toBeCloseTo(1500, 2);
    expect(months[1]).toMatchObject({ yearMonth: '2026-02', income: 500, expense: 0 });
    expect(months[1].closingCash).toBeCloseTo(2000, 2);
  });

  it('returns empty for empty input', () => {
    expect(buildHistoricalMonths([])).toEqual([]);
  });
});

describe('buildFutureExpenses', () => {
  it('groups aged balances by payment month', () => {
    const aged: AgedBalanceRecord[] = [
      {
        cia: '00011', noProveedor: 'P1', nombre: 'Prov', noFactura: 'F1',
        fechaFactura: '2026-03-01', fechaVence: '2026-04-01',
        fechaProgramacionPago: '2026-05-15',
        diasVencida: 0, importeBrutoPesos: 1000, importePendientePesos: 1000,
        importeSubtotalPesos: 800, importeImpuestosPesos: 200,
        importeBrutoDolares: 0, importePendienteDolares: 0,
        moneda: 'MXN', condPago: '', clasifica: '', clasificacionProveedor: '',
        edoPago: '', tipoCambio: 20, porVencer: 1000,
        v1_30: 0, v31_60: 0, v61_90: 0, v91_120: 0, v121_150: 0, v151_180: 0, mas180: 0,
      },
      {
        cia: '00011', noProveedor: 'P2', nombre: 'Prov2', noFactura: 'F2',
        fechaFactura: '2026-03-01', fechaVence: '2026-04-01',
        fechaProgramacionPago: '2026-05-20',
        diasVencida: 0, importeBrutoPesos: 500, importePendientePesos: 500,
        importeSubtotalPesos: 400, importeImpuestosPesos: 100,
        importeBrutoDolares: 0, importePendienteDolares: 0,
        moneda: 'MXN', condPago: '', clasifica: '', clasificacionProveedor: '',
        edoPago: '', tipoCambio: 20, porVencer: 500,
        v1_30: 0, v31_60: 0, v61_90: 0, v91_120: 0, v121_150: 0, v151_180: 0, mas180: 0,
      },
    ];
    const map = buildFutureExpenses(aged);
    expect(map.get('2026-05')).toBe(1500);
  });
});

describe('projectFutureIncome', () => {
  it('averages last N months', () => {
    const hist: CashFlowMonth[] = [
      { yearMonth: '2026-01', isHistorical: true, income: 100, expense: 0, closingCash: 100 },
      { yearMonth: '2026-02', isHistorical: true, income: 200, expense: 0, closingCash: 300 },
      { yearMonth: '2026-03', isHistorical: true, income: 300, expense: 0, closingCash: 600 },
    ];
    expect(projectFutureIncome(hist, 6)).toBe(200);
    expect(projectFutureIncome(hist, 1)).toBe(300);
    expect(projectFutureIncome([])).toBe(0);
  });
});

describe('buildExpenseProjector', () => {
  it('returns 0 when there is no history', () => {
    const p = buildExpenseProjector([]);
    expect(p(1)).toBe(0);
    expect(p(5)).toBe(0);
  });

  it('returns the moving average of the window regardless of offset', () => {
    const hist: CashFlowMonth[] = [
      { yearMonth: '2026-01', isHistorical: true, income: 0, expense: 100, closingCash: 0 },
      { yearMonth: '2026-02', isHistorical: true, income: 0, expense: 200, closingCash: 0 },
      { yearMonth: '2026-03', isHistorical: true, income: 0, expense: 300, closingCash: 0 },
    ];
    const p = buildExpenseProjector(hist);
    // Promedio = (100+200+300)/3 = 200, constante para cualquier offset.
    expect(p(1)).toBeCloseTo(200, 2);
    expect(p(6)).toBeCloseTo(200, 2);
    expect(p(12)).toBeCloseTo(200, 2);
  });

  it('does not collapse to zero when recent months trend down', () => {
    // Antes la regresión lineal devolvía 0 para offsets grandes cuando los
    // últimos meses bajaban (típicamente porque el mes en curso venía
    // parcial). Con la media móvil mantenemos un baseline estable.
    const hist: CashFlowMonth[] = [
      { yearMonth: '2026-01', isHistorical: true, income: 0, expense: 300, closingCash: 0 },
      { yearMonth: '2026-02', isHistorical: true, income: 0, expense: 200, closingCash: 0 },
      { yearMonth: '2026-03', isHistorical: true, income: 0, expense: 100, closingCash: 0 },
    ];
    const p = buildExpenseProjector(hist);
    expect(p(1)).toBeCloseTo(200, 2);
    expect(p(9)).toBeCloseTo(200, 2);
  });

  it('respects the window size, ignoring older months', () => {
    const hist: CashFlowMonth[] = [
      { yearMonth: '2025-10', isHistorical: true, income: 0, expense: 1000, closingCash: 0 },
      { yearMonth: '2025-11', isHistorical: true, income: 0, expense: 1000, closingCash: 0 },
      { yearMonth: '2025-12', isHistorical: true, income: 0, expense: 100, closingCash: 0 },
      { yearMonth: '2026-01', isHistorical: true, income: 0, expense: 100, closingCash: 0 },
    ];
    const p = buildExpenseProjector(hist, 2);
    expect(p(1)).toBeCloseTo(100, 2);
  });
});

describe('filterCompleteHistorical', () => {
  it('drops the current (partial) month and any future-dated rows', () => {
    const hist: CashFlowMonth[] = [
      { yearMonth: '2026-01', isHistorical: true, income: 0, expense: 0, closingCash: 0 },
      { yearMonth: '2026-02', isHistorical: true, income: 0, expense: 0, closingCash: 0 },
      { yearMonth: '2026-03', isHistorical: true, income: 0, expense: 0, closingCash: 0 },
      { yearMonth: '2026-04', isHistorical: true, income: 0, expense: 0, closingCash: 0 },
    ];
    const complete = filterCompleteHistorical(hist, '2026-04-22');
    expect(complete.map((m) => m.yearMonth)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('returns an empty list when no month has closed yet', () => {
    const hist: CashFlowMonth[] = [
      { yearMonth: '2026-04', isHistorical: true, income: 0, expense: 0, closingCash: 0 },
    ];
    expect(filterCompleteHistorical(hist, '2026-04-01')).toEqual([]);
  });
});

describe('projectMonthlyExpense', () => {
  it('uses the committed aged balance when bigger than the projection', () => {
    const projector = () => 100;
    expect(projectMonthlyExpense(1, 500, projector)).toBe(500);
  });

  it('falls back to the regression when nothing is committed', () => {
    const projector = (offset: number) => 200 * offset;
    expect(projectMonthlyExpense(3, 0, projector)).toBe(600);
  });
});

describe('applyProposalToMonth', () => {
  it('disabled proposal contributes nothing', () => {
    const p = { ...baseProposal, enabled: false };
    expect(applyProposalToMonth(p, '2026-01')).toEqual({ deltaIncome: 0, deltaExpense: 0 });
  });

  it('monthly saving applies every month from start', () => {
    expect(applyProposalToMonth(baseProposal, '2025-12')).toEqual({ deltaIncome: 0, deltaExpense: 0 });
    expect(applyProposalToMonth(baseProposal, '2026-01')).toEqual({ deltaIncome: 0, deltaExpense: -10_000 });
    expect(applyProposalToMonth(baseProposal, '2026-06')).toEqual({ deltaIncome: 0, deltaExpense: -10_000 });
  });

  it('one_time only fires at startYearMonth', () => {
    const p: Proposal = { ...baseProposal, frequency: 'one_time' };
    expect(applyProposalToMonth(p, '2026-01')).toEqual({ deltaIncome: 0, deltaExpense: -10_000 });
    expect(applyProposalToMonth(p, '2026-02')).toEqual({ deltaIncome: 0, deltaExpense: 0 });
  });

  it('quarterly fires every 3 months', () => {
    const p: Proposal = { ...baseProposal, frequency: 'quarterly' };
    expect(applyProposalToMonth(p, '2026-01').deltaExpense).toBe(-10_000);
    expect(applyProposalToMonth(p, '2026-02').deltaExpense).toBe(0);
    expect(applyProposalToMonth(p, '2026-04').deltaExpense).toBe(-10_000);
    expect(applyProposalToMonth(p, '2026-07').deltaExpense).toBe(-10_000);
  });

  it('semiannual fires every 6 months', () => {
    const p: Proposal = { ...baseProposal, frequency: 'semiannual' };
    expect(applyProposalToMonth(p, '2026-01').deltaExpense).toBe(-10_000);
    expect(applyProposalToMonth(p, '2026-07').deltaExpense).toBe(-10_000);
    expect(applyProposalToMonth(p, '2026-04').deltaExpense).toBe(0);
  });

  it('income_increase delta goes to income', () => {
    const p: Proposal = { ...baseProposal, kind: 'income_increase' };
    expect(applyProposalToMonth(p, '2026-01')).toEqual({ deltaIncome: 10_000, deltaExpense: 0 });
  });
});

describe('evaluateCashFlow', () => {
  it('historical months are untouched by proposals', () => {
    const base: CashFlowMonth[] = [
      { yearMonth: '2025-12', isHistorical: true, income: 50_000, expense: 30_000, closingCash: 20_000 },
      { yearMonth: '2026-01', isHistorical: false, income: 60_000, expense: 40_000, closingCash: 40_000 },
      { yearMonth: '2026-02', isHistorical: false, income: 60_000, expense: 40_000, closingCash: 60_000 },
    ];
    const ev = evaluateCashFlow(base, [baseProposal]);
    expect(ev.months[0].forecastClosingCash).toBe(20_000);  // histórico, sin cambio
    expect(ev.months[0].proposalDeltas).toHaveLength(0);
    expect(ev.months[1].forecastClosingCash).toBe(50_000);  // 20_000 + 20_000 (base) + 10_000 (ahorro)
    expect(ev.months[2].forecastClosingCash).toBe(80_000);  // 50_000 + 20_000 + 10_000
  });

  it('multiple proposals stack', () => {
    const base: CashFlowMonth[] = [
      { yearMonth: '2025-12', isHistorical: true, income: 0, expense: 0, closingCash: 100_000 },
      { yearMonth: '2026-01', isHistorical: false, income: 0, expense: 0, closingCash: 100_000 },
    ];
    const ahorro: Proposal = { ...baseProposal, id: 'a', amount: 10_000 };
    const ingreso: Proposal = { ...baseProposal, id: 'i', kind: 'income_increase', amount: 5_000 };
    const ev = evaluateCashFlow(base, [ahorro, ingreso]);
    expect(ev.months[1].proposalDeltas).toHaveLength(2);
    expect(ev.months[1].forecastClosingCash).toBe(115_000);
  });

  it('disabled proposals do not contribute', () => {
    const base: CashFlowMonth[] = [
      { yearMonth: '2026-01', isHistorical: false, income: 0, expense: 0, closingCash: 0 },
    ];
    const disabled: Proposal = { ...baseProposal, enabled: false };
    const ev = evaluateCashFlow(base, [disabled]);
    expect(ev.months[0].forecastClosingCash).toBe(0);
    expect(ev.months[0].proposalDeltas).toHaveLength(0);
  });

  it('chains closing cash across future months', () => {
    const base: CashFlowMonth[] = [
      { yearMonth: '2026-01', isHistorical: false, income: 100, expense: 50, closingCash: 50 },
      { yearMonth: '2026-02', isHistorical: false, income: 100, expense: 50, closingCash: 100 },
      { yearMonth: '2026-03', isHistorical: false, income: 100, expense: 50, closingCash: 150 },
    ];
    const p: Proposal = { ...baseProposal, amount: 10, kind: 'expense_saving', frequency: 'monthly' };
    const ev = evaluateCashFlow(base, [p]);
    // Base: 50, 100, 150
    // Con ahorro (reduce egresos 10/mes): 60, 120, 180
    expect(ev.months.map((m) => m.forecastClosingCash)).toEqual([60, 120, 180]);
  });
});
