import { describe, it, expect } from 'vitest';
import {
  extractHistoricalSeries,
  closedMonthsCount,
  closedMonthsOnly,
  partialCurrentMonth,
  dayOfMonthProfile,
  type SeriesPoint,
} from './seriesPrep';
import type { BankAccountStatement } from '../../services/jde';

// ─────────────────────────────────────────────────────────────────────────
// seriesPrep — primer test directo de la preparación de series históricas
// (agregación mensual/diaria, relleno de huecos, mes parcial, filtro de
// traspasos internos). Fixtures deterministas al estilo de
// predictiveEngine.test.ts.
// ─────────────────────────────────────────────────────────────────────────

function makeStatement(
  movimientos: Array<{ date: string; type: 'ABONO' | 'CARGO'; amount: number; concepto?: string }>,
  cia = 'CIA1',
  cuenta = '001',
): BankAccountStatement {
  return {
    cia,
    cuenta,
    moneda: 'MXN',
    saldoInicial: 0,
    saldoFinal: 0,
    fechaEstadoCuenta: movimientos[movimientos.length - 1]?.date ?? '2025-01-01',
    banco: 'TEST',
    movimientos: movimientos.map((m, i) => ({
      fechaOperacion: m.date,
      tipoMovimiento: m.type,
      importe: m.amount,
      concepto: m.concepto ?? `${m.type} mov ${i}`,
      referencia: `X${i}`,
      moneda: 'MXN',
    })),
  } as unknown as BankAccountStatement;
}

function values(series: SeriesPoint[]): Record<string, number> {
  return Object.fromEntries(series.map(p => [p.key, p.value]));
}

describe('extractHistoricalSeries', () => {
  it('agrega ABONO → income y CARGO → expense, mensual y diario, con first/lastYearMonth', () => {
    const out = extractHistoricalSeries([
      makeStatement([
        { date: '2026-01-10', type: 'ABONO', amount: 100 },
        { date: '2026-01-10', type: 'ABONO', amount: 50 },   // mismo día → suma
        { date: '2026-01-20', type: 'CARGO', amount: 30 },
        { date: '2026-02-05', type: 'ABONO', amount: 200 },
      ]),
    ]);

    expect(out.firstYearMonth).toBe('2026-01');
    expect(out.lastYearMonth).toBe('2026-02');

    expect(values(out.monthlyIncome)).toEqual({ '2026-01': 150, '2026-02': 200 });
    expect(values(out.monthlyExpense)).toEqual({ '2026-01': 30, '2026-02': 0 });

    // Daily: un punto por día con movimiento, en orden cronológico.
    expect(out.dailyIncome.map(p => p.key)).toEqual(['2026-01-10', '2026-01-20', '2026-02-05']);
    expect(values(out.dailyIncome)).toEqual({ '2026-01-10': 150, '2026-01-20': 0, '2026-02-05': 200 });
    expect(values(out.dailyExpense)).toEqual({ '2026-01-10': 0, '2026-01-20': 30, '2026-02-05': 0 });
  });

  it('rellena meses sin movimientos con cero en la serie mensual (cadencia constante); daily NO se rellena', () => {
    const out = extractHistoricalSeries([
      makeStatement([
        { date: '2026-01-15', type: 'ABONO', amount: 100 },
        { date: '2026-04-15', type: 'ABONO', amount: 400 }, // hueco: feb y mar
      ]),
    ]);

    expect(out.monthlyIncome.map(p => p.key)).toEqual(['2026-01', '2026-02', '2026-03', '2026-04']);
    expect(out.monthlyIncome.map(p => p.value)).toEqual([100, 0, 0, 400]);
    expect(out.monthlyExpense.map(p => p.value)).toEqual([0, 0, 0, 0]);
    // Daily sólo trae los días con movimiento real.
    expect(out.dailyIncome).toHaveLength(2);
  });

  it('excluye traspasos internos (mismo clasificador que el Dashboard) de ambas series', () => {
    const out = extractHistoricalSeries([
      makeStatement([
        { date: '2026-01-10', type: 'ABONO', amount: 100, concepto: 'PAGO CLIENTE' },
        // Leyenda de traspaso interno → classifyMovement(...).kind === 'internal'
        { date: '2026-01-12', type: 'CARGO', amount: 999, concepto: 'TRASPASO REF 0001' },
        { date: '2026-01-20', type: 'CARGO', amount: 40, concepto: 'PAGO PROVEEDOR' },
      ]),
    ]);

    expect(values(out.monthlyIncome)).toEqual({ '2026-01': 100 });
    expect(values(out.monthlyExpense)).toEqual({ '2026-01': 40 }); // el 999 interno NO cuenta
    expect(out.dailyExpense.map(p => p.key)).not.toContain('2026-01-12');
  });

  it('filtra por companyCode ("all" incluye todo) y recorta con asOfDate', () => {
    const statements = [
      makeStatement([{ date: '2026-01-10', type: 'ABONO', amount: 100 }], 'CIA1', '001'),
      makeStatement([{ date: '2026-01-10', type: 'ABONO', amount: 700 }], 'CIA2', '002'),
    ];

    const all = extractHistoricalSeries(statements, { companyCode: 'all' });
    expect(values(all.monthlyIncome)).toEqual({ '2026-01': 800 });

    const one = extractHistoricalSeries(statements, { companyCode: 'CIA2' });
    expect(values(one.monthlyIncome)).toEqual({ '2026-01': 700 });

    // asOfDate: movimientos con fecha POSTERIOR quedan fuera (corte inclusivo).
    const cut = extractHistoricalSeries(
      [
        makeStatement([
          { date: '2026-01-10', type: 'ABONO', amount: 100 },
          { date: '2026-03-10', type: 'ABONO', amount: 500 },
        ]),
      ],
      { asOfDate: '2026-01-31' },
    );
    expect(values(cut.monthlyIncome)).toEqual({ '2026-01': 100 });
    expect(cut.lastYearMonth).toBe('2026-01');
  });

  it('regresa series vacías sin first/lastYearMonth cuando no hay statements', () => {
    const out = extractHistoricalSeries([]);
    expect(out.monthlyIncome).toEqual([]);
    expect(out.monthlyExpense).toEqual([]);
    expect(out.dailyIncome).toEqual([]);
    expect(out.dailyExpense).toEqual([]);
    expect(out.firstYearMonth).toBeUndefined();
    expect(out.lastYearMonth).toBeUndefined();
  });
});

describe('closedMonthsCount / closedMonthsOnly', () => {
  it('cuentan y recortan estrictamente a meses ANTERIORES al mes de asOfDate (el mes en curso queda fuera)', () => {
    const series: SeriesPoint[] = [
      { key: '2026-01', value: 1 },
      { key: '2026-02', value: 2 },
      { key: '2026-03', value: 3 }, // mes en curso (parcial)
    ];
    expect(closedMonthsCount(series, '2026-03-15')).toBe(2);
    expect(closedMonthsOnly(series, '2026-03-15').map(p => p.key)).toEqual(['2026-01', '2026-02']);
    // Todo cerrado si asOfDate cae en un mes posterior a la serie.
    expect(closedMonthsCount(series, '2026-04-01')).toBe(3);
  });
});

describe('partialCurrentMonth', () => {
  it('suma sólo los días del mes en curso ≤ asOfDate (mismo total en income y expense — el caller usa uno)', () => {
    const daily: SeriesPoint[] = [
      { key: '2026-02-28', value: 999 }, // mes anterior — fuera
      { key: '2026-03-05', value: 100 },
      { key: '2026-03-10', value: 50 },
      { key: '2026-03-20', value: 777 }, // posterior al corte — fuera
    ];
    const out = partialCurrentMonth(daily, '2026-03-15');
    expect(out.income).toBe(150);
    expect(out.expense).toBe(150); // misma estructura a propósito
  });
});

describe('dayOfMonthProfile', () => {
  it('reparte el peso mensual por día-del-mes y normaliza a suma 1', () => {
    // Dos meses con el mismo patrón: 70% el día 5, 30% el día 20.
    const daily: SeriesPoint[] = [
      { key: '2026-01-05', value: 700 },
      { key: '2026-01-20', value: 300 },
      { key: '2026-02-05', value: 70 },
      { key: '2026-02-20', value: 30 },
    ];
    const profile = dayOfMonthProfile(daily);
    expect(profile).toHaveLength(31);
    expect(profile[4]).toBeCloseTo(0.7, 10);  // día 5
    expect(profile[19]).toBeCloseTo(0.3, 10); // día 20
    expect(profile.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
    expect(profile[0]).toBe(0); // días sin flujo observado quedan en 0
  });

  it('sin datos cae a perfil uniforme sobre 30 días con el día 31 en cero', () => {
    const profile = dayOfMonthProfile([]);
    expect(profile).toHaveLength(31);
    for (let i = 0; i < 30; i++) expect(profile[i]).toBeCloseTo(1 / 30, 10);
    expect(profile[30]).toBe(0);
    expect(profile.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 10);
  });
});
