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
 *   • exact — misma cuenta, misma fecha, importe al céntimo.
 *   • tolerance — misma cuenta, importe ±5% (mín ±$1), fecha ±30 días.
 *   • cross-account — match en cuenta hermana de la misma cía.
 *   • jde-reconciled — sello final: la línea trae `estatusConciliado === 'R'`
 *     (JDE ya la concilió). Es CONFIRMACIÓN, no requisito: las líneas sin R
 *     que cruzaron por exact/tolerance/cross-account valen igual; el conteo
 *     `cruzadasSinR` las cuenta solo como info.
 *   • gl-orphan — asiento JDE sin movimiento bancario (timing / error).
 *
 * Buckets aparte (no cuentan como cruce fallido):
 *   • caja — líneas de objeto 1010: no tienen estado de cuenta bancario.
 *   • interno — traspasos entre cuentas propias del grupo. Tres señales,
 *     LAS MISMAS que usa la verdad bancaria (`buildHistoricalMonths`) y
 *     MOTOR 1: (a) narrativa GL / heurística bancaria (leyenda, RFC,
 *     beneficiario, cuenta propia), (b) cuenta con flow `neutro` en el
 *     catálogo de bancos, y (c) línea GL emparejada a un movimiento bancario
 *     pareado CARGO↔ABONO entre cuentas propias (±3d). Sin (b)/(c) los
 *     totales reconciliados incluían traspasos que el resto de Midas excluye
 *     y los brutos del Dashboard divergían de Planeación/Bancos.
 *
 * Movimientos bancarios sin línea GL → `bankOrphans` (comisiones, intereses
 * no asentados). Excluye los económicamente internos (pareados / neutros).
 */

import type {
  AuxiliarContableRecord,
  BankAccountStatement,
  BankStatementLine,
} from '../services/jdeTypes';
import { bankMovementKey } from './bankMovementKey';
import { enrichMovementWithCatalog, findBankAccount } from './bankAccountsCatalog';
import {
  buildOwnAccountsIndex,
  buildOwnAccountDetector,
  buildPairMatchedKeys,
  classifyMovement,
  isInternalTransfer,
} from './netCashFlowEngine';
import { describeDocType } from './jdeDocTypeCatalog';
import { BANK_TIPO_BATCH } from './auxiliarReconciliationConfig';

// ── Configuración ──────────────────────────────────────────────────────────

/** Tolerancia relativa de importe para la capa `tolerance`. Histórico:
 *  0.005 → 0.05 (5%) tras diagnóstico 2026-05; 0.05 → 0.10 (10%) tras
 *  diagnóstico 2026-05-26: cheques con SPEI fee + ISR retención + IVA
 *  acumulan diffs de 5-8% entre el asiento contable bruto y el cargo
 *  bancario neto. ±10% sigue siendo defensible (los pagos legítimos no
 *  difieren >10% del aux). */
const AMOUNT_TOLERANCE_PCT = 0.10;
/** Tolerancia absoluta mínima de importe. */
const AMOUNT_TOLERANCE_MIN_ABS = 1;
/** Ventana de fecha (±N días) para la capa `tolerance`. Histórico:
 *  5 → 30; 30 → 45 (2026-05-26): pagos a proveedores grandes y cobros
 *  intercompañía pueden lagear ±6 semanas entre asiento y cargo bancario. */
const DATE_WINDOW_DAYS = 45;
const DAY_MS = 86_400_000;

// ── Tipos públicos ─────────────────────────────────────────────────────────

export type AuxiliarFlujo = 'ingreso' | 'egreso';

export type AuxiliarMatchTier =
  | 'jde-reconciled'
  | 'exact'
  | 'tolerance'
  | 'gl-orphan'
  | 'caja'
  | 'interno'
  /** Asiento contable interno (tipoDocto=VI: registros de viaje) que llega
   *  como 1020 pero NO es movimiento bancario — no debe contarse como cruce
   *  fallido. */
  | 'asiento-interno'
  /** Asiento contable de tipoDocto journal-style (JX revaluación FX, AF
   *  ajustes, BA ajustes facturación, EX compensación, CZ contabilidad caja,
   *  T1 desembolso nómina, JG ajustes conciliación, JI journal interno,
   *  PF finiquito-accrual con tipoBatch=G, etc.). Estas líneas NO tienen
   *  contraparte bancaria por definición — son registros de ajuste. Se
   *  detectan post-matching: si la línea quedó como orphan Y su tipoDocto
   *  está en el catálogo de "asientos / contabilidad general", se
   *  reclasifica aquí (excluida del denominador). Si tiene contraparte real
   *  ya cruzó por exact/tolerance antes de esta reclasificación. */
  | 'asiento-contable'
  /** Cola de revisión humana — líneas que NO encontraron contraparte
   *  bancaria por matching automático y TAMPOCO encajan en ningún bucket
   *  semántico (no son asientos contables, no son caja, no es gap
   *  estructural, no es timing). Tipos comunes: cheques que pagaron
   *  intercompañía y el banco marcó el ABONO/CARGO como traspaso interno;
   *  RC/RO agregados (N líneas aux suman a 1 ABONO bancario); pagos cuyo
   *  importe difiere >10% por comisiones múltiples. Excluidas del
   *  denominador del % cruce — un humano de contabilidad debe revisarlas
   *  manualmente (o JDE las marca con `estatusConciliado='R'` directamente
   *  en el ERP y al siguiente run cruzan por la promoción `jde-reconciled`).
   *  El drilldown las muestra como sección primaria accionable. */
  | 'pendiente-revision'
  /** Línea aux 1020 cuya cía NO tiene estado de cuenta bancario cargado —
   *  match imposible por gap de datos, no por error del motor. */
  | 'sin-banco'
  /** Línea aux 1020 sin `cuentaBanco` poblada — no hay cuenta a la cual
   *  buscar contraparte. Gap del API, no error del motor. */
  | 'sin-cuenta-aux'
  /** Línea aux 1020 cuya `cuentaBanco` NO tiene NINGÚN movimiento bancario
   *  cargado (la cía sí tiene otros estados de cuenta, pero esta cuenta en
   *  particular no aparece en /bancos). Caso típico: cuenta `por_cancelar`
   *  inactiva contra la que el ERP sigue asentando reclasificaciones, o
   *  cuenta que el catálogo /bancos JDE no expone. Match imposible por gap
   *  de datos, no por error del motor. */
  | 'cuenta-no-en-banco'
  /** Línea aux 1020 cuya fechaContable es posterior al último movimiento
   *  del estado de cuenta de esa cuenta — banco aún no entregó el extracto
   *  del día. Match imposible por timing, no por error del motor. */
  | 'timing-pendiente'
  /** Match en cuenta hermana de la misma cía. La empresa asienta el pago en
   *  cuenta A pero el movimiento real salió de cuenta B (concentración de
   *  liquidez). Confianza menor que `tolerance` por la heurística. */
  | 'cross-account';

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
  /** Cuenta contable completa (BU.Objeto.Subsidiaria — p.ej. "42.1020.0010409"). */
  cuentaContable: string;
  /** Objeto contable ("1010" caja | "1020" bancos). */
  cuentaObjeto: string;
  /** Id de cuenta — usado para categorizar el flujo por rango (ver glAccountFlowCatalog). */
  idCuenta: string;
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

/**
 * Inconsistencia detectada por el engine — para auditoría. NO altera el
 * resultado del cruce; sólo lo anota. La UI las muestra como alertas
 * críticas para que el operador investigue antes de cerrar el período.
 */
export type AuxiliarInconsistencyKind = 'non-bank-batch-in-1020';

export interface AuxiliarInconsistency {
  kind: AuxiliarInconsistencyKind;
  cia: string;
  /** Referencia local — glKey, movementKey, gsaid, idCuenta según aplique. */
  ref: string;
  /** Detalle libre para UI / log. */
  detail: string;
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
  /** true si el movimiento cae fuera de la ventana de fechas del aux —
   *  match imposible por desfase temporal, no por error real. */
  outOfWindow: boolean;
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
  /** Líneas que cruzaron (exact/tolerance/cross-account) pero JDE NO marcó R.
   *  Informativo — el cruce vale igual; sirve para ver qué falta marcar en JDE. */
  cruzadasSinR: number;
  cajaLineas: number;
  cajaMonto: number;
  internoLineas: number;
  internoMonto: number;
  /** Asientos VI (viaje) en 1020 — no son movs bancarios. */
  asientoInternoLineas: number;
  asientoInternoMonto: number;
  /** Asientos contables (journal-style: JX, JG, AF, T1, BA, EX, etc.;
   *  finiquitos batch G/PF) — registros de ajuste sin contraparte bancaria
   *  por diseño. */
  asientoContableLineas: number;
  asientoContableMonto: number;
  /** Cola de revisión humana — orphans residuales tras todas las pasadas
   *  de match (incluida reclasificación asiento-contable). Excluidos del
   *  denominador del % cruce; el drilldown los expone como accionables. */
  pendienteRevisionLineas: number;
  pendienteRevisionMonto: number;
  /** Líneas aux cuya cía no tiene estados de cuenta cargados. */
  sinBancoLineas: number;
  sinBancoMonto: number;
  /** Líneas aux 1020 sin `cuentaBanco` poblada — no hay clave a buscar. */
  sinCuentaAuxLineas: number;
  sinCuentaAuxMonto: number;
  /** Líneas aux cuya cuentaBanco no tiene movimientos cargados (cuenta
   *  inactiva / no expuesta por /bancos). */
  cuentaNoEnBancoLineas: number;
  cuentaNoEnBancoMonto: number;
  /** Líneas aux posteriores al cierre del extracto bancario — banco aún
   *  no ha entregado el extracto del día. */
  timingPendienteLineas: number;
  timingPendienteMonto: number;
  glOrphanLineas: number;
  glOrphanMonto: number;
  /** Bank orphans dentro de la ventana aux — candidatos reales a investigar. */
  bankOrphanLineas: number;
  bankOrphanMonto: number;
  /** Bank orphans fuera de la ventana aux — match imposible por rango. */
  bankOrphanOutOfWindowLineas: number;
  bankOrphanOutOfWindowMonto: number;
  /** Ventana de fechas del aux 1020. Útil para mostrar al usuario. */
  auxWindow: { min: string | null; max: string | null };
  ciaBreakdown: Array<{ cia: string; lineas: number; cruzadas: number; pct: number }>;
  /** Conteos por tipo de inconsistencia detectada. */
  inconsistencyCounts: Record<AuxiliarInconsistencyKind, number>;
}

/**
 * Totales de flujo económico reconciliado por (cía, mes). Es la unidad de
 * verdad histórica sobre la que MOTOR 1 (histórico reconciliado) re-sourcea
 * los brutos de ingreso/egreso. `*Cruzado` cuenta sólo las líneas que cruzaron
 * a banco (jde-reconciled|exact|tolerance|cross-account); `*Total` incluye
 * además las líneas económicas sin cruce (gl-orphan) para poder medir cobertura.
 * Excluye buckets estructurales (caja, interno, asientos, timing, gaps). Llave
 * `${cia}::${yyyy-mm}`. El mes se bucketea por `bankDate` (verdad de caja)
 * cuando existe, con fallback a `fechaContable`.
 */
export interface ReconciledMonthTotals {
  cia: string;
  yearMonth: string;
  ingresoCruzado: number;
  egresoCruzado: number;
  ingresoTotal: number;
  egresoTotal: number;
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
  /**
   * Ingreso/egreso reconciliado por (cía, mes) — la verdad histórica de MOTOR 1.
   * Aditivo: no altera el cruce ni el summary, sólo lo agrega por mes.
   */
  reconciledByCompanyMonth: Map<string, ReconciledMonthTotals>;
  /**
   * Inconsistencias detectadas para auditoría (no alteran el cruce, sólo lo
   * anotan). La UI puede mostrarlas como alertas críticas previo a cierre.
   */
  inconsistencies: AuxiliarInconsistency[];
}

export interface AuxiliarReconOptions {
  /** Si se pasa, solo se concilian estas compañías. */
  ciaFilter?: Set<string>;
  /**
   * Tipos de Batch que cuentan como movimientos bancarios reales. Records de
   * objeto 1020 con otro `Tipo_Batch` se reportan como
   * `non-bank-batch-in-1020`. Default: `BANK_TIPO_BATCH`.
   * Pasar `null` desactiva la auditoría.
   */
  tipoBatchFilter?: ReadonlySet<string> | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Dirección de flujo de una línea GL. Chokepoint único — ver Riesgos del plan. */
export function deriveFlujo(record: Pick<AuxiliarContableRecord, 'importe'>): AuxiliarFlujo {
  // Convención CONFIRMADA por negocio (Santiago, 2026-07-05): en una cuenta
  // de activo (banco/caja) un cargo contable (importe positivo) incrementa el
  // saldo = entra dinero = ingreso; un abono contable (NEGATIVO) lo reduce =
  // EGRESO. El gate de regresión (`computeFlujoSignAudit` en
  // auxiliarKeyValidation.ts) se conserva por si el contrato del API cambiara.
  return record.importe < 0 ? 'egreso' : 'ingreso';
}

/** Normaliza moneda — el aux trae 'MXP'/'USD'/'' y bancos trae 'MXN'/'USD'/''.
 *  El bucket de match debe colapsar ambos a la misma forma o cruzar entre
 *  monedas (USD aux vs MXN banco) por error. Default 'MXN' cuando viene vacío. */
function normalizeMoneda(m: string | null | undefined): string {
  const s = (m ?? '').trim().toUpperCase();
  if (s === '' || s === 'MXP' || s === 'PESOS' || s === 'MXN') return 'MXN';
  if (s === 'DOLARES' || s === 'DÓLARES') return 'USD';
  return s;
}

/** Llave canónica de cuenta bancaria, tolerante a padding por banco. */
function accountMatchKey(cuenta: string | null | undefined): string {
  const entry = findBankAccount(cuenta);
  if (entry && entry.cuentaDigits) {
    const digits = entry.cuentaDigits.replace(/\D+/g, '').replace(/^0+/, '');
    if (digits) return `c:${digits}`;
    // Cuenta centinela sin dígitos (BANBAJIO: mapBankLine colapsa todas las
    // líneas Bajío a cuenta="BANBAJIO"). Sin esta rama la llave era '' y TODO
    // el flujo Bajío quedaba fuera del pool de match: sus movimientos salían
    // como bank-orphans permanentes y sus líneas GL nunca cruzaban.
    const sentinel = entry.cuentaDigits.trim().toUpperCase();
    if (sentinel) return `s:${sentinel}`;
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
  if (deriveFlujo(rec) === 'egreso' && rec.tipoPago && rec.noPago) {
    return { kind: 'pago', cia: rec.cia, ref: `${rec.tipoPago}${rec.noPago}`, contraparte };
  }
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
  /**
   * Movimiento económicamente interno bajo la MISMA clasificación que usa la
   * verdad bancaria (`buildHistoricalMonths`) y MOTOR 1: detección heurística
   * (leyenda/RFC/beneficiario/cuenta-propia), pareo simétrico CARGO↔ABONO
   * entre cuentas propias (`buildPairMatchedKeys`, ±3d) o cuenta con flow
   * `neutro` en el catálogo de bancos. A diferencia de `internal`, estos
   * movimientos SÍ permanecen en el pool de match para que la pata GL del
   * traspaso encuentre su contraparte y se bucketee `interno` (en vez de
   * inflar `pendiente-revision`), pero NUNCA cuentan como flujo económico
   * cruzado ni como bank-orphan.
   */
  econInternal: boolean;
  consumed: boolean;
}

const CONFIDENCE: Record<AuxiliarMatchTier, number> = {
  'jde-reconciled': 0.99,
  exact: 0.97,
  tolerance: 0.85,
  'gl-orphan': 0,
  caja: 0,
  interno: 0,
  'asiento-interno': 0,
  'asiento-contable': 0,
  'pendiente-revision': 0,
  'sin-banco': 0,
  'sin-cuenta-aux': 0,
  'cuenta-no-en-banco': 0,
  'timing-pendiente': 0,
  'cross-account': 0.75,
};

/** tipoDocto-codes que SIEMPRE son asientos contables sin contraparte
 *  bancaria, según el catálogo JDE de "Asientos / contabilidad general".
 *  Si una línea orphan trae uno de estos códigos, se reclasifica como
 *  `asiento-contable` (fuera del denominador del % cruce).
 *
 *  Convención: prefijo `J*` (Journal) más códigos no-J explícitos. */
const ACCOUNTING_TIPO_DOCTO_NON_J: ReadonlySet<string> = new Set([
  // Del catálogo en jdeDocTypeCatalog.ts:
  'AE',  // Asientos automáticos
  'AF',  // Asientos de ajuste
  'CZ',  // Contabilidad caja
  'T1',  // Asientos desembolso nómina
  'BA',  // Ajustes facturación
  'EX',  // Compensación conversión moneda
  // Códigos observados empíricamente en orphans (2026-05-26):
  'VR',  // Variación cambiaria (FX revaluation)
  'DC',  // Diferencia cuenta / reclasificación
]);

/** True si el tipoDocto representa un asiento contable puro (no
 *  movimiento bancario). Cubre todo el prefijo `J*` (Journal) más los
 *  códigos explícitos en `ACCOUNTING_TIPO_DOCTO_NON_J`. */
function isAccountingTipoDocto(tipoDocto: string | null | undefined): boolean {
  const code = (tipoDocto ?? '').trim().toUpperCase();
  if (!code) return false;
  if (code.startsWith('J')) return true;
  return ACCOUNTING_TIPO_DOCTO_NON_J.has(code);
}

// ── Motor ────────────────────────────────────────────────────────────────

export function reconcileAuxiliar(
  records: AuxiliarContableRecord[],
  bankStatements: BankAccountStatement[],
  options: AuxiliarReconOptions = {},
): AuxiliarReconResult {
  const ciaFilter = options.ciaFilter;
  const passesCia = (cia: string) => !ciaFilter || ciaFilter.has(cia);
  // Default ON. Para desactivar (test/back-compat), pasar `null` explícito.
  const tipoBatchFilter =
    options.tipoBatchFilter === undefined ? BANK_TIPO_BATCH : options.tipoBatchFilter;

  const inconsistencies: AuxiliarInconsistency[] = [];

  // 0. Pre-cálculo: ventana de fechas aux 1020 (post-cia-filter) y cías con
  //    estado de cuenta cargado. Sirven para clasificar líneas/movs que NUNCA
  //    podrían cruzar por razones estructurales (desfase de rango / gap data)
  //    en buckets aparte, sin inflar `gl-orphan` ni `bank-orphan`.
  let auxMin: string | null = null;
  let auxMax: string | null = null;
  for (const rec of records) {
    if (!passesCia(rec.cia)) continue;
    if (rec.cuentaObjeto !== '1020') continue;
    const f = rec.fechaContable;
    if (!f) continue;
    if (auxMin === null || f < auxMin) auxMin = f;
    if (auxMax === null || f > auxMax) auxMax = f;
  }
  const ciasConBanco = new Set<string>();
  for (const stmt of bankStatements) {
    if (!passesCia(stmt.cia)) continue;
    // La presencia del stmt indica que la cía tiene banco cargado, aunque no
    // haya movs en este rango. Los movs aportan el cia real cuando difiere.
    ciasConBanco.add(stmt.cia);
    for (const l of stmt.movimientos) if (l.cia) ciasConBanco.add(l.cia);
  }

  // 1. Normalizar líneas bancarias. Indexadas por `${accountKey}|${flujo}|${moneda}`.
  //    La moneda separa pools MXN y USD: una línea aux USD nunca debe buscar
  //    contraparte en movimientos MXN del mismo banco (importes distintos por
  //    orden de magnitud — el matcher por tolerancia ±5% no protege contra
  //    cruces espurios entre monedas).
  //
  //    Clasificación de traspasos internos: la MISMA que aplica la verdad
  //    bancaria (`buildHistoricalMonths` en cashFlowEngine) y MOTOR 1 —
  //    `classifyMovement` (heurística + pareo simétrico CARGO↔ABONO ±3d) más
  //    el corte de cuentas con flow `neutro` del catálogo. Antes este motor
  //    sólo usaba la heurística (`isInternalTransfer`), así que los totales
  //    reconciliados (`reconciledByCompanyMonth`) podían incluir traspasos
  //    que TODAS las demás superficies de Midas excluyen — los brutos del
  //    Dashboard divergían de Planeación/Bancos para el mismo mes cerrado.
  const ownAccountDetector = buildOwnAccountDetector(buildOwnAccountsIndex(bankStatements));
  const pairedKeys = buildPairMatchedKeys(bankStatements);
  const bankPool = new Map<string, BankNorm[]>();
  const allBankNorms: BankNorm[] = [];
  /** AccountKeys de cuentas con AL MENOS un movimiento bancario cargado
   *  (cualquier moneda, cualquier flujo, no interno). Sirve para detectar
   *  líneas aux apuntando a cuentas que no tienen estado de cuenta — bucket
   *  `cuenta-no-en-banco`, gap estructural. */
  const bankAccountKeys = new Set<string>();
  // Última fecha de movimiento por cuenta — sirve para detectar líneas aux
  // posteriores al cierre del extracto bancario (bucket `timing-pendiente`).
  const bankMaxDateByAccount = new Map<string, string>();
  for (const stmt of bankStatements) {
    if (!passesCia(stmt.cia)) continue;
    for (const line of stmt.movimientos) {
      const flujo: AuxiliarFlujo = line.tipoMovimiento === 'ABONO' ? 'ingreso' : 'egreso';
      const accountKey = accountMatchKey(line.cuenta || line.cuentaBancos);
      const monedaKey = normalizeMoneda(line.moneda);
      // Clasificación completa (heurística + pair-matched). `internal` conserva
      // el corte previo (sólo heurística) para no sacar del pool las patas
      // pareadas — ver `econInternal` en BankNorm.
      const classification = classifyMovement(
        line,
        { ownAccountDetector, pairedKeys },
        stmt.cia,
        stmt.cuenta,
      );
      const internal = classification.kind === 'internal'
        && classification.reason !== 'pair-matched';
      const catalogEnrich = enrichMovementWithCatalog({
        cuenta: stmt.cuenta,
        cuentaBancos: line.cuentaBancos ?? line.cuenta,
        tipoMovimiento: line.tipoMovimiento,
        importe: line.importe,
      });
      const econInternal = classification.kind === 'internal'
        || (catalogEnrich !== null && catalogEnrich.entry.flow === 'neutro');
      const norm: BankNorm = {
        line,
        movementKey: bankMovementKey(line),
        accountKey,
        flujo,
        fecha: line.fechaOperacion,
        importe: Math.abs(line.importe),
        internal,
        econInternal,
        consumed: false,
      };
      allBankNorms.push(norm);

      // NOTE: gsaid es el ID JDE de la cuenta bancaria (account-level), NO un
      // ID de línea. Se repite en cada movimiento de la misma cuenta — eso es
      // la cardinalidad natural del campo, no una inconsistencia.

      if (!accountKey || internal) continue;
      bankAccountKeys.add(accountKey);
      // Última fecha por cuenta (sin distinguir flujo — el "cierre" del
      // extracto aplica a la cuenta entera).
      const prevMax = bankMaxDateByAccount.get(accountKey);
      if (!prevMax || norm.fecha > prevMax) bankMaxDateByAccount.set(accountKey, norm.fecha);
      const poolKey = `${accountKey}|${flujo}|${monedaKey}`;
      const bucket = bankPool.get(poolKey);
      if (bucket) bucket.push(norm);
      else bankPool.set(poolKey, [norm]);
      // Pool secundario por (cia, flujo, moneda) — usado para fallback
      // `cross-account` cuando el aux se asentó en una cuenta pero el banco
      // lo registró en cuenta hermana de la misma cía (misma moneda).
      const ciaKey = `cia:${stmt.cia}|${flujo}|${monedaKey}`;
      const ciaBucket = bankPool.get(ciaKey);
      if (ciaBucket) ciaBucket.push(norm);
      else bankPool.set(ciaKey, [norm]);
    }
  }

  // 2. Recorrer las líneas GL. Caja e interno se clasifican directo; el resto
  //    se empareja en dos pasadas (exacta → tolerancia).
  const lines: AuxiliarReconLine[] = [];
  const pending: Array<{ rec: AuxiliarContableRecord; line: AuxiliarReconLine; absImporte: number; accountKey: string; monedaKey: string }> = [];
  const recByGlKey = new Map<string, AuxiliarContableRecord>();

  for (const rec of records) {
    if (!passesCia(rec.cia)) continue;
    const flujo = deriveFlujo(rec);
    // Solo el objeto 1020 son cuentas bancarias con estado de cuenta. El
    // resto del rango (1010 caja) no tiene contraparte que cruzar.
    const esCaja = rec.cuentaObjeto !== '1020';

    // Audit: dentro de 1020, vigilar Tipo_Batch e idCuenta.
    if (!esCaja) {
      const tb = (rec.tipoBatch ?? '').trim();
      if (tipoBatchFilter && tipoBatchFilter.size > 0 && !tipoBatchFilter.has(tb)) {
        inconsistencies.push({
          kind: 'non-bank-batch-in-1020',
          cia: rec.cia,
          ref: glKeyFor(rec),
          detail: `Tipo_Batch '${tb || '(empty)'}' en cuenta 1020 — fuera de BANK_TIPO_BATCH`,
        });
      }
    }

    const base: AuxiliarReconLine = {
      glKey: glKeyFor(rec),
      cia: rec.cia,
      cuentaBanco: rec.cuentaBanco,
      nombreCuenta: rec.nombreCuenta,
      cuentaContable: rec.cuentaContable,
      cuentaObjeto: rec.cuentaObjeto,
      idCuenta: rec.idCuenta,
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
    // tipoDocto=VI son asientos contables de viaje (registros internos);
    // llegan como 1020 pero NO tienen contraparte bancaria — no inflar
    // gl-orphan con ellos. Bucket aparte para auditoría.
    if (rec.tipoDocto === 'VI') {
      base.matchTier = 'asiento-interno';
      lines.push(base);
      continue;
    }
    // Si la cía no tiene estado de cuenta cargado, ninguna línea aux 1020 de
    // esa cía puede cruzar — gap de datos, no error de motor. Bucket aparte.
    if (!ciasConBanco.has(rec.cia)) {
      base.matchTier = 'sin-banco';
      lines.push(base);
      continue;
    }
    // Si la línea aux no trae `cuentaBanco` poblada, no hay clave a la cual
    // emparejar — gap del API. Bucket aparte (no inflar gl-orphan).
    if (!rec.cuentaBanco || !rec.cuentaBanco.trim()) {
      base.matchTier = 'sin-cuenta-aux';
      lines.push(base);
      continue;
    }
    // El auxiliar separa "concepto" (corto, máquina) de "explicacion" (libre,
     // humano) y "nombre" (contraparte). Internal transfer detector mira
     // concepto+referencia — pasamos `nombre` como parte del referencia para
     // que detecte casos como "SIR-TICH ABRL 2026" o "BANCO NACIONAL DE MX, SA".
    const internalSearchText = [rec.explicacion, rec.nombre].filter(Boolean).join(' ');
    const internal = isInternalTransfer({
      concepto: rec.concepto,
      referencia: internalSearchText,
      cuenta: rec.cuentaBanco,
    });
    if (internal) {
      base.matchTier = 'interno';
      lines.push(base);
      continue;
    }
    // Cuenta con flow `neutro` en el catálogo de bancos (reserva, ahorro,
    // crédito, garantía, por_cancelar, saldo_retenido): traspaso interno por
    // definición — mismo corte que aplican la verdad bancaria
    // (buildHistoricalMonths) y MOTOR 1 al lado banco. Sin esto, la línea GL
    // cruzaba contra el movimiento de la cuenta neutra y contaba como flujo
    // económico en `reconciledByCompanyMonth`, que el resto de Midas excluye.
    const auxCatalogEntry = findBankAccount(rec.cuentaBanco);
    if (auxCatalogEntry !== null && auxCatalogEntry.flow === 'neutro') {
      base.matchTier = 'interno';
      lines.push(base);
      continue;
    }
    // Si la cuenta aux no tiene NINGÚN movimiento bancario cargado (cuenta
    // por_cancelar inactiva, o cuenta que /bancos no expone), el match es
    // imposible por gap estructural — no inflar gl-orphan. La R-override del
    // paso 5 todavía puede confirmar la línea si JDE la marcó como conciliada.
    const auxAccountKey = accountMatchKey(rec.cuentaBanco);
    // Sin llave derivable (cuentaBanco poblada pero sin dígitos ni centinela
    // del catálogo): no hay contra qué emparejar — mismo bucket que la línea
    // sin cuenta. Antes caía al loop de match con llave '' y terminaba
    // inflando pendiente-revision (la cola de revisión humana) por un gap
    // estructural de datos.
    if (!auxAccountKey) {
      base.matchTier = 'sin-cuenta-aux';
      lines.push(base);
      continue;
    }
    if (!bankAccountKeys.has(auxAccountKey)) {
      base.matchTier = 'cuenta-no-en-banco';
      lines.push(base);
      continue;
    }
    lines.push(base);
    pending.push({
      rec,
      line: base,
      absImporte: Math.abs(rec.importe),
      accountKey: auxAccountKey,
      monedaKey: normalizeMoneda(rec.moneda),
    });
  }

  // Match en una sola pasada con best-fit global. El motor anterior corría
  // dos pasadas greedy (exact primero, tolerance después) — pero la pasada
  // exacta usaba `find()` (first-match): si dos líneas aux competían por el
  // mismo movimiento banco, la primera ganaba y la segunda quedaba huérfana
  // aunque hubiera otra contraparte casi-exacta disponible. Bug detectado
  // empíricamente: 14 orphans con monto+fecha exactos dentro del rango.
  //
  // Estrategia nueva: construir todos los pares candidatos elegibles (mismo
  // accountKey + flujo, dentro de DATE_WINDOW_DAYS, dentro de
  // AMOUNT_TOLERANCE_PCT), puntuarlos por score normalizado, ordenar y
  // consumir en orden óptimo. Tier:
  //   - score 0 (diff=0, dt=0) → exact
  //   - score > 0                → tolerance
  type Cand = { item: typeof pending[number]; bank: BankNorm; score: number; exact: boolean };
  const cands: Cand[] = [];
  for (const item of pending) {
    const bucket = bankPool.get(`${item.accountKey}|${item.line.flujo}|${item.monedaKey}`);
    if (!bucket) continue;
    for (const b of bucket) {
      const dDays = daysBetween(b.fecha, item.line.fechaContable);
      if (dDays > DATE_WINDOW_DAYS) continue;
      const diff = Math.abs(b.importe - item.absImporte);
      const tol = Math.max(AMOUNT_TOLERANCE_MIN_ABS, item.absImporte * AMOUNT_TOLERANCE_PCT);
      if (diff > tol) continue;
      const diffPct = item.absImporte > 0 ? diff / item.absImporte : 0;
      // Normalizado: ambos componentes en rango 0..1. Igual peso.
      const score = dDays / DATE_WINDOW_DAYS + diffPct / AMOUNT_TOLERANCE_PCT;
      cands.push({ item, bank: b, score, exact: diff === 0 && dDays === 0 });
    }
  }
  cands.sort((a, b) => a.score - b.score);
  for (const c of cands) {
    if (c.bank.consumed) continue;
    if (c.item.line.bankMovementKey) continue;
    c.bank.consumed = true;
    c.item.line.bankMovementKey = c.bank.movementKey;
    c.item.line.bankDate = c.bank.fecha;
    c.item.line.bankAmount = c.bank.line.importe;
    // Contraparte bancaria económicamente interna (pareo CARGO↔ABONO entre
    // cuentas propias o cuenta neutra del catálogo): la línea GL es la pata
    // contable de un traspaso interno → bucket `interno`, fuera de los
    // totales económicos (igual que la verdad bancaria descarta ese
    // movimiento). Conserva bankMovementKey para drill-down/auditoría.
    c.item.line.matchTier = c.bank.econInternal
      ? 'interno'
      : c.exact ? 'exact' : 'tolerance';
  }

  // 3. Capa cross-account: para los aún sin pareja, intentar match en cuenta
  //    hermana de la misma cía. Caso real: la empresa asienta el pago en una
  //    cuenta contable pero el banco lo registró en otra cuenta del grupo
  //    (concentración de liquidez). Tolerancia: misma que `tolerance`, pero
  //    el item.accountKey no aplica — se busca por (cia, flujo).
  const crossCands: Cand[] = [];
  for (const item of pending) {
    if (item.line.bankMovementKey) continue;
    const ciaBucket = bankPool.get(`cia:${item.line.cia}|${item.line.flujo}|${item.monedaKey}`);
    if (!ciaBucket) continue;
    for (const b of ciaBucket) {
      // Saltar las del mismo accountKey — ya las consideramos en best-fit.
      if (b.accountKey === item.accountKey) continue;
      const dDays = daysBetween(b.fecha, item.line.fechaContable);
      if (dDays > DATE_WINDOW_DAYS) continue;
      const diff = Math.abs(b.importe - item.absImporte);
      const tol = Math.max(AMOUNT_TOLERANCE_MIN_ABS, item.absImporte * AMOUNT_TOLERANCE_PCT);
      if (diff > tol) continue;
      const diffPct = item.absImporte > 0 ? diff / item.absImporte : 0;
      const score = dDays / DATE_WINDOW_DAYS + diffPct / AMOUNT_TOLERANCE_PCT;
      crossCands.push({ item, bank: b, score, exact: false });
    }
  }
  crossCands.sort((a, b) => a.score - b.score);
  for (const c of crossCands) {
    if (c.bank.consumed) continue;
    if (c.item.line.bankMovementKey) continue;
    c.bank.consumed = true;
    c.item.line.bankMovementKey = c.bank.movementKey;
    c.item.line.bankDate = c.bank.fecha;
    c.item.line.bankAmount = c.bank.line.importe;
    // Mismo criterio que el best-fit principal: contraparte económicamente
    // interna → la línea GL se bucketea `interno` (no cuenta como cruce).
    c.item.line.matchTier = c.bank.econInternal ? 'interno' : 'cross-account';
  }

  // 4. Para los que aún quedan sin pareja, ¿estamos viendo el ledger más allá
  //    del cierre del estado de cuenta? Si la fecha aux es posterior al
  //    último movimiento bancario de esa cuenta, el match es imposible por
  //    timing — banco aún no entregó el extracto del día. Bucket aparte.
  for (const item of pending) {
    if (item.line.bankMovementKey) continue;
    const maxBank = bankMaxDateByAccount.get(item.accountKey);
    if (maxBank && item.line.fechaContable > maxBank) {
      item.line.matchTier = 'timing-pendiente';
    }
  }

  // 5. Tier final: `estatusConciliado === 'R'` gana sobre exact/tolerance/orphan
  //    Y sobre los buckets de gap estructural (cuenta-no-en-banco, sin-banco,
  //    sin-cuenta-aux, timing-pendiente). R es la marca de JDE de "ya
  //    conciliada con banco" — confirmación autorizada por el ERP. Si JDE
  //    afirma que cruzó, vale aunque NUESTROS datos no permitan reconstruir
  //    el match. Excepciones: `caja` (1010, no es bancaria), `interno`
  //    (traspaso clasificado aparte) y `asiento-interno` (VI, no es mov
  //    bancario real) NO se promueven a jde-reconciled — son categorías
  //    semánticas, no estados de match.
  for (const line of lines) {
    if (
      line.estatusConciliado.trim().toUpperCase() === 'R' &&
      line.matchTier !== 'caja' &&
      line.matchTier !== 'interno' &&
      line.matchTier !== 'asiento-interno'
    ) {
      line.matchTier = 'jde-reconciled';
    }
  }

  // 5b. Reclasificación post-matching: orphans cuyo tipoDocto es journal-style
  //     (`J*` o un código del catálogo de asientos contables) se mueven a
  //     `asiento-contable` — semánticamente no son movs bancarios fallidos
  //     sino registros de ajuste sin contraparte por diseño. Las líneas con
  //     ese tipoDocto que SÍ encontraron contraparte (ej. JT que pagó IVA al
  //     SAT vía banco) ya cruzaron en pasos anteriores; aquí solo cae lo que
  //     quedó huérfano.
  //
  //     Adicional: `tipoBatch=G + tipoDocto=PF` son provisiones de finiquito
  //     contables, no pagos reales — el pago real es una entrada K/PT
  //     separada. Bucketear como asiento-contable también.
  for (const line of lines) {
    if (line.matchTier !== 'gl-orphan') continue;
    const rec = recByGlKey.get(line.glKey);
    if (isAccountingTipoDocto(line.tipoDocto)) {
      line.matchTier = 'asiento-contable';
      continue;
    }
    if (rec && (rec.tipoBatch ?? '').trim().toUpperCase() === 'G' && line.tipoDocto === 'PF') {
      line.matchTier = 'asiento-contable';
    }
  }

  // 5c. Cola de revisión: los orphans que sobreviven al paso 5b son cheques,
  //     cobros y pagos que SÍ son movs bancarios pero no encontraron pareja
  //     automática (motivos típicos: pago intercompañía cuyo banco marcó
  //     traspaso interno; N:1 cuando varias líneas aux agregan a un solo
  //     ABONO; importe difiere >10% por comisiones). El motor no los puede
  //     confirmar sin intervención humana — quedan en `pendiente-revision`,
  //     que SÍ cuenta en el denominador del % cruce (flujo económico no
  //     cruzado; ver buildSummary). La drilldown los expone como la
  //     sección primaria accionable para que contabilidad los marque R en
  //     JDE o ajuste el asiento. NOTA: si en el futuro se agrega N:M
  //     aggregation o intercompany cross-cia detection, esos buckets deben
  //     interceptar ANTES de este reclassify.
  for (const line of lines) {
    if (line.matchTier === 'gl-orphan') {
      line.matchTier = 'pendiente-revision';
    }
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
      line.matchTier === 'tolerance' ||
      line.matchTier === 'cross-account';
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

  // 5. Movimientos bancarios sin línea GL (excluye internos — tanto los
  //    heurísticos como los económicamente internos: pareados y cuentas
  //    neutras; un traspaso sin pata GL no es un faltante contable real).
  //    Los marcamos con `outOfWindow=true` si caen fuera del rango aux: el
  //    match era imposible por desfase temporal, no por error del motor.
  //    Sin ventana aux (no hay líneas GL 1020 en el rango) el match era
  //    imposible por gap estructural de datos — TODOS los orphans son
  //    out-of-window, no candidatos reales a investigar.
  const bankOrphans: AuxiliarBankOrphan[] = [];
  for (const b of allBankNorms) {
    if (b.consumed || b.internal || b.econInternal) continue;
    const oow =
      auxMin !== null && auxMax !== null
        ? b.fecha < auxMin || b.fecha > auxMax
        : true;
    bankOrphans.push({
      movementKey: b.movementKey,
      cia: b.line.cia,
      cuenta: b.line.cuenta,
      fecha: b.fecha,
      importe: b.line.importe,
      flujo: b.flujo,
      concepto: b.line.concepto,
      referencia: b.line.referencia,
      outOfWindow: oow,
    });
  }

  return {
    lines,
    bankOrphans,
    sourceConfirmation,
    summary: buildSummary(lines, bankOrphans, inconsistencies, { min: auxMin, max: auxMax }),
    reconciledByCompanyMonth: buildReconciledByCompanyMonth(lines),
    inconsistencies,
  };
}

/** Tiers estructurales que NO cuentan como flujo económico (excluidos del
 *  denominador del % cruce y de los totales reconciliados por mes). Coincide
 *  con los `continue` de `buildSummary`; `gl-orphan`/`pendiente-revision` NO
 *  están aquí (son flujo económico sin cruce — el paso 5c reclasifica todo
 *  gl-orphan a pendiente-revision, así que excluirlo dejaba el denominador
 *  igual al numerador y los `*Total` idénticos a `*Cruzado`). */
const STRUCTURAL_NON_FLOW_TIERS: ReadonlySet<AuxiliarMatchTier> = new Set([
  'caja',
  'interno',
  'asiento-interno',
  'asiento-contable',
  'sin-banco',
  'sin-cuenta-aux',
  'cuenta-no-en-banco',
  'timing-pendiente',
]);

/** Una línea cruzó a banco — mismo predicado que `buildSummary` usa para
 *  `ingresoMontoCruzado`/`egresoMontoCruzado`. */
function isCruzadaTier(tier: AuxiliarMatchTier): boolean {
  return (
    tier === 'jde-reconciled' ||
    tier === 'exact' ||
    tier === 'tolerance' ||
    tier === 'cross-account'
  );
}

/**
 * Agrega ingreso/egreso económico por (cía, mes). La suma de `ingresoCruzado`
 * (resp. `egresoCruzado`) sobre todos los meses iguala `summary.ingresoMontoCruzado`
 * (resp. `egresoMontoCruzado`), porque usa el mismo conjunto de líneas y el
 * mismo predicado de cruce. Mes por `bankDate` cuando existe (cruce real a
 * banco), fallback `fechaContable`.
 */
function buildReconciledByCompanyMonth(
  lines: AuxiliarReconLine[],
): Map<string, ReconciledMonthTotals> {
  const map = new Map<string, ReconciledMonthTotals>();
  for (const line of lines) {
    if (STRUCTURAL_NON_FLOW_TIERS.has(line.matchTier)) continue;
    const bucketDate = line.bankDate || line.fechaContable;
    if (!bucketDate || bucketDate.length < 7) continue;
    const ym = bucketDate.slice(0, 7);
    const key = `${line.cia}::${ym}`;
    let totals = map.get(key);
    if (!totals) {
      totals = {
        cia: line.cia,
        yearMonth: ym,
        ingresoCruzado: 0,
        egresoCruzado: 0,
        ingresoTotal: 0,
        egresoTotal: 0,
      };
      map.set(key, totals);
    }
    const monto = Math.abs(line.importe);
    const cruzada = isCruzadaTier(line.matchTier);
    if (line.flujo === 'ingreso') {
      totals.ingresoTotal += monto;
      if (cruzada) totals.ingresoCruzado += monto;
    } else {
      totals.egresoTotal += monto;
      if (cruzada) totals.egresoCruzado += monto;
    }
  }
  return map;
}

function buildSummary(
  lines: AuxiliarReconLine[],
  bankOrphans: AuxiliarBankOrphan[],
  inconsistencies: AuxiliarInconsistency[],
  auxWindow: { min: string | null; max: string | null },
): AuxiliarReconSummary {
  const inconsistencyCounts: Record<AuxiliarInconsistencyKind, number> = {
    'non-bank-batch-in-1020': 0,
  };
  for (const inc of inconsistencies) inconsistencyCounts[inc.kind] += 1;

  let bankOrphanIn = 0;
  let bankOrphanInMonto = 0;
  let bankOrphanOut = 0;
  let bankOrphanOutMonto = 0;
  for (const b of bankOrphans) {
    const m = Math.abs(b.importe);
    if (b.outOfWindow) {
      bankOrphanOut += 1;
      bankOrphanOutMonto += m;
    } else {
      bankOrphanIn += 1;
      bankOrphanInMonto += m;
    }
  }
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
    cruzadasSinR: 0,
    cajaLineas: 0,
    cajaMonto: 0,
    internoLineas: 0,
    internoMonto: 0,
    asientoInternoLineas: 0,
    asientoInternoMonto: 0,
    asientoContableLineas: 0,
    asientoContableMonto: 0,
    pendienteRevisionLineas: 0,
    pendienteRevisionMonto: 0,
    sinBancoLineas: 0,
    sinBancoMonto: 0,
    sinCuentaAuxLineas: 0,
    sinCuentaAuxMonto: 0,
    cuentaNoEnBancoLineas: 0,
    cuentaNoEnBancoMonto: 0,
    timingPendienteLineas: 0,
    timingPendienteMonto: 0,
    glOrphanLineas: 0,
    glOrphanMonto: 0,
    bankOrphanLineas: bankOrphanIn,
    bankOrphanMonto: bankOrphanInMonto,
    bankOrphanOutOfWindowLineas: bankOrphanOut,
    bankOrphanOutOfWindowMonto: bankOrphanOutMonto,
    auxWindow,
    ciaBreakdown: [],
    inconsistencyCounts,
  };
  const ciaAgg = new Map<string, { lineas: number; cruzadas: number }>();
  for (const line of lines) {
    const monto = Math.abs(line.importe);
    const cruzada =
      line.matchTier === 'jde-reconciled' ||
      line.matchTier === 'exact' ||
      line.matchTier === 'tolerance' ||
      line.matchTier === 'cross-account';
    const tieneR = line.estatusConciliado.trim().toUpperCase() === 'R';
    if (tieneR) s.conciliadasJde += 1;
    if (cruzada && !tieneR) s.cruzadasSinR += 1;

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
    if (line.matchTier === 'asiento-interno') {
      s.asientoInternoLineas += 1;
      s.asientoInternoMonto += monto;
      continue;
    }
    if (line.matchTier === 'asiento-contable') {
      s.asientoContableLineas += 1;
      s.asientoContableMonto += monto;
      continue;
    }
    if (line.matchTier === 'pendiente-revision') {
      s.pendienteRevisionLineas += 1;
      s.pendienteRevisionMonto += monto;
      // SIN `continue`: pendiente-revision es el gl-orphan reclasificado —
      // flujo económico QUE NO CRUZÓ. Debe contar en los denominadores del
      // % cruce (ingresoLineas/egresoLineas + ciaBreakdown). Con el continue,
      // el denominador solo contenía tiers cruzados y pctIngresoCruzado /
      // pctEgresoCruzado / ciaBreakdown.pct eran SIEMPRE 100% — el semáforo
      // del KPI de cobertura no podía disparar jamás.
    }
    if (line.matchTier === 'sin-banco') {
      s.sinBancoLineas += 1;
      s.sinBancoMonto += monto;
      continue;
    }
    if (line.matchTier === 'sin-cuenta-aux') {
      s.sinCuentaAuxLineas += 1;
      s.sinCuentaAuxMonto += monto;
      continue;
    }
    if (line.matchTier === 'cuenta-no-en-banco') {
      s.cuentaNoEnBancoLineas += 1;
      s.cuentaNoEnBancoMonto += monto;
      continue;
    }
    if (line.matchTier === 'timing-pendiente') {
      s.timingPendienteLineas += 1;
      s.timingPendienteMonto += monto;
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
      cruzadasSinR: 0,
      cajaLineas: 0,
      cajaMonto: 0,
      internoLineas: 0,
      internoMonto: 0,
      asientoInternoLineas: 0,
      asientoInternoMonto: 0,
      asientoContableLineas: 0,
      asientoContableMonto: 0,
      pendienteRevisionLineas: 0,
      pendienteRevisionMonto: 0,
      sinBancoLineas: 0,
      sinBancoMonto: 0,
      sinCuentaAuxLineas: 0,
      sinCuentaAuxMonto: 0,
      cuentaNoEnBancoLineas: 0,
      cuentaNoEnBancoMonto: 0,
      timingPendienteLineas: 0,
      timingPendienteMonto: 0,
      glOrphanLineas: 0,
      glOrphanMonto: 0,
      bankOrphanLineas: 0,
      bankOrphanMonto: 0,
      bankOrphanOutOfWindowLineas: 0,
      bankOrphanOutOfWindowMonto: 0,
      auxWindow: { min: null, max: null },
      ciaBreakdown: [],
      inconsistencyCounts: {
        'non-bank-batch-in-1020': 0,
      },
    },
    reconciledByCompanyMonth: new Map(),
    inconsistencies: [],
  };
}
