/**
 * comprasForecastModels — pronóstico de FUTURAS órdenes de compra a partir
 * del histórico de Compras (ComprasRecord) y del catálogo de proveedores.
 *
 * Diferencia con `comprasToPurchaseReceipts.ts`:
 *   - Aquel proyecta CUÁNDO se pagará una OC YA EMITIDA pero sin recibir
 *     (PROJECTED por lead-time histórico).
 *   - Este proyecta OCs AÚN NO EMITIDAS pero esperables por patrón
 *     histórico — extiende la curva de egresos al futuro.
 *
 * Tres modelos seleccionables por el usuario en Proyección:
 *
 *   1. `moving-avg`        Promedio mensual por proveedor en los últimos
 *                          N meses, proyectado plano hacia adelante.
 *   2. `linear-trend`      Regresión lineal por proveedor, con la pendiente
 *                          amortiguada según clasificación (CRITICO no baja,
 *                          FLEX_BAJO usa solo el promedio).
 *   3. `historical-cadence` Detecta cadencia de OCs por proveedor y
 *                          replica adelante con el monto promedio.
 *
 * Cada modelo emite `PurchaseReceiptRecord` con `confidence: 'PROJECTED'`
 * para que el motor canónico (`buildPurchaseReceiptMovements`) los incluya
 * como egresos proyectados.
 */

import type { ComprasRecord } from '../services/jdeTypes';
import type { Provider } from './types';
import type {
  PurchaseReceiptRecord,
  FinancialTaxRate,
  FinancialTaxTreatment,
} from '../modules/shared-finance/types';
import { normalizeJdeKey, normalizeProviderName } from './providerIdentity';

export type ForecastModelId = 'moving-avg' | 'linear-trend' | 'historical-cadence';

export const FORECAST_MODELS: Array<{ id: ForecastModelId; label: string; description: string }> = [
  {
    id: 'moving-avg',
    label: 'Promedio móvil',
    description: 'Σ últimos 3 meses ÷ 3, proyectado plano hacia adelante por proveedor.',
  },
  {
    id: 'linear-trend',
    label: 'Tendencia lineal × clasificación',
    description: 'Regresión sobre últimos 6 meses; pendiente amortiguada por criticidad.',
  },
  {
    id: 'historical-cadence',
    label: 'Cadencia histórica',
    description: 'Detecta intervalo entre OCs por proveedor y replica adelante.',
  },
];

export const DEFAULT_FORECAST_MODEL: ForecastModelId = 'moving-avg';

export interface ForecastInput {
  comprasRecords: ComprasRecord[];
  providers: Provider[];
  /** Fecha "hoy" para anclar ventanas. Default: hoy UTC. */
  asOfDate?: string;
  /** Meses hacia adelante a proyectar. Default 6. */
  horizonMonths?: number;
  /** Ventana hacia atrás para muestreo histórico. Default 6. */
  historyMonths?: number;
  /** Top-N proveedores por gasto histórico. Default 80. Limita la cantidad
   *  de movimientos sintéticos para no saturar el pipeline canónico. */
  topProvidersByVolume?: number;
}

export interface ForecastOutput {
  modelId: ForecastModelId;
  receipts: PurchaseReceiptRecord[];
  perProvider: Array<{
    jdeKey: string;
    providerName: string;
    historicalMonthlyAvg: number;
    projectedMonthlyAvg: number;
    monthsOfHistory: number;
    monthsProjected: number;
  }>;
}

const DAY_MS = 86_400_000;

// Memo simple para evitar recomputar el forecast en cada render mientras
// los inputs son idénticos por referencia.
const FORECAST_CACHE = new Map<string, ForecastOutput>();
const FORECAST_CACHE_LIMIT = 12;

export function forecastFutureCompras(
  input: ForecastInput,
  modelId: ForecastModelId,
): ForecastOutput {
  const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
  const horizonMonths = input.horizonMonths ?? 6;
  const historyMonths = input.historyMonths ?? (modelId === 'linear-trend' ? 6 : 3);
  const topProviders = input.topProvidersByVolume ?? 80;

  const cacheKey = `${modelId}|${asOfDate.slice(0, 7)}|${input.comprasRecords.length}|${input.providers.length}|${horizonMonths}|${historyMonths}|${topProviders}`;
  const cached = FORECAST_CACHE.get(cacheKey);
  if (cached) return cached;

  const window = recentWindow(asOfDate, historyMonths);
  const allBuckets = bucketByProvider(input.comprasRecords, window.start, window.end);
  const buckets = limitToTopProviders(allBuckets, topProviders);
  const catalog = indexProviders(input.providers);

  let result: ForecastOutput;
  switch (modelId) {
    case 'moving-avg':
      result = runMovingAverage({ buckets, catalog, asOfDate, horizonMonths, historyMonths });
      break;
    case 'linear-trend':
      result = runLinearTrend({ buckets, catalog, asOfDate, horizonMonths, historyMonths });
      break;
    case 'historical-cadence':
      result = runHistoricalCadence({
        buckets,
        comprasRecords: input.comprasRecords,
        windowStart: window.start,
        windowEnd: window.end,
        catalog,
        asOfDate,
        horizonMonths,
        historyMonths,
      });
      break;
  }

  FORECAST_CACHE.set(cacheKey, result);
  if (FORECAST_CACHE.size > FORECAST_CACHE_LIMIT) {
    const oldest = FORECAST_CACHE.keys().next().value;
    if (oldest) FORECAST_CACHE.delete(oldest);
  }
  return result;
}

/** Mantén solo los top-N buckets por volumen total para acotar el costo. */
function limitToTopProviders(
  buckets: Map<string, ProviderBucket>,
  topN: number,
): Map<string, ProviderBucket> {
  if (buckets.size <= topN) return buckets;
  const sorted = Array.from(buckets.entries()).sort((a, b) => {
    const sumA = Array.from(a[1].byMonth.values()).reduce((s, v) => s + v, 0);
    const sumB = Array.from(b[1].byMonth.values()).reduce((s, v) => s + v, 0);
    return sumB - sumA;
  });
  return new Map(sorted.slice(0, topN));
}

// ─── Bucketing helpers ──────────────────────────────────────────────────

interface ProviderBucket {
  jdeKey: string;
  jdeRaw: string;
  name: string;
  cia: string;
  familia: string;
  subFamilia: string;
  categoria: string;
  diasCredito: number;
  /** monto agregado por yearMonth */
  byMonth: Map<string, number>;
  /** órdenes individuales (para cadencia) */
  orders: Array<{ date: string; amount: number; familia: string; subFamilia: string; cia: string }>;
}

function recentWindow(asOfDate: string, months: number): { start: string; end: string } {
  const safe = /^\d{4}-\d{2}-\d{2}/.test(asOfDate)
    ? asOfDate.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const [y, m] = safe.split('-').map(Number);
  const endDate = new Date(Date.UTC(y, m - 1, 0));
  const startMonth = endDate.getUTCMonth() - (months - 1);
  const startYear = endDate.getUTCFullYear() + Math.floor(startMonth / 12);
  const safeMonth = ((startMonth % 12) + 12) % 12;
  const startDate = new Date(Date.UTC(startYear, safeMonth, 1));
  return {
    start: startDate.toISOString().slice(0, 10),
    end: endDate.toISOString().slice(0, 10),
  };
}

function bucketByProvider(
  records: ComprasRecord[],
  start: string,
  end: string,
): Map<string, ProviderBucket> {
  const out = new Map<string, ProviderBucket>();
  for (const r of records) {
    if (r.cancelada) continue;
    if (!r.fechaPedido || r.fechaPedido < start || r.fechaPedido > end) continue;
    const amount = r.importeTotal || 0;
    if (amount <= 0) continue;
    const jdeKey = normalizeJdeKey(r.noProveedor);
    const nameKey = normalizeProviderName(r.nombreProveedor);
    const key = jdeKey || nameKey;
    if (!key) continue;
    const ym = r.fechaPedido.slice(0, 7);
    let bucket = out.get(key);
    if (!bucket) {
      bucket = {
        jdeKey: key,
        jdeRaw: r.noProveedor || '',
        name: r.nombreProveedor || '',
        cia: r.cia || '',
        familia: r.familia || '',
        subFamilia: r.subFamilia || '',
        categoria: r.categoria || '',
        diasCredito: r.diasCredito || 30,
        byMonth: new Map(),
        orders: [],
      };
      out.set(key, bucket);
    }
    bucket.byMonth.set(ym, (bucket.byMonth.get(ym) ?? 0) + amount);
    bucket.orders.push({
      date: r.fechaPedido,
      amount,
      familia: r.familia || '',
      subFamilia: r.subFamilia || '',
      cia: r.cia || '',
    });
  }
  return out;
}

function indexProviders(providers: Provider[]): Map<string, Provider> {
  const out = new Map<string, Provider>();
  for (const p of providers) {
    const jde = normalizeJdeKey(p.numProveedorJDE);
    if (jde) out.set(jde, p);
    const name = normalizeProviderName(p.name);
    if (name && !out.has(name)) out.set(name, p);
  }
  return out;
}

// ─── Model 1: Moving Average ────────────────────────────────────────────

interface RunCommon {
  buckets: Map<string, ProviderBucket>;
  catalog: Map<string, Provider>;
  asOfDate: string;
  horizonMonths: number;
  historyMonths: number;
}

function runMovingAverage(args: RunCommon): ForecastOutput {
  const receipts: PurchaseReceiptRecord[] = [];
  const perProvider: ForecastOutput['perProvider'] = [];
  const futureMonths = nextMonthsFrom(args.asOfDate, args.horizonMonths);

  for (const bucket of args.buckets.values()) {
    const totals = Array.from(bucket.byMonth.values());
    if (totals.length === 0) continue;
    const monthlyAvg = totals.reduce((a, b) => a + b, 0) / args.historyMonths;
    if (monthlyAvg <= 0) continue;
    perProvider.push({
      jdeKey: bucket.jdeKey,
      providerName: bucket.name,
      historicalMonthlyAvg: monthlyAvg,
      projectedMonthlyAvg: monthlyAvg,
      monthsOfHistory: totals.length,
      monthsProjected: futureMonths.length,
    });
    for (const ym of futureMonths) {
      receipts.push(
        buildForecastReceipt({
          bucket,
          ym,
          amount: monthlyAvg,
          modelTag: 'movavg',
          asOfDate: args.asOfDate,
        }),
      );
    }
  }

  return { modelId: 'moving-avg', receipts, perProvider };
}

// ─── Model 2: Linear Trend with Classification Dampening ───────────────

function runLinearTrend(args: RunCommon): ForecastOutput {
  const receipts: PurchaseReceiptRecord[] = [];
  const perProvider: ForecastOutput['perProvider'] = [];
  const futureMonths = nextMonthsFrom(args.asOfDate, args.horizonMonths);
  const sortedHistMonths = recentMonthList(args.asOfDate, args.historyMonths);

  for (const bucket of args.buckets.values()) {
    const points = sortedHistMonths.map((ym, idx) => ({ x: idx, y: bucket.byMonth.get(ym) ?? 0 }));
    const totals = points.map((p) => p.y);
    const sum = totals.reduce((a, b) => a + b, 0);
    if (sum <= 0) continue;
    const mean = sum / args.historyMonths;
    const slope = linearRegressionSlope(points);
    const provider = bucket.jdeKey ? args.catalog.get(bucket.jdeKey) : undefined;
    const dampening = dampingForProvider(provider);
    const effectiveSlope = slope * dampening;

    perProvider.push({
      jdeKey: bucket.jdeKey,
      providerName: bucket.name,
      historicalMonthlyAvg: mean,
      projectedMonthlyAvg: Math.max(0, mean + effectiveSlope * (futureMonths.length / 2)),
      monthsOfHistory: totals.filter((v) => v > 0).length,
      monthsProjected: futureMonths.length,
    });

    futureMonths.forEach((ym, futureIdx) => {
      const x = sortedHistMonths.length + futureIdx;
      const base = mean + effectiveSlope * (x - (sortedHistMonths.length - 1) / 2);
      const amount = Math.max(0, base);
      if (amount <= 0) return;
      receipts.push(
        buildForecastReceipt({
          bucket,
          ym,
          amount,
          modelTag: 'lintrend',
          asOfDate: args.asOfDate,
        }),
      );
    });
  }

  return { modelId: 'linear-trend', receipts, perProvider };
}

function linearRegressionSlope(points: Array<{ x: number; y: number }>): number {
  const n = points.length;
  if (n < 2) return 0;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  if (den === 0) return 0;
  return num / den;
}

function dampingForProvider(provider: Provider | undefined): number {
  const cls = provider?.clasificacionAlberto || provider?.clasificacionAutomatica;
  switch (cls) {
    case 'CRITICO':    return 0.2;  // Operación crítica — no asumir tendencias agresivas, casi plano.
    case 'FLEX_ALTO':
    case 'ALTO':       return 1.0;  // Sigue la tendencia tal cual.
    case 'FLEX_MEDIO':
    case 'MEDIO':      return 0.5;  // Tendencia parcial.
    case 'FLEX_BAJO':
    case 'BAJO':       return 0.0;  // Solo el promedio, sin extrapolar tendencia.
    case 'PAUSAR':     return 0.0;
    default:           return 0.5;
  }
}

// ─── Model 3: Historical Cadence ────────────────────────────────────────

interface CadenceArgs extends RunCommon {
  comprasRecords: ComprasRecord[];
  windowStart: string;
  windowEnd: string;
}

function runHistoricalCadence(args: CadenceArgs): ForecastOutput {
  const receipts: PurchaseReceiptRecord[] = [];
  const perProvider: ForecastOutput['perProvider'] = [];
  const horizonEnd = addDays(args.asOfDate, args.horizonMonths * 30);

  for (const bucket of args.buckets.values()) {
    if (bucket.orders.length < 2) continue;
    const sorted = [...bucket.orders].sort((a, b) => a.date.localeCompare(b.date));
    const intervals: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const delta = daysBetween(sorted[i - 1].date, sorted[i].date);
      if (delta > 0 && delta <= 180) intervals.push(delta);
    }
    if (intervals.length === 0) continue;
    const medianInterval = median(intervals);
    if (medianInterval <= 0) continue;
    const avgAmount = sorted.reduce((s, o) => s + o.amount, 0) / sorted.length;
    if (avgAmount <= 0) continue;
    const monthlyEquivalent = avgAmount * (30 / medianInterval);

    perProvider.push({
      jdeKey: bucket.jdeKey,
      providerName: bucket.name,
      historicalMonthlyAvg: monthlyEquivalent,
      projectedMonthlyAvg: monthlyEquivalent,
      monthsOfHistory: bucket.byMonth.size,
      monthsProjected: args.horizonMonths,
    });

    let next = addDays(sorted[sorted.length - 1].date, medianInterval);
    if (next < args.asOfDate) next = addDays(args.asOfDate, Math.min(medianInterval, 14));
    while (next <= horizonEnd) {
      const ym = next.slice(0, 7);
      receipts.push(
        buildForecastReceipt({
          bucket,
          ym,
          amount: avgAmount,
          modelTag: 'cadencia',
          asOfDate: args.asOfDate,
          dateOverride: next,
        }),
      );
      next = addDays(next, medianInterval);
    }
  }

  return { modelId: 'historical-cadence', receipts, perProvider };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  return n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[(n - 1) / 2];
}

// ─── Receipt construction ───────────────────────────────────────────────

interface BuildArgs {
  bucket: ProviderBucket;
  ym: string;
  amount: number;
  modelTag: string;
  asOfDate: string;
  dateOverride?: string;
}

function buildForecastReceipt({
  bucket,
  ym,
  amount,
  modelTag,
  asOfDate,
  dateOverride,
}: BuildArgs): PurchaseReceiptRecord {
  const orderDate = dateOverride ?? midMonthDate(ym);
  // Estimate due date = order + creditDays (conservador, sin lead time)
  const estimatedDueDate = addDays(orderDate, Math.max(0, bucket.diasCredito || 30));
  const safeDueDate = estimatedDueDate < asOfDate ? asOfDate : estimatedDueDate;
  const taxRate: FinancialTaxRate | undefined = 16;
  const taxTreatment: FinancialTaxTreatment = 'IVA_CREDITABLE';
  const taxBaseAmount = amount / 1.16;
  const taxAmount = amount - taxBaseAmount;

  return {
    cia: bucket.cia,
    noProveedor: bucket.jdeRaw,
    supplierName: bucket.name || 'Proveedor sin nombre',
    invoiceNo: '',
    purchaseOrderNo: `forecast-${modelTag}-${bucket.jdeKey}-${ym}`,
    receiptNo: '',
    orderDate,
    receiptDate: '',
    creditDays: bucket.diasCredito || 30,
    estimatedDueDate: safeDueDate,
    currency: 'MXN',
    exchangeRate: 1,
    totalAmount: amount,
    amountMxn: amount,
    taxCode: undefined,
    taxRateCode: 'IVA16',
    taxRate,
    taxTreatment,
    taxBaseAmount,
    taxAmount,
    cancelledAt: undefined,
    isCancelled: false,
    status: 'PROJECTED_BASE',
    costCenter: undefined,
    productCode: undefined,
    productDescription: `Forecast ${modelTag} · ${bucket.name}`,
    productType: undefined,
    categoryCode: bucket.categoria || undefined,
    categoryName: bucket.categoria || undefined,
    familyCode: bucket.familia || undefined,
    familyName: bucket.familia || undefined,
    subfamilyCode: bucket.subFamilia || undefined,
    subfamilyName: bucket.subFamilia || undefined,
    confidence: 'PROJECTED',
    projectedLeadTimeDays: 0,
    projectedLeadTimeSource: `model:${modelTag}`,
    workflowState: undefined,
  };
}

// ─── Date helpers ───────────────────────────────────────────────────────

function midMonthDate(yearMonth: string): string {
  return `${yearMonth}-15`;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return (
    (new Date(`${b}T00:00:00.000Z`).getTime() - new Date(`${a}T00:00:00.000Z`).getTime()) / DAY_MS
  );
}

function nextMonthsFrom(asOfDate: string, count: number): string[] {
  const [y, m] = asOfDate.slice(0, 7).split('-').map(Number);
  const months: string[] = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(Date.UTC(y, m - 1 + i, 1));
    months.push(date.toISOString().slice(0, 7));
  }
  return months;
}

function recentMonthList(asOfDate: string, count: number): string[] {
  const [y, m] = asOfDate.slice(0, 7).split('-').map(Number);
  const months: string[] = [];
  for (let i = count; i >= 1; i--) {
    const date = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(date.toISOString().slice(0, 7));
  }
  return months;
}
