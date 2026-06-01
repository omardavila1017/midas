/**
 * Servicio de análisis de Nómina (TRESS) — agregaciones para el dashboard
 * analítico (sub-pestañas Resumen / Comparativo / Conceptos / Tendencia /
 * Predictivo / Alertas).
 *
 * Replica, hasta donde el API permite, la lógica del dashboard HTML de
 * referencia. El API `/nomina` entrega filas con grano
 * `empresa × concepto × periodo × mes` — NO trae empleado, puesto, centro de
 * costo ni "segmento". Por eso la composición que el HTML hacía por
 * "Segmento Costo" (Sueldo / Variable / Tiempo Extra / …) aquí se sustituye
 * por las clasificaciones que SÍ trae el API: `cashTreatment` y `conceptType`.
 * Ver `README.md` del módulo para el mapeo HTML→API y los gaps.
 *
 * Todo aquí es puramente funcional y memoizable. La persistencia vive en
 * `src/domain/persistence.ts`; este archivo no toca `localStorage`.
 */

import type { PayrollCashTreatment, PayrollCostRecord } from '../../shared-finance/types';
import {
  summarizeByConcept,
  type PayrollConceptBreakdown,
} from './payrollModuleService';

// ── Metadata de presentación ────────────────────────────────────────────────

export const CASH_TREATMENT_LABELS: Record<PayrollCashTreatment, string> = {
  CASH_OUT: 'Percepciones',
  DEDUCTION: 'Deducciones',
  WITHHOLDING_PAYABLE: 'Retenciones',
  EMPLOYER_TAX: 'Aportaciones patronales',
  NON_CASH: 'No monetario',
};

/** Orden estable para leyendas/donuts (de mayor a menor relevancia de caja). */
export const CASH_TREATMENT_ORDER: PayrollCashTreatment[] = [
  'CASH_OUT',
  'WITHHOLDING_PAYABLE',
  'EMPLOYER_TAX',
  'DEDUCTION',
  'NON_CASH',
];

export const CASH_TREATMENT_COLORS: Record<PayrollCashTreatment, string> = {
  CASH_OUT: 'var(--accent-blue)',
  WITHHOLDING_PAYABLE: 'var(--warning)',
  EMPLOYER_TAX: 'var(--danger)',
  DEDUCTION: 'var(--gray-500)',
  NON_CASH: 'var(--gray-300)',
};

/**
 * Paleta categórica para series sin color semántico fijo (conceptos, tipos de
 * concepto). Tokens del DS — Recharts las resuelve en `fill`/`stroke`.
 */
export const CATEGORICAL_PALETTE: string[] = [
  'var(--accent-blue)',
  'var(--success)',
  'var(--warning)',
  'var(--danger)',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
  '#ea580c',
  '#475569',
];

export function paletteColor(index: number): string {
  return CATEGORICAL_PALETTE[index % CATEGORICAL_PALETTE.length];
}

// ── Distribuciones por categoría (donuts) ───────────────────────────────────

export interface CategoryTotal {
  key: string;
  label: string;
  total: number;
  occurrences: number;
  /** Participación sobre la suma de todas las categorías (0–100). */
  pct: number;
  color: string;
}

function finalizeShares(rows: Omit<CategoryTotal, 'pct'>[]): CategoryTotal[] {
  const grand = rows.reduce((s, r) => s + r.total, 0);
  return rows
    .map(r => ({ ...r, pct: grand > 0 ? (r.total / grand) * 100 : 0 }))
    .sort((a, b) => b.total - a.total);
}

/** Distribución del monto total por `cashTreatment`. */
export function summarizeByCashTreatment(records: PayrollCostRecord[]): CategoryTotal[] {
  const map = new Map<PayrollCashTreatment, { total: number; occurrences: number }>();
  for (const r of records) {
    const e = map.get(r.cashTreatment) ?? { total: 0, occurrences: 0 };
    e.total += r.amount;
    e.occurrences += 1;
    map.set(r.cashTreatment, e);
  }
  return finalizeShares(
    Array.from(map.entries()).map(([key, e]) => ({
      key,
      label: CASH_TREATMENT_LABELS[key],
      total: e.total,
      occurrences: e.occurrences,
      color: CASH_TREATMENT_COLORS[key],
    })),
  );
}

/** Distribución del monto total por `conceptType` (Percepción/Deducción/…). */
export function summarizeByConceptType(records: PayrollCostRecord[]): CategoryTotal[] {
  const map = new Map<string, { total: number; occurrences: number }>();
  for (const r of records) {
    const key = r.conceptType || 'Sin tipo';
    const e = map.get(key) ?? { total: 0, occurrences: 0 };
    e.total += r.amount;
    e.occurrences += 1;
    map.set(key, e);
  }
  return finalizeShares(
    Array.from(map.entries()).map(([key, e], i) => ({
      key,
      label: key,
      total: e.total,
      occurrences: e.occurrences,
      color: paletteColor(i),
    })),
  );
}

/** Distribución del monto total por tipo de nómina (Semanal/Quincenal). */
export function summarizeByPayrollType(records: PayrollCostRecord[]): CategoryTotal[] {
  const map = new Map<string, { total: number; occurrences: number }>();
  for (const r of records) {
    const key = r.payrollType || 'Sin tipo';
    const e = map.get(key) ?? { total: 0, occurrences: 0 };
    e.total += r.amount;
    e.occurrences += 1;
    map.set(key, e);
  }
  return finalizeShares(
    Array.from(map.entries()).map(([key, e], i) => ({
      key,
      label: key,
      total: e.total,
      occurrences: e.occurrences,
      color: paletteColor(i + 4),
    })),
  );
}

// ── Comparativo por empresa ─────────────────────────────────────────────────

export interface CompanySummary {
  cia: string;
  empresaNomina: string;
  grossEarnings: number;
  netDeductions: number;
  withholdings: number;
  employerTaxes: number;
  nonCash: number;
  netCashOnPaymentDate: number;
  /** Costo real para la empresa: Percepciones + Aportaciones patronales. */
  employerCost: number;
  conceptCount: number;
  /** Participación del `employerCost` sobre el total de empresas (0–100). */
  share: number;
}

function addToBuckets(
  target: { grossEarnings: number; netDeductions: number; withholdings: number; employerTaxes: number; nonCash: number },
  r: PayrollCostRecord,
): void {
  switch (r.cashTreatment) {
    case 'CASH_OUT': target.grossEarnings += r.amount; break;
    case 'DEDUCTION': target.netDeductions += r.amount; break;
    case 'WITHHOLDING_PAYABLE': target.withholdings += r.amount; break;
    case 'EMPLOYER_TAX': target.employerTaxes += r.amount; break;
    case 'NON_CASH': target.nonCash += r.amount; break;
  }
}

export function summarizeByCompany(records: PayrollCostRecord[]): CompanySummary[] {
  const map = new Map<string, CompanySummary>();
  for (const r of records) {
    const key = r.cia || r.empresaNomina || 'N/D';
    const e = map.get(key) ?? {
      cia: r.cia,
      empresaNomina: r.empresaNomina,
      grossEarnings: 0,
      netDeductions: 0,
      withholdings: 0,
      employerTaxes: 0,
      nonCash: 0,
      netCashOnPaymentDate: 0,
      employerCost: 0,
      conceptCount: 0,
      share: 0,
    };
    addToBuckets(e, r);
    e.conceptCount += 1;
    if (!e.empresaNomina && r.empresaNomina) e.empresaNomina = r.empresaNomina;
    map.set(key, e);
  }
  const rows = Array.from(map.values()).map(e => ({
    ...e,
    netCashOnPaymentDate: e.grossEarnings - e.netDeductions - e.withholdings,
    employerCost: e.grossEarnings + e.employerTaxes,
  }));
  const grand = rows.reduce((s, r) => s + r.employerCost, 0);
  return rows
    .map(r => ({ ...r, share: grand > 0 ? (r.employerCost / grand) * 100 : 0 }))
    .sort((a, b) => b.employerCost - a.employerCost);
}

// ── Serie temporal ──────────────────────────────────────────────────────────

export type PayrollGranularity = 'weekly' | 'monthly';

export interface TimeSeriesPoint {
  /** `YYYY-MM-DD` (lunes ISO de la semana) o `YYYY-MM`. Ordenable lexicográfico. */
  bucket: string;
  label: string;
  grossEarnings: number;
  netDeductions: number;
  withholdings: number;
  employerTaxes: number;
  nonCash: number;
  netCashOnPaymentDate: number;
  /** Costo real para la empresa: Percepciones + Aportaciones patronales. */
  employerCost: number;
}

const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/** Parseo local de `YYYY-MM-DD` evitando el corrimiento UTC. */
function parseLocalDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Lunes ISO de la semana que contiene `iso`, como `YYYY-MM-DD`. */
export function isoWeekMonday(iso: string): string | null {
  const d = parseLocalDate(iso);
  if (!d) return null;
  const dow = (d.getDay() + 6) % 7; // 0 = lunes
  d.setDate(d.getDate() - dow);
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function monthKey(record: PayrollCostRecord): string {
  return `${record.year}-${String(record.month).padStart(2, '0')}`;
}

function weeklyLabel(bucket: string): string {
  const d = parseLocalDate(bucket);
  if (!d) return bucket;
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

function monthlyLabel(bucket: string): string {
  const [y, m] = bucket.split('-').map(Number);
  if (!y || !m) return bucket;
  return `${MONTHS_SHORT[(m - 1) % 12]} ${String(y).slice(-2)}`;
}

/**
 * Serie temporal del costo de nómina. En granularidad `weekly` ancla cada fila
 * al lunes ISO de su `paymentDate` (apropiado para nómina Semanal); en
 * `monthly` agrupa por `year-month`. Devuelve los buckets ordenados
 * cronológicamente.
 */
export function buildPayrollTimeSeries(
  records: PayrollCostRecord[],
  granularity: PayrollGranularity,
): TimeSeriesPoint[] {
  const map = new Map<string, TimeSeriesPoint>();
  for (const r of records) {
    let bucket: string | null;
    if (granularity === 'weekly') {
      bucket = r.paymentDate ? isoWeekMonday(r.paymentDate) : null;
      if (!bucket) bucket = monthKey(r); // fallback defensivo si falta fecha
    } else {
      bucket = monthKey(r);
    }
    const e = map.get(bucket) ?? {
      bucket,
      label: granularity === 'weekly' ? weeklyLabel(bucket) : monthlyLabel(bucket),
      grossEarnings: 0,
      netDeductions: 0,
      withholdings: 0,
      employerTaxes: 0,
      nonCash: 0,
      netCashOnPaymentDate: 0,
      employerCost: 0,
    };
    addToBuckets(e, r);
    map.set(bucket, e);
  }
  return Array.from(map.values())
    .map(e => ({
      ...e,
      netCashOnPaymentDate: e.grossEarnings - e.netDeductions - e.withholdings,
      employerCost: e.grossEarnings + e.employerTaxes,
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

// ── Variación vs periodo anterior ───────────────────────────────────────────

export interface SeriesVariation {
  current: number;
  previous: number;
  deltaAbs: number;
  /** Cambio porcentual; `null` cuando el periodo previo es 0 (no definible). */
  deltaPct: number | null;
}

/** Variación del último valor de la serie contra el inmediato anterior. */
export function seriesVariation(values: number[]): SeriesVariation {
  const current = values.length > 0 ? values[values.length - 1] : 0;
  const previous = values.length > 1 ? values[values.length - 2] : 0;
  const deltaAbs = current - previous;
  const deltaPct = previous !== 0 ? (deltaAbs / Math.abs(previous)) * 100 : null;
  return { current, previous, deltaAbs, deltaPct };
}

// ── Conceptos (top-N con participación) ──────────────────────────────────────

export interface ConceptShare extends PayrollConceptBreakdown {
  /** Participación sobre el total absoluto de todos los conceptos (0–100). */
  pct: number;
}

/**
 * Top-N conceptos por monto absoluto, con su participación. Envuelve
 * `summarizeByConcept` (no lo modifica) y agrega `pct`.
 */
export function topConceptsWithShare(records: PayrollCostRecord[], n = 12): ConceptShare[] {
  const all = summarizeByConcept(records);
  const grand = all.reduce((s, c) => s + Math.abs(c.total), 0);
  return all.slice(0, n).map(c => ({
    ...c,
    pct: grand > 0 ? (Math.abs(c.total) / grand) * 100 : 0,
  }));
}

/** Agrupa conceptos por `conceptType`, cada grupo con sus conceptos (drill). */
export interface ConceptTypeGroup {
  conceptType: string;
  total: number;
  concepts: PayrollConceptBreakdown[];
}

export function groupConceptsByType(records: PayrollCostRecord[]): ConceptTypeGroup[] {
  const concepts = summarizeByConcept(records);
  const map = new Map<string, ConceptTypeGroup>();
  for (const c of concepts) {
    const key = c.conceptType || 'Sin tipo';
    const g = map.get(key) ?? { conceptType: key, total: 0, concepts: [] };
    g.total += c.total;
    g.concepts.push(c);
    map.set(key, g);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

// ── Series mensuales para forecast / anomalías ──────────────────────────────

/** Lista ordenada de meses (`YYYY-MM`) presentes en los registros. */
export function distinctMonths(records: PayrollCostRecord[]): string[] {
  const set = new Set<string>();
  for (const r of records) set.add(monthKey(r));
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/**
 * Serie mensual del monto total para un concepto, alineada a `months`. Los
 * meses sin dato del concepto quedan en 0 (la serie densa que necesitan los
 * modelos de suavizado). Usa monto absoluto.
 */
export function monthlyConceptSeries(
  records: PayrollCostRecord[],
  conceptId: string | number,
  months: string[],
): number[] {
  const byMonth = new Map<string, number>();
  for (const r of records) {
    if (String(r.conceptId) !== String(conceptId)) continue;
    const key = monthKey(r);
    byMonth.set(key, (byMonth.get(key) ?? 0) + r.amount);
  }
  return months.map(m => byMonth.get(m) ?? 0);
}

/** Serie mensual del costo total de empresa (Percepciones + patronal). */
export function monthlyEmployerCostSeries(records: PayrollCostRecord[], months: string[]): number[] {
  const byMonth = new Map<string, number>();
  for (const r of records) {
    if (r.cashTreatment !== 'CASH_OUT' && r.cashTreatment !== 'EMPLOYER_TAX') continue;
    const key = monthKey(r);
    byMonth.set(key, (byMonth.get(key) ?? 0) + r.amount);
  }
  return months.map(m => byMonth.get(m) ?? 0);
}
