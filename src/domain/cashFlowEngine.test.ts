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
  analyzeLiquidity,
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

  it('filtra traspasos entre cuentas propias (no cuentan como ingreso/egreso real)', () => {
    // Dos cuentas del grupo (mismo prefijo >= 6 chars para entrar al detector).
    // Un traspaso aparece como CARGO en una y ABONO en la otra, con la leyenda
    // "TRASPASO REF ..." — ambas deben quedar fuera del total mensual.
    const statements: BankAccountStatement[] = [
      {
        cia: '00011', banco: 'BANAMEX', cuenta: '019004783A', moneda: 'MXN',
        fechaEstadoCuenta: '2026-01-31', saldoInicial: 500_000, saldoFinal: 0,
        movimientos: [
          { cia: '00011', banco: 'BANAMEX', cuenta: '019004783A', moneda: 'MXN',
            fechaOperacion: '2026-01-10', referencia: 'R1', concepto: 'TRASPASO REF 123 CTA DESTINO',
            tipoMovimiento: 'CARGO', importe: 300_000 },
          { cia: '00011', banco: 'BANAMEX', cuenta: '019004783A', moneda: 'MXN',
            fechaOperacion: '2026-01-20', referencia: 'R2', concepto: 'PAGO CLIENTE',
            tipoMovimiento: 'ABONO', importe: 100_000 },
        ],
      },
      {
        cia: '00011', banco: 'BANAMEX', cuenta: '019004784B', moneda: 'MXN',
        fechaEstadoCuenta: '2026-01-31', saldoInicial: 0, saldoFinal: 0,
        movimientos: [
          { cia: '00011', banco: 'BANAMEX', cuenta: '019004784B', moneda: 'MXN',
            fechaOperacion: '2026-01-10', referencia: 'R1', concepto: 'TRASPASO REF 123 CTA ORIGEN',
            tipoMovimiento: 'ABONO', importe: 300_000 },
        ],
      },
    ];
    const months = buildHistoricalMonths(statements);
    expect(months).toHaveLength(1);
    // Sólo debe contar el pago real de cliente, no el traspaso interno.
    expect(months[0].income).toBe(100_000);
    expect(months[0].expense).toBe(0);
  });

  it('filtra traspasos pair-matched sin leyenda (paridad con pantalla Bancos)', () => {
    // Dos cuentas del mismo grupo con un CARGO y un ABONO simétricos el
    // mismo día, mismo importe. Sin leyenda "TRASPASO". Antes el engine
    // dejaba pasar estos pares como ingreso/egreso real, mientras la
    // pantalla de Bancos ya los marcaba como internos — la gráfica de caja
    // se desviaba del filtro visible en Bancos. Ahora se alinean.
    const statements: BankAccountStatement[] = [
      {
        cia: '00011', banco: 'BANAMEX', cuenta: '019004783A', moneda: 'MXN',
        fechaEstadoCuenta: '2026-01-31', saldoInicial: 1_000_000, saldoFinal: 0,
        movimientos: [
          { cia: '00011', banco: 'BANAMEX', cuenta: '019004783A', moneda: 'MXN',
            fechaOperacion: '2026-01-15', referencia: 'P-777', concepto: 'MOV 777',
            tipoMovimiento: 'CARGO', importe: 500_000 },
        ],
      },
      {
        cia: '00011', banco: 'BANAMEX', cuenta: '019004784B', moneda: 'MXN',
        fechaEstadoCuenta: '2026-01-31', saldoInicial: 0, saldoFinal: 0,
        movimientos: [
          { cia: '00011', banco: 'BANAMEX', cuenta: '019004784B', moneda: 'MXN',
            fechaOperacion: '2026-01-15', referencia: 'P-888', concepto: 'MOV 888',
            tipoMovimiento: 'ABONO', importe: 500_000 },
        ],
      },
    ];
    // Si SÓLO hubiera un legítimo pago de cliente además del pair-match,
    // lo contaríamos sin inflar con el traspaso pair-matched.
    statements[0].movimientos.push({
      cia: '00011', banco: 'BANAMEX', cuenta: '019004783A', moneda: 'MXN',
      fechaOperacion: '2026-01-20', referencia: 'CLI-1', concepto: 'PAGO CLIENTE',
      tipoMovimiento: 'ABONO', importe: 250_000,
    });
    const months = buildHistoricalMonths(statements);
    expect(months).toHaveLength(1);
    // El traspaso pair-matched (CARGO+ABONO 500k mismo día/grupo) no cuenta;
    // sólo entra el pago de cliente.
    expect(months[0].income).toBe(250_000);
    expect(months[0].expense).toBe(0);
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

  it('endYearMonth stops the proposal the month after it', () => {
    const p: Proposal = { ...baseProposal, endYearMonth: '2026-03' };
    expect(applyProposalToMonth(p, '2026-01').deltaExpense).toBe(-10_000);
    expect(applyProposalToMonth(p, '2026-03').deltaExpense).toBe(-10_000);
    expect(applyProposalToMonth(p, '2026-04').deltaExpense).toBe(0);
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

  it('new_expense delta adds to expense (pago de deuda, nuevo gasto)', () => {
    const p: Proposal = { ...baseProposal, kind: 'new_expense' };
    expect(applyProposalToMonth(p, '2026-01')).toEqual({ deltaIncome: 0, deltaExpense: 10_000 });
  });

  it('revenue_loss delta subtracts from income', () => {
    const p: Proposal = { ...baseProposal, kind: 'revenue_loss' };
    expect(applyProposalToMonth(p, '2026-01')).toEqual({ deltaIncome: -10_000, deltaExpense: 0 });
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

describe('analyzeLiquidity', () => {
  const futureMonths = (cashes: Array<{ base: number; fore: number; ym: string }>): CashFlowMonth[] =>
    cashes.map((c) => ({
      yearMonth: c.ym,
      isHistorical: false,
      income: 0,
      expense: 0,
      closingCash: c.base,
    }));

  it('ignora meses históricos aunque estén en rojo', () => {
    // El mes histórico está negativo pero no se reporta como alerta porque
    // ya ocurrió. El mes futuro parte de una caja histórica sana y queda
    // positivo, así que tampoco se reporta.
    const ev = evaluateCashFlow(
      [
        { yearMonth: '2025-11', isHistorical: true, income: 0, expense: 0, closingCash: -50_000 },
        { yearMonth: '2025-12', isHistorical: true, income: 0, expense: 0, closingCash: 10_000 },
        { yearMonth: '2026-01', isHistorical: false, income: 100, expense: 50, closingCash: 10_050 },
      ],
      [],
    );
    const summary = analyzeLiquidity(ev);
    expect(summary.shortfalls).toHaveLength(0);
  });

  it('reporta un mes forecast en crisis y no confunde base_only con forecast_only', () => {
    const base = futureMonths([
      { ym: '2026-05', base: 10, fore: 10 },
    ]);
    const p: Proposal = { ...baseProposal, kind: 'new_expense', amount: 500, frequency: 'one_time', startYearMonth: '2026-05' };
    const ev = evaluateCashFlow(base, [p]);
    const summary = analyzeLiquidity(ev);
    expect(summary.shortfalls).toHaveLength(1);
    expect(summary.shortfalls[0].status).toBe('forecast_only');
    expect(summary.forecastWorsensAnyMonth).toBe(true);
  });

  it('marca base_only cuando las propuestas rescatan un mes negativo', () => {
    const base: CashFlowMonth[] = [
      { yearMonth: '2026-06', isHistorical: false, income: 0, expense: 0, closingCash: -100 },
    ];
    const p: Proposal = { ...baseProposal, kind: 'income_increase', amount: 500, frequency: 'one_time', startYearMonth: '2026-06' };
    const ev = evaluateCashFlow(base, [p]);
    const summary = analyzeLiquidity(ev);
    expect(summary.shortfalls).toHaveLength(1);
    expect(summary.shortfalls[0].status).toBe('base_only');
    expect(summary.shortfalls[0].forecastClosingCash).toBeGreaterThan(0);
    expect(summary.forecastWorsensAnyMonth).toBe(false);
  });

  it('si ambos están bajo el umbral, status es "both"', () => {
    const base: CashFlowMonth[] = [
      { yearMonth: '2026-07', isHistorical: false, income: 0, expense: 0, closingCash: -100 },
    ];
    const ev = evaluateCashFlow(base, []);
    const summary = analyzeLiquidity(ev);
    expect(summary.shortfalls).toHaveLength(1);
    expect(summary.shortfalls[0].status).toBe('both');
    expect(summary.worstForecastMonth).toBe('2026-07');
    expect(summary.worstForecastClosingCash).toBe(-100);
  });

  it('respeta el umbral prudencial (threshold > 0)', () => {
    const base: CashFlowMonth[] = [
      { yearMonth: '2026-08', isHistorical: false, income: 0, expense: 0, closingCash: 50_000 },
    ];
    const ev = evaluateCashFlow(base, []);
    expect(analyzeLiquidity(ev, 0).shortfalls).toHaveLength(0);
    expect(analyzeLiquidity(ev, 100_000).shortfalls).toHaveLength(1);
  });

  it('resumen neutro cuando no hay meses futuros', () => {
    const ev = evaluateCashFlow([], []);
    const summary = analyzeLiquidity(ev);
    expect(summary.shortfalls).toHaveLength(0);
    expect(summary.worstForecastMonth).toBeNull();
    expect(summary.worstForecastClosingCash).toBe(0);
    // referencia intencional para evitar unused-var
    expect(futureMonths([])).toEqual([]);
  });
});
