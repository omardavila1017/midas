import { describe, expect, it } from 'vitest';
import type { PayrollCashTreatment, PayrollCostRecord } from '../../shared-finance/types';
import { detectPayrollAnomalies } from './payrollAnomalyService';

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
    const anomalies = detectPayrollAnomalies(records);
    const bono = anomalies.find(a => a.scope === 'concepto' && a.label === 'BONO DE EFECTIVIDAD');
    expect(bono).toBeDefined();
    expect(bono!.severity).toBe('CRITICO');
    expect(bono!.month).toBe('2026-07');
    expect(bono!.value).toBe(500_000);
    expect(bono!.zscore).toBeGreaterThan(3);
  });

  it('no marca series estables', () => {
    const records = monthlySeries(2, 'SUELDO ORDINARIO', [100_000, 101_000, 99_500, 100_500, 100_000, 99_800, 100_200]);
    const anomalies = detectPayrollAnomalies(records);
    expect(anomalies.find(a => a.label === 'SUELDO ORDINARIO')).toBeUndefined();
  });

  it('requiere historia mínima (no evalúa con pocos meses)', () => {
    const records = monthlySeries(3, 'BONO', [100_000, 500_000]);
    expect(detectPayrollAnomalies(records)).toHaveLength(0);
  });

  it('ordena por severidad descendente', () => {
    const records = [
      ...monthlySeries(1, 'BONO A', [100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 900_000]),
      ...monthlySeries(2, 'BONO B', [100_000, 100_000, 100_000, 100_000, 100_000, 100_000, 160_000]),
    ];
    const anomalies = detectPayrollAnomalies(records);
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    // El primero debe tener la severidad más alta.
    const rank = { CRITICO: 3, ALTO: 2, MEDIO: 1 } as const;
    for (let i = 1; i < anomalies.length; i++) {
      expect(rank[anomalies[i - 1].severity]).toBeGreaterThanOrEqual(rank[anomalies[i].severity]);
    }
  });
});
