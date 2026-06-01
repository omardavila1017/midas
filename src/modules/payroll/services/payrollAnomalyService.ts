/**
 * Detección de anomalías de Nómina a nivel concepto / empresa.
 *
 * El dashboard HTML detectaba "casos sospechosos" a nivel EMPLEADO (z-score de
 * variable+tiempo-extra vs sueldo). El API `/nomina` es agregado y NO trae
 * empleado, así que esa detección no es posible. Aquí se adapta al grano más
 * fino que el API sí soporta:
 *
 *   - Por concepto: la serie mensual del monto de cada concepto y se marca el
 *     mes más reciente cuyo valor se desvía de su propia historia previa.
 *   - Por empresa: la serie mensual del costo patronal total por cía.
 *
 * Señales combinadas: z-score contra la media/desviación de los meses previos
 * y salto MoM (% contra el mes inmediato anterior). La severidad es la más alta
 * de ambas señales.
 *
 * Los meses con firma de carga parcial (`findSuspectMonths`) se excluyen para
 * no marcar caídas que en realidad son truncamientos del API.
 */

import type { PayrollCostRecord } from '../../shared-finance/types';
import { findSuspectMonths } from './payrollModuleService';
import { distinctMonths } from './payrollAnalyticsService';

export type AnomalySeverity = 'CRITICO' | 'ALTO' | 'MEDIO';

export interface PayrollAnomaly {
  scope: 'concepto' | 'empresa';
  key: string;
  label: string;
  cia?: string;
  /** Mes evaluado (`YYYY-MM`). */
  month: string;
  value: number;
  mean: number;
  std: number;
  zscore: number;
  /** Salto vs mes anterior (%); `null` si el previo es 0. */
  momDeltaPct: number | null;
  severity: AnomalySeverity;
  reason: string;
}

export interface AnomalyOptions {
  /** Mínimo de meses previos requeridos para evaluar una serie. */
  minHistory: number;
  /** Umbrales de z-score por severidad. */
  zMedio: number;
  zAlto: number;
  zCritico: number;
  /** Umbral de salto MoM (%) para severidad media. */
  momMedioPct: number;
  /**
   * Piso de relevancia: una serie se ignora si su monto máximo es menor a esta
   * fracción del monto máximo entre TODAS las series del mismo scope. Evita
   * marcar conceptos minúsculos como anomalías ruidosas.
   */
  relevanceFloor: number;
}

export const DEFAULT_ANOMALY_OPTIONS: AnomalyOptions = {
  minHistory: 4,
  zMedio: 2,
  zAlto: 2.5,
  zCritico: 3,
  momMedioPct: 40,
  relevanceFloor: 0.02,
};

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function std(xs: number[], mu: number): number {
  if (xs.length === 0) return 0;
  const variance = xs.reduce((s, v) => s + (v - mu) * (v - mu), 0) / xs.length;
  return Math.sqrt(variance);
}

function severityFor(absZ: number, absMom: number, opts: AnomalyOptions): AnomalySeverity | null {
  if (absZ >= opts.zCritico) return 'CRITICO';
  if (absZ >= opts.zAlto) return 'ALTO';
  if (absZ >= opts.zMedio || absMom >= opts.momMedioPct) return 'MEDIO';
  return null;
}

interface SeriesInput {
  scope: 'concepto' | 'empresa';
  key: string;
  label: string;
  cia?: string;
  /** Serie densa alineada a `months`. */
  values: number[];
}

/**
 * Evalúa el último mes con dato de una serie contra su historia previa. La
 * historia previa excluye el punto evaluado. El "último mes" es el último
 * índice cuyo valor es > 0 (evita evaluar ceros de relleno al final).
 */
function evaluateSeries(
  input: SeriesInput,
  months: string[],
  opts: AnomalyOptions,
): PayrollAnomaly | null {
  const { values } = input;
  // Último índice con dato real.
  let lastIdx = -1;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] > 0) { lastIdx = i; break; }
  }
  if (lastIdx < opts.minHistory) return null;

  const history = values.slice(0, lastIdx); // estrictamente previos
  const nonZeroHistory = history.filter(v => v > 0);
  if (nonZeroHistory.length < opts.minHistory) return null;

  const value = values[lastIdx];
  const mu = mean(nonZeroHistory);
  const sd = std(nonZeroHistory, mu);
  const zscore = sd > 0 ? (value - mu) / sd : 0;

  const prev = values[lastIdx - 1];
  const momDeltaPct = prev > 0 ? ((value - prev) / prev) * 100 : null;

  const severity = severityFor(Math.abs(zscore), Math.abs(momDeltaPct ?? 0), opts);
  if (!severity) return null;

  const dir = value >= mu ? 'arriba' : 'abajo';
  const momTxt = momDeltaPct != null ? ` · ${momDeltaPct >= 0 ? '+' : ''}${momDeltaPct.toFixed(0)}% MoM` : '';
  const reason = `z=${zscore.toFixed(1)} (${dir} del promedio)${momTxt}`;

  return {
    scope: input.scope,
    key: input.key,
    label: input.label,
    cia: input.cia,
    month: months[lastIdx],
    value,
    mean: mu,
    std: sd,
    zscore,
    momDeltaPct,
    severity,
    reason,
  };
}

const SEVERITY_RANK: Record<AnomalySeverity, number> = { CRITICO: 3, ALTO: 2, MEDIO: 1 };

/**
 * Filtra series irrelevantes (montos minúsculos) por el piso de relevancia.
 */
function applyRelevanceFloor(inputs: SeriesInput[], floor: number): SeriesInput[] {
  const maxOfMax = inputs.reduce((m, s) => Math.max(m, ...s.values, 0), 0);
  if (maxOfMax <= 0) return inputs;
  const threshold = maxOfMax * floor;
  return inputs.filter(s => Math.max(...s.values, 0) >= threshold);
}

export function detectPayrollAnomalies(
  records: PayrollCostRecord[],
  options: Partial<AnomalyOptions> = {},
): PayrollAnomaly[] {
  const opts = { ...DEFAULT_ANOMALY_OPTIONS, ...options };

  // Excluye meses parciales/truncados.
  const suspect = new Set(findSuspectMonths(records).map(s => `${s.year}-${String(s.month).padStart(2, '0')}`));
  const clean = records.filter(r => !suspect.has(`${r.year}-${String(r.month).padStart(2, '0')}`));
  if (clean.length === 0) return [];

  const months = distinctMonths(clean);
  if (months.length <= opts.minHistory) return [];

  const monthIndex = new Map(months.map((m, i) => [m, i]));
  const keyOf = (r: PayrollCostRecord) => `${r.year}-${String(r.month).padStart(2, '0')}`;

  // Series por concepto (monto absoluto).
  const conceptMap = new Map<string, SeriesInput>();
  // Series por empresa (costo patronal = Percepciones + Aportaciones).
  const companyMap = new Map<string, SeriesInput>();

  for (const r of clean) {
    const mi = monthIndex.get(keyOf(r));
    if (mi == null) continue;

    const cKey = String(r.conceptId);
    let c = conceptMap.get(cKey);
    if (!c) {
      c = { scope: 'concepto', key: cKey, label: r.conceptName, values: new Array(months.length).fill(0) };
      conceptMap.set(cKey, c);
    }
    c.values[mi] += r.amount;

    if (r.cashTreatment === 'CASH_OUT' || r.cashTreatment === 'EMPLOYER_TAX') {
      const eKey = r.cia || r.empresaNomina || 'N/D';
      let e = companyMap.get(eKey);
      if (!e) {
        e = { scope: 'empresa', key: eKey, label: r.empresaNomina || r.cia, cia: r.cia, values: new Array(months.length).fill(0) };
        companyMap.set(eKey, e);
      }
      e.values[mi] += r.amount;
    }
  }

  const conceptInputs = applyRelevanceFloor(Array.from(conceptMap.values()), opts.relevanceFloor);
  const companyInputs = Array.from(companyMap.values()); // pocas empresas, sin piso

  const anomalies: PayrollAnomaly[] = [];
  for (const input of [...conceptInputs, ...companyInputs]) {
    const a = evaluateSeries(input, months, opts);
    if (a) anomalies.push(a);
  }

  return anomalies.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return Math.abs(b.zscore) - Math.abs(a.zscore);
  });
}
