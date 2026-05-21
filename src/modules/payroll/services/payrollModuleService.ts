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

export const PAYROLL_AUTO_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;

/** Llave canónica usada en `MidasStore.nominaLoadedKeys`. */
export function nominaCacheKey(k: NominaCacheKey): string {
  return `${k.idEmpresa}:${k.tipoNomina}:${k.anio}:${k.mes}`;
}

export interface NominaMonthPlanItem {
  anio: number;
  mes: number;
  cacheKey: string;
}

export function buildNominaMonthPlan(
  anchor: { anio: number; mes: number },
  count: number,
  idEmpresa = 99,
  tipoNomina = 99,
): NominaMonthPlanItem[] {
  const out: NominaMonthPlanItem[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(anchor.anio, anchor.mes - 1 - i, 1);
    const anio = d.getFullYear();
    const mes = d.getMonth() + 1;
    out.push({
      anio,
      mes,
      cacheKey: nominaCacheKey({ idEmpresa, tipoNomina, anio, mes }),
    });
  }
  return out;
}

export function deriveNominaLoadedKeysFromRecords(
  records: PayrollCostRecord[],
  existing: Record<string, string> = {},
  loadedAtIso: string = new Date().toISOString(),
): Record<string, string> {
  if (records.length === 0) return existing;
  let changed = false;
  const next = { ...existing };
  for (const record of records) {
    if (!record.year || !record.month) continue;
    const key = nominaCacheKey({
      idEmpresa: 99,
      tipoNomina: 99,
      anio: record.year,
      mes: record.month,
    });
    if (next[key]) continue;
    next[key] = loadedAtIso;
    changed = true;
  }
  return changed ? next : existing;
}

export function filterStaleNominaPlan(
  plan: NominaMonthPlanItem[],
  loadedKeys: Record<string, string>,
  maxAgeMs = PAYROLL_AUTO_REFRESH_TTL_MS,
  now: number = Date.now(),
): NominaMonthPlanItem[] {
  return plan.filter(item => !isCacheFresh(loadedKeys[item.cacheKey], maxAgeMs, now));
}

/**
 * Devuelve `{anio, mes}` para el periodo dado y los `n-1` anteriores, en orden
 * cronológico ascendente (el más viejo primero, el actual al final).
 *
 * Ejemplo: `lastNMonths(2026, 5, 4)` → [
 *   {anio:2026,mes:2}, {anio:2026,mes:3}, {anio:2026,mes:4}, {anio:2026,mes:5}
 * ].
 *
 * Usado por el dashboard de nómina para jalar el histórico necesario para
 * proyectar (mes actual + 3 anteriores por default).
 */
export function lastNMonths(anio: number, mes: number, n: number): Array<{ anio: number; mes: number }> {
  const out: Array<{ anio: number; mes: number }> = [];
  for (let i = n - 1; i >= 0; i--) {
    let m = mes - i;
    let y = anio;
    while (m <= 0) { m += 12; y -= 1; }
    out.push({ anio: y, mes: m });
  }
  return out;
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

/**
 * Conceptos bajo TipoConcepto="Obligación Empresa" que NO son cash real:
 *  - EXENTO/EXCENTO: porción exenta de un concepto (informativo para base
 *    fiscal — el cash real ya salió como Percepción).
 *  - GRAVADO/GRAVADA: porción gravada (mismo caso, informativo).
 *  - PROVISION/PROVISIÓN: provisión contable (ej. ISN), no es el pago real
 *    al fisco. El pago real se proyecta vía taxModule.
 *  - DESPENSA GRAVADA: la porción gravada de los vales, informativo.
 */
const EMPLOYER_INFORMATIVO_PATTERNS = [
  /\bexento\b/i,
  /\bexcento\b/i,
  /\bgravad[oa]\b/i,
  /provisi(ó|o)n/i,
  /hrs?\s+extras?\s+gravad/i,
];

/**
 * Conceptos bajo TipoConcepto="Prestación" que SÍ son cash real al empleado
 * (no vales). Indemnización, gratificación por separación y prima de
 * antigüedad se pagan al banco en FechaPago.
 */
const PRESTACION_CASH_PATTERNS = [
  /indemnizaci(ó|o)n/i,
  /gratificaci(ó|o)n\s+por\s+separaci(ó|o)n/i,
  /prima\s+de\s+antig(ü|u)edad/i,
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
  if (record.cashTreatment === 'EMPLOYER_TAX') {
    // ISR (EMPRESA) es ISR retenido al empleado pero registrado bajo
    // Obligación Empresa. Reclasificamos a WITHHOLDING_PAYABLE para que viva
    // junto con las demás retenciones que la empresa entera al SAT.
    if (WITHHOLDING_PATTERNS.some(p => p.test(concept))) return 'WITHHOLDING_PAYABLE';
    if (EMPLOYER_INFORMATIVO_PATTERNS.some(p => p.test(concept))) return 'NON_CASH';
    return 'EMPLOYER_TAX';
  }
  if (record.cashTreatment === 'NON_CASH') {
    // Promoción NON_CASH → CASH_OUT para pagos reales bajo "Prestación".
    // Se queda NON_CASH para todo lo demás (vales, despensa, retroactivos).
    if (record.conceptType === 'Prestación' || record.conceptType === 'Prestacion') {
      if (PRESTACION_CASH_PATTERNS.some(p => p.test(record.conceptName))) return 'CASH_OUT';
    }
    return 'NON_CASH';
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
 * Detecta meses con firma de carga parcial. Dos firmas:
 *
 *  1) Truncamiento total (AWS API Gateway >1MB): records>0 pero ningún
 *     `DEDUCTION` ni `EMPLOYER_TAX`. La response solo trajo Percepciones.
 *  2) Quincena suelta: records>0 con muy pocas deducciones — el response
 *     solo trajo una o dos quincenas del mes (típicamente cuando TRESS
 *     responde parcial por un periodo en tránsito). Detectado por
 *     `dedCount / cashCount < 0.3` Y monto total bajo (`gross < 25%` del
 *     mes vecino más alto). Una nómina completa siempre tiene un DEDUCTION
 *     por cada CASH_OUT (mínimo IMSS empleado + ISR), así que ratio < 0.3
 *     casi nunca es legítimo. Antes del fix, estos meses se promediaban
 *     con los meses completos y tiraban el TRESS prom 3m varios M.
 *
 * Devuelve la lista de `{year, month}` afectados para que el boot pueda
 * purgar esos records (y su cacheKey) antes de refetch.
 */
export function findSuspectMonths(
  records: PayrollCostRecord[],
): Array<{ year: number; month: number }> {
  type Entry = {
    year: number;
    month: number;
    hasDed: boolean;
    hasTax: boolean;
    cashCount: number;
    dedCount: number;
    gross: number;
  };
  const byMonth = new Map<string, Entry>();
  for (const r of records) {
    if (!r.year || !r.month) continue;
    const key = `${r.year}|${r.month}`;
    const entry = byMonth.get(key) ?? {
      year: r.year,
      month: r.month,
      hasDed: false,
      hasTax: false,
      cashCount: 0,
      dedCount: 0,
      gross: 0,
    };
    if (r.cashTreatment === 'DEDUCTION') { entry.hasDed = true; entry.dedCount += 1; }
    if (r.cashTreatment === 'WITHHOLDING_PAYABLE') { entry.hasDed = true; entry.dedCount += 1; }
    if (r.cashTreatment === 'EMPLOYER_TAX') entry.hasTax = true;
    if (r.cashTreatment === 'CASH_OUT') { entry.cashCount += 1; entry.gross += r.amount; }
    byMonth.set(key, entry);
  }
  // Baseline para detectar "quincena suelta": gross máximo entre meses que
  // tienen ratio dedCount/cashCount sano (>=0.3). Eso da el techo razonable
  // del gross mensual; cualquier mes con gross < 25% de ese techo y ratio
  // bajo es parcial.
  let baselineGross = 0;
  for (const e of byMonth.values()) {
    const ratio = e.cashCount > 0 ? e.dedCount / e.cashCount : 0;
    if (ratio >= 0.3 && e.gross > baselineGross) baselineGross = e.gross;
  }
  const PARTIAL_RATIO = 0.3;
  const PARTIAL_GROSS_RATIO = 0.25;
  const suspect: Array<{ year: number; month: number }> = [];
  for (const e of byMonth.values()) {
    // Firma 1: truncamiento total — sin deducciones ni aportaciones.
    if (e.cashCount > 0 && !e.hasDed && !e.hasTax) {
      suspect.push({ year: e.year, month: e.month });
      continue;
    }
    // Firma 2: quincena suelta — ratio bajo Y gross bajo vs el techo.
    if (e.cashCount > 0 && baselineGross > 0) {
      const ratio = e.dedCount / e.cashCount;
      if (ratio < PARTIAL_RATIO && e.gross < baselineGross * PARTIAL_GROSS_RATIO) {
        suspect.push({ year: e.year, month: e.month });
      }
    }
  }
  return suspect;
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
