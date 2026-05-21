import type { ForecastRun } from '../../shared-finance/types';

export interface MonthlyCashRow {
  yearMonth: string;
  baseIncome: number;
  baseExpense: number;
  baseClosingCash: number;
  forecastIncome: number;
  forecastExpense: number;
  forecastClosingCash: number;
  hasBaseline: boolean;
}

function ymOf(date: string): string {
  return date.slice(0, 7);
}

function aggregateByMonth(run: ForecastRun): Map<string, { inflows: number; outflows: number; closingCash: number; lastDate: string }> {
  const out = new Map<string, { inflows: number; outflows: number; closingCash: number; lastDate: string }>();
  for (const bucket of run.buckets) {
    const ym = ymOf(bucket.date);
    const entry = out.get(ym);
    if (!entry) {
      out.set(ym, {
        inflows: bucket.inflows,
        outflows: bucket.outflows,
        closingCash: bucket.closingCash,
        lastDate: bucket.date,
      });
      continue;
    }
    entry.inflows += bucket.inflows;
    entry.outflows += bucket.outflows;
    if (bucket.date >= entry.lastDate) {
      entry.lastDate = bucket.date;
      entry.closingCash = bucket.closingCash;
    }
  }
  return out;
}

export function aggregateProjectionToMonths(
  projection: ForecastRun,
  baseProjection?: ForecastRun,
): MonthlyCashRow[] {
  const forecastByMonth = aggregateByMonth(projection);
  const baseByMonth = baseProjection ? aggregateByMonth(baseProjection) : new Map();

  const allMonths = new Set<string>([
    ...forecastByMonth.keys(),
    ...baseByMonth.keys(),
  ]);
  const months = Array.from(allMonths).sort();

  return months.map((ym) => {
    const forecast = forecastByMonth.get(ym);
    const base = baseByMonth.get(ym);
    const baseIncome = base?.inflows ?? forecast?.inflows ?? 0;
    const baseExpense = base?.outflows ?? forecast?.outflows ?? 0;
    const baseClosingCash = base?.closingCash ?? forecast?.closingCash ?? 0;
    return {
      yearMonth: ym,
      baseIncome,
      baseExpense,
      baseClosingCash,
      forecastIncome: forecast?.inflows ?? baseIncome,
      forecastExpense: forecast?.outflows ?? baseExpense,
      forecastClosingCash: forecast?.closingCash ?? baseClosingCash,
      hasBaseline: Boolean(base),
    };
  });
}
