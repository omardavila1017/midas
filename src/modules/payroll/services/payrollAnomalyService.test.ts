import { describe, expect, it } from 'vitest';
import type { PayrollCashTreatment, PayrollCostRecord } from '../../shared-finance/types';
import { detectPayrollAnomalies } from './payrollAnomalyService';

// Reloj FIJO: sin esto los tests dependían de la fecha real — las series usan
// meses de 2026 y, corridos antes de que esos meses cerraran, el filtro de mes
// en curso los descartaría y la suite fallaría según el día.
const TODAY = '2027-01-15';

function rec(partial: Partial<PayrollCostRecord>): PayrollCostRecord {
  return {
    cia: '00011',
    empresaNomina: 'SIR',
    year: 2026,
    month: 1,
    paymentDate: '2026-01-07',
    payrollPeriod: 1,
    payrollType: 'Semanal',
    conceptId: 1,
    conceptName: 'SUELDO ORDINARIO',
    conceptType: 'Percepción',
    cashTreatment: 'CASH_OUT' as PayrollCashTreatment,
    amount: 100_000,
    ...partial,
  };
}

/**
 * Construye una serie mensual completa (con deducción y aportación por mes
 * para que `findSuspectMonths` no la marque como parcial) para un concepto.
 */
function monthlySeries(conceptId: number, conceptName: string, amounts: number[]): PayrollCostRecord[] {
  const out: PayrollCostRecord[] = [];
  amounts.forEach((amount, i) => {
    const month = i + 1;
    out.push(rec({ conceptId, conceptName, month, year: 2026, amount, cashTreatment: 'CASH_OUT' }));
    // deducción + aportación de relleno → mes "completo" para findSuspectMonths
    out.push(rec({ conceptId: 900, conceptName: 'IMSS', month, year: 2026, amount: amount * 0.1, cashTreatment: 'DEDUCTION' }));
    out.push(rec({ conceptId: 901, conceptName: 'IMSS PATRONAL', month, year: 2026, amount: amount * 0.2, cashTreatment: 'EMPLOYER_TAX' }));
  });
  return out;
}

describe('detectPayrollAnomalies', () => {
  it('marca un salto fuerte en el último mes como anomalía', () => {
    // 6 meses estables ~100k, séptimo mes dispara a 500k.
    const records = monthlySeries(1, 'BONO DE EFECTIVIDAD', [100_000, 102_000, 99_000, 101_000, 100_500, 98_000, 500_000]);
    const anomalies = detectPayrollAnomalies(records, { todayIso: TODAY });
    const bono = anomalies.find(a => a.scope === 'concepto' && a.label === 'BONO DE EFECTIVIDAD');
    expect(bono).toBeDefined();
    expect(bono!.severity).toBe('CRITICO');
    expect(bono!.month).toBe('2026-07');
    expect(bono!.value).toBe(500_000);
    expect(bono!.zscore).toBeGreaterThan(3);
  });

  it('no marca series estables', () => {
    const records = monthlySeries(2, 'SUELDO ORDINARIO', [100_000, 101_000, 99_500, 100_500, 100_000, 99_800, 100_200]);
    const anomalies = detectPayrollAnomalies(records, { todayIso: TODAY });
    expect(anomalies.find(a => a.label === 'SUELDO ORDINARIO')).toBeUndefined();
  });

  it('requiere historia mínima (no evalúa con pocos meses)', () => {
    const records = monthlySeries(3, 'BONO', [100_000, 500_000]);
    expect(detectPayrollAnomalies(records, { todayIso: TODAY })).toHaveLength(0);
  });

  it('ordena por severidad descendente', () => {
    const records = [
      ...monthlySeries(1, 'BONO A', [100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 900_000]),
      ...monthlySeries(2, 'BONO B', [100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 160_000]),
    ];
    const anomalies = detectPayrollAnomalies(records, { todayIso: TODAY });
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    // El primero debe tener la severidad más alta.
    const rank = { CRITICO: 3, ALTO: 2, MEDIO: 1 } as const;
    for (let i = 1; i < anomalies.length; i++) {
      expect(rank[anomalies[i - 1].severity]).toBeGreaterThanOrEqual(rank[anomalies[i].severity]);
    }
  });
});

/**
 * Las tres firmas de `findSuspectMonths` NO cubren el mes en curso: la 3 lo
 * exenta a propósito, la 1 exige cero deducciones Y cero aportaciones, y la 2
 * pide ratio bajo Y gross bajo el 25% del techo. Un mes a la mitad tiene ratio
 * sano y pasa. Medido el 2026-09-21: septiembre llevaba $120.6M contra $237.7M
 * de agosto y ninguna firma lo marcaba.
 */
describe('detectPayrollAnomalies — mes en curso y meses futuros', () => {
  it('NO marca como anomalía el mes en curso incompleto', () => {
    // 6 meses estables + el séptimo a un cuarto: si entrara, saldría CRÍTICO.
    // Meses 1-6 estables (el 6 queda EN la media, así que no es anómalo por sí
    // mismo); el 7 a un cuarto — si entrara, saldría CRÍTICO.
    const records = monthlySeries(1, 'SUELDO ORDINARIO', [
      99_000, 100_000, 101_000, 100_000, 99_000, 100_000, 25_000,
    ]);
    // "Hoy" cae DENTRO del mes 7 → ese mes está en progreso.
    const anomalies = detectPayrollAnomalies(records, { todayIso: '2026-07-14' });
    expect(anomalies.filter(a => a.label === 'SUELDO ORDINARIO')).toEqual([]);
  });

  it('SÍ lo marca una vez que el mes cerró', () => {
    const records = monthlySeries(1, 'SUELDO ORDINARIO', [
      99_000, 100_000, 101_000, 100_000, 99_000, 100_000, 25_000,
    ]);
    const anomalies = detectPayrollAnomalies(records, { todayIso: '2026-08-02' });
    expect(anomalies.some(a => a.label === 'SUELDO ORDINARIO')).toBe(true);
  });

  /** TRESS carga meses por adelantado: octubre ya traía $67k el 21-sep. */
  it('descarta los meses FUTUROS que TRESS carga por adelantado', () => {
    const records = monthlySeries(1, 'SUELDO ORDINARIO', [
      99_000, 100_000, 101_000, 100_000, 99_000, 100_000, 100_000, 300,
    ]);
    const anomalies = detectPayrollAnomalies(records, { todayIso: '2026-07-20' });
    expect(anomalies.filter(a => a.label === 'SUELDO ORDINARIO')).toEqual([]);
  });
});
