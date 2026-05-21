import type {
  FinancialMovement,
  ForecastRun,
  ModelDiagnostics,
  ProbabilisticBucket,
  ProbabilisticForecastRequest,
  ProbabilisticForecastRun,
  ProbabilisticSummary,
  ProjectionBucket,
  ProjectionGranularity,
} from '../types';
import { bucketKeyForDate, effectiveAmount, effectiveMovementDate } from './financialProjectionEngine';

const DEFAULT_SIMULATIONS = 1200;
const DEFAULT_HORIZON_DAYS = 365;
const MODEL_VERSION = 'prob-v1-arima-ets-mc';

interface DailyBaselineRow {
  date: string;
  label: string;
  inflows: number;
  outflows: number;
  closingCash: number;
}

interface HistoricalStats {
  sampleSize: number;
  inflowVolatility: number;
  outflowVolatility: number;
  netResidualStd: number;
  autocorrelation: number;
  diagnostics: ModelDiagnostics;
}

interface DailySimulationAggregate {
  date: string;
  label: string;
  cash: number[];
  belowZeroCount: number;
  belowMinimumCount: number;
  creditRequired: number[];
}

export function buildProbabilisticForecast(
  request: ProbabilisticForecastRequest,
): ProbabilisticForecastRun {
  const simulations = Math.max(200, Math.round(request.simulations ?? DEFAULT_SIMULATIONS));
  const horizonDays = Math.max(30, Math.round(request.horizonDays ?? DEFAULT_HORIZON_DAYS));
  const dailyBaseline = buildDailyBaseline(request.baseProjection, horizonDays);
  const stats = estimateHistoricalStats(request.baseProjection.movements);
  const seed = request.seed ?? seedFromProjection(request.baseProjection);
  const rng = mulberry32(seed);
  const rows = dailyBaseline.map<DailySimulationAggregate>((row) => ({
    date: row.date,
    label: row.label,
    cash: [],
    belowZeroCount: 0,
    belowMinimumCount: 0,
    creditRequired: [],
  }));
  const terminalCreditRequired: number[] = [];
  let scenariosWithDeficit = 0;
  let scenariosBelowMinimum = 0;

  for (let scenario = 0; scenario < simulations; scenario++) {
    let cash = dailyBaseline[0]?.closingCash
      ? dailyBaseline[0].closingCash - dailyBaseline[0].inflows + dailyBaseline[0].outflows
      : request.baseProjection.buckets[0]?.openingCash ?? request.baseProjection.summary.currentCash;
    let correlatedShock = 0;
    let sawNegative = false;
    let sawBelowMinimum = false;
    let scenarioCreditRequired = 0;

    for (let i = 0; i < dailyBaseline.length; i++) {
      const base = dailyBaseline[i];
      const inflowNoise = relativeShock(rng, stats.inflowVolatility, base.inflows);
      const outflowNoise = relativeShock(rng, stats.outflowVolatility, base.outflows);
      const innovation = gaussian(rng) * stats.netResidualStd;
      correlatedShock = stats.autocorrelation * correlatedShock + innovation;
      const inflows = Math.max(0, base.inflows + inflowNoise);
      const outflows = Math.max(0, base.outflows + outflowNoise);
      cash += inflows - outflows + correlatedShock;

      const deficit = Math.max(0, request.minimumCash - cash);
      const row = rows[i];
      row.cash.push(cash);
      row.creditRequired.push(deficit);
      if (cash < 0) {
        row.belowZeroCount += 1;
        sawNegative = true;
      }
      if (cash < request.minimumCash) {
        row.belowMinimumCount += 1;
        sawBelowMinimum = true;
      }
      scenarioCreditRequired = Math.max(scenarioCreditRequired, deficit);
    }

    if (sawNegative) scenariosWithDeficit += 1;
    if (sawBelowMinimum) scenariosBelowMinimum += 1;
    terminalCreditRequired.push(scenarioCreditRequired);
  }

  const dailyBuckets = rows.map((row) => summarizeDailyRow(row, simulations));
  const buckets = aggregateProbabilisticBuckets(dailyBuckets, request.baseProjection.granularity);
  const summary = summarizeProbabilisticRun({
    buckets,
    simulations,
    scenariosWithDeficit,
    scenariosBelowMinimum,
    terminalCreditRequired,
    diagnostics: stats.diagnostics,
  });

  return {
    id: `${MODEL_VERSION}:${request.baseProjection.id}:${request.baseProjection.granularity}:${seed}:${simulations}`,
    baseForecastId: request.baseProjection.id,
    scenarioId: request.baseProjection.scenarioId,
    granularity: request.baseProjection.granularity,
    startDate: dailyBaseline[0]?.date ?? request.baseProjection.startDate,
    endDate: dailyBaseline[dailyBaseline.length - 1]?.date ?? request.baseProjection.endDate,
    generatedAt: new Date().toISOString(),
    simulations,
    buckets,
    summary,
    diagnostics: stats.diagnostics,
  };
}

export function buildProbabilisticForecastCacheKey(request: ProbabilisticForecastRequest): string {
  const run = request.baseProjection;
  return [
    MODEL_VERSION,
    run.id,
    run.generatedAt,
    run.summary.finalCash,
    run.summary.totalInflows,
    run.summary.totalOutflows,
    run.buckets.length,
    request.minimumCash,
    request.simulations ?? DEFAULT_SIMULATIONS,
    request.seed ?? seedFromProjection(run),
    request.horizonDays ?? DEFAULT_HORIZON_DAYS,
  ].join('|');
}

function buildDailyBaseline(projection: ForecastRun, horizonDays: number): DailyBaselineRow[] {
  const dailyDates = enumerateDates(projection.startDate, addDays(projection.startDate, horizonDays - 1));
  const daily = projection.granularity === 'daily'
    ? new Map(projection.buckets.map((bucket) => [bucket.date, bucket]))
    : distributeBucketsToDays(projection.buckets, projection.granularity);

  let lastClosingCash = projection.buckets[0]?.openingCash ?? projection.summary.currentCash;
  return dailyDates.map((date) => {
    const source = daily.get(date);
    if (source) lastClosingCash = source.closingCash;
    return {
      date,
      label: date.slice(5),
      inflows: source?.inflows ?? 0,
      outflows: source?.outflows ?? 0,
      closingCash: source?.closingCash ?? lastClosingCash,
    };
  });
}

function distributeBucketsToDays(
  buckets: ProjectionBucket[],
  granularity: Exclude<ProjectionGranularity, 'daily'>,
): Map<string, ProjectionBucket> {
  const out = new Map<string, ProjectionBucket>();
  for (const bucket of buckets) {
    const nextBoundary = granularity === 'weekly'
      ? addDays(bucket.date, 6)
      : endOfMonth(bucket.date);
    const dates = enumerateDates(bucket.date, nextBoundary);
    const divisor = Math.max(1, dates.length);
    let rollingCash = bucket.openingCash;
    for (const [index, date] of dates.entries()) {
      const inflows = bucket.inflows / divisor;
      const outflows = bucket.outflows / divisor;
      rollingCash += inflows - outflows;
      out.set(date, {
        ...bucket,
        date,
        label: date.slice(5),
        openingCash: index === 0 ? bucket.openingCash : rollingCash - (inflows - outflows),
        inflows,
        outflows,
        net: inflows - outflows,
        closingCash: index === dates.length - 1 ? bucket.closingCash : rollingCash,
      });
    }
  }
  return out;
}

function estimateHistoricalStats(movements: FinancialMovement[]): HistoricalStats {
  const realMovements = movements.filter((movement) =>
    movement.status === 'REAL'
    || movement.status === 'EXECUTED'
    || movement.sourceSystem === 'BANK'
    || Boolean(movement.actualDate),
  );
  const netByDay = new Map<string, { inflows: number; outflows: number }>();
  for (const movement of realMovements) {
    const date = movement.actualDate ?? effectiveMovementDate(movement);
    const entry = netByDay.get(date) ?? { inflows: 0, outflows: 0 };
    const amount = Math.max(0, effectiveAmount(movement));
    if (movement.type === 'INFLOW') entry.inflows += amount;
    else entry.outflows += amount;
    netByDay.set(date, entry);
  }
  const days = Array.from(netByDay.keys()).sort();
  const inflowSeries = days.map((date) => netByDay.get(date)?.inflows ?? 0);
  const outflowSeries = days.map((date) => netByDay.get(date)?.outflows ?? 0);
  const netSeries = days.map((date) => {
    const entry = netByDay.get(date);
    return (entry?.inflows ?? 0) - (entry?.outflows ?? 0);
  });

  const sampleSize = netSeries.length;
  const etsResiduals = etsResidualSeries(netSeries);
  const residuals = etsResiduals.length > 0 ? etsResiduals : demean(netSeries);
  const netResidualStd = safeStd(residuals) || Math.max(1, Math.abs(mean(netSeries)) * 0.08);
  const autocorrelation = clamp(lagOneCorrelation(residuals), -0.6, 0.6);
  const inflowVolatility = relativeVolatility(inflowSeries, 0.08);
  const outflowVolatility = relativeVolatility(outflowSeries, 0.08);
  const diagnostics: ModelDiagnostics = sampleSize >= 90
    ? {
      modelKind: 'ARIMA',
      confidence: 'HIGH',
      sampleSize,
      inflowVolatility,
      outflowVolatility,
      netResidualStd,
      autocorrelation,
    }
    : sampleSize >= 21
      ? {
        modelKind: 'ETS',
        confidence: 'MEDIUM',
        sampleSize,
        inflowVolatility,
        outflowVolatility,
        netResidualStd,
        autocorrelation,
      }
      : {
        modelKind: 'EMPIRICAL_FALLBACK',
        confidence: 'LOW',
        sampleSize,
        inflowVolatility: Math.max(inflowVolatility, 0.12),
        outflowVolatility: Math.max(outflowVolatility, 0.12),
        netResidualStd: Math.max(netResidualStd, 1),
        autocorrelation: 0,
        fallbackReason: 'Historial real insuficiente para calibrar ARIMA/ETS con estabilidad.',
      };

  return {
    sampleSize,
    inflowVolatility: diagnostics.inflowVolatility,
    outflowVolatility: diagnostics.outflowVolatility,
    netResidualStd: diagnostics.netResidualStd,
    autocorrelation: diagnostics.autocorrelation,
    diagnostics,
  };
}

function aggregateProbabilisticBuckets(
  dailyBuckets: ProbabilisticBucket[],
  granularity: ProjectionGranularity,
): ProbabilisticBucket[] {
  if (granularity === 'daily') return dailyBuckets;
  const grouped = new Map<string, ProbabilisticBucket[]>();
  for (const bucket of dailyBuckets) {
    const key = bucketKeyForDate(bucket.date, granularity);
    const rows = grouped.get(key) ?? [];
    rows.push(bucket);
    grouped.set(key, rows);
  }
  return Array.from(grouped.entries()).map(([date, rows]) => {
    const closing = rows[rows.length - 1];
    const maxRisk = maxBy(rows, (row) => row.probabilityBelowMinimumCash) ?? closing;
    const maxExpectedCredit = maxBy(rows, (row) => row.expectedCreditRequired) ?? closing;
    const maxP90Credit = maxBy(rows, (row) => row.p90CreditRequired) ?? closing;
    return {
      date,
      label: date.slice(5),
      cash: closing.cash,
      probabilityBelowZero: maxRisk.probabilityBelowZero,
      probabilityBelowMinimumCash: maxRisk.probabilityBelowMinimumCash,
      expectedCreditRequired: maxExpectedCredit.expectedCreditRequired,
      p90CreditRequired: maxP90Credit.p90CreditRequired,
    };
  });
}

function summarizeDailyRow(row: DailySimulationAggregate, simulations: number): ProbabilisticBucket {
  return {
    date: row.date,
    label: row.label,
    cash: {
      p10: percentile(row.cash, 0.1),
      p50: percentile(row.cash, 0.5),
      p90: percentile(row.cash, 0.9),
    },
    probabilityBelowZero: row.belowZeroCount / simulations,
    probabilityBelowMinimumCash: row.belowMinimumCount / simulations,
    expectedCreditRequired: mean(row.creditRequired),
    p90CreditRequired: percentile(row.creditRequired, 0.9),
  };
}

function summarizeProbabilisticRun(args: {
  buckets: ProbabilisticBucket[];
  simulations: number;
  scenariosWithDeficit: number;
  scenariosBelowMinimum: number;
  terminalCreditRequired: number[];
  diagnostics: ModelDiagnostics;
}): ProbabilisticSummary {
  const maxRisk = maxBy(args.buckets, (bucket) => bucket.probabilityBelowMinimumCash);
  return {
    probabilityOfDeficit: args.scenariosWithDeficit / args.simulations,
    probabilityBelowMinimumCash: args.scenariosBelowMinimum / args.simulations,
    expectedCreditRequired: mean(args.terminalCreditRequired),
    p90CreditRequired: percentile(args.terminalCreditRequired, 0.9),
    maxRiskDate: maxRisk?.date,
    confidence: args.diagnostics.confidence,
  };
}

function relativeShock(rng: () => number, volatility: number, baseAmount: number): number {
  if (baseAmount <= 0) return 0;
  return gaussian(rng) * volatility * baseAmount;
}

function etsResidualSeries(values: number[]): number[] {
  if (values.length === 0) return [];
  const alpha = 0.35;
  let level = values[0];
  const residuals: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const forecast = level;
    residuals.push(values[i] - forecast);
    level = alpha * values[i] + (1 - alpha) * level;
  }
  return residuals;
}

function lagOneCorrelation(values: number[]): number {
  if (values.length < 3) return 0;
  const left = values.slice(0, -1);
  const right = values.slice(1);
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSq = 0;
  let rightSq = 0;
  for (let i = 0; i < left.length; i++) {
    const a = left[i] - leftMean;
    const b = right[i] - rightMean;
    numerator += a * b;
    leftSq += a * a;
    rightSq += b * b;
  }
  const denom = Math.sqrt(leftSq * rightSq);
  return denom > 0 ? numerator / denom : 0;
}

function relativeVolatility(values: number[], fallback: number): number {
  const positive = values.filter((value) => value > 0);
  if (positive.length < 2) return fallback;
  const average = mean(positive);
  if (average <= 0) return fallback;
  return clamp(safeStd(positive) / average, 0.04, 0.45);
}

function demean(values: number[]): number[] {
  const average = mean(values);
  return values.map((value) => value - average);
}

function safeStd(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = mean(values.map((value) => (value - average) ** 2));
  return Math.sqrt(Math.max(0, variance));
}

function percentile(values: number[], target: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(target, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxBy<T>(values: T[], score: (value: T) => number): T | undefined {
  let best: T | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const current = score(value);
    if (current > bestScore) {
      best = value;
      bestScore = current;
    }
  }
  return best;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function seedFromProjection(projection: ForecastRun): number {
  const text = `${projection.id}|${projection.scenarioId}|${projection.startDate}|${projection.endDate}|${projection.summary.finalCash}`;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(Number.EPSILON, rng());
  const v = Math.max(Number.EPSILON, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function enumerateDates(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function endOfMonth(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + 1, 0);
  return value.toISOString().slice(0, 10);
}
