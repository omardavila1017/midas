/**
 * Servicio del módulo de Nómina (TRESS).
 *
 * Responsabilidades:
 *   - Calcular cache keys consistentes para (idEmpresa, tipoNomina, anio, mes).
 *   - Mergear lotes nuevos sobre los registros existentes en el store sin
 *     duplicar la misma combinación (cia, periodo, conceptId, fechaPago).
 *   - Reclasificar `cashTreatment` con una tabla fina por concepto, encima
 *     del mapping naive que hace el mapper de `jde.ts` (ver
 *     "Decisiones de arquitectura" en el plan).
 *   - Agregaciones para el dashboard: KPIs, breakdown por concepto, totales
 *     por (cia, FechaPago) listos para emitir `PaymentEvent`s en PR3.
 *
 * Mantener este servicio puramente funcional. La persistencia vive en
 * `src/domain/persistence.ts`; este archivo no toca `localStorage`.
 */

import type { PayrollCashTreatment, PayrollCostRecord } from '../../shared-finance/types';

export interface NominaCacheKey {
  idEmpresa: number;
  tipoNomina: number;
  anio: number;
  mes: number;
}

/** Llave canónica usada en `MidasStore.nominaLoadedKeys`. */
export function nominaCacheKey(k: NominaCacheKey): string {
  return `${k.idEmpresa}:${k.tipoNomina}:${k.anio}:${k.mes}`;
}

/**
 * Refina el `cashTreatment` heurístico que asigna el mapper basándose solo
 * en el `TipoConcepto`. Aquí inspeccionamos el nombre/ID del concepto para
 * separar:
 *   - ISR / IMSS empleado → WITHHOLDING_PAYABLE (la empresa lo paga al SAT/IMSS
 *     en su fecha de entero, no el día de la nómina).
 *   - Préstamos, pensión alimenticia, faltas → DEDUCTION (sí reduce el neto
 *     que recibe el empleado en FechaPago).
 *   - Vales de despensa pagados con monedero electrónico distinto → NON_CASH.
 *
 * Reglas conservadoras: si el patrón no matchea, conserva el valor que ya
 * traía el record. Esto permite ir afinando la tabla sin que un patrón nuevo
 * rompa el flujo existente.
 */
const WITHHOLDING_PATTERNS = [
  /\bisr\b/i,
  /imss\s+(emp|trab|obrero)/i,
  /\briv\b/i, // RIVA — retención IVA
  /retencion/i,
];

const NON_CASH_PATTERNS = [
  /\bvales?\b/i,
  /despensa.*electronic/i,
  /provisi(ó|o)n/i,
  /informativ/i,
];

export function refineCashTreatment(record: PayrollCostRecord): PayrollCashTreatment {
  const concept = `${record.conceptName} ${record.conceptType}`;

  if (record.cashTreatment === 'DEDUCTION') {
    if (WITHHOLDING_PATTERNS.some(p => p.test(concept))) return 'WITHHOLDING_PAYABLE';
    return 'DEDUCTION';
  }
  if (record.cashTreatment === 'CASH_OUT') {
    if (NON_CASH_PATTERNS.some(p => p.test(concept))) return 'NON_CASH';
    return 'CASH_OUT';
  }
  return record.cashTreatment;
}

/**
 * Reasigna `cashTreatment` a cada record vía `refineCashTreatment`. No muta;
 * devuelve una copia.
 */
export function refineBatch(records: PayrollCostRecord[]): PayrollCostRecord[] {
  return records.map(r => ({ ...r, cashTreatment: refineCashTreatment(r) }));
}

/**
 * Mergea un batch nuevo (resultado de `fetchNomina`) con los existentes.
 *
 * Estrategia:
 *   1. Identifica qué combinación (anio, mes, cia, tipoNomina) cubre el
 *      batch nuevo y elimina del existente cualquier record que matchee
 *      esa misma combinación. Esto evita que registros viejos del mismo
 *      periodo persistan tras un refresh.
 *   2. Concatena los registros nuevos (ya refinados por `refineBatch`).
 *
 * Mantiene orden estable: existentes primero (sin los desplazados), luego
 * los nuevos.
 */
export function mergeNominaBatch(
  existing: PayrollCostRecord[],
  incoming: PayrollCostRecord[],
): PayrollCostRecord[] {
  if (incoming.length === 0) return existing;

  // Construye la huella (year, month, cia, payrollType) que el batch nuevo
  // cubre. Cualquier record existente con la misma huella es reemplazado.
  const coveredFingerprints = new Set<string>();
  for (const r of incoming) {
    coveredFingerprints.add(`${r.year}|${r.month}|${r.cia}|${r.payrollType}`);
  }

  const filtered = existing.filter(r => {
    const fp = `${r.year}|${r.month}|${r.cia}|${r.payrollType}`;
    return !coveredFingerprints.has(fp);
  });

  return [...filtered, ...refineBatch(incoming)];
}

/**
 * ¿El cache para esta llave está vigente?
 *
 * - `maxAgeMs`: edad máxima en ms (default: 30 minutos).
 * - `now`: para inyectar reloj en tests.
 *
 * Si no hay timestamp registrado, devuelve `false` (= necesita fetch).
 */
export function isCacheFresh(
  loadedAtIso: string | undefined,
  maxAgeMs = 30 * 60 * 1000,
  now: number = Date.now(),
): boolean {
  if (!loadedAtIso) return false;
  const t = Date.parse(loadedAtIso);
  if (!Number.isFinite(t)) return false;
  return now - t < maxAgeMs;
}

// ── Agregaciones para el dashboard ──────────────────────────────────────────

export interface PayrollPeriodSummary {
  cia: string;
  empresaNomina: string;
  year: number;
  month: number;
  paymentDate: string;
  payrollPeriod: string | number;
  payrollType: string;
  /** Σ Percepciones. */
  grossEarnings: number;
  /** Σ Deducciones que efectivamente reducen el neto al empleado. */
  netDeductions: number;
  /** Σ Retenciones (ISR/IMSS empleado) que la empresa entera al fisco después. */
  withholdings: number;
  /** Σ Aportaciones patronales (IMSS patronal, INFONAVIT, ISN). */
  employerTaxes: number;
  /** Σ Conceptos no-cash (vales, provisiones). */
  nonCash: number;
  /**
   * Neto que sale del banco al empleado el día `paymentDate`:
   *   grossEarnings − netDeductions − withholdings.
   * Las retenciones se restan acá porque ya están contenidas en la nómina
   * bruta como deducciones del empleado, aunque el flujo de pago real al
   * SAT/IMSS ocurra después.
   */
  netCashOnPaymentDate: number;
  /** Cuántos conceptos componen este resumen. */
  conceptCount: number;
}

function emptySummary(seed: PayrollCostRecord): PayrollPeriodSummary {
  return {
    cia: seed.cia,
    empresaNomina: seed.empresaNomina,
    year: seed.year,
    month: seed.month,
    paymentDate: seed.paymentDate,
    payrollPeriod: seed.payrollPeriod,
    payrollType: seed.payrollType,
    grossEarnings: 0,
    netDeductions: 0,
    withholdings: 0,
    employerTaxes: 0,
    nonCash: 0,
    netCashOnPaymentDate: 0,
    conceptCount: 0,
  };
}

/**
 * Agrupa por (cia, paymentDate, payrollType, payrollPeriod) y aplica la
 * fórmula del cash neto. La salida es la base que PR3 va a consumir para
 * emitir `PaymentEvent`s al motor de cash flow.
 */
export function summarizePeriods(records: PayrollCostRecord[]): PayrollPeriodSummary[] {
  const map = new Map<string, PayrollPeriodSummary>();

  for (const r of records) {
    const key = `${r.cia}|${r.paymentDate}|${r.payrollType}|${r.payrollPeriod}`;
    const existing = map.get(key) ?? emptySummary(r);

    switch (r.cashTreatment) {
      case 'CASH_OUT':
        existing.grossEarnings += r.amount;
        break;
      case 'DEDUCTION':
        existing.netDeductions += r.amount;
        break;
      case 'WITHHOLDING_PAYABLE':
        existing.withholdings += r.amount;
        break;
      case 'EMPLOYER_TAX':
        existing.employerTaxes += r.amount;
        break;
      case 'NON_CASH':
        existing.nonCash += r.amount;
        break;
    }
    existing.conceptCount += 1;
    map.set(key, existing);
  }

  // Aplica la fórmula del cash neto y devuelve ordenado por paymentDate ascendente.
  return Array.from(map.values())
    .map(s => ({
      ...s,
      netCashOnPaymentDate: s.grossEarnings - s.netDeductions - s.withholdings,
    }))
    .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
}

export interface PayrollConceptBreakdown {
  conceptId: string | number;
  conceptName: string;
  conceptType: string;
  cashTreatment: PayrollCashTreatment;
  total: number;
  occurrences: number;
}

/** Breakdown por concepto para el dashboard (top conceptos, ranking). */
export function summarizeByConcept(records: PayrollCostRecord[]): PayrollConceptBreakdown[] {
  const map = new Map<string, PayrollConceptBreakdown>();
  for (const r of records) {
    const key = `${r.conceptId}|${r.conceptName}`;
    const existing = map.get(key);
    if (existing) {
      existing.total += r.amount;
      existing.occurrences += 1;
    } else {
      map.set(key, {
        conceptId: r.conceptId,
        conceptName: r.conceptName,
        conceptType: r.conceptType,
        cashTreatment: r.cashTreatment,
        total: r.amount,
        occurrences: 1,
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

export interface PayrollKpis {
  totalGross: number;
  totalNetCash: number;
  totalWithholdings: number;
  totalEmployerTaxes: number;
  periodCount: number;
  conceptCount: number;
  payingCompanies: number;
}

export function computeKpis(records: PayrollCostRecord[]): PayrollKpis {
  const summaries = summarizePeriods(records);
  const ciaSet = new Set<string>();
  let totalGross = 0;
  let totalNetCash = 0;
  let totalWithholdings = 0;
  let totalEmployerTaxes = 0;
  for (const s of summaries) {
    totalGross += s.grossEarnings;
    totalNetCash += s.netCashOnPaymentDate;
    totalWithholdings += s.withholdings;
    totalEmployerTaxes += s.employerTaxes;
    if (s.cia) ciaSet.add(s.cia);
  }
  return {
    totalGross,
    totalNetCash,
    totalWithholdings,
    totalEmployerTaxes,
    periodCount: summaries.length,
    conceptCount: records.length,
    payingCompanies: ciaSet.size,
  };
}

/**
 * Filtros para el dashboard. Cualquier valor falsy se interpreta como "sin
 * filtro" (no restringe).
 */
export interface PayrollFilter {
  cia?: string;
  year?: number;
  month?: number;
  payrollType?: string;
  cashTreatment?: PayrollCashTreatment;
}

export function filterRecords(records: PayrollCostRecord[], f: PayrollFilter): PayrollCostRecord[] {
  return records.filter(r => {
    if (f.cia && r.cia !== f.cia) return false;
    if (f.year && r.year !== f.year) return false;
    if (f.month && r.month !== f.month) return false;
    if (f.payrollType && r.payrollType !== f.payrollType) return false;
    if (f.cashTreatment && r.cashTreatment !== f.cashTreatment) return false;
    return true;
  });
}
