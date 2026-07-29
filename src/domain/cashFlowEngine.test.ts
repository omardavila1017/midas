import { describe, it, expect } from 'vitest';
import {
  addMonths,
  monthsBetween,
  buildBaseCashFlow,
  buildHistoricalMonths,
  buildFutureExpenses,
  compareYearMonth,
  lastDayOfMonth,
  projectFutureIncome,
  buildExpenseProjector,
  projectMonthlyExpense,
  filterCompleteHistorical,
  toYearMonth,
} from './cashFlowEngine';
import type { CashFlowMonth } from '../types';
import type {
  BankAccountStatement,
  AgedBalanceRecord,
} from '../services/jde';

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

  it('toYearMonth slices ISO dates (with or without time) and passes short strings through', () => {
    expect(toYearMonth('2026-04-22')).toBe('2026-04');
    expect(toYearMonth('2026-04-22T13:00:00Z')).toBe('2026-04');
    expect(toYearMonth('')).toBe('');
    expect(toYearMonth('2026')).toBe('2026'); // no valida — slice puro
  });

  it('compareYearMonth is a lexicographic comparator usable for sorting', () => {
    expect(compareYearMonth('2025-12', '2026-01')).toBeLessThan(0);
    expect(compareYearMonth('2026-01', '2026-01')).toBe(0);
    expect(compareYearMonth('2026-02', '2026-01')).toBeGreaterThan(0);
    const months = ['2026-03', '2025-11', '2026-01'];
    expect([...months].sort(compareYearMonth)).toEqual(['2025-11', '2026-01', '2026-03']);
  });

  it('lastDayOfMonth handles month lengths, February and leap years', () => {
    expect(lastDayOfMonth('2026-01')).toBe('2026-01-31');
    expect(lastDayOfMonth('2026-04')).toBe('2026-04-30');
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28'); // no bisiesto
    expect(lastDayOfMonth('2024-02')).toBe('2024-02-29'); // bisiesto
    expect(lastDayOfMonth('2026-12')).toBe('2026-12-31'); // frontera de año
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
    expect(months[0].income).toBe(100_000);
    expect(months[0].expense).toBe(0);
  });

  it('filtra traspasos pair-matched sin leyenda (paridad con pantalla Bancos)', () => {
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
    statements[0].movimientos.push({
      cia: '00011', banco: 'BANAMEX', cuenta: '019004783A', moneda: 'MXN',
      fechaOperacion: '2026-01-20', referencia: 'CLI-1', concepto: 'PAGO CLIENTE',
      tipoMovimiento: 'ABONO', importe: 250_000,
    });
    const months = buildHistoricalMonths(statements);
    expect(months).toHaveLength(1);
    expect(months[0].income).toBe(250_000);
    expect(months[0].expense).toBe(0);
  });

  it('excluye movimientos de cuentas con flow neutro en el catálogo (p.ej. RESERVA)', () => {
    // '70144758151' = SENDA SERVICIOS FINANCIEROS · RESERVA · flow "neutro"
    // en src/assets/bankAccountsCatalog.json.
    const statements: BankAccountStatement[] = [
      {
        cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
        fechaEstadoCuenta: '2026-01-31', saldoInicial: 0, saldoFinal: 0,
        movimientos: [
          { cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
            fechaOperacion: '2026-01-05', referencia: 'R1', concepto: 'PAGO CLIENTE',
            tipoMovimiento: 'ABONO', importe: 1000 },
        ],
      },
      {
        cia: '00011', banco: 'BANAMEX', cuenta: '70144758151', moneda: 'MXN',
        fechaEstadoCuenta: '2026-01-31', saldoInicial: 100, saldoFinal: 0,
        movimientos: [
          { cia: '00011', banco: 'BANAMEX', cuenta: '70144758151', moneda: 'MXN',
            fechaOperacion: '2026-01-06', referencia: 'R2', concepto: 'DEPOSITO',
            tipoMovimiento: 'ABONO', importe: 5000 },
        ],
      },
    ];
    const months = buildHistoricalMonths(statements);
    expect(months).toHaveLength(1);
    // El ABONO de la cuenta neutra NO cuenta como ingreso económico…
    expect(months[0].income).toBe(1000);
    expect(months[0].expense).toBe(0);
    // …pero SÍ cuenta en la caja (el dinero existe en la cuenta del grupo).
    expect(months[0].closingCash).toBe(0 + 1000 + 100 + 5000);
  });

  it('meses sin movimientos NO aparecen en la serie (hueco de mes) y la caja arrastra', () => {
    const statements: BankAccountStatement[] = [{
      cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
      fechaEstadoCuenta: '2026-03-31', saldoInicial: 50, saldoFinal: 0,
      movimientos: [
        { cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
          fechaOperacion: '2026-01-05', referencia: 'R1', concepto: 'PAGO CLIENTE',
          tipoMovimiento: 'ABONO', importe: 100 },
        // Febrero sin movimientos.
        { cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
          fechaOperacion: '2026-03-10', referencia: 'R2', concepto: 'PAGO PROVEEDOR',
          tipoMovimiento: 'CARGO', importe: 30 },
      ],
    }];
    const months = buildHistoricalMonths(statements);
    expect(months.map((m) => m.yearMonth)).toEqual(['2026-01', '2026-03']);
    expect(months[0].closingCash).toBe(150);
    expect(months[1]).toMatchObject({ income: 0, expense: 30, closingCash: 120 });
  });

  it('saldoInicial ausente se trata como 0 y movimientos sin fecha se ignoran', () => {
    const statements: BankAccountStatement[] = [{
      cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
      fechaEstadoCuenta: '2026-01-31', saldoInicial: undefined as unknown as number, saldoFinal: 0,
      movimientos: [
        { cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
          fechaOperacion: '', referencia: 'R0', concepto: 'SIN FECHA',
          tipoMovimiento: 'ABONO', importe: 999_999 },
        { cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
          fechaOperacion: '2026-01-05', referencia: 'R1', concepto: 'PAGO CLIENTE',
          tipoMovimiento: 'ABONO', importe: 200 },
      ],
    }];
    const months = buildHistoricalMonths(statements);
    expect(months).toHaveLength(1);
    expect(months[0].income).toBe(200);
    expect(months[0].closingCash).toBe(200); // saldoInicial ?? 0
  });

  it('devuelve [] cuando hay statements pero ningún movimiento fechado', () => {
    const statements: BankAccountStatement[] = [{
      cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
      fechaEstadoCuenta: '2026-01-31', saldoInicial: 100, saldoFinal: 100,
      movimientos: [],
    }];
    expect(buildHistoricalMonths(statements)).toEqual([]);
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
    expect(p(1)).toBeCloseTo(200, 2);
    expect(p(6)).toBeCloseTo(200, 2);
    expect(p(12)).toBeCloseTo(200, 2);
  });

  it('does not collapse to zero when recent months trend down', () => {
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

describe('buildFutureExpenses — fechas inválidas', () => {
  const mkAged = (fechaProgramacionPago: string, importePendientePesos: number): AgedBalanceRecord => ({
    cia: '00011', noProveedor: 'P1', nombre: 'Prov', noFactura: 'F1',
    fechaFactura: '2026-03-01', fechaVence: '2026-04-01',
    fechaProgramacionPago,
    diasVencida: 0, importeBrutoPesos: importePendientePesos, importePendientePesos,
    importeSubtotalPesos: 0, importeImpuestosPesos: 0,
    importeBrutoDolares: 0, importePendienteDolares: 0,
    moneda: 'MXN', condPago: '', clasifica: '', clasificacionProveedor: '',
    edoPago: '', tipoCambio: 20, porVencer: importePendientePesos,
    v1_30: 0, v31_60: 0, v61_90: 0, v91_120: 0, v121_150: 0, v151_180: 0, mas180: 0,
  });

  it('ignora facturas sin fecha de programación o con fecha corta no-ISO', () => {
    const map = buildFutureExpenses([
      mkAged('', 1000),
      mkAged('n/a', 500), // slice(0,7)='n/a' → length !== 7 → ignorada
      mkAged('2026-06-15', 250),
    ]);
    expect(map.size).toBe(1);
    expect(map.get('2026-06')).toBe(250);
  });
});

describe('buildBaseCashFlow (orquestación con datos provistos — sin fetch)', () => {
  const mkStatements = (): BankAccountStatement[] => [{
    cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
    fechaEstadoCuenta: '2026-02-28', saldoInicial: 0, saldoFinal: 0,
    movimientos: [
      { cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
        fechaOperacion: '2026-01-05', referencia: 'R1', concepto: 'PAGO CLIENTE',
        tipoMovimiento: 'ABONO', importe: 100 },
      { cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
        fechaOperacion: '2026-01-20', referencia: 'R2', concepto: 'PAGO PROVEEDOR',
        tipoMovimiento: 'CARGO', importe: 40 },
      { cia: '00011', banco: 'BANAMEX', cuenta: '123', moneda: 'MXN',
        fechaOperacion: '2026-02-10', referencia: 'R3', concepto: 'PAGO CLIENTE',
        tipoMovimiento: 'ABONO', importe: 200 },
    ],
  }];

  const mkAged = (fechaProgramacionPago: string, importePendientePesos: number): AgedBalanceRecord => ({
    cia: '00011', noProveedor: 'P1', nombre: 'Prov', noFactura: 'F9',
    fechaFactura: '2026-03-01', fechaVence: '2026-04-01',
    fechaProgramacionPago,
    diasVencida: 0, importeBrutoPesos: importePendientePesos, importePendientePesos,
    importeSubtotalPesos: 0, importeImpuestosPesos: 0,
    importeBrutoDolares: 0, importePendienteDolares: 0,
    moneda: 'MXN', condPago: '', clasifica: '', clasificacionProveedor: '',
    edoPago: '', tipoCambio: 20, porVencer: importePendientePesos,
    v1_30: 0, v31_60: 0, v61_90: 0, v91_120: 0, v121_150: 0, v151_180: 0, mas180: 0,
  });

  it('encadena históricos + proyección: promedio de ingresos, max(comprometido, baseline) en egresos', async () => {
    const months = await buildBaseCashFlow({
      companyCode: '00011', // ejercita el filtro por cia
      historicalStart: '2026-01-01',
      today: '2026-03-15',
      horizonMonths: 2,
      bankStatements: mkStatements(),
      agedBalances: [mkAged('2026-05-10', 500)],
    });

    // Históricos: ene + feb. Futuros: abr + may (empiezan el mes SIGUIENTE a hoy).
    expect(months.map((m) => m.yearMonth)).toEqual(['2026-01', '2026-02', '2026-04', '2026-05']);
    expect(months[0]).toMatchObject({ isHistorical: true, income: 100, expense: 40 });
    expect(months[1]).toMatchObject({ isHistorical: true, income: 200, expense: 0 });

    // avgIncome = (100+200)/2 = 150; baseline egreso = (40+0)/2 = 20.
    const abr = months[2];
    expect(abr).toMatchObject({ yearMonth: '2026-04', isHistorical: false, income: 150, expense: 20 });
    // runningCash: cierre histórico 260 → 260+150-20 = 390.
    expect(abr.closingCash).toBeCloseTo(390, 2);

    // Mayo: comprometido (500) > baseline (20) → gana el comprometido.
    const may = months[3];
    expect(may).toMatchObject({ yearMonth: '2026-05', income: 150, expense: 500 });
    expect(may.closingCash).toBeCloseTo(40, 2);
  });

  it("companyCode 'all' sin agedBalances omite egresos comprometidos (no hay request válida)", async () => {
    const months = await buildBaseCashFlow({
      companyCode: 'all',
      historicalStart: '2026-01-01',
      today: '2026-03-15',
      horizonMonths: 1,
      bankStatements: mkStatements(),
    });
    expect(months.map((m) => m.yearMonth)).toEqual(['2026-01', '2026-02', '2026-04']);
    // Sin comprometidos: el único egreso futuro es el baseline histórico.
    expect(months[2].expense).toBeCloseTo(20, 2);
  });

  it('filtra por cia: statements de otra compañía no aportan histórico', async () => {
    const months = await buildBaseCashFlow({
      companyCode: '00099', // ninguna cuenta con esta cia
      historicalStart: '2026-01-01',
      today: '2026-03-15',
      horizonMonths: 2,
      bankStatements: mkStatements(),
      agedBalances: [],
    });
    // Sin histórico: solo proyección plana en 0 desde el mes siguiente a hoy.
    expect(months.map((m) => m.yearMonth)).toEqual(['2026-04', '2026-05']);
    for (const m of months) {
      expect(m).toMatchObject({ isHistorical: false, income: 0, expense: 0, closingCash: 0 });
    }
  });

  it('sin statements ni aged: proyección vacía anclada al mes de hoy', async () => {
    const months = await buildBaseCashFlow({
      companyCode: 'all',
      historicalStart: '2026-01-01',
      today: '2026-06-30',
      horizonMonths: 3,
      bankStatements: [],
      agedBalances: [],
    });
    expect(months.map((m) => m.yearMonth)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(months.every((m) => !m.isHistorical && m.closingCash === 0)).toBe(true);
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
