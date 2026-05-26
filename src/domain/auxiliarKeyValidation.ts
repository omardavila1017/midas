/**
 * Auxiliar Contable ↔ Bancos — validación de hipótesis de llave determinista.
 *
 * Función pura, sin I/O. Recibe los registros ya pulled del API/cache y
 * devuelve un reporte estructurado que decide si vale la pena implementar el
 * Tier 0 determinista en `auxiliarReconciliationEngine`.
 *
 * Hipótesis bajo prueba:
 *   1. `bancos.gsaid === auxiliarcontable.idCuenta` produce match 1:1.
 *   2. Filtrar `Tipo_Batch ∈ BANK_TIPO_BATCH` deja sólo movimientos bancarios.
 *   3. `deriveFlujo` por signo de importe es válido (vs derivar por Tipo_Docto).
 *
 * Gate de promoción a Fase 1: matchRate ≥ 95% en muestra real, concordancia
 * cuenta+importe ≥ 99% en los matched, y 0 colisiones (mismo gsaid apareciendo
 * en > 1 línea o > 1 movimiento bancario).
 */

import type {
  AuxiliarContableRecord,
  BankAccountStatement,
  BankStatementLine,
} from '../services/jdeTypes';
import { BANK_TIPO_BATCH } from './auxiliarReconciliationConfig';

export { BANK_TIPO_BATCH };

export interface KeyValidationInput {
  records: AuxiliarContableRecord[];
  bankStatements: BankAccountStatement[];
  /** Compañía a inspeccionar; si se omite se toma todo lo que venga. */
  cia?: string;
  /** Filtro de Tipo_Batch — default = BANK_TIPO_BATCH. Pasa Set vacío para no filtrar. */
  tipoBatchFilter?: ReadonlySet<string>;
  /** true (default) = sólo cuenta_objeto = 1020 para el cruce. */
  restrictTo1020?: boolean;
}

export interface CoverageStats {
  totalRecords: number;
  totalBankLines: number;
  recordsAfterFilter: number;
  bankLinesAfterFilter: number;
  recordsWithIdCuenta: number;
  bankLinesWithGsaid: number;
}

/**
 * Granularidad del campo de llave inferida de la distribución observada.
 *   • line-level   — un valor único por movimiento (auxRecordsPerKey ≈ 1).
 *   • account-level — un valor compartido por muchos movimientos del mismo
 *                    bank account (auxRecordsPerKey ≫ 1, cuenta consistente).
 *                    NO sirve para join 1:1.
 *   • mixed        — distribución ambigua.
 *   • inconclusive — sin datos suficientes.
 */
export type KeyGranularity = 'line-level' | 'account-level' | 'mixed' | 'inconclusive';

export interface KeyMatchStats {
  keyName: string;
  recordsWithKey: number;
  bankLinesWithKey: number;
  matchedCount: number;
  /** % matched / min(recordsWithKey, bankLinesWithKey). null si la base es 0. */
  matchRatePct: number | null;
  auxiliarCollisions: number;
  bankCollisions: number;
  cuentaConcordancePct: number | null;
  importeExactConcordancePct: number | null;
  importeNearConcordancePct: number | null;
  fechaWithin1dPct: number | null;
  estatusReconciledPct: number | null;
  mismatchSamples: KeyMismatchSample[];
  /** Llaves únicas (cardinalidad) del lado auxiliar. */
  uniqueKeysOnAuxSide: number;
  /** Llaves únicas (cardinalidad) del lado bancos. */
  uniqueKeysOnBankSide: number;
  /** Promedio de records auxiliares por key. >>1 indica account-level. */
  auxRecordsPerKey: number;
  /** Promedio de líneas bancarias por key. */
  bankLinesPerKey: number;
  /**
   * % de keys compartidas donde TODAS las apariciones del lado aux están en la
   * misma cuenta bancaria. Si ≈100% y auxRecordsPerKey>>1 → account-level
   * (la "llave" es el ID de cuenta, no del movimiento).
   */
  sameCuentaWithinKeyPct: number | null;
  granularity: KeyGranularity;
}

export interface KeyMismatchSample {
  key: string;
  auxiliar: {
    cia: string;
    cuentaBanco: string;
    importe: number;
    fechaContable: string;
    estatusConciliado: string;
    tipoDocto: string;
  };
  bank: {
    cia: string;
    cuenta: string;
    importe: number;
    tipoMovimiento: string;
    fechaOperacion: string;
  };
  reasons: string[];
}

export interface FlujoSignAudit {
  byTipoDocto: Array<{
    tipoDocto: string;
    count: number;
    positives: number;
    negatives: number;
    zeros: number;
    positivePct: number;
  }>;
  overallPositivePct: number;
  /** true si todos los importes son ≥ 0 — entonces deriveFlujo por signo falla. */
  allNonNegative: boolean;
}

export interface TipoBatchAudit {
  histogram: Array<{ tipoBatch: string; count: number; keptByFilter: boolean }>;
  keptPct: number;
}

export interface KeyValidationVerdict {
  primaryKeyViable: boolean;
  deriveFlujoBySignViable: boolean;
  notes: string[];
  recommendation:
    | 'proceed-with-move-1'
    | 'switch-to-fallback-key'
    | 'fix-derive-flujo-first'
    | 'insufficient-data';
}

export interface KeyValidationReport {
  cia: string | null;
  coverage: CoverageStats;
  primaryKey: KeyMatchStats; // gsaid ↔ idCuenta
  fallbackKeys: KeyMatchStats[]; // noBatch↔noRecibo, documentoOriginal↔noRecibo
  tipoBatchAudit: TipoBatchAudit;
  flujoSignAudit: FlujoSignAudit;
  verdict: KeyValidationVerdict;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function normalize(s: string | null | undefined): string {
  return (s ?? '').trim();
}

function isEmpty(s: string | null | undefined): boolean {
  return normalize(s) === '';
}

function approxEquals(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

function daysBetween(isoA: string, isoB: string): number {
  if (!isoA || !isoB) return Number.POSITIVE_INFINITY;
  const a = Date.parse(`${isoA}T00:00:00Z`);
  const b = Date.parse(`${isoB}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b) / DAY_MS;
}

function digitsOnly(s: string | null | undefined): string {
  return (s ?? '').replace(/\D+/g, '').replace(/^0+/, '');
}

function pct(num: number, den: number): number | null {
  if (den <= 0) return null;
  return (num / den) * 100;
}

// ── Núcleo: índice + match ────────────────────────────────────────────────

interface BankRef {
  line: BankStatementLine;
  stmtCia: string;
}

function buildBankIndex(
  statements: BankAccountStatement[],
  cia: string | null,
  keyOf: (line: BankStatementLine, stmtCia: string) => string,
): { index: Map<string, BankRef[]>; totalLines: number; linesWithKey: number; linesPassedCia: number } {
  const index = new Map<string, BankRef[]>();
  let total = 0;
  let withKey = 0;
  let passedCia = 0;
  for (const stmt of statements) {
    if (cia && normalize(stmt.cia) !== cia) {
      total += stmt.movimientos.length;
      continue;
    }
    for (const line of stmt.movimientos) {
      total++;
      if (cia && normalize(line.cia || stmt.cia) !== cia) continue;
      passedCia++;
      const k = keyOf(line, stmt.cia);
      if (!k) continue;
      withKey++;
      const bucket = index.get(k);
      if (bucket) bucket.push({ line, stmtCia: stmt.cia });
      else index.set(k, [{ line, stmtCia: stmt.cia }]);
    }
  }
  return { index, totalLines: total, linesWithKey: withKey, linesPassedCia: passedCia };
}

function classifyGranularity(
  auxRecordsPerKey: number,
  bankLinesPerKey: number,
  sameCuentaPct: number | null,
): KeyGranularity {
  if (auxRecordsPerKey === 0 && bankLinesPerKey === 0) return 'inconclusive';
  const lineish = auxRecordsPerKey <= 1.5 && bankLinesPerKey <= 1.5;
  if (lineish) return 'line-level';
  // Heavy repetition with consistent cuenta → it's the account ID.
  if ((sameCuentaPct ?? 0) >= 90 && (auxRecordsPerKey > 3 || bankLinesPerKey > 3)) {
    return 'account-level';
  }
  return 'mixed';
}

function matchOnKey(
  keyName: string,
  records: AuxiliarContableRecord[],
  recordKeyOf: (r: AuxiliarContableRecord) => string,
  statements: BankAccountStatement[],
  bankKeyOf: (line: BankStatementLine, stmtCia: string) => string,
  cia: string | null,
): KeyMatchStats {
  const auxByKey = new Map<string, AuxiliarContableRecord[]>();
  let recordsWithKey = 0;
  for (const rec of records) {
    const k = recordKeyOf(rec);
    if (!k) continue;
    recordsWithKey++;
    const bucket = auxByKey.get(k);
    if (bucket) bucket.push(rec);
    else auxByKey.set(k, [rec]);
  }

  const bank = buildBankIndex(statements, cia, bankKeyOf);

  let matched = 0;
  let cuentaConcord = 0;
  let cuentaBase = 0;
  let importeExact = 0;
  let importeNear = 0;
  let importeBase = 0;
  let fechaOk = 0;
  let fechaBase = 0;
  let estatusR = 0;
  let auxCollisions = 0;
  let bankCollisions = 0;
  const samples: KeyMismatchSample[] = [];

  for (const [key, auxList] of auxByKey) {
    const bankList = bank.index.get(key);
    if (!bankList || bankList.length === 0) continue;
    matched += Math.min(auxList.length, bankList.length);
    if (auxList.length > 1) auxCollisions++;
    if (bankList.length > 1) bankCollisions++;

    const rec = auxList[0];
    const ln = bankList[0].line;

    const recCuenta = digitsOnly(rec.cuentaBanco);
    const bankCuenta = digitsOnly(ln.cuenta || ln.cuentaBancos);
    if (recCuenta && bankCuenta) {
      cuentaBase++;
      if (recCuenta === bankCuenta) cuentaConcord++;
    }

    const recAbs = Math.abs(rec.importe);
    const bankAbs = Math.abs(ln.importe);
    if (recAbs > 0 || bankAbs > 0) {
      importeBase++;
      if (recAbs === bankAbs) importeExact++;
      if (approxEquals(recAbs, bankAbs, 0.01)) importeNear++;
    }

    if (rec.fechaContable && ln.fechaOperacion) {
      fechaBase++;
      if (daysBetween(rec.fechaContable, ln.fechaOperacion) <= 1) fechaOk++;
    }

    if (normalize(rec.estatusConciliado) === 'R') estatusR++;

    if (samples.length < 10) {
      const reasons: string[] = [];
      if (recCuenta && bankCuenta && recCuenta !== bankCuenta) reasons.push('cuenta');
      if (recAbs > 0 && bankAbs > 0 && !approxEquals(recAbs, bankAbs, 0.01)) reasons.push('importe');
      if (
        rec.fechaContable &&
        ln.fechaOperacion &&
        daysBetween(rec.fechaContable, ln.fechaOperacion) > 1
      ) {
        reasons.push('fecha');
      }
      if (reasons.length > 0) {
        samples.push({
          key,
          auxiliar: {
            cia: rec.cia,
            cuentaBanco: rec.cuentaBanco,
            importe: rec.importe,
            fechaContable: rec.fechaContable,
            estatusConciliado: rec.estatusConciliado,
            tipoDocto: rec.tipoDocto,
          },
          bank: {
            cia: ln.cia,
            cuenta: ln.cuenta,
            importe: ln.importe,
            tipoMovimiento: ln.tipoMovimiento,
            fechaOperacion: ln.fechaOperacion,
          },
          reasons,
        });
      }
    }
  }

  const matchBase = Math.min(recordsWithKey, bank.linesWithKey);

  // Granularidad inferida.
  const uniqueAux = auxByKey.size;
  const uniqueBank = bank.index.size;
  const auxRecordsPerKey = uniqueAux > 0 ? recordsWithKey / uniqueAux : 0;
  const bankLinesPerKey = uniqueBank > 0 ? bank.linesWithKey / uniqueBank : 0;

  let sameCuentaKeys = 0;
  let sameCuentaBase = 0;
  for (const auxList of auxByKey.values()) {
    if (auxList.length < 2) continue;
    sameCuentaBase++;
    const cuenta0 = digitsOnly(auxList[0].cuentaBanco);
    const allSame = auxList.every((r) => digitsOnly(r.cuentaBanco) === cuenta0);
    if (allSame) sameCuentaKeys++;
  }
  const sameCuentaWithinKeyPct = pct(sameCuentaKeys, sameCuentaBase);
  const granularity = classifyGranularity(auxRecordsPerKey, bankLinesPerKey, sameCuentaWithinKeyPct);

  return {
    keyName,
    recordsWithKey,
    bankLinesWithKey: bank.linesWithKey,
    matchedCount: matched,
    matchRatePct: pct(matched, matchBase),
    auxiliarCollisions: auxCollisions,
    bankCollisions: bankCollisions,
    cuentaConcordancePct: pct(cuentaConcord, cuentaBase),
    importeExactConcordancePct: pct(importeExact, importeBase),
    importeNearConcordancePct: pct(importeNear, importeBase),
    fechaWithin1dPct: pct(fechaOk, fechaBase),
    estatusReconciledPct: pct(estatusR, matched),
    mismatchSamples: samples,
    uniqueKeysOnAuxSide: uniqueAux,
    uniqueKeysOnBankSide: uniqueBank,
    auxRecordsPerKey,
    bankLinesPerKey,
    sameCuentaWithinKeyPct,
    granularity,
  };
}

// ── Auditorías auxiliares ─────────────────────────────────────────────────

function computeFlujoSignAudit(records: AuxiliarContableRecord[]): FlujoSignAudit {
  const byType = new Map<string, { count: number; pos: number; neg: number; zero: number }>();
  let total = 0;
  let positives = 0;
  for (const r of records) {
    const t = normalize(r.tipoDocto) || '(none)';
    let bucket = byType.get(t);
    if (!bucket) {
      bucket = { count: 0, pos: 0, neg: 0, zero: 0 };
      byType.set(t, bucket);
    }
    bucket.count++;
    total++;
    if (r.importe > 0) {
      bucket.pos++;
      positives++;
    } else if (r.importe < 0) {
      bucket.neg++;
    } else {
      bucket.zero++;
    }
  }
  const byTipoDocto = Array.from(byType.entries())
    .map(([tipoDocto, b]) => ({
      tipoDocto,
      count: b.count,
      positives: b.pos,
      negatives: b.neg,
      zeros: b.zero,
      positivePct: b.count > 0 ? (b.pos / b.count) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    byTipoDocto,
    overallPositivePct: total > 0 ? (positives / total) * 100 : 0,
    allNonNegative: total > 0 && byTipoDocto.every((b) => b.negatives === 0),
  };
}

function computeTipoBatchAudit(
  rawRecords: AuxiliarContableRecord[],
  filter: ReadonlySet<string>,
): TipoBatchAudit {
  const hist = new Map<string, number>();
  let kept = 0;
  for (const r of rawRecords) {
    const tb = normalize(r.tipoBatch);
    const label = tb === '' ? '(empty)' : tb;
    hist.set(label, (hist.get(label) ?? 0) + 1);
    if (filter.size === 0 || filter.has(tb)) kept++;
  }
  const histogram = Array.from(hist.entries())
    .map(([tipoBatch, count]) => {
      const raw = tipoBatch === '(empty)' ? '' : tipoBatch;
      return { tipoBatch, count, keptByFilter: filter.size === 0 || filter.has(raw) };
    })
    .sort((a, b) => b.count - a.count);
  return { histogram, keptPct: rawRecords.length > 0 ? (kept / rawRecords.length) * 100 : 0 };
}

// ── Pipeline + entry point ────────────────────────────────────────────────

function applyFilters(input: KeyValidationInput): {
  bankRecords: AuxiliarContableRecord[];
  pre1020Records: AuxiliarContableRecord[];
} {
  const cia = input.cia ? normalize(input.cia) : null;
  const tipoBatchFilter = input.tipoBatchFilter ?? BANK_TIPO_BATCH;
  const restrictTo1020 = input.restrictTo1020 ?? true;

  const ciaAndLibro = input.records.filter((r) => {
    if (cia && normalize(r.cia) !== cia) return false;
    if (normalize(r.tipoLibro) !== 'AA') return false;
    return true;
  });

  const bankRecords = ciaAndLibro.filter((r) => {
    if (restrictTo1020 && normalize(r.cuentaObjeto) !== '1020') return false;
    if (tipoBatchFilter.size > 0 && !tipoBatchFilter.has(normalize(r.tipoBatch))) return false;
    return true;
  });

  return { bankRecords, pre1020Records: ciaAndLibro };
}

function countBankCoverage(
  statements: BankAccountStatement[],
  cia: string | null,
): { total: number; afterFilter: number; withGsaid: number } {
  let total = 0;
  let afterFilter = 0;
  let withGsaid = 0;
  for (const stmt of statements) {
    for (const line of stmt.movimientos) {
      total++;
      if (cia) {
        if (normalize(stmt.cia) !== cia) continue;
        if (normalize(line.cia || stmt.cia) !== cia) continue;
      }
      afterFilter++;
      if (!isEmpty(line.gsaid)) withGsaid++;
    }
  }
  return { total, afterFilter, withGsaid };
}

/** Punto de entrada. */
export function validateAuxiliarBankKeys(input: KeyValidationInput): KeyValidationReport {
  const cia = input.cia ? normalize(input.cia) : null;
  const { bankRecords, pre1020Records } = applyFilters(input);

  let recordsWithIdCuenta = 0;
  for (const r of bankRecords) {
    if (!isEmpty(r.idCuenta)) recordsWithIdCuenta++;
  }
  const bankCov = countBankCoverage(input.bankStatements, cia);

  const coverage: CoverageStats = {
    totalRecords: input.records.length,
    totalBankLines: bankCov.total,
    recordsAfterFilter: bankRecords.length,
    bankLinesAfterFilter: bankCov.afterFilter,
    recordsWithIdCuenta,
    bankLinesWithGsaid: bankCov.withGsaid,
  };

  const primaryKey = matchOnKey(
    'gsaid ↔ idCuenta',
    bankRecords,
    (r) => normalize(r.idCuenta),
    input.bankStatements,
    (line) => normalize(line.gsaid),
    cia,
  );

  const fallbackNoBatch = matchOnKey(
    'noBatch ↔ noRecibo',
    bankRecords,
    (r) => (r.noBatch > 0 ? String(r.noBatch) : ''),
    input.bankStatements,
    (line) => normalize(line.noRecibo),
    cia,
  );

  const fallbackDocOrig = matchOnKey(
    'documentoOriginal ↔ noRecibo',
    bankRecords,
    (r) => normalize(r.documentoOriginal),
    input.bankStatements,
    (line) => normalize(line.noRecibo),
    cia,
  );

  const ciaLibro1020 = pre1020Records.filter((r) => normalize(r.cuentaObjeto) === '1020');
  const tipoBatchAudit = computeTipoBatchAudit(
    ciaLibro1020,
    input.tipoBatchFilter ?? BANK_TIPO_BATCH,
  );

  const flujoSignAudit = computeFlujoSignAudit(bankRecords);

  // Veredicto.
  const notes: string[] = [];
  let primaryViable = false;
  if (primaryKey.matchRatePct === null) {
    notes.push('Sin gsaid / idCuenta en la muestra — sample insuficiente.');
  } else if (primaryKey.matchRatePct >= 95) {
    primaryViable = true;
    notes.push(`Primary key match ${primaryKey.matchRatePct.toFixed(1)}% — Tier 0 viable.`);
  } else {
    notes.push(
      `Primary key match ${primaryKey.matchRatePct.toFixed(1)}% — debajo del 95% gate. Evalúa fallbacks.`,
    );
  }
  if ((primaryKey.cuentaConcordancePct ?? 100) < 99) {
    notes.push(
      `Cuenta concordance ${primaryKey.cuentaConcordancePct?.toFixed(1)}% — investiga divergencias.`,
    );
  }
  if ((primaryKey.importeExactConcordancePct ?? 100) < 99) {
    notes.push(
      `Importe exact concordance ${primaryKey.importeExactConcordancePct?.toFixed(1)}% — comisiones/centavos?`,
    );
  }
  if (primaryKey.auxiliarCollisions > 0 || primaryKey.bankCollisions > 0) {
    notes.push(
      `Colisiones: aux ${primaryKey.auxiliarCollisions} / bank ${primaryKey.bankCollisions} — la llave NO es 1:1.`,
    );
    primaryViable = false;
  }
  if (primaryKey.granularity === 'account-level') {
    notes.push(
      `Granularidad detectada: account-level (auxRecordsPerKey=${primaryKey.auxRecordsPerKey.toFixed(1)}, sameCuentaWithinKey=${primaryKey.sameCuentaWithinKeyPct?.toFixed(0)}%). El campo identifica la CUENTA bancaria, no el MOVIMIENTO. No sirve para join 1:1.`,
    );
    primaryViable = false;
  } else if (primaryKey.granularity === 'mixed') {
    notes.push(
      `Granularidad ambigua (auxRecordsPerKey=${primaryKey.auxRecordsPerKey.toFixed(1)}, sameCuentaWithinKey=${primaryKey.sameCuentaWithinKeyPct?.toFixed(0)}%). Inspecciona muestras antes de promover a Tier 0.`,
    );
  }

  const deriveFlujoBySignViable = !flujoSignAudit.allNonNegative;
  if (flujoSignAudit.allNonNegative) {
    notes.push(
      'Importes todos no-negativos: deriveFlujo por signo NO funciona. Rewire a Tipo_Docto.',
    );
  }

  let recommendation: KeyValidationVerdict['recommendation'];
  if (coverage.recordsWithIdCuenta === 0 || coverage.bankLinesWithGsaid === 0) {
    recommendation = 'insufficient-data';
  } else if (primaryViable && deriveFlujoBySignViable) {
    recommendation = 'proceed-with-move-1';
  } else if (!deriveFlujoBySignViable) {
    recommendation = 'fix-derive-flujo-first';
  } else {
    recommendation = 'switch-to-fallback-key';
  }

  return {
    cia,
    coverage,
    primaryKey,
    fallbackKeys: [fallbackNoBatch, fallbackDocOrig],
    tipoBatchAudit,
    flujoSignAudit,
    verdict: {
      primaryKeyViable: primaryViable,
      deriveFlujoBySignViable,
      notes,
      recommendation,
    },
  };
}

/** Formatea reporte para consola — texto legible, no JSON crudo. */
export function formatReport(report: KeyValidationReport): string {
  const lines: string[] = [];
  const f = (n: number | null, suffix = '%') => (n === null ? 'n/a' : `${n.toFixed(1)}${suffix}`);

  lines.push('═══ Auxiliar ↔ Bancos — Validación de llave ═══');
  lines.push(`Cia: ${report.cia ?? '(todas)'}`);
  lines.push('');
  lines.push('— Coverage —');
  lines.push(`  records raw:            ${report.coverage.totalRecords}`);
  lines.push(`  records tras filtro:    ${report.coverage.recordsAfterFilter}`);
  lines.push(`  records con idCuenta:   ${report.coverage.recordsWithIdCuenta}`);
  lines.push(`  bank lines raw:         ${report.coverage.totalBankLines}`);
  lines.push(`  bank lines tras cia:    ${report.coverage.bankLinesAfterFilter}`);
  lines.push(`  bank lines con gsaid:   ${report.coverage.bankLinesWithGsaid}`);
  lines.push('');
  lines.push('— Tipo_Batch audit (objeto 1020) —');
  lines.push(`  filtro mantiene: ${report.tipoBatchAudit.keptPct.toFixed(1)}% de records 1020`);
  for (const h of report.tipoBatchAudit.histogram.slice(0, 12)) {
    const mark = h.keptByFilter ? '✓' : ' ';
    lines.push(`    ${mark} ${h.tipoBatch.padEnd(8)} ${h.count}`);
  }
  lines.push('');
  lines.push(`— Primary key: ${report.primaryKey.keyName} —`);
  lines.push(`  records con llave:     ${report.primaryKey.recordsWithKey}`);
  lines.push(`  bank lines con llave:  ${report.primaryKey.bankLinesWithKey}`);
  lines.push(`  matched:               ${report.primaryKey.matchedCount}`);
  lines.push(`  match rate:            ${f(report.primaryKey.matchRatePct)}`);
  lines.push(`  cuenta concord:        ${f(report.primaryKey.cuentaConcordancePct)}`);
  lines.push(`  importe exact:         ${f(report.primaryKey.importeExactConcordancePct)}`);
  lines.push(`  importe ±0.01:         ${f(report.primaryKey.importeNearConcordancePct)}`);
  lines.push(`  fecha ±1d:             ${f(report.primaryKey.fechaWithin1dPct)}`);
  lines.push(`  estatus R en matched:  ${f(report.primaryKey.estatusReconciledPct)}`);
  lines.push(
    `  colisiones aux/bank:   ${report.primaryKey.auxiliarCollisions} / ${report.primaryKey.bankCollisions}`,
  );
  lines.push(
    `  granularidad:          ${report.primaryKey.granularity} (aux/key=${report.primaryKey.auxRecordsPerKey.toFixed(1)}, bank/key=${report.primaryKey.bankLinesPerKey.toFixed(1)}, sameCuenta=${f(report.primaryKey.sameCuentaWithinKeyPct)})`,
  );
  lines.push('');
  for (const fk of report.fallbackKeys) {
    lines.push(`— Fallback: ${fk.keyName} —`);
    lines.push(`  match rate: ${f(fk.matchRatePct)}  (matched ${fk.matchedCount})`);
  }
  lines.push('');
  lines.push('— Flujo sign audit —');
  lines.push(`  overall positivos:  ${report.flujoSignAudit.overallPositivePct.toFixed(1)}%`);
  lines.push(`  all non-negative:   ${report.flujoSignAudit.allNonNegative}`);
  for (const b of report.flujoSignAudit.byTipoDocto.slice(0, 10)) {
    lines.push(
      `    ${b.tipoDocto.padEnd(6)} count=${b.count} pos=${b.positives} neg=${b.negatives} (+${b.positivePct.toFixed(0)}%)`,
    );
  }
  lines.push('');
  lines.push('— Veredicto —');
  lines.push(`  recomendación: ${report.verdict.recommendation}`);
  for (const n of report.verdict.notes) lines.push(`  • ${n}`);
  return lines.join('\n');
}
