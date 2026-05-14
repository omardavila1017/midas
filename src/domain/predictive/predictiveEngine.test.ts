import { describe, it, expect } from 'vitest';
import { buildPredictiveForecast } from './predictiveEngine';
import type { BankAccountStatement } from '../../services/jde';

/**
 * Helper: arma un estado de cuenta sintético con `movimientos` mensuales
 * (ABONO o CARGO) en una cuenta única. Útil para tests deterministas.
 */
function makeStatement(
  movimientos: Array<{ date: string; type: 'ABONO' | 'CARGO'; amount: number }>,
  cia = 'CIA1',
): BankAccountStatement {
  return {
    cia,
    cuenta: '001',
    moneda: 'MXN',
    saldoInicial: 0,
    saldoFinal: 0,
    fechaEstadoCuenta: movimientos[movimientos.length - 1]?.date ?? '2025-01-01',
    banco: 'TEST',
    movimientos: movimientos.map((m, i) => ({
      fechaOperacion: m.date,
      tipoMovimiento: m.type,
      importe: m.amount,
      concepto: `${m.type} ${i}`,
      referencia: `REF${i}`,
      moneda: 'MXN',
    })),
  } as unknown as BankAccountStatement;
}

function ymRange(startYm: string, count: number): string[] {
  const [y, m] = startYm.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

describe('buildPredictiveForecast', () => {
  it('devuelve buckets en cero (no series vacías) si no hay estados de cuenta', () => {
    const out = buildPredictiveForecast({
      bankStatements: [],
      companyCode: 'all',
      asOfDate: '2026-05-13',
      horizonMonths: 12,
    });
    // Emite buckets futuros aunque value = 0 — el caller espera horizonte
    // constante. El modelo se marca como 'empty' y las bandas son cero.
    expect(out.income.monthly.length).toBeGreaterThanOrEqual(12);
    expect(out.metadata.income.model).toBe('empty');
    expect(out.metadata.income.historyMonths).toBe(0);
    for (const p of out.income.monthly) {
      expect(p.expected).toBe(0);
      expect(p.stdDev).toBe(0);
    }
    expect(out.overlays.futureOCs).toHaveLength(0);
    expect(out.overlays.openCXC).toHaveLength(0);
  });

  it('elige naive-mean con menos de 6 meses', () => {
    const movs = ymRange('2026-01', 4).map((ym) => ({
      date: `${ym}-15`,
      type: 'ABONO' as const,
      amount: 100_000,
    }));
    const out = buildPredictiveForecast({
      bankStatements: [makeStatement(movs)],
      companyCode: 'CIA1',
      asOfDate: '2026-05-13',
      horizonMonths: 6,
    });
    expect(out.metadata.income.model).toBe('naive-mean');
    // Los siguientes meses deberían tener forecast cerca de 100k
    const futureMonthly = out.income.monthly.filter((p) => !p.isHistorical);
    expect(futureMonthly.length).toBeGreaterThan(0);
    for (const p of futureMonthly) {
      expect(p.expected).toBeGreaterThan(50_000);
      expect(p.expected).toBeLessThan(200_000);
    }
  });

  it('elige Holt (no estacional) con 12-23 meses', () => {
    const movs = ymRange('2024-01', 18).map((ym) => ({
      date: `${ym}-15`,
      type: 'ABONO' as const,
      amount: 100_000 + Math.random() * 10_000,
    }));
    const out = buildPredictiveForecast({
      bankStatements: [makeStatement(movs)],
      companyCode: 'CIA1',
      asOfDate: '2025-07-15',
      horizonMonths: 6,
    });
    expect(out.metadata.income.model).toBe('holt-winters');
  });

  it('elige Holt-Winters estacional con ≥24 meses', () => {
    const movs = ymRange('2024-01', 30).map((ym, i) => ({
      date: `${ym}-15`,
      type: 'ABONO' as const,
      amount: 100_000 + 30_000 * Math.sin((2 * Math.PI * (i % 12)) / 12),
    }));
    const out = buildPredictiveForecast({
      bankStatements: [makeStatement(movs)],
      companyCode: 'CIA1',
      asOfDate: '2026-07-15',
      horizonMonths: 6,
    });
    expect(out.metadata.income.model).toBe('holt-winters-seasonal');
  });

  it('bandas crecen con horizonte', () => {
    const movs = ymRange('2023-01', 30).map((ym, i) => ({
      date: `${ym}-15`,
      type: 'CARGO' as const,
      amount: 50_000 + 10_000 * Math.sin(i / 3),
    }));
    const out = buildPredictiveForecast({
      bankStatements: [makeStatement(movs)],
      companyCode: 'CIA1',
      asOfDate: '2025-07-15',
      horizonMonths: 12,
    });
    const futureExpense = out.expense.monthly.filter((p) => !p.isHistorical);
    expect(futureExpense.length).toBeGreaterThanOrEqual(6);
    // Primera banda < última banda — incertidumbre crece con horizonte
    const firstStdDev = futureExpense[0].stdDev;
    const lastStdDev = futureExpense[futureExpense.length - 1].stdDev;
    expect(lastStdDev).toBeGreaterThan(firstStdDev);
  });

  it('produce buckets daily, weekly y annual derivados del mensual', () => {
    const movs = ymRange('2025-01', 12).map((ym, i) => ({
      date: `${ym}-15`,
      type: 'ABONO' as const,
      amount: 200_000 + i * 5_000,
    }));
    const out = buildPredictiveForecast({
      bankStatements: [makeStatement(movs)],
      companyCode: 'CIA1',
      asOfDate: '2026-01-15',
      horizonMonths: 6,
    });
    expect(out.income.daily.length).toBeGreaterThan(0);
    expect(out.income.weekly.length).toBeGreaterThan(0);
    expect(out.income.annual.length).toBeGreaterThan(0);
    // Suma de daily futuro ≈ suma de monthly futuro (tolerancia 5% por
    // redondeos de día-perfil)
    const futureMonthlySum = out.income.monthly
      .filter((p) => !p.isHistorical)
      .reduce((s, p) => s + p.expected, 0);
    const futureDailySum = out.income.daily
      .filter((p) => !p.isHistorical)
      .reduce((s, p) => s + p.expected, 0);
    expect(Math.abs(futureDailySum - futureMonthlySum) / Math.max(futureMonthlySum, 1)).toBeLessThan(0.05);
  });

  it('net = income - expense bucket a bucket', () => {
    const inflows = ymRange('2025-01', 12).map((ym) => ({
      date: `${ym}-15`,
      type: 'ABONO' as const,
      amount: 100_000,
    }));
    const outflows = ymRange('2025-01', 12).map((ym) => ({
      date: `${ym}-20`,
      type: 'CARGO' as const,
      amount: 60_000,
    }));
    const out = buildPredictiveForecast({
      bankStatements: [makeStatement([...inflows, ...outflows])],
      companyCode: 'CIA1',
      asOfDate: '2026-01-15',
      horizonMonths: 6,
    });
    // Para meses futuros, net.expected ≈ income.expected - expense.expected
    const futureNet = out.net.monthly.filter((p) => !p.isHistorical);
    for (const np of futureNet) {
      const ip = out.income.monthly.find((p) => p.date === np.date);
      const ep = out.expense.monthly.find((p) => p.date === np.date);
      if (ip && ep) {
        expect(Math.abs(np.expected - (ip.expected - ep.expected))).toBeLessThan(1);
      }
    }
  });
});
