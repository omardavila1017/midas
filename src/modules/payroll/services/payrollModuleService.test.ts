import { describe, expect, it } from 'vitest';
import type { PayrollCashTreatment, PayrollCostRecord } from '../../shared-finance/types';
import {
  computeKpis,
  filterRecords,
  isCacheFresh,
  lastNMonths,
  mergeNominaBatch,
  nominaCacheKey,
  refineBatch,
  refineCashTreatment,
  summarizeByConcept,
  summarizePeriods,
} from './payrollModuleService';

function rec(partial: Partial<PayrollCostRecord>): PayrollCostRecord {
  return {
    cia: '00001',
    empresaNomina: 'TAMAULIPAS FEDERAL',
    year: 2026,
    month: 5,
    paymentDate: '2026-05-07',
    periodStartDate: '2026-04-27',
    periodEndDate: '2026-05-03',
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

describe('nominaCacheKey', () => {
  it('genera la llave compuesta canónica', () => {
    expect(nominaCacheKey({ idEmpresa: 99, tipoNomina: 99, anio: 2026, mes: 5 }))
      .toBe('99:99:2026:5');
  });
});

describe('lastNMonths', () => {
  it('devuelve mes actual + n-1 anteriores en orden ascendente', () => {
    expect(lastNMonths(2026, 5, 4)).toEqual([
      { anio: 2026, mes: 2 },
      { anio: 2026, mes: 3 },
      { anio: 2026, mes: 4 },
      { anio: 2026, mes: 5 },
    ]);
  });

  it('cruza el límite de año hacia atrás', () => {
    expect(lastNMonths(2026, 2, 4)).toEqual([
      { anio: 2025, mes: 11 },
      { anio: 2025, mes: 12 },
      { anio: 2026, mes: 1 },
      { anio: 2026, mes: 2 },
    ]);
  });

  it('soporta n=1 (solo mes actual)', () => {
    expect(lastNMonths(2026, 7, 1)).toEqual([{ anio: 2026, mes: 7 }]);
  });
});

describe('refineCashTreatment', () => {
  it('ISR como Deducción → WITHHOLDING_PAYABLE', () => {
    const r = rec({ conceptName: 'ISR', conceptType: 'Deducción', cashTreatment: 'DEDUCTION' });
    expect(refineCashTreatment(r)).toBe('WITHHOLDING_PAYABLE');
  });
  it('IMSS EMPLEADO como Deducción → WITHHOLDING_PAYABLE', () => {
    const r = rec({ conceptName: 'IMSS EMPLEADO', conceptType: 'Deducción', cashTreatment: 'DEDUCTION' });
    expect(refineCashTreatment(r)).toBe('WITHHOLDING_PAYABLE');
  });
  it('Préstamo como Deducción → DEDUCTION (sí reduce neto al empleado)', () => {
    const r = rec({ conceptName: 'PRESTAMO PERSONAL', conceptType: 'Deducción', cashTreatment: 'DEDUCTION' });
    expect(refineCashTreatment(r)).toBe('DEDUCTION');
  });
  it('Vales de despensa como Percepción → NON_CASH', () => {
    const r = rec({ conceptName: 'VALES DESPENSA', conceptType: 'Percepción', cashTreatment: 'CASH_OUT' });
    expect(refineCashTreatment(r)).toBe('NON_CASH');
  });
  it('Sueldo ordinario como Percepción → CASH_OUT', () => {
    expect(refineCashTreatment(rec({}))).toBe('CASH_OUT');
  });
  it('EMPLOYER_TAX para IMSS PATRONAL → EMPLOYER_TAX (lo dueña Taxes module)', () => {
    const r = rec({ cashTreatment: 'EMPLOYER_TAX', conceptName: 'IMSS PATRONAL', conceptType: 'Obligación Empresa' });
    expect(refineCashTreatment(r)).toBe('EMPLOYER_TAX');
  });
  it('EMPLOYER_TAX para INFONAVIT 5% → EMPLOYER_TAX', () => {
    const r = rec({ cashTreatment: 'EMPLOYER_TAX', conceptName: 'INFONAVIT 5%', conceptType: 'Obligación Empresa' });
    expect(refineCashTreatment(r)).toBe('EMPLOYER_TAX');
  });
  it('EMPLOYER_TAX para ISR (EMPRESA) → WITHHOLDING_PAYABLE (es ISR retenido al empleado)', () => {
    const r = rec({ cashTreatment: 'EMPLOYER_TAX', conceptName: 'ISR (EMPRESA)', conceptType: 'Obligación Empresa' });
    expect(refineCashTreatment(r)).toBe('WITHHOLDING_PAYABLE');
  });
  it('EMPLOYER_TAX para EXCENTO VALES DEPENSA → NON_CASH (informativo)', () => {
    const r = rec({ cashTreatment: 'EMPLOYER_TAX', conceptName: 'EXCENTO VALES DEPENSA', conceptType: 'Obligación Empresa' });
    expect(refineCashTreatment(r)).toBe('NON_CASH');
  });
  it('EMPLOYER_TAX para EXENTO PRIMA VACACIONAL → NON_CASH (informativo)', () => {
    const r = rec({ cashTreatment: 'EMPLOYER_TAX', conceptName: 'EXENTO DE PRIMA VACACIONAL', conceptType: 'Obligación Empresa' });
    expect(refineCashTreatment(r)).toBe('NON_CASH');
  });
  it('EMPLOYER_TAX para PROVISION IMPTO SOBRE NOMINA → NON_CASH (provisión contable)', () => {
    const r = rec({ cashTreatment: 'EMPLOYER_TAX', conceptName: 'PROVISION IMPTO SOBRE NOMINA', conceptType: 'Obligación Empresa' });
    expect(refineCashTreatment(r)).toBe('NON_CASH');
  });
  it('EMPLOYER_TAX para HRS EXTRAS GRAVADAS PARA IMSS → NON_CASH (informativo base IMSS)', () => {
    const r = rec({ cashTreatment: 'EMPLOYER_TAX', conceptName: 'HRS EXTRAS GRAVADAS PARA IMSS', conceptType: 'Obligación Empresa' });
    expect(refineCashTreatment(r)).toBe('NON_CASH');
  });
  it('EMPLOYER_TAX para DESPENSA GRAVADA → NON_CASH (informativo)', () => {
    const r = rec({ cashTreatment: 'EMPLOYER_TAX', conceptName: 'DESPENSA GRAVADA', conceptType: 'Obligación Empresa' });
    expect(refineCashTreatment(r)).toBe('NON_CASH');
  });
  it('NON_CASH para INDEMNIZACION bajo Prestación → CASH_OUT (pago real al empleado)', () => {
    const r = rec({ cashTreatment: 'NON_CASH', conceptName: 'INDEMNIZACION', conceptType: 'Prestación' });
    expect(refineCashTreatment(r)).toBe('CASH_OUT');
  });
  it('NON_CASH para GRATIFICACION POR SEPARACION bajo Prestación → CASH_OUT', () => {
    const r = rec({ cashTreatment: 'NON_CASH', conceptName: 'GRATIFICACION POR SEPARACION', conceptType: 'Prestación' });
    expect(refineCashTreatment(r)).toBe('CASH_OUT');
  });
  it('NON_CASH para PRIMA DE ANTIGUEDAD bajo Prestación → CASH_OUT', () => {
    const r = rec({ cashTreatment: 'NON_CASH', conceptName: 'PRIMA DE ANTIGUEDAD', conceptType: 'Prestación' });
    expect(refineCashTreatment(r)).toBe('CASH_OUT');
  });
  it('NON_CASH para VALE DE DESPENSA bajo Prestación → NON_CASH (sigue siendo vale)', () => {
    const r = rec({ cashTreatment: 'NON_CASH', conceptName: 'VALE DE DESPENSA', conceptType: 'Prestación' });
    expect(refineCashTreatment(r)).toBe('NON_CASH');
  });
});

describe('inferCashTreatment desde mapper (a través de mergeNominaBatch + refineBatch)', () => {
  it('Obligación Empresa default → EMPLOYER_TAX', () => {
    const r = rec({ cashTreatment: 'EMPLOYER_TAX', conceptName: 'IMSS PATRONAL', conceptType: 'Obligación Empresa' });
    const refined = refineBatch([r]);
    expect(refined[0].cashTreatment).toBe('EMPLOYER_TAX');
  });
  it('Prestación default → NON_CASH', () => {
    const r = rec({ cashTreatment: 'NON_CASH', conceptName: 'VALE DE DESPENSA', conceptType: 'Prestación' });
    const refined = refineBatch([r]);
    expect(refined[0].cashTreatment).toBe('NON_CASH');
  });
});

describe('mergeNominaBatch', () => {
  it('reemplaza records existentes con la misma huella (year, month, cia, payrollType)', () => {
    const old = [
      rec({ conceptId: 1, amount: 100, conceptName: 'OLD' }),
      // Mismo periodo, distinto concepto → debe ser reemplazado por el batch nuevo
      rec({ conceptId: 2, amount: 50, conceptName: 'OLD2' }),
      // Distinta cia → debe sobrevivir
      rec({ cia: '00011', conceptId: 1, amount: 200, conceptName: 'KEEP' }),
    ];
    const incoming = [
      rec({ conceptId: 1, amount: 150, conceptName: 'NEW' }),
    ];
    const merged = mergeNominaBatch(old, incoming);
    expect(merged).toHaveLength(2);
    expect(merged.find(r => r.cia === '00011')?.conceptName).toBe('KEEP');
    expect(merged.find(r => r.cia === '00001')?.conceptName).toBe('NEW');
    expect(merged.find(r => r.cia === '00001')?.amount).toBe(150);
  });

  it('aplica refineBatch a los registros nuevos al mergear', () => {
    const incoming = [
      rec({ conceptId: 90, conceptName: 'ISR', conceptType: 'Deducción', cashTreatment: 'DEDUCTION', amount: 15_000 }),
    ];
    const merged = mergeNominaBatch([], incoming);
    expect(merged[0].cashTreatment).toBe('WITHHOLDING_PAYABLE');
  });

  it('batch vacío no muta existentes', () => {
    const existing = [rec({})];
    expect(mergeNominaBatch(existing, [])).toBe(existing);
  });
});

describe('refineBatch', () => {
  it('produce nuevos objetos sin mutar el original', () => {
    const input = [rec({ conceptName: 'ISR', cashTreatment: 'DEDUCTION' })];
    const refined = refineBatch(input);
    expect(input[0].cashTreatment).toBe('DEDUCTION');
    expect(refined[0].cashTreatment).toBe('WITHHOLDING_PAYABLE');
  });
});

describe('isCacheFresh', () => {
  const now = Date.parse('2026-05-13T12:00:00Z');
  it('devuelve true si está dentro de la ventana', () => {
    const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
    expect(isCacheFresh(tenMinAgo, 30 * 60 * 1000, now)).toBe(true);
  });
  it('devuelve false si excede la ventana', () => {
    const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
    expect(isCacheFresh(hourAgo, 30 * 60 * 1000, now)).toBe(false);
  });
  it('devuelve false si falta el timestamp', () => {
    expect(isCacheFresh(undefined, 30 * 60 * 1000, now)).toBe(false);
    expect(isCacheFresh('not-a-date', 30 * 60 * 1000, now)).toBe(false);
  });
});

describe('summarizePeriods', () => {
  it('agrupa por (cia, paymentDate, payrollType, payrollPeriod) y calcula cash neto', () => {
    const records: PayrollCostRecord[] = [
      rec({ conceptId: 1, conceptName: 'SUELDO ORDINARIO', cashTreatment: 'CASH_OUT', amount: 100_000 }),
      rec({ conceptId: 2, conceptName: 'BONO PUNTUALIDAD', cashTreatment: 'CASH_OUT', amount: 5_000 }),
      rec({ conceptId: 90, conceptName: 'ISR', cashTreatment: 'WITHHOLDING_PAYABLE', amount: 15_000 }),
      rec({ conceptId: 91, conceptName: 'IMSS EMPLEADO', cashTreatment: 'WITHHOLDING_PAYABLE', amount: 2_500 }),
      rec({ conceptId: 92, conceptName: 'PRESTAMO', cashTreatment: 'DEDUCTION', amount: 1_000 }),
      rec({ conceptId: 200, conceptName: 'IMSS PATRONAL', cashTreatment: 'EMPLOYER_TAX', amount: 18_000 }),
      rec({ conceptId: 300, conceptName: 'VALES', cashTreatment: 'NON_CASH', amount: 2_500 }),
    ];
    const summaries = summarizePeriods(records);
    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.grossEarnings).toBe(105_000);
    expect(s.netDeductions).toBe(1_000);
    expect(s.withholdings).toBe(17_500);
    expect(s.employerTaxes).toBe(18_000);
    expect(s.nonCash).toBe(2_500);
    // Cash neto = 105 000 − 1 000 − 17 500 = 86 500
    expect(s.netCashOnPaymentDate).toBe(86_500);
    expect(s.conceptCount).toBe(7);
  });

  it('separa periodos distintos por paymentDate', () => {
    const records = [
      rec({ paymentDate: '2026-05-07', payrollPeriod: 18, amount: 100 }),
      rec({ paymentDate: '2026-05-14', payrollPeriod: 19, amount: 200 }),
    ];
    const summaries = summarizePeriods(records);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].paymentDate).toBe('2026-05-07');
    expect(summaries[1].paymentDate).toBe('2026-05-14');
  });
});

describe('summarizeByConcept', () => {
  it('suma por concepto y ordena descendente por total', () => {
    const records = [
      rec({ conceptId: 1, conceptName: 'SUELDO', amount: 80 }),
      rec({ conceptId: 1, conceptName: 'SUELDO', amount: 20 }),
      rec({ conceptId: 2, conceptName: 'BONO', amount: 50 }),
    ];
    const breakdown = summarizeByConcept(records);
    expect(breakdown).toHaveLength(2);
    expect(breakdown[0].conceptName).toBe('SUELDO');
    expect(breakdown[0].total).toBe(100);
    expect(breakdown[0].occurrences).toBe(2);
    expect(breakdown[1].conceptName).toBe('BONO');
    expect(breakdown[1].total).toBe(50);
  });
});

describe('computeKpis', () => {
  it('agrega totales sobre los periodos resumidos', () => {
    const records: PayrollCostRecord[] = [
      rec({ cia: '00001', paymentDate: '2026-05-07', conceptId: 1, cashTreatment: 'CASH_OUT', amount: 100_000 }),
      rec({ cia: '00001', paymentDate: '2026-05-07', conceptId: 90, cashTreatment: 'WITHHOLDING_PAYABLE', amount: 15_000 }),
      rec({ cia: '00011', paymentDate: '2026-05-07', conceptId: 1, cashTreatment: 'CASH_OUT', amount: 200_000 }),
    ];
    const kpis = computeKpis(records);
    expect(kpis.totalGross).toBe(300_000);
    expect(kpis.totalWithholdings).toBe(15_000);
    expect(kpis.totalNetCash).toBe(285_000); // 300k - 15k
    expect(kpis.payingCompanies).toBe(2);
    expect(kpis.periodCount).toBe(2);
    expect(kpis.conceptCount).toBe(3);
  });
});

describe('filterRecords', () => {
  const records = [
    rec({ cia: '00001', year: 2026, month: 5, payrollType: 'Semanal' }),
    rec({ cia: '00001', year: 2026, month: 5, payrollType: 'Quincenal' }),
    rec({ cia: '00011', year: 2026, month: 4, payrollType: 'Semanal' }),
  ];
  it('filtros vacíos devuelven todo', () => {
    expect(filterRecords(records, {})).toHaveLength(3);
  });
  it('combina cia + payrollType', () => {
    expect(filterRecords(records, { cia: '00001', payrollType: 'Semanal' })).toHaveLength(1);
  });
  it('filtra por month', () => {
    expect(filterRecords(records, { month: 4 })).toHaveLength(1);
  });
});
