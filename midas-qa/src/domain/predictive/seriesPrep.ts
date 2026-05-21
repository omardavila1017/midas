// ─────────────────────────────────────────────────────────────────────────
// seriesPrep — extrae series temporales históricas (ingresos y egresos)
// desde los estados de cuenta bancarios. Filtra transferencias internas
// usando el mismo clasificador que el Dashboard (`classifyMovement`) para
// que las series coincidan byte-a-byte con `buildHistoricalMonths`.
//
// Output: dos series cronológicas (monthly y daily) por tipo.
// ─────────────────────────────────────────────────────────────────────────

import type { BankAccountStatement } from '../../services/jde';
import {
  buildOwnAccountDetector,
  buildOwnAccountsIndex,
  buildPairMatchedKeys,
  classifyMovement,
} from '../netCashFlowEngine';
import { toYearMonth, addMonths, compareYearMonth } from '../cashFlowEngine';

export interface SeriesPoint {
  /** YYYY-MM para monthly, YYYY-MM-DD para daily. */
  key: string;
  value: number;
}

export interface ExtractedSeries {
  monthlyIncome: SeriesPoint[];
  monthlyExpense: SeriesPoint[];
  dailyIncome: SeriesPoint[];
  dailyExpense: SeriesPoint[];
  firstYearMonth?: string;
  lastYearMonth?: string;
}

export interface ExtractOpts {
  companyCode?: string;
  /** Si se da, recorta serie a histórico anterior a este día (exclusivo). */
  asOfDate?: string;
}

/**
 * Devuelve series chronological. Mensual usa todos los meses cerrados +
 * el mes en curso (parcial, no relleno). El caller decide si entrenar
 * sobre meses cerrados solamente.
 */
export function extractHistoricalSeries(
  statements: BankAccountStatement[],
  opts: ExtractOpts = {},
): ExtractedSeries {
  if (statements.length === 0) {
    return { monthlyIncome: [], monthlyExpense: [], dailyIncome: [], dailyExpense: [] };
  }
  const { companyCode, asOfDate } = opts;
  const filtered = !companyCode || companyCode === 'all'
    ? statements
    : statements.filter((s) => s.cia === companyCode);

  const ctx = {
    ownAccountDetector: buildOwnAccountDetector(buildOwnAccountsIndex(filtered)),
    pairedKeys: buildPairMatchedKeys(filtered),
  };

  const monthly = new Map<string, { income: number; expense: number }>();
  const daily = new Map<string, { income: number; expense: number }>();
  let firstYm: string | undefined;
  let lastYm: string | undefined;

  for (const acc of filtered) {
    for (const mov of acc.movimientos) {
      const date = mov.fechaOperacion;
      if (!date || date.length < 10) continue;
      if (asOfDate && date > asOfDate) continue;
      if (classifyMovement(mov, ctx, acc.cia, acc.cuenta).kind === 'internal') continue;

      const ym = toYearMonth(date);
      if (!firstYm || compareYearMonth(ym, firstYm) < 0) firstYm = ym;
      if (!lastYm || compareYearMonth(ym, lastYm) > 0) lastYm = ym;

      const mBucket = monthly.get(ym) ?? { income: 0, expense: 0 };
      const dBucket = daily.get(date) ?? { income: 0, expense: 0 };

      if (mov.tipoMovimiento === 'ABONO') {
        mBucket.income += mov.importe;
        dBucket.income += mov.importe;
      } else if (mov.tipoMovimiento === 'CARGO') {
        mBucket.expense += mov.importe;
        dBucket.expense += mov.importe;
      }
      monthly.set(ym, mBucket);
      daily.set(date, dBucket);
    }
  }

  const monthlyIncome: SeriesPoint[] = [];
  const monthlyExpense: SeriesPoint[] = [];

  // Rellenamos huecos: si entre el primer y último mes hay meses sin
  // ningún movimiento, los emitimos en cero para no romper la serie
  // temporal (los modelos asumen cadencia constante).
  if (firstYm && lastYm) {
    let cursor = firstYm;
    while (compareYearMonth(cursor, lastYm) <= 0) {
      const bucket = monthly.get(cursor) ?? { income: 0, expense: 0 };
      monthlyIncome.push({ key: cursor, value: bucket.income });
      monthlyExpense.push({ key: cursor, value: bucket.expense });
      cursor = addMonths(cursor, 1);
    }
  }

  const dailyKeys = Array.from(daily.keys()).sort();
  const dailyIncome: SeriesPoint[] = dailyKeys.map((k) => ({ key: k, value: daily.get(k)!.income }));
  const dailyExpense: SeriesPoint[] = dailyKeys.map((k) => ({ key: k, value: daily.get(k)!.expense }));

  return {
    monthlyIncome,
    monthlyExpense,
    dailyIncome,
    dailyExpense,
    firstYearMonth: firstYm,
    lastYearMonth: lastYm,
  };
}

/**
 * Determina cuántos meses cerrados (excluyendo el actual) hay en la serie.
 * Útil para elegir modelo según disponibilidad.
 */
export function closedMonthsCount(series: SeriesPoint[], asOfDate: string): number {
  const currentYm = toYearMonth(asOfDate);
  return series.filter((p) => compareYearMonth(p.key, currentYm) < 0).length;
}

/**
 * Recorta la serie a sólo meses cerrados (estricto). Conserva orden.
 */
export function closedMonthsOnly(series: SeriesPoint[], asOfDate: string): SeriesPoint[] {
  const currentYm = toYearMonth(asOfDate);
  return series.filter((p) => compareYearMonth(p.key, currentYm) < 0);
}

/**
 * Suma ingresos/egresos reales del mes en curso hasta la fecha de corte.
 * Devuelve los acumulados parciales — el predictor usa esto para componer
 * el bucket parcial: real-a-la-fecha + predicción del resto.
 */
export function partialCurrentMonth(
  daily: SeriesPoint[],
  asOfDate: string,
): { income: number; expense: number } {
  // El caller pasa la serie de income o de expense; este helper sólo suma
  // valores ≤ asOfDate del mes actual.
  const currentYm = toYearMonth(asOfDate);
  let total = 0;
  for (const p of daily) {
    if (toYearMonth(p.key) !== currentYm) continue;
    if (p.key > asOfDate) continue;
    total += p.value;
  }
  return { income: total, expense: total }; // misma estructura — caller usa uno
}

/**
 * Construye perfil de día-del-mes (1..31) normalizado: porcentaje promedio
 * del flujo mensual que ocurre cada día. Útil para distribuir el forecast
 * mensual en buckets diarios respetando la cadencia real observada.
 *
 * Si el día N tiene 0 ocurrencias históricas en al menos un mes, se
 * estima como uniforme (1/N) para no producir ceros artificiales.
 */
export function dayOfMonthProfile(daily: SeriesPoint[]): number[] {
  const profile = new Array(31).fill(0);
  const monthlyTotals = new Map<string, number>();

  for (const p of daily) {
    const ym = toYearMonth(p.key);
    monthlyTotals.set(ym, (monthlyTotals.get(ym) ?? 0) + p.value);
  }

  for (const p of daily) {
    const day = Number(p.key.slice(8, 10));
    if (!day) continue;
    const monthTotal = monthlyTotals.get(toYearMonth(p.key)) ?? 0;
    if (monthTotal <= 0) continue;
    profile[day - 1] += p.value / monthTotal;
  }

  const monthCount = monthlyTotals.size || 1;
  // Promedio del peso de cada día sobre todos los meses observados.
  for (let i = 0; i < 31; i++) profile[i] /= monthCount;

  // Normaliza por si los días observados no cubren los 31 — el caller
  // espera que la suma de los días reales de un mes ≈ 1.
  const sum = profile.reduce((s, v) => s + v, 0);
  if (sum > 0) {
    for (let i = 0; i < 31; i++) profile[i] /= sum;
  } else {
    // Sin datos → uniforme sobre 30 días (aproximación segura).
    for (let i = 0; i < 30; i++) profile[i] = 1 / 30;
    profile[30] = 0;
  }
  return profile;
}
