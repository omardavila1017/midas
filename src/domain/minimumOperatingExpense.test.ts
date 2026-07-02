import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeMinimumOperatingExpense,
  payrollForMonth,
  floorForMonth,
  prorateMinimumExpense,
  loadMinimumExpenseOverrides,
  saveMinimumExpenseOverrides,
  resolveMinimumExpenseForMonth,
  type MinimumExpenseOverride,
} from './minimumOperatingExpense';
import type { Provider } from './types';
import type { Budget } from './budget';

function provider(name: string, overrides: Partial<Provider> = {}): Provider {
  return {
    id: `p-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    type: 'Otro',
    risk: 'Medio',
    paymentPeriod: '30 días',
    ...overrides,
  };
}

function budget(expenseByConcept: Array<{ concept: string; monthly: number[] }>): Budget {
  return {
    year: 2026,
    scale: 'pesos',
    incomeTotal: Array(12).fill(0),
    incomeByConcept: [],
    expenseTotal: Array(12).fill(0),
    expenseByConcept,
    uploadedAt: '2026-01-01T00:00:00.000Z',
  };
}

const months = (v: number) => Array(12).fill(v);

describe('computeMinimumOperatingExpense', () => {
  it('sums only CRITICO providers with a positive gastoMinimoMensual', () => {
    const providers = [
      provider('Diesel SA', { clasificacionAutomatica: 'CRITICO', gastoMinimoMensual: 100_000, type: 'Combustible' }),
      provider('Llantas SA', { clasificacionAutomatica: 'CRITICO', gastoMinimoMensual: 50_000, type: 'Refacciones' }),
      provider('Sin dato SA', { clasificacionAutomatica: 'CRITICO' }),
      provider('No crítico SA', { clasificacionAutomatica: 'MEDIO', gastoMinimoMensual: 999_999 }),
      provider('Cero SA', { clasificacionAutomatica: 'CRITICO', gastoMinimoMensual: 0 }),
    ];

    const summary = computeMinimumOperatingExpense(providers);

    expect(summary.providersMonthly).toBe(150_000);
    expect(summary.totalMonthly).toBe(150_000);
    expect(summary.totalAnnual).toBe(150_000 * 12);
    expect(summary.criticalCount).toBe(4);
    expect(summary.criticalWithData).toBe(2);
    expect(summary.criticalMissingData).toBe(2);
    expect(summary.criticalsWithoutData).toEqual([
      { providerId: 'p-sin-dato-sa', providerName: 'Sin dato SA', categoria: 'Otro' },
      { providerId: 'p-cero-sa', providerName: 'Cero SA', categoria: 'Otro' },
    ]);
    // Ordered by amount desc
    expect(summary.byProvider.map((p) => p.providerName)).toEqual(['Diesel SA', 'Llantas SA']);
  });

  it('groups byCategory sorted desc and does not include payroll when absent', () => {
    const providers = [
      provider('A', { clasificacionAutomatica: 'CRITICO', gastoMinimoMensual: 10, type: 'Combustible' }),
      provider('B', { clasificacionAutomatica: 'CRITICO', gastoMinimoMensual: 30, type: 'Refacciones' }),
      provider('C', { clasificacionAutomatica: 'CRITICO', gastoMinimoMensual: 25, type: 'Combustible' }),
    ];

    const summary = computeMinimumOperatingExpense(providers);

    expect(summary.byCategory).toEqual([
      { categoria: 'Combustible', total: 35, count: 2 },
      { categoria: 'Refacciones', total: 30, count: 1 },
    ]);
  });

  it('adds payroll from budget as monthly average, in totals and byCategory but not byProvider', () => {
    const providers = [
      provider('A', { clasificacionAutomatica: 'CRITICO', gastoMinimoMensual: 100 }),
    ];
    const b = budget([
      { concept: 'NOMINA OPERATIVA', monthly: months(1_200) }, // avg 1200
      { concept: 'FINIQUITOS', monthly: months(120) }, // avg 120
      { concept: 'RENTA', monthly: months(999) }, // not payroll
    ]);

    const summary = computeMinimumOperatingExpense(providers, b);

    expect(summary.payrollMonthly).toBeCloseTo(1_320);
    expect(summary.totalMonthly).toBeCloseTo(1_420);
    expect(summary.byProvider).toHaveLength(1);
    expect(summary.byCategory[0]).toEqual({ categoria: 'NÓMINA + FINIQUITOS', total: 1_320, count: 1 });
  });

  it('dedupes duplicated payroll concepts from the budget (capture errors must not inflate the floor)', () => {
    const b = budget([
      { concept: 'NOMINA OPERATIVA', monthly: months(1_200) },
      { concept: 'NOMINA OPERATIVA', monthly: months(1_200) },
    ]);

    const summary = computeMinimumOperatingExpense([], b);

    expect(summary.payrollMonthly).toBeCloseTo(1_200);
  });

  it('prefers the payrollMonthlyOverride (TRESS real cash) over the budget when positive', () => {
    const b = budget([{ concept: 'NOMINA', monthly: months(1_200) }]);

    const withOverride = computeMinimumOperatingExpense([], b, 2_000);
    expect(withOverride.payrollMonthly).toBe(2_000);

    // Zero/negative override falls back to budget
    const zeroOverride = computeMinimumOperatingExpense([], b, 0);
    expect(zeroOverride.payrollMonthly).toBeCloseTo(1_200);
  });
});

describe('payrollForMonth / floorForMonth', () => {
  const b = budget([
    { concept: 'NÓMINA', monthly: [100, 200, 300, 0, 0, 0, 0, 0, 0, 0, 0, 600] },
    { concept: 'FINIQUITOS', monthly: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40] },
  ]);

  it('returns the specific month value, not the average', () => {
    expect(payrollForMonth(b, 0)).toBe(110);
    expect(payrollForMonth(b, 1)).toBe(200);
    expect(payrollForMonth(b, 11)).toBe(640);
    expect(payrollForMonth(b, 3)).toBe(0);
  });

  it('is defensive about missing budget and out-of-range months', () => {
    expect(payrollForMonth(null, 0)).toBe(0);
    expect(payrollForMonth(undefined, 0)).toBe(0);
    expect(payrollForMonth(b, -1)).toBe(0);
    expect(payrollForMonth(b, 12)).toBe(0);
  });

  it('floorForMonth = providers floor + payroll of that month', () => {
    expect(floorForMonth('2026-01', 1_000, b)).toBe(1_110);
    expect(floorForMonth('2026-12', 1_000, b)).toBe(1_640);
    expect(floorForMonth('2026-04', 1_000, b)).toBe(1_000);
  });

  it('floorForMonth falls back to the providers floor on malformed yearMonth', () => {
    expect(floorForMonth('', 1_000, b)).toBe(1_000);
    expect(floorForMonth('2026', 1_000, b)).toBe(1_000);
  });
});

describe('prorateMinimumExpense', () => {
  it('prorates by days within a single month', () => {
    // 7 days of a 30-day month (April)
    const result = prorateMinimumExpense(30_000, '2026-04-01', '2026-04-07');
    expect(result).toBeCloseTo(30_000 * (7 / 30));
  });

  it('a full month equals the monthly total', () => {
    const result = prorateMinimumExpense(31_000, '2026-01-01', '2026-01-31');
    expect(result).toBeCloseTo(31_000);
  });

  it('prorates across month boundaries per-month', () => {
    // Jan 30-31 (2/31) + Feb 1-2 (2/28, 2026 is not a leap year)
    const result = prorateMinimumExpense(28_000, '2026-01-30', '2026-02-02');
    expect(result).toBeCloseTo(28_000 * (2 / 31) + 28_000 * (2 / 28));
  });

  it('returns 0 on invalid input', () => {
    expect(prorateMinimumExpense(0, '2026-01-01', '2026-01-31')).toBe(0);
    expect(prorateMinimumExpense(-5, '2026-01-01', '2026-01-31')).toBe(0);
    expect(prorateMinimumExpense(1_000, '', '2026-01-31')).toBe(0);
    expect(prorateMinimumExpense(1_000, 'garbage', '2026-01-31')).toBe(0);
    expect(prorateMinimumExpense(1_000, '2026-02-01', '2026-01-01')).toBe(0);
  });
});

describe('minimum expense overrides (localStorage)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips overrides through localStorage', () => {
    const overrides: MinimumExpenseOverride[] = [
      { yearMonth: '2026-03', amount: 500_000, note: 'ajuste manual', updatedAt: '2026-03-01T00:00:00.000Z' },
    ];
    saveMinimumExpenseOverrides(overrides);
    expect(loadMinimumExpenseOverrides()).toEqual(overrides);
  });

  it('filters malformed persisted entries instead of throwing', () => {
    window.localStorage.setItem(
      'flujo-senda::minimum-expense-overrides',
      JSON.stringify([
        { yearMonth: '2026-03', amount: 100, updatedAt: 'x' },
        { yearMonth: 42, amount: 100 },
        { amount: 100 },
        null,
        'garbage',
      ]),
    );
    expect(loadMinimumExpenseOverrides()).toEqual([
      { yearMonth: '2026-03', amount: 100, updatedAt: 'x' },
    ]);

    window.localStorage.setItem('flujo-senda::minimum-expense-overrides', '{not json');
    expect(loadMinimumExpenseOverrides()).toEqual([]);

    window.localStorage.setItem('flujo-senda::minimum-expense-overrides', '{"a":1}');
    expect(loadMinimumExpenseOverrides()).toEqual([]);
  });

  it('resolveMinimumExpenseForMonth: override wins over the computed base', () => {
    const overrides: MinimumExpenseOverride[] = [
      { yearMonth: '2026-03', amount: 500_000, note: 'n', updatedAt: 'x' },
    ];
    expect(resolveMinimumExpenseForMonth('2026-03', 100, overrides)).toEqual({
      amount: 500_000,
      isOverride: true,
      note: 'n',
    });
    expect(resolveMinimumExpenseForMonth('2026-04', 100, overrides)).toEqual({
      amount: 100,
      isOverride: false,
    });
  });
});
