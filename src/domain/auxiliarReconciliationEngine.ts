/**
 * Auxiliar Contable Reconciliation Engine — Libro mayor JDE ↔ Estado de cuenta
 *
 * Reemplaza a `realReconciliationEngine` (cobranza↔ABONO) y
 * `paymentReconciliationEngine` (pagoProveedor↔CARGO). En vez de cruzar un
 * documento fuente difuso contra un movimiento bancario, cruza el LIBRO
 * MAYOR de JDE (API /AuxiliarContable, objeto 1010-1020) contra las líneas
 * reales del estado de cuenta. Ambos lados son registros contables, así que
 * el match por (cuenta bancaria, fecha, importe) es casi determinista —
 * "cruce al 100%".
 *
 * Cada línea GL es trazable a su documento fuente (factura, OC, pago) y trae
 * el flag propio de conciliación de JDE (`estatusConciliado`).
 *
 * Capas de match (por cuenta bancaria, dentro de la misma dirección de flujo):
 *   • jde-reconciled — la línea trae `estatusConciliado === 'R'`: JDE ya la
 *     concilió. Confiada de entrada; igual se intenta emparejar con una línea
 *     bancaria para mostrar la contraparte.
 *   • exact — misma cuenta, misma fecha, importe al céntimo.
 *   • tolerance — misma cuenta, importe ±0.5% (mín ±$1), fecha ±5 días.
 *   • gl-orphan — asiento JDE sin movimiento bancario (timing / error).
 *
 * Buckets aparte (no cuentan como cruce fallido):
 *   • caja — líneas de objeto 1010: no tienen estado de cuenta bancario.
 *   • interno — traspasos entre cuentas propias del grupo.
 *
 * Movimientos bancarios sin línea GL → `bankOrphans` (comisiones, intereses
 * no asentados).
 */

import type {
  AuxiliarContableRecord,
  BankAccountStatement,
  BankStatementLine,
} from '../services/jdeTypes';
import { bankMovementKey } from './bankMovementKey';
import { findBankAccount } from './bankAccountsCatalog';
import { buildOwnAccountsIndex, buildOwnAccountDetector, isInternalTransfer } from './netCashFlowEngine';
import { describeDocType } from './jdeDocTypeCatalog';

// ── Configuración ──────────────────────────────────────────────────────────

/** Tolerancia relativa de importe para la capa `tolerance`. */
const AMOUNT_TOLERANCE_PCT = 0.005;
/** Tolerancia absoluta mínima de importe. */
const AMOUNT_TOLERANCE_MIN_ABS = 1;
/** Ventana de fecha (±N días) para la capa `tolerance`. */
const DATE_WINDOW_DAYS = 5;
const DAY_MS = 86_400_000;

// ── Tipos públicos ─────────────────────────────────────────────────────────

export type AuxiliarFlujo = 'ingreso' | 'egreso';

export type AuxiliarMatchTier =
  | 'jde-reconciled'
  | 'exact'
  | 'tolerance'
  | 'gl-orphan'
  | 'caja'
  | 'interno';

/** Documento fuente al que una línea GL es trazable. */
export interface AuxiliarSourceRef {
  kind: 'factura' | 'oc' | 'pago' | 'otro';
  cia: string;
  ref: string;
  contraparte?: string;
}

/** Una línea del libro mayor JDE con su estado de conciliación. */
export interface AuxiliarReconLine {
  /** Llave estable: `cia::idCuenta::tipoDocto::noDocto`. */
  glKey: string;
  cia: string;
  cuentaBanco: string;
  nombreCuenta: string;
  flujo: AuxiliarFlujo;
  /** true si la línea es de objeto caja (1010), sin contraparte bancaria. */
  esCaja: boolean;
  fechaContable: string;
  /** Importe con signo crudo del asiento. */
  importe: number;
  moneda: string;
  tipoDocto: string;
  tipoDoctoDesc: string;
  estatusConciliado: string;
  matchTier: AuxiliarMatchTier;
  confidence: number;
  /** Contraparte bancaria emparejada (cuando matchTier la produjo). */
  bankMovementKey?: string;
  bankDate?: string;
  bankAmount?: number;
  /** Documento fuente. */
  source: AuxiliarSourceRef;
}

/** Movimiento bancario sin línea GL que lo respalde. */
export interface AuxiliarBankOrphan {
  movementKey: string;
  cia: string;
  cuenta: string;
  fecha: string;
  importe: number;
  flujo: AuxiliarFlujo;
  concepto: string;
  referencia: string;
}

/** Confirmación de un documento fuente contra el banco — contrato con la proyección. */
export interface AuxiliarSourceConfirmation {
  confirmed: boolean;
  flujo: AuxiliarFlujo;
  importe: number;
  bankDate?: string;
  fechaContable: string;
}

export interface AuxiliarReconSummary {
  totalLineas: number;
  ingresoLineas: number;
  ingresoCruzadas: number;
  ingresoMonto: number;
  ingresoMontoCruzado: number;
  /** % de líneas de ingreso cruzadas a banco (0..100). Excluye caja/interno. */
  pctIngresoCruzado: number;
  egresoLineas: number;
  egresoCruzadas: number;
  egresoMonto: number;
  egresoMontoCruzado: number;
  /** % de líneas de egreso cruzadas a banco (0..100). Excluye caja/interno. */
  pctEgresoCruzado: number;
  /** Líneas con `estatusConciliado === 'R'` (conciliadas por JDE). */
  conciliadasJde: number;
  cajaLineas: number;
  cajaMonto: number;
  internoLineas: number;
  internoMonto: number;
  glOrphanLineas: number;
  glOrphanMonto: number;
  bankOrphanLineas: number;
  bankOrphanMonto: number;
  ciaBreakdown: Array<{ cia: string; lineas: number; cruzadas: number; pct: number }>;
}

export interface AuxiliarReconResult {
  lines: AuxiliarReconLine[];
  bankOrphans: AuxiliarBankOrphan[];
  /**
   * Por documento fuente, ¿quedó confirmado contra el banco? La proyección
   * usa este mapa para no re-proyectar facturas/OCs/pagos ya consumados.
   * Llaves: `factura:${cia}::${ref}`, `oc:${cia}::${ref}`, `pago:${cia}::${ref}`.
   */
  sourceConfirmation: Map<string, AuxiliarSourceConfirmation>;
  summary: AuxiliarReconSummary;
}

export interface AuxiliarReconOptions {
  /** Si se pasa, solo se concilian estas compañías. */
  ciaFilter?: Set<string>;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Dirección de flujo de una línea GL. Chokepoint único — ver Riesgos del plan. */
export function deriveFlujo(record: Pick<AuxiliarContableRecord, 'importe'>): AuxiliarFlujo {
  // Convención asumida: en una cuenta de activo (banco/caja) un cargo
  // contable (importe positivo) incrementa el saldo = entra dinero = ingreso;
  // un abono contable (negativo) lo reduce = egreso. PENDIENTE de verificar
  // con datos reales — si el API entrega todo positivo habrá que derivar la
  // dirección de `Tipo_Docto`.
  return record.importe < 0 ? 'egreso' : 'ingreso';
}

/** Llave canónica de cuenta bancaria, tolerante a padding por banco. */
function accountMatchKey(cuenta: string | null | undefined): string {
  const entry = findBankAccount(cuenta);
  if (entry && entry.cuentaDigits) {
    const digits = entry.cuentaDigits.replace(/\D+/g, '').replace(/^0+/, '');
    if (digits) return `c:${digits}`;
  }
  const raw = (cuenta ?? '').replace(/\D+/g, '').replace(/^0+/, '');
  return raw ? `d:${raw}` : '';
}

function daysBetween(isoA: string, isoB: string): number {
  if (!isoA || !isoB) return Number.POSITIVE_INFINITY;
  const a = Date.parse(`${isoA}T00:00:00Z`);
  const b = Date.parse(`${isoB}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(a - b) / DAY_MS;
}

function amountWithinTolerance(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  const tol = Math.max(AMOUNT_TOLERANCE_MIN_ABS, Math.abs(a) * AMOUNT_TOLERANCE_PCT);
  return diff <= tol;
}

/** Llaves de documento fuente que esta línea GL confirma. */
function sourceKeysFor(rec: AuxiliarContableRecord): string[] {
  const keys: string[] = [];
  if (rec.noFactura) keys.push(`factura:${rec.cia}::${rec.noFactura}`);
  if (rec.noOrdenCompra) keys.push(`oc:${rec.cia}::${rec.noOrdenCompra}`);
  if (rec.tipoPago && rec.noPago) keys.push(`pago:${rec.cia}::${rec.tipoPago}${rec.noPago}`);
  return keys;
}

function deriveSource(rec: AuxiliarContableRecord): AuxiliarSourceRef {
  const contraparte = rec.nombre || rec.nombreCuenta || undefined;
  if (rec.noFactura) return { kind: 'factura', cia: rec.cia, ref: rec.noFactura, contraparte };
  if (rec.noOrdenCompra) return { kind: 'oc', cia: rec.cia, ref: rec.noOrdenCompra, contraparte };
  if (rec.tipoPago && rec.noPago) {
    return { kind: 'pago', cia: rec.cia, ref: `${rec.tipoPago}${rec.noPago}`, contraparte };
  }
  return { kind: 'otro', cia: rec.cia, ref: rec.concepto || rec.explicacion || String(rec.noDocto), contraparte };
}

function glKeyFor(rec: AuxiliarContableRecord): string {
  return `${rec.cia}::${rec.idCuenta}::${rec.tipoDocto}::${rec.noDocto}`;
}

// ── Estructuras internas de match ───────────────────────────────────────

interface BankNorm {
  line: BankStatementLine;
  movementKey: string;
  accountKey: string;
  flujo: AuxiliarFlujo;
  fecha: string;
  importe: number;
  internal: boolean;
  consumed: boolean;
}

const CONFIDENCE: Record<AuxiliarMatchTier, number> = {
  'jde-reconciled': 0.99,
  exact: 0.97,
  tolerance: 0.85,
  'gl-orphan': 0,
  caja: 0,
  interno: 0,
};

// ── Motor ────────────────────────────────────────────────────────────────

export function reconcileAuxiliar(
  records: AuxiliarContableRecord[],
  bankStatements: BankAccountStatement[],
  options: AuxiliarReconOptions = {},
): AuxiliarReconResult {
  const ciaFilter = options.ciaFilter;
  const passesCia = (cia: string) => !ciaFilter || ciaFilter.has(cia);

  // 1. Normalizar líneas bancarias. Indexadas por `${accountKey}|${flujo}`.
  const ownAccountDetector = buildOwnAccountDetector(buildOwnAccountsIndex(bankStatements));
  const bankPool = new Map<string, BankNorm[]>();
  const allBankNorms: BankNorm[] = [];
  for (const stmt of bankStatements) {
    if (!passesCia(stmt.cia)) continue;
    for (const line of stmt.movimientos) {
      const flujo: AuxiliarFlujo = line.tipoMovimiento === 'ABONO' ? 'ingreso' : 'egreso';
      const accountKey = accountMatchKey(line.cuenta || line.cuentaBancos);
      const internal = isInternalTransfer(
        { concepto: line.concepto, referencia: line.referencia, cuenta: line.cuenta },
        ownAccountDetector,
      );
      const norm: BankNorm = {
        line,
        movementKey: bankMovementKey(line),
        accountKey,
        flujo,
        fecha: line.fechaOperacion,
        importe: Math.abs(line.importe),
        internal,
        consumed: false,
      };
      allBankNorms.push(norm);
      if (!accountKey || internal) continue;
      const poolKey = `${accountKey}|${flujo}`;
      const bucket = bankPool.get(poolKey);
      if (bucket) bucket.push(norm);
      else bankPool.set(poolKey, [norm]);
    }
  }

  // 2. Recorrer las líneas GL. Caja e interno se clasifican directo; el resto
  //    se empareja en dos pasadas (exacta → tolerancia).
  const lines: AuxiliarReconLine[] = [];
  const pending: Array<{ rec: AuxiliarContableRecord; line: AuxiliarReconLine; absImporte: number; accountKey: string }> = [];
  const recByGlKey = new Map<string, AuxiliarContableRecord>();

  for (const rec of records) {
    if (!passesCia(rec.cia)) continue;
    const flujo = deriveFlujo(rec);
    // Solo el objeto 1020 son cuentas bancarias con estado de cuenta. El
    // resto del rango (1010 caja) no tiene contraparte que cruzar.
    const esCaja = rec.cuentaObjeto !== '1020';
    const base: AuxiliarReconLine = {
      glKey: glKeyFor(rec),
      cia: rec.cia,
      cuentaBanco: rec.cuentaBanco,
      nombreCuenta: rec.nombreCuenta,
      flujo,
      esCaja,
      fechaContable: rec.fechaContable,
      importe: rec.importe,
      moneda: rec.moneda,
      tipoDocto: rec.tipoDocto,
      tipoDoctoDesc: describeDocType(rec.tipoDocto),
      estatusConciliado: rec.estatusConciliado,
      matchTier: 'gl-orphan',
      confidence: 0,
      source: deriveSource(rec),
    };
    recByGlKey.set(base.glKey, rec);

    if (esCaja) {
      base.matchTier = 'caja';
      lines.push(base);
      continue;
    }
    const internal = isInternalTransfer({
      concepto: rec.concepto,
      referencia: rec.explicacion,
      cuenta: rec.cuentaBanco,
    });
    if (internal) {
      base.matchTier = 'interno';
      lines.push(base);
      continue;
    }
    lines.push(base);
    pending.push({
      rec,
      line: base,
      absImporte: Math.abs(rec.importe),
      accountKey: accountMatchKey(rec.cuentaBanco),
    });
  }

  // Pasada A — match exacto (misma fecha, importe al céntimo).
  for (const item of pending) {
    const bucket = bankPool.get(`${item.accountKey}|${item.line.flujo}`);
    if (!bucket) continue;
    const hit = bucket.find(
      (b) => !b.consumed && b.fecha === item.line.fechaContable && b.importe === item.absImporte,
    );
    if (hit) {
      hit.consumed = true;
      item.line.bankMovementKey = hit.movementKey;
      item.line.bankDate = hit.fecha;
      item.line.bankAmount = hit.line.importe;
      item.line.matchTier = 'exact';
    }
  }

  // Pasada B — tolerancia (±0.5% importe, ±5 días) sobre las aún sin pareja.
  for (const item of pending) {
    if (item.line.bankMovementKey) continue;
    const bucket = bankPool.get(`${item.accountKey}|${item.line.flujo}`);
    if (!bucket) continue;
    let best: BankNorm | undefined;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const b of bucket) {
      if (b.consumed) continue;
      const dDays = daysBetween(b.fecha, item.line.fechaContable);
      if (dDays > DATE_WINDOW_DAYS) continue;
      if (!amountWithinTolerance(b.importe, item.absImporte)) continue;
      const delta = Math.abs(b.importe - item.absImporte) + dDays;
      if (delta < bestDelta) {
        bestDelta = delta;
        best = b;
      }
    }
    if (best) {
      best.consumed = true;
      item.line.bankMovementKey = best.movementKey;
      item.line.bankDate = best.fecha;
      item.line.bankAmount = best.line.importe;
      item.line.matchTier = 'tolerance';
    }
  }

  // 3. Tier final: `estatusConciliado === 'R'` gana sobre exact/tolerance/orphan.
  for (const item of pending) {
    if (item.line.estatusConciliado.trim().toUpperCase() === 'R') {
      item.line.matchTier = 'jde-reconciled';
    }
    item.line.confidence = CONFIDENCE[item.line.matchTier];
  }
  for (const line of lines) {
    line.confidence = CONFIDENCE[line.matchTier];
  }

  // 4. sourceConfirmation — contrato con la proyección.
  const sourceConfirmation = new Map<string, AuxiliarSourceConfirmation>();
  for (const line of lines) {
    const rec = recByGlKey.get(line.glKey);
    const confirmed =
      line.matchTier === 'jde-reconciled' ||
      line.matchTier === 'exact' ||
      line.matchTier === 'tolerance';
    if (line.matchTier === 'caja' || line.matchTier === 'interno') continue;
    const keys = rec ? sourceKeysFor(rec) : [];
    for (const key of keys) {
      const prior = sourceConfirmation.get(key);
      // Si cualquier línea de ese documento confirmó, el documento confirma.
      if (!prior || (!prior.confirmed && confirmed)) {
        sourceConfirmation.set(key, {
          confirmed,
          flujo: line.flujo,
          importe: line.importe,
          bankDate: line.bankDate,
          fechaContable: line.fechaContable,
        });
      }
    }
  }

  // 5. Movimientos bancarios sin línea GL (excluye internos).
  const bankOrphans: AuxiliarBankOrphan[] = [];
  for (const b of allBankNorms) {
    if (b.consumed || b.internal) continue;
    bankOrphans.push({
      movementKey: b.movementKey,
      cia: b.line.cia,
      cuenta: b.line.cuenta,
      fecha: b.fecha,
      importe: b.line.importe,
      flujo: b.flujo,
      concepto: b.line.concepto,
      referencia: b.line.referencia,
    });
  }

  return {
    lines,
    bankOrphans,
    sourceConfirmation,
    summary: buildSummary(lines, bankOrphans),
  };
}

function buildSummary(
  lines: AuxiliarReconLine[],
  bankOrphans: AuxiliarBankOrphan[],
): AuxiliarReconSummary {
  const s: AuxiliarReconSummary = {
    totalLineas: lines.length,
    ingresoLineas: 0,
    ingresoCruzadas: 0,
    ingresoMonto: 0,
    ingresoMontoCruzado: 0,
    pctIngresoCruzado: 0,
    egresoLineas: 0,
    egresoCruzadas: 0,
    egresoMonto: 0,
    egresoMontoCruzado: 0,
    pctEgresoCruzado: 0,
    conciliadasJde: 0,
    cajaLineas: 0,
    cajaMonto: 0,
    internoLineas: 0,
    internoMonto: 0,
    glOrphanLineas: 0,
    glOrphanMonto: 0,
    bankOrphanLineas: bankOrphans.length,
    bankOrphanMonto: bankOrphans.reduce((acc, b) => acc + Math.abs(b.importe), 0),
    ciaBreakdown: [],
  };
  const ciaAgg = new Map<string, { lineas: number; cruzadas: number }>();
  for (const line of lines) {
    const monto = Math.abs(line.importe);
    const cruzada =
      line.matchTier === 'jde-reconciled' ||
      line.matchTier === 'exact' ||
      line.matchTier === 'tolerance';
    if (line.estatusConciliado.trim().toUpperCase() === 'R') s.conciliadasJde += 1;

    if (line.matchTier === 'caja') {
      s.cajaLineas += 1;
      s.cajaMonto += monto;
      continue;
    }
    if (line.matchTier === 'interno') {
      s.internoLineas += 1;
      s.internoMonto += monto;
      continue;
    }
    if (line.matchTier === 'gl-orphan') {
      s.glOrphanLineas += 1;
      s.glOrphanMonto += monto;
    }
    const agg = ciaAgg.get(line.cia) ?? { lineas: 0, cruzadas: 0 };
    agg.lineas += 1;
    if (cruzada) agg.cruzadas += 1;
    ciaAgg.set(line.cia, agg);

    if (line.flujo === 'ingreso') {
      s.ingresoLineas += 1;
      s.ingresoMonto += monto;
      if (cruzada) {
        s.ingresoCruzadas += 1;
        s.ingresoMontoCruzado += monto;
      }
    } else {
      s.egresoLineas += 1;
      s.egresoMonto += monto;
      if (cruzada) {
        s.egresoCruzadas += 1;
        s.egresoMontoCruzado += monto;
      }
    }
  }
  s.pctIngresoCruzado = s.ingresoLineas > 0 ? (s.ingresoCruzadas / s.ingresoLineas) * 100 : 0;
  s.pctEgresoCruzado = s.egresoLineas > 0 ? (s.egresoCruzadas / s.egresoLineas) * 100 : 0;
  s.ciaBreakdown = Array.from(ciaAgg.entries())
    .map(([cia, agg]) => ({
      cia,
      lineas: agg.lineas,
      cruzadas: agg.cruzadas,
      pct: agg.lineas > 0 ? (agg.cruzadas / agg.lineas) * 100 : 0,
    }))
    .sort((a, b) => a.cia.localeCompare(b.cia));
  return s;
}

/** Resultado vacío — estado inicial antes de que corra la conciliación. */
export function emptyAuxiliarReconResult(): AuxiliarReconResult {
  return {
    lines: [],
    bankOrphans: [],
    sourceConfirmation: new Map(),
    summary: {
      totalLineas: 0,
      ingresoLineas: 0,
      ingresoCruzadas: 0,
      ingresoMonto: 0,
      ingresoMontoCruzado: 0,
      pctIngresoCruzado: 0,
      egresoLineas: 0,
      egresoCruzadas: 0,
      egresoMonto: 0,
      egresoMontoCruzado: 0,
      pctEgresoCruzado: 0,
      conciliadasJde: 0,
      cajaLineas: 0,
      cajaMonto: 0,
      internoLineas: 0,
      internoMonto: 0,
      glOrphanLineas: 0,
      glOrphanMonto: 0,
      bankOrphanLineas: 0,
      bankOrphanMonto: 0,
      ciaBreakdown: [],
    },
  };
}
