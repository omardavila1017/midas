import { describe, expect, it } from 'vitest';
import {
  computePayrollMonthlyFloor,
  payrollWeekKey,
  PAYROLL_WEEKS_PER_MONTH,
  type PayrollFloorRecordLike,
} from './payrollOperatingFloor';

/**
 * Cifras REALES de `tress.Nomina` (db_Artefactos, carga 2026-08-04), deduplicadas
 * por `IDAnio, IDMes, IDEmpresa, IDConcepto, IDTipoNomina, Periodo` y agrupadas
 * por lunes de `FechaPago`. Σ percepciones (`TipoConcepto = 'Percepción'` →
 * `cashTreatment CASH_OUT`).
 *
 * Nótese la alternancia semana-normal / semana-con-quincena: ~$9-11M vs ~$15M.
 * Ese es el patrón que hacía inservible tomar UNA sola semana.
 */
const REAL_WEEKLY_GROSS: Array<{ monday: string; gross: number; percep: number; deduc: number }> = [
  { monday: '2026-07-06', gross: 9_417_958.26, percep: 248, deduc: 225 },
  { monday: '2026-07-13', gross: 11_542_498.56, percep: 283, deduc: 310 },
  { monday: '2026-07-20', gross: 10_260_986.09, percep: 248, deduc: 200 },
  { monday: '2026-07-27', gross: 15_029_463.39, percep: 279, deduc: 293 },
];

/** Nómina real promedio de los meses CERRADOS de 2026 (ene–jul), de la BD. */
const REAL_MONTHLY_AVERAGE = 49_693_983.02;

function recordsForWeek(week: { monday: string; gross: number; percep: number; deduc: number }): PayrollFloorRecordLike[] {
  const out: PayrollFloorRecordLike[] = [];
  const year = Number(week.monday.slice(0, 4));
  const month = Number(week.monday.slice(5, 7));
  const per = week.gross / week.percep;
  for (let i = 0; i < week.percep; i++) {
    out.push({ paymentDate: week.monday, year, month, amount: per, cashTreatment: 'CASH_OUT' });
  }
  for (let i = 0; i < week.deduc; i++) {
    out.push({ paymentDate: week.monday, year, month, amount: 1_000, cashTreatment: 'DEDUCTION' });
  }
  return out;
}

const REAL_RECORDS = REAL_WEEKLY_GROSS.flatMap(recordsForWeek);

describe('payrollWeekKey', () => {
  it('ancla al lunes UTC de la semana', () => {
    expect(payrollWeekKey('2026-08-04')).toBe('2026-08-03'); // martes → lunes
    expect(payrollWeekKey('2026-08-03')).toBe('2026-08-03'); // lunes → sí mismo
    expect(payrollWeekKey('2026-08-09')).toBe('2026-08-03'); // domingo → lunes previo
  });

  it('regresa null ante fecha inválida o vacía', () => {
    expect(payrollWeekKey('')).toBeNull();
    expect(payrollWeekKey('no-es-fecha')).toBeNull();
  });
});

describe('computePayrollMonthlyFloor', () => {
  it('promedia las últimas 4 semanas cerradas y cae dentro del 1% de la nómina real', () => {
    const result = computePayrollMonthlyFloor(REAL_RECORDS, { todayIso: '2026-08-04' });
    // (9,417,958.26 + 11,542,498.56 + 10,260,986.09 + 15,029,463.39)/4 × 4.33
    expect(result.monthly).toBeCloseTo(50_066_606.07, 1);
    expect(result.weeksUsed).toEqual(['2026-07-27', '2026-07-20', '2026-07-13', '2026-07-06']);
    // El piso queda a menos del 1% del gasto real de nómina medido en la BD.
    const desvio = Math.abs((result.monthly ?? 0) - REAL_MONTHLY_AVERAGE) / REAL_MONTHLY_AVERAGE;
    expect(desvio).toBeLessThan(0.01);
  });

  it('REGRESIÓN: una sola semana sobreestima el piso >30% (el defecto corregido)', () => {
    // Comportamiento previo: `closedWeeks[0]` × 4.33. La semana más reciente
    // cerrada (2026-07-27) trae quincena, así que infla el piso.
    const unaSemana = computePayrollMonthlyFloor(REAL_RECORDS, { todayIso: '2026-08-04', weeks: 1 });
    expect(unaSemana.monthly).toBeCloseTo(65_077_576.48, 1);
    const sesgo = ((unaSemana.monthly ?? 0) - REAL_MONTHLY_AVERAGE) / REAL_MONTHLY_AVERAGE;
    expect(sesgo).toBeGreaterThan(0.3);

    // …y pararse en una semana normal lo subestima ~18%: por eso el piso
    // oscilaba según el día en que se abría la app.
    const soloNormal = computePayrollMonthlyFloor(
      recordsForWeek(REAL_WEEKLY_GROSS[0]),
      { todayIso: '2026-07-14', weeks: 1 },
    );
    expect(soloNormal.monthly).toBeCloseTo(9_417_958.26 * PAYROLL_WEEKS_PER_MONTH, 1);
    expect((soloNormal.monthly ?? 0) / REAL_MONTHLY_AVERAGE).toBeLessThan(0.85);
  });

  it('excluye la semana en curso (nómina posiblemente parcial)', () => {
    const conParcial = [
      ...REAL_RECORDS,
      ...recordsForWeek({ monday: '2026-08-03', gross: 1_081_364.92, percep: 96, deduc: 71 }),
    ];
    const result = computePayrollMonthlyFloor(conParcial, { todayIso: '2026-08-04' });
    expect(result.weeksUsed).not.toContain('2026-08-03');
    expect(result.monthly).toBeCloseTo(50_066_606.07, 1);
  });

  it('excluye una semana futura sin deducciones (carga incompleta)', () => {
    // Real: FechaPago 2026-08-15 existe con 17 percepciones y CERO deducciones.
    const conFutura = [
      ...REAL_RECORDS,
      ...recordsForWeek({ monday: '2026-08-10', gross: 867_387.32, percep: 17, deduc: 0 }),
    ];
    const result = computePayrollMonthlyFloor(conFutura, { todayIso: '2026-08-04' });
    expect(result.weeksUsed).not.toContain('2026-08-10');
    expect(result.monthly).toBeCloseTo(50_066_606.07, 1);
  });

  it('con menos de 4 semanas cerradas promedia las que hay', () => {
    const dos = [...recordsForWeek(REAL_WEEKLY_GROSS[2]), ...recordsForWeek(REAL_WEEKLY_GROSS[3])];
    const result = computePayrollMonthlyFloor(dos, { todayIso: '2026-08-04' });
    expect(result.weeksUsed).toEqual(['2026-07-27', '2026-07-20']);
    expect(result.monthly).toBeCloseTo(
      ((10_260_986.09 + 15_029_463.39) / 2) * PAYROLL_WEEKS_PER_MONTH,
      1,
    );
  });

  it('sin semanas cerradas devuelve undefined, nunca 0', () => {
    // Un piso 0 significaría "nunca hay déficit": es peor que no tener dato.
    expect(computePayrollMonthlyFloor([], { todayIso: '2026-08-04' }).monthly).toBeUndefined();
    const soloSemanaActual = recordsForWeek({ monday: '2026-08-03', gross: 1_000, percep: 2, deduc: 2 });
    expect(computePayrollMonthlyFloor(soloSemanaActual, { todayIso: '2026-08-04' }).monthly).toBeUndefined();
  });

  it('respeta el filtro por cía', () => {
    const mezcla = [
      ...recordsForWeek(REAL_WEEKLY_GROSS[3]).map((r) => ({ ...r, cia: '00011' })),
      ...recordsForWeek(REAL_WEEKLY_GROSS[0]).map((r) => ({ ...r, cia: '00033' })),
    ];
    const soloCia11 = computePayrollMonthlyFloor(mezcla, { todayIso: '2026-08-04', ciaFilter: '00011' });
    expect(soloCia11.weeklyAverage).toBeCloseTo(15_029_463.39, 1);
  });
});
