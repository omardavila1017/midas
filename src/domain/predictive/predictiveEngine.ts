// ─────────────────────────────────────────────────────────────────────────
// predictiveEngine — motor de predicción de ingresos/egresos. Toma el
// histórico real validado en banco (cobranza y pagos matcheados) y
// extrapola a 12 meses con bandas de incertidumbre que crecen con el
// horizonte.
//
// Output:
//   - PredictiveForecastResult con buckets daily/weekly/monthly/annual,
//     cada uno con expected + stdDev + CI 80% + CI 95%.
//   - PredictiveOverlays separadas (OCs futuras, CXC abierta) que se
//     muestran como tooltip/desglose pero NO se suman a `expected`
//     porque el modelo ya las cubre implícitamente (entrenado sobre
//     todos los pagos bancarios, que incluyen OCs históricas).
//
// Estrategia de modelo (tiered, según meses cerrados disponibles):
//   - ≥24 mo: Holt-Winters aditivo con estacionalidad m=12
//   - 12–23 mo: Holt (sin estacionalidad)
//   - 6–11 mo: Single exponential smoothing
//   - <6 mo: Naive media (últimos 3 meses)
//
// Bandas: stdDev base = RMSE residuales del fit. Para horizonte h pasos
// adelante, stdDev(h) ≈ RMSE * √h (random-walk assumption). Conservador
// pero defendible sin justificar derivaciones complejas.
// ─────────────────────────────────────────────────────────────────────────

import type { BankAccountStatement } from '../../services/jde';
import type { CobranzaRecord } from '../../services/jdeTypes';
import type { PurchaseReceiptRecord } from '../../modules/shared-finance/types';
import { toYearMonth, addMonths, compareYearMonth, lastDayOfMonth } from '../cashFlowEngine';
import {
  holtLinear,
  holtWintersAdditive,
  naiveMean,
  singleExpSmoothing,
  type ModelOutput,
} from './holtWinters';
import {
  closedMonthsOnly,
  dayOfMonthProfile,
  extractHistoricalSeries,
  type SeriesPoint,
} from './seriesPrep';
import type {
  ModelKind,
  OverlayPoint,
  PredictionPoint,
  PredictiveForecastResult,
  PredictiveOverlays,
  PredictiveSeries,
  PredictiveSeriesMeta,
} from './types';

const Z_80 = 1.2816;
const Z_95 = 1.96;

export interface BuildPredictiveInput {
  bankStatements: BankAccountStatement[];
  companyCode: string;
  asOfDate: string;
  /** Número de meses futuros a proyectar (default 12). */
  horizonMonths?: number;
  /** OCs (compras programadas) para overlay informativo. */
  purchaseReceipts?: PurchaseReceiptRecord[];
  /** CXC abierta (facturas por cobrar) para overlay informativo. */
  cobranzaRecords?: CobranzaRecord[];
}

export interface BuildPredictiveResult extends PredictiveForecastResult {
  overlays: PredictiveOverlays;
}

export function buildPredictiveForecast(
  input: BuildPredictiveInput,
): BuildPredictiveResult {
  const horizonMonths = input.horizonMonths ?? 12;
  const asOfDate = input.asOfDate;
  const series = extractHistoricalSeries(input.bankStatements, {
    companyCode: input.companyCode,
    asOfDate,
  });

  const incomeMonthly = closedMonthsOnly(series.monthlyIncome, asOfDate);
  const expenseMonthly = closedMonthsOnly(series.monthlyExpense, asOfDate);

  const incomePartial = sumPartialMonth(series.dailyIncome, asOfDate);
  const expensePartial = sumPartialMonth(series.dailyExpense, asOfDate);

  const incomeForecast = forecastSeries(incomeMonthly, asOfDate, horizonMonths);
  const expenseForecast = forecastSeries(expenseMonthly, asOfDate, horizonMonths);

  const incomeDayProfile = dayOfMonthProfile(series.dailyIncome);
  const expenseDayProfile = dayOfMonthProfile(series.dailyExpense);

  const income = composePredictiveSeries({
    historyMonthly: series.monthlyIncome,
    forecastMonthlyValues: incomeForecast.monthlyValues,
    forecastMonthlyStdDev: incomeForecast.monthlyStdDev,
    forecastMonthlyDates: incomeForecast.monthlyDates,
    dayProfile: incomeDayProfile,
    asOfDate,
    partialToDate: incomePartial,
    horizonMonths,
  });

  const expense = composePredictiveSeries({
    historyMonthly: series.monthlyExpense,
    forecastMonthlyValues: expenseForecast.monthlyValues,
    forecastMonthlyStdDev: expenseForecast.monthlyStdDev,
    forecastMonthlyDates: expenseForecast.monthlyDates,
    dayProfile: expenseDayProfile,
    asOfDate,
    partialToDate: expensePartial,
    horizonMonths,
  });

  const net = subtractSeries(income, expense);

  const overlays: PredictiveOverlays = {
    futureOCs: buildOcOverlay(input.purchaseReceipts ?? [], input.companyCode, asOfDate, horizonMonths),
    openCXC: buildCxcOverlay(input.cobranzaRecords ?? [], input.companyCode, asOfDate, horizonMonths),
  };

  return {
    income,
    expense,
    net,
    asOfDate,
    horizonMonths,
    metadata: {
      income: buildMeta(incomeMonthly, incomeForecast),
      expense: buildMeta(expenseMonthly, expenseForecast),
    },
    overlays,
  };
}

// ── Forecast per series ──────────────────────────────────────────────────

interface SeriesForecast {
  monthlyValues: number[];
  monthlyStdDev: number[];
  monthlyDates: string[];
  model: ModelKind;
  fit: ModelOutput | null;
  lastObservedYm?: string;
}

function forecastSeries(
  monthly: SeriesPoint[],
  asOfDate: string,
  horizonMonths: number,
): SeriesForecast {
  const dates: string[] = [];
  let cursor = toYearMonth(asOfDate);
  for (let i = 0; i < horizonMonths; i++) {
    dates.push(cursor);
    cursor = addMonths(cursor, 1);
  }

  if (monthly.length === 0) {
    return {
      monthlyValues: new Array(horizonMonths).fill(0),
      monthlyStdDev: new Array(horizonMonths).fill(0),
      monthlyDates: dates,
      model: 'empty',
      fit: null,
    };
  }

  const values = monthly.map((p) => p.value);
  const lastObserved = monthly[monthly.length - 1].key;
  const model = chooseModel(values.length);
  const fit = fitModel(model, values, horizonMonths);

  // Las predicciones del modelo arrancan en el mes posterior al último
  // observado. Mapear esas predicciones contra `dates` (que arranca en el
  // mes en curso) requiere alinear: si el último observado es M-1 y el
  // mes en curso es M, fit.forecast[0] corresponde a M.
  const monthsBetween = diffMonths(lastObserved, dates[0]);
  // fit.forecast[k] corresponde a mes (lastObserved + k+1)
  // queremos values para mes (dates[i]) = lastObserved + (monthsBetween + i)
  // → índice forecast = monthsBetween + i - 1
  const monthlyValues: number[] = [];
  const monthlyStdDev: number[] = [];
  for (let i = 0; i < horizonMonths; i++) {
    const forecastIdx = monthsBetween + i - 1;
    const stepsAhead = forecastIdx + 1;
    if (forecastIdx >= 0 && forecastIdx < fit.forecast.length) {
      monthlyValues.push(Math.max(0, fit.forecast[forecastIdx]));
      monthlyStdDev.push(fit.rmse * Math.sqrt(Math.max(1, stepsAhead)));
    } else if (forecastIdx < 0) {
      // Posición histórica — usa fitted (no debería pasar si dates arranca en mes actual)
      const histIdx = monthly.length + forecastIdx;
      const v = histIdx >= 0 && histIdx < fit.fitted.length ? fit.fitted[histIdx] : 0;
      monthlyValues.push(Math.max(0, v));
      monthlyStdDev.push(0);
    } else {
      // Fuera del horizonte del fit: extrapola con último valor y stdDev creciente
      const lastVal = fit.forecast[fit.forecast.length - 1] ?? 0;
      monthlyValues.push(Math.max(0, lastVal));
      monthlyStdDev.push(fit.rmse * Math.sqrt(Math.max(1, stepsAhead)));
    }
  }

  // Re-fit asegurando que `forecast` cubre exactamente los meses pedidos:
  // si dates[0] está más allá de lo que pidió fitModel, refitea.
  const neededHorizon = monthsBetween + horizonMonths;
  if (neededHorizon > fit.forecast.length) {
    const refit = fitModel(model, values, neededHorizon);
    for (let i = 0; i < horizonMonths; i++) {
      const forecastIdx = monthsBetween + i - 1;
      const stepsAhead = forecastIdx + 1;
      if (forecastIdx >= 0 && forecastIdx < refit.forecast.length) {
        monthlyValues[i] = Math.max(0, refit.forecast[forecastIdx]);
        monthlyStdDev[i] = refit.rmse * Math.sqrt(Math.max(1, stepsAhead));
      }
    }
    return {
      monthlyValues,
      monthlyStdDev,
      monthlyDates: dates,
      model,
      fit: refit,
      lastObservedYm: lastObserved,
    };
  }

  return {
    monthlyValues,
    monthlyStdDev,
    monthlyDates: dates,
    model,
    fit,
    lastObservedYm: lastObserved,
  };
}

function chooseModel(historyLength: number): ModelKind {
  if (historyLength === 0) return 'empty';
  if (historyLength >= 24) return 'holt-winters-seasonal';
  if (historyLength >= 12) return 'holt-winters';
  if (historyLength >= 6) return 'exp-smoothing-trend';
  return 'naive-mean';
}

function fitModel(model: ModelKind, values: number[], horizon: number): ModelOutput {
  switch (model) {
    case 'holt-winters-seasonal':
      try {
        return holtWintersAdditive(values, 12, horizon);
      } catch {
        return holtLinear(values, horizon);
      }
    case 'holt-winters':
      try {
        return holtLinear(values, horizon);
      } catch {
        return singleExpSmoothing(values, horizon);
      }
    case 'exp-smoothing-trend':
      try {
        return holtLinear(values, horizon);
      } catch {
        return singleExpSmoothing(values, horizon);
      }
    case 'naive-mean':
      return naiveMean(values, horizon);
    case 'empty':
    default:
      return {
        fitted: [],
        forecast: new Array(horizon).fill(0),
        residuals: [],
        rmse: 0,
        mape: 0,
        params: {},
      };
  }
}

function buildMeta(monthly: SeriesPoint[], forecast: SeriesForecast): PredictiveSeriesMeta {
  return {
    historyMonths: monthly.length,
    model: forecast.model,
    fit: {
      residuals: forecast.fit?.residuals ?? [],
      rmse: forecast.fit?.rmse ?? 0,
      mape: forecast.fit?.mape ?? 0,
      params: forecast.fit?.params,
    },
    lastObservedDate: forecast.lastObservedYm,
  };
}

// ── Compose historical + forecast into PredictiveSeries ──────────────────

interface ComposeArgs {
  historyMonthly: SeriesPoint[];
  forecastMonthlyValues: number[];
  forecastMonthlyStdDev: number[];
  forecastMonthlyDates: string[];
  dayProfile: number[];
  asOfDate: string;
  partialToDate: number;
  horizonMonths: number;
}

function composePredictiveSeries(args: ComposeArgs): PredictiveSeries {
  const monthly = composeMonthly(args);
  const daily = composeDaily(args, monthly);
  const weekly = aggregateWeekly(daily);
  const annual = aggregateAnnual(monthly);
  return { daily, weekly, monthly, annual };
}

function composeMonthly(args: ComposeArgs): PredictionPoint[] {
  const out: PredictionPoint[] = [];
  const currentYm = toYearMonth(args.asOfDate);

  // 1) Histórico cerrado: meses estrictamente anteriores al mes en curso.
  for (const p of args.historyMonthly) {
    if (compareYearMonth(p.key, currentYm) >= 0) continue;
    out.push(makePoint({
      date: `${p.key}-01`,
      bucket: 'monthly',
      expected: p.value,
      stdDev: 0,
      isHistorical: true,
      isPartial: false,
    }));
  }

  // 2) Mes en curso (parcial): real-a-la-fecha + forecast del resto.
  const forecastIdxCurrent = args.forecastMonthlyDates.indexOf(currentYm);
  if (forecastIdxCurrent >= 0) {
    const forecastTotal = args.forecastMonthlyValues[forecastIdxCurrent];
    const forecastStdDev = args.forecastMonthlyStdDev[forecastIdxCurrent];
    // Días restantes vs días pasados afecta la composición:
    // expected = real_to_date + forecast_remainder
    // donde forecast_remainder = forecast_total * (1 - cumProfile(asOfDate.day))
    const dayOfMonth = Number(args.asOfDate.slice(8, 10));
    const cumProfile = sumProfile(args.dayProfile, 0, dayOfMonth);
    const forecastRemainder = forecastTotal * Math.max(0, 1 - cumProfile);
    const expected = args.partialToDate + forecastRemainder;
    // stdDev del bucket parcial: sólo el resto del mes tiene incertidumbre.
    const stdDev = forecastStdDev * Math.max(0, 1 - cumProfile);
    out.push(makePoint({
      date: `${currentYm}-01`,
      bucket: 'monthly',
      expected,
      stdDev,
      isHistorical: true,
      isPartial: true,
      components: {
        historical: args.partialToDate,
        predicted: forecastRemainder,
      },
    }));
  }

  // 3) Meses futuros (después del actual).
  for (let i = 0; i < args.forecastMonthlyDates.length; i++) {
    const ym = args.forecastMonthlyDates[i];
    if (compareYearMonth(ym, currentYm) <= 0) continue;
    out.push(makePoint({
      date: `${ym}-01`,
      bucket: 'monthly',
      expected: args.forecastMonthlyValues[i],
      stdDev: args.forecastMonthlyStdDev[i],
      isHistorical: false,
      isPartial: false,
      components: {
        predicted: args.forecastMonthlyValues[i],
      },
    }));
  }

  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

function composeDaily(args: ComposeArgs, monthly: PredictionPoint[]): PredictionPoint[] {
  const out: PredictionPoint[] = [];
  const currentYm = toYearMonth(args.asOfDate);

  for (const mPoint of monthly) {
    const ym = mPoint.date.slice(0, 7);
    const lastDay = Number(lastDayOfMonth(ym).slice(8, 10));
    // Re-normalizar perfil al número real de días del mes.
    const monthProfile = normalizeProfileForMonth(args.dayProfile, lastDay);

    for (let day = 1; day <= lastDay; day++) {
      const date = `${ym}-${String(day).padStart(2, '0')}`;
      const weight = monthProfile[day - 1];
      const isPast = date <= args.asOfDate;

      if (mPoint.isHistorical && !mPoint.isPartial) {
        // Mes cerrado: día = real. Sin stdDev.
        out.push(makePoint({
          date,
          bucket: 'daily',
          expected: mPoint.expected * weight,
          stdDev: 0,
          isHistorical: true,
          isPartial: false,
        }));
      } else if (mPoint.isPartial) {
        // Mes en curso: días pasados = real (peso x partial accumulated proporcional),
        // días futuros = forecast distribuido.
        if (isPast) {
          const totalToDateWeight = sumProfile(args.dayProfile, 0, Number(args.asOfDate.slice(8, 10)));
          const realPortion = totalToDateWeight > 0
            ? (mPoint.components?.historical ?? 0) * (weight / totalToDateWeight)
            : (mPoint.components?.historical ?? 0) / Math.max(1, Number(args.asOfDate.slice(8, 10)));
          out.push(makePoint({
            date,
            bucket: 'daily',
            expected: realPortion,
            stdDev: 0,
            isHistorical: true,
            isPartial: false,
          }));
        } else {
          const remainderWeight = sumProfile(args.dayProfile, Number(args.asOfDate.slice(8, 10)), lastDay);
          const dayShare = remainderWeight > 0
            ? (mPoint.components?.predicted ?? 0) * (weight / remainderWeight)
            : (mPoint.components?.predicted ?? 0) / Math.max(1, lastDay - Number(args.asOfDate.slice(8, 10)));
          out.push(makePoint({
            date,
            bucket: 'daily',
            expected: dayShare,
            stdDev: mPoint.stdDev * (remainderWeight > 0 ? weight / remainderWeight : 0),
            isHistorical: false,
            isPartial: true,
          }));
        }
      } else {
        // Mes futuro completo.
        out.push(makePoint({
          date,
          bucket: 'daily',
          expected: mPoint.expected * weight,
          stdDev: mPoint.stdDev * weight,
          isHistorical: false,
          isPartial: false,
        }));
      }
    }
    // Suppress unused warning (currentYm used implicitly via mPoint.date)
    void currentYm;
  }

  return out;
}

function aggregateWeekly(daily: PredictionPoint[]): PredictionPoint[] {
  if (daily.length === 0) return [];
  const buckets = new Map<string, { expected: number; variance: number; isHistorical: boolean; isPartial: boolean; date: string }>();
  for (const p of daily) {
    const weekStart = isoWeekStart(p.date);
    const existing = buckets.get(weekStart) ?? {
      expected: 0,
      variance: 0,
      isHistorical: true,
      isPartial: false,
      date: weekStart,
    };
    existing.expected += p.expected;
    existing.variance += p.stdDev * p.stdDev;
    if (!p.isHistorical) existing.isHistorical = false;
    if (p.isPartial) existing.isPartial = true;
    buckets.set(weekStart, existing);
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((b) =>
      makePoint({
        date: b.date,
        bucket: 'weekly',
        expected: b.expected,
        stdDev: Math.sqrt(b.variance),
        isHistorical: b.isHistorical,
        isPartial: b.isPartial,
      }),
    );
}

function aggregateAnnual(monthly: PredictionPoint[]): PredictionPoint[] {
  if (monthly.length === 0) return [];
  const buckets = new Map<string, { expected: number; variance: number; isHistorical: boolean; isPartial: boolean }>();
  for (const p of monthly) {
    const year = p.date.slice(0, 4);
    const existing = buckets.get(year) ?? { expected: 0, variance: 0, isHistorical: true, isPartial: false };
    existing.expected += p.expected;
    existing.variance += p.stdDev * p.stdDev;
    if (!p.isHistorical) existing.isHistorical = false;
    if (p.isPartial) existing.isPartial = true;
    buckets.set(year, existing);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, b]) =>
      makePoint({
        date: `${year}-01-01`,
        bucket: 'annual',
        expected: b.expected,
        stdDev: Math.sqrt(b.variance),
        isHistorical: b.isHistorical,
        isPartial: b.isPartial,
      }),
    );
}

function subtractSeries(a: PredictiveSeries, b: PredictiveSeries): PredictiveSeries {
  return {
    daily: subtractPoints(a.daily, b.daily),
    weekly: subtractPoints(a.weekly, b.weekly),
    monthly: subtractPoints(a.monthly, b.monthly),
    annual: subtractPoints(a.annual, b.annual),
  };
}

function subtractPoints(a: PredictionPoint[], b: PredictionPoint[]): PredictionPoint[] {
  const bMap = new Map(b.map((p) => [p.date, p]));
  const out: PredictionPoint[] = [];
  for (const ap of a) {
    const bp = bMap.get(ap.date);
    if (!bp) {
      out.push({ ...ap, expected: ap.expected });
      continue;
    }
    const expected = ap.expected - bp.expected;
    // Varianza de la diferencia = var(a) + var(b) (asumiendo independencia)
    const variance = ap.stdDev * ap.stdDev + bp.stdDev * bp.stdDev;
    const stdDev = Math.sqrt(variance);
    out.push(makePoint({
      date: ap.date,
      bucket: ap.bucket,
      expected,
      stdDev,
      isHistorical: ap.isHistorical && bp.isHistorical,
      isPartial: ap.isPartial || bp.isPartial,
    }));
  }
  return out;
}

// ── Overlays (OC / CXC) ──────────────────────────────────────────────────

function buildOcOverlay(
  receipts: PurchaseReceiptRecord[],
  companyCode: string,
  asOfDate: string,
  horizonMonths: number,
): OverlayPoint[] {
  const filtered = !companyCode || companyCode === 'all'
    ? receipts
    : receipts.filter((r) => r.cia === companyCode);
  const horizonEnd = addMonths(toYearMonth(asOfDate), horizonMonths - 1);
  const out: OverlayPoint[] = [];
  for (const r of filtered) {
    if (r.isCancelled) continue;
    const date = r.estimatedDueDate ?? r.receiptDate ?? r.orderDate;
    if (!date || date < asOfDate) continue;
    if (toYearMonth(date) > horizonEnd) continue;
    const amount = r.amountMxn > 0 ? r.amountMxn : r.totalAmount;
    if (amount <= 0) continue;
    out.push({
      date: `${toYearMonth(date)}-01`,
      bucket: 'monthly',
      amount,
    });
  }
  return aggregateOverlay(out);
}

function buildCxcOverlay(
  records: CobranzaRecord[],
  companyCode: string,
  asOfDate: string,
  horizonMonths: number,
): OverlayPoint[] {
  const filtered = !companyCode || companyCode === 'all'
    ? records
    : records.filter((r) => r.cia === companyCode);
  const horizonEnd = addMonths(toYearMonth(asOfDate), horizonMonths - 1);
  const out: OverlayPoint[] = [];
  for (const r of filtered) {
    if (r.importePendientePesos <= 0) continue;
    const date = (r.fechaVence && r.fechaVence >= asOfDate)
      ? r.fechaVence
      : asOfDate;
    if (toYearMonth(date) > horizonEnd) continue;
    out.push({
      date: `${toYearMonth(date)}-01`,
      bucket: 'monthly',
      amount: r.importePendientePesos,
    });
  }
  return aggregateOverlay(out);
}

function aggregateOverlay(points: OverlayPoint[]): OverlayPoint[] {
  const byDate = new Map<string, number>();
  for (const p of points) {
    byDate.set(p.date, (byDate.get(p.date) ?? 0) + p.amount);
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, amount]) => ({ date, bucket: 'monthly' as const, amount }));
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makePoint(args: {
  date: string;
  bucket: PredictionPoint['bucket'];
  expected: number;
  stdDev: number;
  isHistorical: boolean;
  isPartial: boolean;
  components?: PredictionPoint['components'];
}): PredictionPoint {
  const stdDev = Math.max(0, args.stdDev);
  return {
    date: args.date,
    bucket: args.bucket,
    expected: args.expected,
    stdDev,
    ci80Low: args.expected - Z_80 * stdDev,
    ci80High: args.expected + Z_80 * stdDev,
    ci95Low: args.expected - Z_95 * stdDev,
    ci95High: args.expected + Z_95 * stdDev,
    isHistorical: args.isHistorical,
    isPartial: args.isPartial,
    components: args.components,
  };
}

function sumPartialMonth(daily: SeriesPoint[], asOfDate: string): number {
  const currentYm = toYearMonth(asOfDate);
  let total = 0;
  for (const p of daily) {
    if (toYearMonth(p.key) !== currentYm) continue;
    if (p.key > asOfDate) continue;
    total += p.value;
  }
  return total;
}

function sumProfile(profile: number[], fromDayExclusive: number, toDayInclusive: number): number {
  let s = 0;
  for (let i = fromDayExclusive; i < toDayInclusive && i < profile.length; i++) {
    s += profile[i];
  }
  return s;
}

function normalizeProfileForMonth(profile: number[], lastDay: number): number[] {
  const slice = profile.slice(0, lastDay);
  const sum = slice.reduce((s, v) => s + v, 0);
  if (sum <= 0) return slice.map(() => 1 / lastDay);
  return slice.map((v) => v / sum);
}

function diffMonths(a: string, b: string): number {
  // a, b son YYYY-MM
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

function isoWeekStart(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay();
  // Lunes como inicio de semana (ISO).
  const offsetToMonday = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + offsetToMonday);
  return date.toISOString().slice(0, 10);
}
