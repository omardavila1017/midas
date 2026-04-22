import { describe, it, expect } from 'vitest';
import {
  parseBudgetCsv,
  parseBudgetNumber,
  detectScaleFromText,
  buildBudgetTemplateCsv,
  scaleFactor,
} from './budget';

const SAMPLE_CSV = `Presupuesto 2026 — Resumen Mensual,,,,,,,,,,,,,
Cifras en millones de pesos (MXN),,,,,,,,,,,,,
Todas las compañias,,,,,,,,,,,,,
,,,,,,,,,,,,,
Concepto,Ene,Feb,Mar,Abr,May,Jun,Jul,Ago,Sep,Oct,Nov,Dic,Total Año
Caja Inicial,376.4,210.9,164.8,164.0,36.0,173.2,274.0,342.8,525.1,772.8,990.6,846.3,376.4
INGRESOS,,,,,,,,,,,,,
Ingresos Totales,290.7,253.5,343.3,288.5,325.4,380.8,324.6,415.1,344.4,329.9,420.5,365.4,"4,082.0"
EGRESOS,,,,,,,,,,,,,
Nómina,82.3,80.1,94.4,77.0,86.0,89.5,77.2,95.9,72.1,77.2,95.9,111.2,"1,038.7"
Finiquitos,6.7,5.5,7.2,4.6,3.7,3.7,3.0,3.5,2.8,2.8,3.5,2.8,49.9
Diésel,59.9,49.4,66.8,58.3,64.7,80.9,64.7,80.9,64.7,64.7,80.9,64.7,800.7
Gas,3.4,6.4,5.9,5.8,5.2,6.5,5.2,6.5,5.2,5.2,6.5,5.2,66.9
Lubricantes y Otros,5.4,2.1,1.8,3.8,5.1,6.4,5.1,6.4,5.1,5.1,6.4,5.1,57.9
Impuestos,50.7,14.8,25.3,27.3,62.5,27.5,51.5,14.5,51.5,14.5,51.5,154.5,546.1
Gastos de Operación,47.2,57.8,78.1,43.5,61.4,67.5,60.9,92.0,59.4,59.9,91.5,59.9,779.1
CAPEX,-,-,-,-,0.2,0.2,0.2,0.2,0.2,0.2,0.2,0.2,1.6
Pasivos Financieros,41.5,98.5,51.9,98.2,45.6,51.7,93.3,58.6,28.8,92.4,62.3,26.0,748.9
TOTALES,,,,,,,,,,,,,
Total Egresos,297.3,314.5,331.5,318.6,334.4,333.8,361.1,358.5,289.8,322.0,398.6,429.6,"4,089.7"
Flujo Neto del Mes,(6.6),(61.1),11.8,(30.1),(9.0),47.0,(36.5),56.6,54.6,7.9,21.9,(64.3),(7.7)
Caja Final,373.9,153.6,146.5,149.9,57.3,229.7,244.7,408.5,587.1,788.1,"1,022.3",789.0,789.0
`;

describe('parseBudgetNumber', () => {
  it('parses plain numbers', () => {
    expect(parseBudgetNumber('290.7')).toBe(290.7);
    expect(parseBudgetNumber('82')).toBe(82);
  });
  it('parses thousand-separated', () => {
    expect(parseBudgetNumber('1,038.7')).toBe(1038.7);
    expect(parseBudgetNumber('4,082.0')).toBe(4082.0);
  });
  it('parses negative in parentheses', () => {
    expect(parseBudgetNumber('(6.6)')).toBe(-6.6);
    expect(parseBudgetNumber('(61.1)')).toBe(-61.1);
  });
  it('handles dash / em-dash as zero', () => {
    expect(parseBudgetNumber('-')).toBe(0);
    expect(parseBudgetNumber('—')).toBe(0);
    expect(parseBudgetNumber('')).toBe(0);
  });
});

describe('detectScaleFromText', () => {
  it('detects millones', () => {
    expect(detectScaleFromText('Cifras en millones de pesos (MXN)')).toBe('millones');
  });
  it('detects miles', () => {
    expect(detectScaleFromText('valores en miles de pesos')).toBe('miles');
  });
  it('detects pesos', () => {
    expect(detectScaleFromText('Montos en pesos')).toBe('pesos');
  });
  it('returns null when not detectable', () => {
    expect(detectScaleFromText('resumen mensual')).toBeNull();
  });
});

describe('parseBudgetCsv', () => {
  it('parses the real 2026 sample', () => {
    const { budget, detectedScale, warnings, error } = parseBudgetCsv(SAMPLE_CSV);
    expect(error).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(detectedScale).toBe('millones');
    expect(budget).toBeTruthy();
    const b = budget!;
    expect(b.year).toBe(2026);
    expect(b.scale).toBe('millones');
    // Ingresos: Enero 290.7 millones = 290_700_000 pesos.
    expect(b.incomeTotal[0]).toBeCloseTo(290_700_000, 0);
    // Diciembre Pasivos Financieros 26.0 millones.
    const pasivos = b.expenseByConcept.find((r) => r.concept.toLowerCase().includes('pasivos'))!;
    expect(pasivos.monthly[11]).toBeCloseTo(26_000_000, 0);
    // CAPEX enero con "-" → 0
    const capex = b.expenseByConcept.find((r) => r.concept === 'CAPEX')!;
    expect(capex.monthly[0]).toBe(0);
    expect(capex.monthly[4]).toBeCloseTo(200_000, 0);
    // Total egresos del mes 3 (Marzo) = 331.5 millones
    expect(b.expenseTotal[2]).toBeCloseTo(331_500_000, 0);
    // Caja inicial Ene = 376.4 millones
    expect(b.openingCash?.[0]).toBeCloseTo(376_400_000, 0);
    // Conteo de conceptos de egreso (9 categorías en el CSV).
    expect(b.expenseByConcept.length).toBe(9);
    // Un solo concepto de ingreso (Ingresos Totales es el TOTAL, no detalle).
    expect(b.incomeByConcept.length).toBe(0);
  });

  it('respects explicit scale override', () => {
    const { budget } = parseBudgetCsv(SAMPLE_CSV, { scale: 'pesos' });
    // Si forzamos pesos, 290.7 (número) queda como 290.7 pesos.
    expect(budget!.incomeTotal[0]).toBeCloseTo(290.7, 2);
  });

  it('returns an error when header row is missing', () => {
    const bad = 'sin header alguno\nsolo texto,aqui\n';
    const res = parseBudgetCsv(bad);
    expect(res.error).toBeTruthy();
    expect(res.budget).toBeNull();
  });
});

describe('buildBudgetTemplateCsv', () => {
  it('roundtrips in millones without precision loss', () => {
    const csv = buildBudgetTemplateCsv('millones', 2026);
    const { budget, detectedScale } = parseBudgetCsv(csv);
    expect(detectedScale).toBe('millones');
    expect(budget!.year).toBe(2026);
    // Verificamos que el total de ingresos del primer mes caiga cerca de
    // los 290.7 millones del ejemplo.
    expect(budget!.incomeTotal[0]).toBeCloseTo(290_700_000, -4); // tolerancia ±10k
  });

  it('roundtrips in pesos', () => {
    const csv = buildBudgetTemplateCsv('pesos', 2026);
    const { budget, detectedScale } = parseBudgetCsv(csv);
    expect(detectedScale).toBe('pesos');
    expect(budget!.incomeTotal[0]).toBeCloseTo(290_700_000, -5);
  });

  it('emits the header scale line correctly', () => {
    const csv = buildBudgetTemplateCsv('miles', 2027);
    expect(csv).toContain('Presupuesto 2027');
    expect(csv).toContain('miles de pesos');
  });
});

describe('scaleFactor', () => {
  it('matches expected multipliers', () => {
    expect(scaleFactor('pesos')).toBe(1);
    expect(scaleFactor('miles')).toBe(1_000);
    expect(scaleFactor('millones')).toBe(1_000_000);
  });
});
