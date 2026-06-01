import { describe, expect, it } from 'vitest';
import type { PayrollCashTreatment, PayrollCostRecord } from '../../shared-finance/types';
import {
  buildPayrollTimeSeries,
  distinctMonths,
  groupConceptsByType,
  isoWeekMonday,
  monthlyConceptSeries,
  monthlyEmployerCostSeries,
  seriesVariation,
  summarizeByCashTreatment,
  summarizeByCompany,
  summarizeByConceptType,
  summarizeByPayrollType,
  topConceptsWithShare,
} from './payrollAnalyticsService';

function rec(partial: Partial<PayrollCostRecord>): PayrollCostRecord {
  return {
    cia: '00011',
    empresaNomina: 'SIR',
    year: 2026,
    month: 5,
    paymentDate: '2026-05-07',
    payrollPeriod: 18,
    payrollType: 'Semanal',
    conceptId: 1,
    conceptName: 'SUELDO ORDINARIO',
    conceptType: 'Percepción',
    cashTreatment: 'CASH_OUT' as PayrollCashTreatment,
    amount: 100_000,
    ...partial,
  };
}

describe('summarizeByCashTreatment', () => {
  it('agrupa montos por tratamiento y calcula participación', () => {
    const rows = summarizeByCashTreatment([
      rec({ cashTreatment: 'CASH_OUT', amount: 80 }),
      rec({ cashTreatment: 'EMPLOYER_TAX', amount: 20 }),
    ]);
    const cash = rows.find(r => r.key === 'CASH_OUT')!;
    const tax = rows.find(r => r.key === 'EMPLOYER_TAX')!;
    expect(cash.total).toBe(80);
    expect(cash.pct).toBeCloseTo(80);
    expect(tax.pct).toBeCloseTo(20);
    // ordenado desc por total
    expect(rows[0].key).toBe('CASH_OUT');
  });
});

describe('summarizeByConceptType / summarizeByPayrollType', () => {
  it('agrupa por tipo de concepto', () => {
    const rows = summarizeByConceptType([
      rec({ conceptType: 'Percepción', amount: 70 }),
      rec({ conceptType: 'Deducción', amount: 30 }),
    ]);
    expect(rows.map(r => r.label).sort()).toEqual(['Deducción', 'Percepción']);
  });

  it('agrupa por tipo de nómina', () => {
    const rows = summarizeByPayrollType([
      rec({ payrollType: 'Semanal', amount: 60 }),
      rec({ payrollType: 'Quincenal', amount: 40 }),
    ]);
    expect(rows.reduce((s, r) => s + r.total, 0)).toBe(100);
  });
});

describe('summarizeByCompany', () => {
  it('calcula costo empresa = bruto + patronal y participación', () => {
    const rows = summarizeByCompany([
      rec({ cia: '00011', empresaNomina: 'SIR', cashTreatment: 'CASH_OUT', amount: 100 }),
      rec({ cia: '00011', empresaNomina: 'SIR', cashTreatment: 'EMPLOYER_TAX', amount: 20 }),
      rec({ cia: '00017', empresaNomina: 'SIT', cashTreatment: 'CASH_OUT', amount: 60 }),
    ]);
    const sir = rows.find(r => r.cia === '00011')!;
    expect(sir.employerCost).toBe(120);
    expect(sir.grossEarnings).toBe(100);
    expect(sir.employerTaxes).toBe(20);
    const totalCost = 120 + 60;
    expect(sir.share).toBeCloseTo((120 / totalCost) * 100);
    // ordenado por costo desc
    expect(rows[0].cia).toBe('00011');
  });
});

describe('isoWeekMonday', () => {
  it('ancla cualquier día a su lunes ISO', () => {
    // 2026-05-07 es jueves → lunes 2026-05-04
    expect(isoWeekMonday('2026-05-07')).toBe('2026-05-04');
    // un lunes se mapea a sí mismo
    expect(isoWeekMonday('2026-05-04')).toBe('2026-05-04');
    // domingo 2026-05-10 → lunes 2026-05-04
    expect(isoWeekMonday('2026-05-10')).toBe('2026-05-04');
  });
});

describe('buildPayrollTimeSeries', () => {
  it('agrupa por mes y calcula costo empresa + pago neto', () => {
    const series = buildPayrollTimeSeries([
      rec({ year: 2026, month: 4, cashTreatment: 'CASH_OUT', amount: 100 }),
      rec({ year: 2026, month: 4, cashTreatment: 'WITHHOLDING_PAYABLE', amount: 10 }),
      rec({ year: 2026, month: 5, cashTreatment: 'CASH_OUT', amount: 200 }),
      rec({ year: 2026, month: 5, cashTreatment: 'EMPLOYER_TAX', amount: 40 }),
    ], 'monthly');
    expect(series.map(p => p.bucket)).toEqual(['2026-04', '2026-05']);
    expect(series[0].netCashOnPaymentDate).toBe(90); // 100 - 10
    expect(series[1].employerCost).toBe(240); // 200 + 40
  });

  it('agrupa por semana usando el lunes ISO de la fecha de pago', () => {
    const series = buildPayrollTimeSeries([
      rec({ paymentDate: '2026-05-07', cashTreatment: 'CASH_OUT', amount: 100 }),
      rec({ paymentDate: '2026-05-08', cashTreatment: 'CASH_OUT', amount: 50 }),
      rec({ paymentDate: '2026-05-14', cashTreatment: 'CASH_OUT', amount: 70 }),
    ], 'weekly');
    expect(series.map(p => p.bucket)).toEqual(['2026-05-04', '2026-05-11']);
    expect(series[0].grossEarnings).toBe(150);
  });
});

describe('seriesVariation', () => {
  it('calcula delta y porcentaje del último vs anterior', () => {
    expect(seriesVariation([100, 120])).toEqual({
      current: 120, previous: 100, deltaAbs: 20, deltaPct: 20,
    });
  });
  it('devuelve deltaPct null cuando el previo es 0', () => {
    expect(seriesVariation([0, 50]).deltaPct).toBeNull();
  });
  it('maneja series vacías', () => {
    expect(seriesVariation([])).toEqual({ current: 0, previous: 0, deltaAbs: 0, deltaPct: null });
  });
});

describe('topConceptsWithShare / groupConceptsByType', () => {
  it('top conceptos con participación', () => {
    const rows = topConceptsWithShare([
      rec({ conceptId: 1, conceptName: 'SUELDO', amount: 75 }),
      rec({ conceptId: 2, conceptName: 'BONO', amount: 25 }),
    ], 5);
    expect(rows[0].conceptName).toBe('SUELDO');
    expect(rows[0].pct).toBeCloseTo(75);
  });

  it('agrupa conceptos por tipo', () => {
    const groups = groupConceptsByType([
      rec({ conceptId: 1, conceptType: 'Percepción', amount: 100 }),
      rec({ conceptId: 2, conceptType: 'Deducción', amount: 30 }),
    ]);
    expect(groups[0].conceptType).toBe('Percepción');
    expect(groups[0].concepts).toHaveLength(1);
  });
});

describe('monthly series helpers', () => {
  it('distinctMonths ordena los meses presentes', () => {
    const months = distinctMonths([
      rec({ year: 2026, month: 5 }),
      rec({ year: 2026, month: 1 }),
      rec({ year: 2025, month: 12 }),
    ]);
    expect(months).toEqual(['2025-12', '2026-01', '2026-05']);
  });

  it('monthlyConceptSeries alinea a meses y rellena ceros', () => {
    const months = ['2026-01', '2026-02', '2026-03'];
    const series = monthlyConceptSeries([
      rec({ conceptId: 7, year: 2026, month: 1, amount: 100 }),
      rec({ conceptId: 7, year: 2026, month: 3, amount: 300 }),
      rec({ conceptId: 9, year: 2026, month: 2, amount: 999 }),
    ], 7, months);
    expect(series).toEqual([100, 0, 300]);
  });

  it('monthlyEmployerCostSeries suma CASH_OUT + EMPLOYER_TAX', () => {
    const months = ['2026-01'];
    const series = monthlyEmployerCostSeries([
      rec({ year: 2026, month: 1, cashTreatment: 'CASH_OUT', amount: 100 }),
      rec({ year: 2026, month: 1, cashTreatment: 'EMPLOYER_TAX', amount: 20 }),
      rec({ year: 2026, month: 1, cashTreatment: 'DEDUCTION', amount: 999 }),
    ], months);
    expect(series).toEqual([120]);
  });
});
