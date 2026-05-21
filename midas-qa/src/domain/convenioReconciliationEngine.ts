// ─────────────────────────────────────────────────────────────────────────
// Convenio Concursal — conciliación contra movimientos bancarios.
//
// Cruza cada trimestre histórico del convenio (interés + capital programados)
// contra los CARGOS bancarios reales. Reglas acordadas con el cliente:
//
//   - Empate por MONTO, no restringido a una sola cuenta: el pago puede
//     salir de una cuenta distinta a la "dueña" de la deuda. Por eso se
//     aplanan TODOS los CARGOS de TODAS las cuentas/cías.
//   - El pago cae el último día hábil del mes del trimestre; si se recorre
//     por inhábil sigue devengando interés, así que el monto real puede
//     diferir del programado. El empate usa una BANDA DE TOLERANCIA de
//     monto (no exacto) y una ventana de fechas alrededor de la fecha
//     programada.
//   - Un pago trimestral puede salir partido en varios CARGOS (varias
//     cuentas) → se intenta también suma de subconjuntos acotada.
//
// El motor consume cada CARGO una sola vez (1:1) y procesa los trimestres
// en orden cronológico para no doble-contar.
// ─────────────────────────────────────────────────────────────────────────
import type { BankAccountStatement, BankStatementLine } from '../services/jdeTypes';
import { buildConvenioSchedule, type ConvenioScheduledPayment } from './convenioConcursal';

export interface ConvenioReconciliationConfig {
  /** Días antes de la fecha programada que abren la ventana de búsqueda. */
  daysBefore: number;
  /** Días después de la fecha programada que cierran la ventana. */
  daysAfter: number;
  /** Tolerancia de monto como fracción del pago programado (0.06 = 6%). */
  amountTolerancePct: number;
  /** Piso absoluto de tolerancia en MXN (para trimestres chicos). */
  amountToleranceMinAbs: number;
  /** Tope de tamaño de subconjunto para empate partido. */
  maxSubsetSize: number;
}

export const DEFAULT_CONVENIO_RECON_CONFIG: ConvenioReconciliationConfig = {
  daysBefore: 10,
  daysAfter: 20,
  amountTolerancePct: 0.06,
  amountToleranceMinAbs: 50_000,
  maxSubsetSize: 6,
};

export type ConvenioMatchStatus = 'matched' | 'partial' | 'unmatched' | 'sin-datos-banco';
export type ConvenioMatchTier = 'exact' | 'tolerance' | 'subset' | 'none';

export interface ConvenioBankRef {
  cia: string;
  banco: string;
  cuenta: string;
  fechaOperacion: string;
  concepto: string;
  referencia: string;
  importe: number;
}

export interface ConvenioReconciliationMatch {
  key: string;
  year: number;
  month: string;
  monthIndex: number;
  scheduledDateIso: string;
  scheduledTotalMxn: number;
  status: ConvenioMatchStatus;
  matchTier: ConvenioMatchTier;
  /** Suma de los CARGOS empatados a este trimestre (MXN). */
  matchedAmountMxn: number;
  /** matched − programado. Positivo = se pagó de más (interés por recorrido). */
  deltaMxn: number;
  /** delta como fracción del programado. */
  deltaPct: number;
  /** 0..1 — qué tan confiable es el empate. */
  confidence: number;
  bankMovements: ConvenioBankRef[];
}

export interface ConvenioReconciliationSummary {
  elapsedCount: number;
  matchedCount: number;
  partialCount: number;
  unmatchedCount: number;
  noBankDataCount: number;
  scheduledElapsedMxn: number;
  matchedMxn: number;
  /** Suma de deltas en trimestres empatados (variabilidad por recorrido). */
  varianceMxn: number;
  bankCoverage: { earliest: string | null; latest: string | null; cargoCount: number };
}

export interface ConvenioReconciliationResult {
  matches: ConvenioReconciliationMatch[];
  summary: ConvenioReconciliationSummary;
  config: ConvenioReconciliationConfig;
}

interface Candidate {
  idx: number;
  importe: number;
  ref: ConvenioBankRef;
}

const DAY_MS = 86_400_000;

function isCargo(line: BankStatementLine): boolean {
  return String(line.tipoMovimiento).toUpperCase() === 'CARGO';
}

function isMxn(line: BankStatementLine): boolean {
  const m = (line.moneda || '').toUpperCase().trim();
  return m === '' || m === 'MXN' || m === 'PESOS' || m === 'MN';
}

function shiftIso(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00.000Z`);
  return new Date(t + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Suma de subconjunto acotada: busca el subconjunto (tamaño 2..maxSize) cuya
 * suma quede más cerca del objetivo dentro de la tolerancia. Candidatos
 * ordenados desc y acotados aguas arriba para mantener la combinatoria chica.
 */
function findSubset(
  cands: Candidate[],
  target: number,
  tol: number,
  maxSize: number,
): Candidate[] | null {
  // Contenedor por propiedad: evita que el control-flow de TS estreche
  // `best` a `never` por la mutación dentro del closure `dfs`.
  const state: { best: { combo: Candidate[]; err: number } | null } = { best: null };
  const n = cands.length;
  const pick: Candidate[] = [];
  const dfs = (start: number, sum: number) => {
    if (pick.length >= 2) {
      const err = Math.abs(sum - target);
      if (err <= tol && (!state.best || err < state.best.err)) {
        state.best = { combo: [...pick], err };
      }
    }
    if (pick.length >= maxSize) return;
    for (let i = start; i < n; i++) {
      const next = sum + cands[i].importe;
      // Poda: si ya nos pasamos del objetivo + tolerancia, parar (orden desc).
      if (next - target > tol && pick.length >= 1) continue;
      pick.push(cands[i]);
      dfs(i + 1, next);
      pick.pop();
    }
  };
  dfs(0, 0);
  return state.best ? state.best.combo : null;
}

export function reconcileConvenioPayments(
  bankStatements: BankAccountStatement[],
  asOfDate?: string,
  config: ConvenioReconciliationConfig = DEFAULT_CONVENIO_RECON_CONFIG,
): ConvenioReconciliationResult {
  const schedule = buildConvenioSchedule(asOfDate);

  // Aplanar TODOS los CARGOS MXN de TODAS las cuentas/cías.
  const allCargos: Candidate[] = [];
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const stmt of bankStatements) {
    for (const line of stmt.movimientos || []) {
      if (!isCargo(line) || !isMxn(line)) continue;
      const fecha = line.fechaOperacion;
      if (fecha) {
        if (!earliest || fecha < earliest) earliest = fecha;
        if (!latest || fecha > latest) latest = fecha;
      }
      allCargos.push({
        idx: allCargos.length,
        importe: line.importe || 0,
        ref: {
          cia: line.cia,
          banco: line.nombreBanco || line.banco,
          cuenta: line.cuenta,
          fechaOperacion: fecha,
          concepto: line.concepto || '',
          referencia: line.referencia || '',
          importe: line.importe || 0,
        },
      });
    }
  }

  const consumed = new Set<number>();
  const matches: ConvenioReconciliationMatch[] = [];

  for (const q of schedule.elapsed) {
    const target = q.totalMxn;
    const tol = Math.max(target * config.amountTolerancePct, config.amountToleranceMinAbs);
    const windowStart = shiftIso(q.scheduledDateIso, -config.daysBefore);
    const windowEnd = shiftIso(q.scheduledDateIso, config.daysAfter);

    const inWindow = allCargos.filter(
      (c) =>
        !consumed.has(c.idx) &&
        c.ref.fechaOperacion >= windowStart &&
        c.ref.fechaOperacion <= windowEnd,
    );

    // ¿Hay datos bancarios que cubran esta ventana? Si la cobertura global no
    // intersecta la ventana, es "sin datos" (no "no empatado").
    const coverageOverlaps =
      earliest !== null && latest !== null && earliest <= windowEnd && latest >= windowStart;

    const base = buildBaseMatch(q);

    if (!coverageOverlaps) {
      matches.push({ ...base, status: 'sin-datos-banco', matchTier: 'none' });
      continue;
    }

    // Tier 1/2: un solo CARGO. Buscar el más cercano al objetivo.
    let bestSingle: Candidate | null = null;
    let bestSingleErr = Infinity;
    for (const c of inWindow) {
      const err = Math.abs(c.importe - target);
      if (err < bestSingleErr) {
        bestSingleErr = err;
        bestSingle = c;
      }
    }
    const exactTol = Math.max(target * 0.005, 1);
    if (bestSingle && bestSingleErr <= exactTol) {
      consumed.add(bestSingle.idx);
      matches.push(finalize(base, [bestSingle], target, 'exact', 0.97));
      continue;
    }
    if (bestSingle && bestSingleErr <= tol) {
      consumed.add(bestSingle.idx);
      const conf = 0.9 - Math.min(0.25, bestSingleErr / target);
      matches.push(finalize(base, [bestSingle], target, 'tolerance', conf));
      continue;
    }

    // Tier 3: suma de subconjuntos (pago partido en varias cuentas).
    const subsetPool = inWindow
      .filter((c) => c.importe >= target * 0.02)
      .sort((a, b) => b.importe - a.importe)
      .slice(0, 24);
    const subset = findSubset(subsetPool, target, tol, config.maxSubsetSize);
    if (subset && subset.length > 0) {
      const sum = subset.reduce((s, c) => s + c.importe, 0);
      subset.forEach((c) => consumed.add(c.idx));
      const conf = 0.72 - Math.min(0.2, Math.abs(sum - target) / target);
      matches.push(finalize(base, subset, target, 'subset', conf));
      continue;
    }

    // Parcial: un CARGO grande que cubre parte pero queda bajo tolerancia.
    if (bestSingle && bestSingle.importe >= target * 0.4 && bestSingle.importe < target - tol) {
      consumed.add(bestSingle.idx);
      matches.push({
        ...finalize(base, [bestSingle], target, 'tolerance', 0.4),
        status: 'partial',
      });
      continue;
    }

    matches.push({ ...base, status: 'unmatched', matchTier: 'none' });
  }

  const summary: ConvenioReconciliationSummary = {
    elapsedCount: schedule.elapsed.length,
    matchedCount: matches.filter((m) => m.status === 'matched').length,
    partialCount: matches.filter((m) => m.status === 'partial').length,
    unmatchedCount: matches.filter((m) => m.status === 'unmatched').length,
    noBankDataCount: matches.filter((m) => m.status === 'sin-datos-banco').length,
    scheduledElapsedMxn: schedule.totals.elapsedTotalMxn,
    matchedMxn: matches.reduce((s, m) => s + m.matchedAmountMxn, 0),
    varianceMxn: matches
      .filter((m) => m.status === 'matched')
      .reduce((s, m) => s + m.deltaMxn, 0),
    bankCoverage: { earliest, latest, cargoCount: allCargos.length },
  };

  return { matches, summary, config };
}

function buildBaseMatch(q: ConvenioScheduledPayment): ConvenioReconciliationMatch {
  return {
    key: q.key,
    year: q.year,
    month: q.month,
    monthIndex: q.monthIndex,
    scheduledDateIso: q.scheduledDateIso,
    scheduledTotalMxn: q.totalMxn,
    status: 'unmatched',
    matchTier: 'none',
    matchedAmountMxn: 0,
    deltaMxn: 0,
    deltaPct: 0,
    confidence: 0,
    bankMovements: [],
  };
}

function finalize(
  base: ConvenioReconciliationMatch,
  picks: Candidate[],
  target: number,
  tier: ConvenioMatchTier,
  confidence: number,
): ConvenioReconciliationMatch {
  const matchedAmountMxn = picks.reduce((s, c) => s + c.importe, 0);
  const deltaMxn = matchedAmountMxn - target;
  return {
    ...base,
    status: 'matched',
    matchTier: tier,
    matchedAmountMxn,
    deltaMxn,
    deltaPct: target > 0 ? deltaMxn / target : 0,
    confidence: Math.max(0, Math.min(1, confidence)),
    bankMovements: picks.map((c) => c.ref),
  };
}
