import { describe, expect, it } from 'vitest';
import {
  computePayrollMonthlyFloor,
  isAccruedNotDisbursed,
  payrollMonthKey,
  type PayrollFloorRecordLike,
} from './payrollOperatingFloor';

/**
 * Cifras REALES de `tress.Nomina` (db_Artefactos, carga 2026-09-09), medidas con
 * la MISMA clasificación que aplica `refineCashTreatment`:
 *
 *   bruto        = Percepción (menos vales/provisión/informativo) + las
 *                  Prestaciones promovidas (indemnización, gratificación por
 *                  separación, prima de antigüedad).
 *   aportaciones = Obligación Empresa menos retenciones (ISR/ISPT/IMSS obrero),
 *                  menos informativo (exento/gravado/provisión/salario diario)
 *                  y menos `FONDO AHORRO EMPRESA` (se devenga aquí y se paga
 *                  como `LIQ TOTAL FA` en Percepción — doble conteo).
 *
 * Las cifras EXCLUYEN la cía 33 (MULTICARGA), que Midas no jala: no está en
 * `NOMINA_FANOUT_EMPRESAS` y `dropExcludedByCia` la corta en `fetchNomina`.
 * Son, por tanto, lo que el store debe sostener — no el total de la tabla.
 *
 * Septiembre está EN CURSO al 2026-09-09: 9 días. Es la razón por la que el mes
 * en curso no puede ser el piso.
 */
const REAL_MONTHLY: Array<{ month: string; bruto: number; aportaciones: number; fondoAhorro: number }> = [
  { month: '2026-06', bruto: 44_819_033.10, aportaciones: 26_180_086.35, fondoAhorro: 1_477_412.35 },
  { month: '2026-07', bruto: 53_640_419.91, aportaciones: 34_651_886.27, fondoAhorro: 1_591_563.89 },
  { month: '2026-08', bruto: 54_214_007.89, aportaciones: 32_589_567.36, fondoAhorro: 1_480_600.88 },
  { month: '2026-09', bruto: 17_530_645.44, aportaciones: 9_757_409.91, fondoAhorro: 296_232.72 },
];

/** Piso = bruto + aportaciones. Ago-2026 (último mes cerrado) = $86,803,575.25. */
const AGO_FLOOR = 54_214_007.89 + 32_589_567.36;
const JUL_FLOOR = 53_640_419.91 + 34_651_886.27;

function recordsForMonth(m: typeof REAL_MONTHLY[number]): PayrollFloorRecordLike[] {
  const out: PayrollFloorRecordLike[] = [];
  const year = Number(m.month.slice(0, 4));
  const month = Number(m.month.slice(5, 7));
  const push = (amount: number, cashTreatment: string, conceptName: string, n: number) => {
    for (let i = 0; i < n; i++) {
      out.push({
        paymentDate: `${m.month}-${String((i % 28) + 1).padStart(2, '0')}`,
        year, month, amount: amount / n, cashTreatment, conceptName,
      });
    }
  };
  push(m.bruto, 'CASH_OUT', 'SUELDO ORDINARIO', 250);
  push(m.aportaciones, 'EMPLOYER_TAX', 'IMSS PATRONAL', 80);
  // Devengado que se paga como LIQ TOTAL FA en Percepción: NO es piso.
  push(m.fondoAhorro, 'EMPLOYER_TAX', 'FONDO AHORRO EMPRESA', 15);
  // Ya viven DENTRO del bruto: sumarlas sería doble conteo.
  out.push({ paymentDate: `${m.month}-15`, year, month, amount: 30_000_000, cashTreatment: 'DEDUCTION', conceptName: 'PRESTAMO' });
  out.push({ paymentDate: `${m.month}-15`, year, month, amount: 9_000_000, cashTreatment: 'WITHHOLDING_PAYABLE', conceptName: 'ISR' });
  out.push({ paymentDate: `${m.month}-15`, year, month, amount: 8_000_000, cashTreatment: 'NON_CASH', conceptName: 'EXENTO DE AGUINALDO' });
  return out;
}

const REAL_RECORDS = REAL_MONTHLY.flatMap(recordsForMonth);

describe('payrollMonthKey', () => {
  it('usa la fecha de pago, que es cuando sale el dinero', () => {
    expect(payrollMonthKey({
      paymentDate: '2026-08-31', periodEndDate: '2026-07-31', year: 2026, month: 7,
      amount: 1, cashTreatment: 'CASH_OUT',
    })).toBe('2026-08');
  });

  it('cae a fin de periodo, luego a year/month, luego al periodo solicitado', () => {
    const base = { amount: 1, cashTreatment: 'CASH_OUT' };
    expect(payrollMonthKey({ ...base, periodEndDate: '2026-08-31', year: 0, month: 0 })).toBe('2026-08');
    expect(payrollMonthKey({ ...base, year: 2026, month: 3 })).toBe('2026-03');
    expect(payrollMonthKey({ ...base, year: 0, month: 0, sourcePeriod: '2026-05' })).toBe('2026-05');
    expect(payrollMonthKey({ ...base, year: 0, month: 0 })).toBeNull();
  });
});

describe('computePayrollMonthlyFloor', () => {
  it('devuelve el efectivo REAL del último mes completo: bruto + aportaciones', () => {
    const r = computePayrollMonthlyFloor(REAL_RECORDS, { todayIso: '2026-09-09' });
    expect(r.monthUsed).toBe('2026-08');
    expect(r.monthly).toBeCloseTo(AGO_FLOOR, 2); // $90,141,699.14
  });

  it('las aportaciones patronales SON piso: el bruto solo subreportaba 37%', () => {
    const r = computePayrollMonthlyFloor(REAL_RECORDS, { todayIso: '2026-09-09' });
    expect(r.monthly!).toBeGreaterThan(54_214_007.89); // el bruto de ago
    expect(r.monthly! - 54_214_007.89).toBeCloseTo(32_589_567.36, 2);
  });

  it('NO suma deducciones ni retenciones: ya viven dentro del bruto', () => {
    // Cada mes lleva $39M de ruido DEDUCTION + WITHHOLDING_PAYABLE.
    const r = computePayrollMonthlyFloor(REAL_RECORDS, { todayIso: '2026-09-09' });
    expect(r.monthly).toBeCloseTo(AGO_FLOOR, 2);
  });

  it('NO suma el fondo de ahorro devengado: se paga como LIQ TOTAL FA', () => {
    // $1.48M/mes bajo Obligación Empresa cuyo desembolso ya está en Percepción.
    const r = computePayrollMonthlyFloor(REAL_RECORDS, { todayIso: '2026-09-09' });
    expect(r.monthly).toBeCloseTo(AGO_FLOOR, 2);
    expect(r.monthly).not.toBeCloseTo(AGO_FLOOR + 1_480_600.88, 2);
  });

  it('no toma el mes EN CURSO: septiembre lleva 9 días', () => {
    const r = computePayrollMonthlyFloor(REAL_RECORDS, { todayIso: '2026-09-09' });
    expect(r.monthUsed).not.toBe('2026-09');
    expect(r.byMonth[0]!.month).toBe('2026-09');
    expect(r.byMonth[0]!.amount).toBeCloseTo(17_530_645.44 + 9_757_409.91, 2);
    expect(r.byMonth[0]!.gross).toBeCloseTo(17_530_645.44, 2);
    expect(r.byMonth[0]!.employerTax).toBeCloseTo(9_757_409.91, 2);
  });

  it('REGRESIÓN: dos filas futuras de $18k ya no pueden mover el piso', () => {
    // El 2026-09-09 TRESS cargó 2 percepciones con FechaPago 2026-09-24. Con la
    // ventana de 4 semanas eso desplazaba una semana real y tiraba el piso 27%.
    const conFuturo: PayrollFloorRecordLike[] = [
      ...REAL_RECORDS,
      { paymentDate: '2026-09-24', year: 2026, month: 9, amount: 18_003.98, cashTreatment: 'CASH_OUT', conceptName: 'SUELDO ORDINARIO' },
    ];
    const r = computePayrollMonthlyFloor(conFuturo, { todayIso: '2026-09-09' });
    expect(r.monthUsed).toBe('2026-08');
    expect(r.monthly).toBeCloseTo(AGO_FLOOR, 2);
  });

  it('REGRESIÓN: un evento anual no distorsiona los meses vecinos', () => {
    // $10.7M de liquidación de fondo de ahorro cayeron el 2026-08-03. Con la
    // ventana móvil inflaban el piso 4 semanas seguidas; ahora viven en su mes.
    const r = computePayrollMonthlyFloor(REAL_RECORDS, { todayIso: '2026-08-20' });
    expect(r.monthUsed).toBe('2026-07');
    expect(r.monthly).toBeCloseTo(JUL_FLOOR, 2);
  });

  it('expone el desglose por mes, más reciente primero', () => {
    const r = computePayrollMonthlyFloor(REAL_RECORDS, { todayIso: '2026-09-09' });
    expect(r.byMonth.map(m => m.month)).toEqual(['2026-09', '2026-08', '2026-07', '2026-06']);
  });

  it('sin mes completo devuelve undefined, nunca 0', () => {
    const soloEnCurso = recordsForMonth(REAL_MONTHLY[3]!);
    const r = computePayrollMonthlyFloor(soloEnCurso, { todayIso: '2026-09-09' });
    expect(r.monthly).toBeUndefined();
    expect(r.byMonth).toHaveLength(1);
  });

  it('sin registros devuelve undefined', () => {
    expect(computePayrollMonthlyFloor([], { todayIso: '2026-09-09' }).monthly).toBeUndefined();
  });

  it('respeta el filtro por cía', () => {
    const recs: PayrollFloorRecordLike[] = [
      { cia: '00001', paymentDate: '2026-08-10', year: 2026, month: 8, amount: 800_000, cashTreatment: 'CASH_OUT' },
      { cia: '00001', paymentDate: '2026-08-10', year: 2026, month: 8, amount: 200_000, cashTreatment: 'EMPLOYER_TAX' },
      { cia: '00011', paymentDate: '2026-08-10', year: 2026, month: 8, amount: 6_000_000, cashTreatment: 'CASH_OUT' },
      { cia: '00011', paymentDate: '2026-08-10', year: 2026, month: 8, amount: 3_000_000, cashTreatment: 'EMPLOYER_TAX' },
    ];
    expect(computePayrollMonthlyFloor(recs, { todayIso: '2026-09-09', ciaFilter: '00001' }).monthly)
      .toBeCloseTo(1_000_000, 2);
    expect(computePayrollMonthlyFloor(recs, { todayIso: '2026-09-09' }).monthly)
      .toBeCloseTo(10_000_000, 2);
  });
});

describe('mes truncado por el gateway (>1MB corta las aportaciones)', () => {
  /** Ago-2026 tal cual, pero SIN el bloque de Obligación Empresa. */
  const agoTruncado = () => [
    ...recordsForMonth(REAL_MONTHLY[0]!), // jun completo
    ...recordsForMonth(REAL_MONTHLY[1]!), // jul completo
    ...recordsForMonth({ ...REAL_MONTHLY[2]!, aportaciones: 0, fondoAhorro: 0 }),
  ];

  it('NO reporta el mes truncado: caería 37% sin decirlo', () => {
    const r = computePayrollMonthlyFloor(agoTruncado(), { todayIso: '2026-09-09' });
    expect(r.monthUsed).toBe('2026-07');
    expect(r.monthly).toBeCloseTo(JUL_FLOOR, 2);
    expect(r.monthly).not.toBeCloseTo(54_214_007.89, 2); // el bruto solo de ago
  });

  it('lo confiesa en skippedTruncated y lo deja visible en byMonth', () => {
    const r = computePayrollMonthlyFloor(agoTruncado(), { todayIso: '2026-09-09' });
    expect(r.skippedTruncated).toEqual(['2026-08']);
    expect(r.byMonth.find(m => m.month === '2026-08')).toMatchObject({
      truncated: true, employerTax: 0,
    });
  });

  it('un mes completo NUNCA se marca truncado', () => {
    const r = computePayrollMonthlyFloor(REAL_RECORDS, { todayIso: '2026-09-09' });
    expect(r.skippedTruncated).toEqual([]);
    expect(r.byMonth.every(m => !m.truncated)).toBe(true);
  });

  it('si TODOS los meses cerrados están truncados devuelve undefined, no un piso corto', () => {
    const todosTruncados = REAL_MONTHLY.map(m => ({ ...m, aportaciones: 0, fondoAhorro: 0 }))
      .flatMap(recordsForMonth);
    const r = computePayrollMonthlyFloor(todosTruncados, { todayIso: '2026-09-09' });
    expect(r.monthly).toBeUndefined();
    expect(r.skippedTruncated).toEqual(['2026-08', '2026-07', '2026-06']);
  });
});

describe('isAccruedNotDisbursed', () => {
  it('marca el fondo de ahorro de la EMPRESA, en sus dos grafías', () => {
    for (const conceptName of ['FONDO AHORRO EMPRESA', 'FONDO DE AHORRO EMPRESA']) {
      expect(isAccruedNotDisbursed({ conceptName, amount: 1, cashTreatment: 'EMPLOYER_TAX', year: 2026, month: 8 })).toBe(true);
    }
  });

  it('NO marca el fondo de ahorro del EMPLEADO ni otras aportaciones', () => {
    const cases = ['FONDO DE AHORRO', 'IMSS PATRONAL', 'INFONAVIT 5%', 'RETIRO, CESANTIA Y VEJEZ'];
    for (const conceptName of cases) {
      expect(isAccruedNotDisbursed({ conceptName, amount: 1, cashTreatment: 'EMPLOYER_TAX', year: 2026, month: 8 })).toBe(false);
    }
  });

  it('sólo aplica a EMPLOYER_TAX: la LIQUIDACIÓN en Percepción SÍ es piso', () => {
    expect(isAccruedNotDisbursed({
      conceptName: 'LIQ TOTAL FA EMP', amount: 1, cashTreatment: 'CASH_OUT', year: 2026, month: 8,
    })).toBe(false);
  });
});

describe('truncamiento PARCIAL: falta el bloque de UNA cía, no del mes entero', () => {
  // El fetch se trocea por empresa y tipo (`nominaLacksEmployerTax`), así que el
  // corte del gateway es parcial por naturaleza: es MÁS probable que se pierdan
  // las aportaciones de la cía más grande que las de todas a la vez. Medido en
  // `tress.Nomina` jun–ago 2026 (sin la cía 33): cero combinaciones
  // (mes, cía, tipo) con percepciones y sin aportaciones — así que un grupo en
  // esa forma es truncamiento, no un mes legítimamente sin aportación patronal.
  const sano = (month: string, cia: string, bruto: number, aport: number): PayrollFloorRecordLike[] => [
    { paymentDate: `${month}-15`, cia, payrollType: 'Semanal', year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)), amount: bruto, cashTreatment: 'CASH_OUT', conceptName: 'SUELDO' },
    { paymentDate: `${month}-15`, cia, payrollType: 'Semanal', year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)), amount: aport, cashTreatment: 'EMPLOYER_TAX', conceptName: 'IMSS PATRONAL' },
  ];
  const soloBruto = (month: string, cia: string, bruto: number): PayrollFloorRecordLike[] => [
    { paymentDate: `${month}-15`, cia, payrollType: 'Semanal', year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)), amount: bruto, cashTreatment: 'CASH_OUT', conceptName: 'SUELDO' },
  ];

  it('descarta el mes cuando a UNA cía le faltan sus aportaciones, aunque el total del mes traiga', () => {
    const res = computePayrollMonthlyFloor(
      [
        // Ago: la cía 00011 (el chunk más grande, ~$25M de aportaciones) perdió
        // su bloque. El employerTax AGREGADO del mes sale > 0 por la cía 00001.
        ...sano('2026-08', '00001', 12_700_000, 10_351_707),
        ...soloBruto('2026-08', '00011', 20_494_567),
        ...sano('2026-07', '00001', 12_875_971, 10_048_784),
        ...sano('2026-07', '00011', 21_523_799, 26_510_806),
      ],
      { todayIso: '2026-09-09' },
    );
    expect(res.monthUsed).toBe('2026-07');
    expect(res.monthly).toBeCloseTo(12_875_971 + 10_048_784 + 21_523_799 + 26_510_806, 2);
    expect(res.skippedTruncated).toEqual(['2026-08']);
    const ago = res.byMonth.find((m) => m.month === '2026-08')!;
    expect(ago.truncated).toBe(true);
    expect(ago.truncatedGroups).toEqual(['00011 · Semanal']);
  });

  it('un mes con TODAS las cías completas no se descarta y no reporta grupos', () => {
    const res = computePayrollMonthlyFloor(
      [...sano('2026-08', '00001', 12_700_000, 10_351_707), ...sano('2026-08', '00011', 20_494_567, 24_768_541)],
      { todayIso: '2026-09-09' },
    );
    expect(res.monthUsed).toBe('2026-08');
    expect(res.skippedTruncated).toEqual([]);
    expect(res.byMonth[0].truncatedGroups).toEqual([]);
  });

  it('el truncamiento se evalúa por TIPO además de por cía (el troceo es por los dos)', () => {
    const quincenal = (month: string, cia: string, bruto: number): PayrollFloorRecordLike[] => [
      { paymentDate: `${month}-15`, cia, payrollType: 'Quincenal', year: 2026, month: 8, amount: bruto, cashTreatment: 'CASH_OUT', conceptName: 'SUELDO' },
    ];
    const res = computePayrollMonthlyFloor(
      [...sano('2026-08', '00001', 12_700_000, 10_351_707), ...quincenal('2026-08', '00001', 3_000_000)],
      { todayIso: '2026-09-09' },
    );
    expect(res.byMonth[0].truncatedGroups).toEqual(['00001 · Quincenal']);
    expect(res.monthUsed).toBeUndefined();
  });
});

describe('payrollMonthKey — fecha en formato no-ISO cae al fallback year/month', () => {
  // `trimIsoDate` (el mapper) recorta a 10 chars SIN validar formato. Sin la
  // validación, `'2026/08/15'.slice(0,7)` = `'2026/08'`: una llave que no empata
  // con ninguna otra fila del mes y que ordena por ENCIMA del mes en curso
  // (`'/'` 47 > `'-'` 45), así que el filtro de meses cerrados la excluye para
  // siempre — el monto desaparece del piso sin aparecer en `skippedTruncated`.
  const base = { amount: 1_000, cashTreatment: 'CASH_OUT', conceptName: 'SUELDO', year: 2026, month: 8 };

  it('usa year/month cuando la fecha no es ISO', () => {
    expect(payrollMonthKey({ ...base, paymentDate: '2026/08/15' })).toBe('2026-08');
    expect(payrollMonthKey({ ...base, paymentDate: '15-08-2026' })).toBe('2026-08');
  });

  it('el monto de esa fila sigue contando en el piso de su mes real', () => {
    const res = computePayrollMonthlyFloor(
      [
        { paymentDate: '2026-08-15', cia: '00001', payrollType: 'Semanal', year: 2026, month: 8, amount: 1_000_000, cashTreatment: 'CASH_OUT', conceptName: 'SUELDO' },
        { paymentDate: '2026/08/20', cia: '00001', payrollType: 'Semanal', year: 2026, month: 8, amount: 500_000, cashTreatment: 'CASH_OUT', conceptName: 'SUELDO' },
        { paymentDate: '2026-08-15', cia: '00001', payrollType: 'Semanal', year: 2026, month: 8, amount: 800_000, cashTreatment: 'EMPLOYER_TAX', conceptName: 'IMSS PATRONAL' },
      ],
      { todayIso: '2026-09-09' },
    );
    expect(res.monthUsed).toBe('2026-08');
    expect(res.monthly).toBe(2_300_000);
    expect(res.byMonth).toHaveLength(1);
  });

  it('passthrough para el formato real de la fuente (ISO): sin cambio', () => {
    expect(payrollMonthKey({ ...base, paymentDate: '2026-08-15' })).toBe('2026-08');
    expect(payrollMonthKey({ ...base, paymentDate: '2026-08-15T12:00:00.000Z' })).toBe('2026-08');
    expect(payrollMonthKey({ ...base, paymentDate: '2026-08' })).toBe('2026-08');
  });
});
