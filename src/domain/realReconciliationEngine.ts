/**
 * Real Reconciliation Engine — Cobranza JDE ↔ Movimientos Bancarios
 *
 * A diferencia de `reconciliationEngine.ts` (que cruza eventos PROYECTADOS
 * heurísticos contra abonos), este motor cruza FACTURAS REALES extraídas
 * del API /v1/erp/tesoreria/cobranza contra ABONOs reales del estado de
 * cuenta. Es el ground truth de la operación.
 *
 * Algoritmo en 4 capas (de más estricta a más laxa):
 *
 *   1. EXACTO: factura abierta de un cliente con `importeBruto` o
 *      `importePendiente` que coincide al céntimo con un ABONO del mismo
 *      cliente y cía, dentro de ±60 días de fechaVence.
 *
 *   2. TOLERANCIA: mismo cliente/cía, monto coincide ±0.5% (redondeo
 *      bancario, comisiones de transferencia, ajustes mínimos).
 *
 *   3. SUBSET-SUM: un ABONO grande paga 2-4 facturas del mismo cliente.
 *      Buscar combinaciones cuya suma == ABONO ±0.5%. Acotado a 4
 *      facturas para no explotar combinatoriamente — el 95% de los pagos
 *      reales caben en este límite.
 *
 *   4. SIN MATCH: el ABONO sobra (cliente sin factura abierta del monto,
 *      anticipo, depósito en garantía) o la factura sigue pendiente.
 *
 * Filtros previos:
 *   - ABONOs marcados como `isInternalTransfer` (traspasos entre cuentas
 *     propias) NUNCA entran al pool. El detector vive en
 *     `netCashFlowEngine.ts` y ya ignora RFCs y nombres del grupo.
 *   - Solo se intentan cruces dentro de la MISMA `cia`. Si una factura es
 *     de cia 00011 y el ABONO de cia 00038, no se mezclan — aunque sea
 *     el mismo número de cliente.
 *
 * Restricciones:
 *   - Cada ABONO puede matchear con UNA factura (capa 1/2) o UN GRUPO
 *     (capa 3). No puede aparecer en dos resultados.
 *   - Cada factura puede matchear con UN ABONO. Pagos parciales en
 *     bancos consecutivos no se modelan en esta versión — caen en
 *     "pendiente" si el saldo no coincide. Caso edge raro en Senda.
 */

import type { BankAccountStatement, BankStatementLine, CobranzaPayment, CobranzaRecord } from '../services/jdeTypes';
import {
  buildOwnAccountsIndex,
  buildOwnAccountDetector,
  buildPairMatchedKeys,
  classifyMovement,
} from './netCashFlowEngine';

// ── Configuración ──────────────────────────────────────────────────────────

/** Tolerancia en monto para cobertura "tolerancia" y "subset". */
const AMOUNT_TOLERANCE_PCT = 0.02; // 2% — covers bank fees, rounding, minor IVA diffs
/** Tolerancia absoluta mínima — un ABONO de $100 debe poder ajustar ±$1. */
const AMOUNT_TOLERANCE_MIN_ABS = 1;
/** Máximo de facturas en una combinación subset-sum. */
const SUBSET_MAX_INVOICES = 6;
/** Ventana de fecha alrededor de fechaVence (±N días) — capa 1/2. */
const DATE_WINDOW_DAYS = 60;
/** Ventana de fecha alrededor de fechaCobro cuando ya viene del ERP (±N días). */
const COBRO_WINDOW_DAYS = 5;

const DAY_MS = 86_400_000;

// ── Tipos públicos ─────────────────────────────────────────────────────────

export type MatchTier =
  | 'payment-confirmed-ref'
  | 'payment-auto-unique'
  | 'payment-ambiguous'
  | 'invoice-reference'
  | 'customer-reference'
  | 'exact'
  | 'tolerance'
  | 'subset'
  | 'multi-abono';
export type FacturaStatus = 'cobrada-banco' | 'cobrada-jde-sin-banco' | 'pendiente';
export type AbonoStatus = 'factura-cobrada' | 'cobranza-sin-factura' | 'no-cobranza';
export type ReviewStatus = 'auto' | 'review' | 'unmatched';
export type PaymentReconciliationStatus = 'CONFIRMED_REF' | 'AUTO_UNIQUE' | 'AMBIGUOUS' | 'UNMATCHED';

export interface BankMovementSnapshot {
  movementKey: string;
  cia: string;
  cuenta: string;
  fechaOperacion: string;
  importe: number;
  concepto: string;
  referencia: string;
  noRecibo?: string;
  banco?: string;
  nombreBanco?: string;
}

export interface ReconciliationCandidateFactura {
  cia: string;
  noFactura: string;
  noCliente: string;
  nombreCliente: string;
  importeBruto: number;
  importePendiente: number;
  fechaFactura: string;
  fechaVence: string;
  confidence: number;
  matchTier: MatchTier;
  matchReason: string;
}

export interface ReconciliationReviewCandidate {
  movement: BankMovementSnapshot;
  candidateFacturas: ReconciliationCandidateFactura[];
  matchReason: string;
}

export interface RealReconciliationBankCoverage {
  loadedDates: string[];
  from?: string;
  to?: string;
  totalMovements: number;
  totalAbonos: number;
}

export interface RealReconciliationTimings {
  totalMs: number;
  indexMs: number;
  matchMs: number;
}

/** Resultado del cruce, una entrada por factura. */
export interface RealReconciliationMatch {
  /** Identidad de la factura. */
  cia: string;
  noFactura: string;
  noCliente: string;
  nombreCliente: string;

  /** Estado de la factura. */
  status: FacturaStatus;

  /** Monto y fecha de la factura. */
  importeBruto: number;
  importePendiente: number;
  fechaFactura: string;
  fechaVence: string;
  diasVencida: number;
  moneda: string;

  /** Capa que produjo el match. Solo presente cuando status==='cobrada-banco'. */
  matchTier?: MatchTier;
  /** Confianza 0..1 — útil para ordenar y mostrar warnings. */
  confidence?: number;
  /** Auto = cruce aplicado; review = candidato visible pero no aplicado. */
  reviewStatus: ReviewStatus;
  /** Explicación corta de por qué se cruzó o por qué quedó para revisión. */
  matchReason?: string;

  /** Datos del movimiento bancario que cubrió la factura. */
  bankRef?: string;
  bankAmount?: number;
  bankDate?: string;
  bankConcept?: string;
  bankAccount?: string;
  bankCia?: string;
  /** Movimientos que cubren la factura. 1 para match normal, N para multi-abono. */
  bankMovements?: BankMovementSnapshot[];
  /** Id Pago de IndicadoresCobranza cuando el match viene por recibo. */
  idPago?: string;
  noRecibo?: string;
  paymentMatchStatus?: Exclude<PaymentReconciliationStatus, 'UNMATCHED'>;

  /** Si la factura es parte de un subset (un solo ABONO cubre varias). */
  subsetGroupId?: string;
  subsetSize?: number;
}

/** Etiqueta enriquecida sobre un movimiento bancario ABONO. */
export interface AbonoEnrichment {
  /** Identifica de forma estable el movimiento bancario. */
  movementKey: string;
  status: AbonoStatus;
  matchTier?: MatchTier;
  confidence?: number;

  /** Facturas que cubre este ABONO (1 para capa 1/2, 2-4 para subset). */
  facturas?: Array<{
    cia: string;
    noFactura: string;
    noCliente: string;
    nombreCliente: string;
    importeBruto: number;
  }>;
  idPago?: string;
  noRecibo?: string;
  paymentMatchStatus?: Exclude<PaymentReconciliationStatus, 'UNMATCHED'>;
  /** Facturas candidatas cuando el ABONO no alcanzó confianza para auto-cruce. */
  candidateFacturas?: ReconciliationCandidateFactura[];
  matchReason?: string;

  /** Datos básicos del ABONO para que el caller no tenga que cruzar. */
  cia: string;
  cuenta: string;
  fechaOperacion: string;
  importe: number;
  concepto: string;
  referencia: string;
}

export interface PaymentApplicationReconciliation {
  cia: string;
  noFactura: string;
  noFacturaNormalizada: string;
  noCliente: string;
  cliente: string;
  tipoDocto: string;
  fechaAplicacion: string;
  fechaFactura: string;
  fechaVencimiento: string;
  importeCobrado: number;
  importeOriginalFactura: number;
  importePteFactura: number;
  tasaIva: string;
  importeIvaFacturaOriginal: number;
  ivaCausadoProporcional: number;
  facturaStatus?: FacturaStatus;
}

export interface PaymentReconciliation {
  idPago: string;
  cia: string;
  fechaCobro: string;
  fechaContable: string;
  cuentaBancaria: string;
  banco: string;
  noRecibo: string;
  importeRecibo: number;
  pendienteAplicar: number;
  noCliente: string;
  cliente: string;
  noBatch: string;
  tipoCambio: number;
  applicationCount: number;
  importeAplicado: number;
  status: PaymentReconciliationStatus;
  matchTier?: MatchTier;
  confidence?: number;
  matchReason?: string;
  bankMovement?: BankMovementSnapshot;
  applications: PaymentApplicationReconciliation[];
}

export interface RealReconciliationSummary {
  /** Conteos de facturas. */
  totalFacturas: number;
  facturasCobradasBanco: number;
  facturasCobradasJdeSinBanco: number;
  facturasPendientes: number;

  /** Saldos. */
  totalSaldoBruto: number;
  totalSaldoPendiente: number;
  totalCobradoBanco: number;

  /** Conteos de ABONO. */
  totalAbonos: number;
  totalAbonoMonto: number;
  abonosFacturaCobrada: number;
  abonosSinFactura: number;
  abonosTraspasoInterno: number;
  totalPagosIndicadores?: number;
  pagosConciliadosBanco?: number;
  pagosSinBanco?: number;
  pagosAmbiguos?: number;
  pagosMultiFactura?: number;
  montoPagosMultiFacturaConciliado?: number;

  /** KPI principal: % de ABONOs que tienen una factura JDE asociada. */
  pctAbonosCruzados: number;

  /** KPI secundario: % de facturas (con saldo > 0) que cruzan a banco. */
  pctFacturasCruzadas: number;

  /**
   * Desglose por compañía — útil para diagnosticar 0% de cruce. Permite
   * ver de un vistazo si una cía tiene facturas pero no abonos (o
   * viceversa), o si la cia está en distintos formatos en cada lado.
   */
  ciaBreakdown: Array<{
    cia: string;
    facturas: number;
    abonos: number;
    matches: number;
  }>;
}

export interface RealReconciliationResult {
  /** Una entrada por factura del input. */
  matches: RealReconciliationMatch[];
  /** Una entrada por ABONO bancario (después de filtrar internos). */
  abonoEnrichments: AbonoEnrichment[];
  /** Una entrada por Id Pago de IndicadoresCobranza. */
  paymentReconciliations: PaymentReconciliation[];
  /** Métricas top-level para KPIs. */
  summary: RealReconciliationSummary;
  /** Candidatos que operación puede revisar sin inflar los ingresos reales. */
  reviewCandidates: ReconciliationReviewCandidate[];
  /** Cobertura observada de movimientos bancarios cargados. */
  bankCoverage: RealReconciliationBankCoverage;
  /** Métricas de duración del engine para detectar regresiones. */
  timingsMs: RealReconciliationTimings;
}

// ── Helpers internos ───────────────────────────────────────────────────────

/** Genera una clave estable para un movimiento bancario. Mismo formato que
 *  reconciliationEngine.ts para que ambos motores puedan compartir índices
 *  si en el futuro se quieren cruzar resultados. */
export function bankMovementKey(mov: BankStatementLine): string {
  return [
    mov.cia,
    mov.cuenta,
    mov.fechaOperacion,
    mov.referencia,
    mov.tipoMovimiento,
    mov.importe,
    mov.concepto,
  ].join('|');
}

/**
 * Días entre dos fechas (b − a). Robusto contra cadenas con time component:
 * acepta "YYYY-MM-DD" y también "YYYY-MM-DDTHH:mm:ss" (lo que devuelve JDE).
 *
 * Antes appendaba "T12:00:00Z" a la cadena cruda; eso producía
 * "2025-05-12T00:00:00T12:00:00Z" cuando la fecha ya traía time, y
 * `Date()` regresaba NaN, lo cual rompía silenciosamente cualquier cruce
 * basado en ventana temporal.
 */
function daysBetween(a: string, b: string): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  // Normalizar a YYYY-MM-DD descartando cualquier time component.
  const ad = a.length >= 10 ? a.slice(0, 10) : a;
  const bd = b.length >= 10 ? b.slice(0, 10) : b;
  const da = new Date(ad + 'T12:00:00Z').getTime();
  const db = new Date(bd + 'T12:00:00Z').getTime();
  if (!Number.isFinite(da) || !Number.isFinite(db)) return Number.POSITIVE_INFINITY;
  return Math.round((db - da) / DAY_MS);
}

/**
 * Tolerancia efectiva en valor absoluto. Combina porcentaje con piso para
 * que ABONOs chicos también puedan ajustar comisiones de unos pocos pesos.
 */
function amountTolerance(value: number): number {
  return Math.max(AMOUNT_TOLERANCE_MIN_ABS, Math.abs(value) * AMOUNT_TOLERANCE_PCT);
}

/**
 * Compara dos importes con tolerancia configurable. `tolerancePct=0` exige
 * coincidencia al céntimo (capa 1).
 */
function importesCoinciden(a: number, b: number, exact = false): boolean {
  const diff = Math.abs(a - b);
  if (exact) return diff < 0.01; // un centavo
  return diff <= amountTolerance(Math.max(Math.abs(a), Math.abs(b)));
}

/**
 * Confianza derivada de qué tan cerca están los montos y fechas, escalada
 * por capa (exact > tolerance > subset).
 */
function computeConfidence(
  tier: MatchTier,
  amountDiffPct: number,
  daysDelta: number,
  windowDays: number,
): number {
  const baseByTier =
    tier === 'payment-confirmed-ref' ? 0.99 :
    tier === 'payment-auto-unique' ? 0.94 :
    tier === 'payment-ambiguous' ? 0.55 :
    tier === 'invoice-reference' ? 0.99 :
    tier === 'customer-reference' ? 0.93 :
    tier === 'exact' ? 0.92 :
    tier === 'tolerance' ? 0.82 :
    tier === 'multi-abono' ? 0.92 :
    0.9;
  // Penalización por monto: 0% diff → 1, 0.5% → ~0.5
  const amountFactor = Math.max(0, 1 - amountDiffPct / AMOUNT_TOLERANCE_PCT);
  // Penalización por días: 0d → 1, fuera de ventana → 0
  const dateFactor = Math.max(0, 1 - Math.abs(daysDelta) / Math.max(1, windowDays));
  // Confidence = base * (0.7 amount + 0.3 date)
  const c = baseByTier * (0.7 * amountFactor + 0.3 * dateFactor);
  return Math.max(0, Math.min(1, c));
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Selecciona el monto base de la factura para matching y la moneda alterna. */
function selectFacturaImporte(record: CobranzaRecord, useUSD: boolean): {
  bruto: number;
  pendiente: number;
} {
  if (useUSD) {
    return {
      bruto: record.importeBrutoDolares,
      pendiente: record.importePendienteDolares,
    };
  }
  return {
    bruto: record.importeBrutoPesos,
    pendiente: record.importePendientePesos,
  };
}

/**
 * Determina si la factura y el ABONO comparten moneda. Cobranza siempre
 * tiene MXN (importeBrutoPesos siempre poblado); USD solo cuando moneda
 * lo indica. Los ABONOs JDE marcan moneda con MXN/USD ya normalizado.
 */
function mismaMoneda(record: CobranzaRecord, abono: BankStatementLine): boolean {
  const monedaFactura = (record.moneda || 'MXN').toUpperCase();
  const monedaAbono = (abono.moneda || 'MXN').toUpperCase();
  return monedaFactura === monedaAbono;
}

/** Normaliza el cliente para comparar — mayúsculas, sin acentos, sin espacios extras. */
function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Subset-sum acotado ────────────────────────────────────────────────────

/**
 * Encuentra la primera combinación de hasta SUBSET_MAX_INVOICES facturas
 * cuya suma esté dentro de la tolerancia del target. Devuelve null si no
 * encuentra. El algoritmo es fuerza bruta acotada — adecuado para N≤30
 * por cliente, que es el caso real (un cliente Senda promedio tiene ~5-20
 * facturas abiertas).
 *
 * Optimización: pre-filtramos facturas cuyo importe individual ya supera
 * el target — no pueden entrar a una suma exacta.
 */
function findSubset(
  candidates: CobranzaRecord[],
  target: number,
  useUSD: boolean,
): CobranzaRecord[] | null {
  const tol = amountTolerance(target);
  // Solo consideramos facturas con bruto ≤ target (con margen de tolerancia).
  const usable = candidates
    .map(r => ({ r, bruto: selectFacturaImporte(r, useUSD).bruto }))
    .filter(x => x.bruto > 0 && x.bruto <= target + tol)
    .sort((a, b) => b.bruto - a.bruto); // descendente — converge más rápido

  // Probar combinaciones de tamaño 2..MAX
  for (let size = 2; size <= SUBSET_MAX_INVOICES; size++) {
    const found = searchK(usable, size, target, tol);
    if (found) return found.map(x => x.r);
  }
  return null;
}

/** Búsqueda combinatoria acotada para tamaño k. */
function searchK<T extends { bruto: number }>(
  arr: T[],
  k: number,
  target: number,
  tol: number,
): T[] | null {
  if (k === 0) return Math.abs(target) <= tol ? [] : null;
  const n = arr.length;
  // Cota: incluso sumando los k más grandes no llegamos al target.
  // Cota inferior: sumando los k más pequeños rebasamos.
  for (let i = 0; i + k <= n; i++) {
    const head = arr[i];
    if (head.bruto > target + tol) continue; // demasiado grande aun solo
    const remaining = arr.slice(i + 1);
    const sub = searchK(remaining, k - 1, target - head.bruto, tol);
    if (sub) return [head, ...sub];
  }
  return null;
}

// ── Índices de candidatos ─────────────────────────────────────────────────

const AUTO_CONFIDENCE_THRESHOLD = 0.75;
const REVIEW_CONFIDENCE_THRESHOLD = 0.50;
const AMOUNT_BUCKET_SIZE = 1; // pesos redondeados; luego se valida al centavo/tolerancia.
const MAX_REVIEW_CANDIDATES_PER_ABONO = 4;

type TargetKind = 'bruto' | 'pagado' | 'pendiente';

interface FacturaTarget {
  id: string;
  record: CobranzaRecord;
  facturaKey: string;
  clienteKey: string;
  amount: number;
  kind: TargetKind;
  refDate: string;
  windowDays: number;
}

interface CandidateEvaluation {
  target: FacturaTarget;
  tier: MatchTier;
  confidence: number;
  daysDelta: number;
  amountDiffPct: number;
  exact: boolean;
  reason: string;
}

interface IndexedFacturas {
  targetsByAmount: Map<string, FacturaTarget[]>;
  targetsByFactura: Map<string, FacturaTarget[]>;
  targetsByCliente: Map<string, FacturaTarget[]>;
  invoiceRefs: Map<string, Set<string>>;
  customerRefs: Map<string, Set<string>>;
  customerTokens: Map<string, Set<string>>;
}

interface UnmatchedAbono {
  line: BankStatementLine;
  movementKey: string;
  enrichment: AbonoEnrichment;
  strongClienteKeys: Set<string>;
}

interface PaymentMatchMeta {
  status: PaymentReconciliationStatus;
  matchTier?: MatchTier;
  confidence?: number;
  matchReason?: string;
  bankMovement?: BankMovementSnapshot;
}

function indexKey(cia: string, moneda: string): string {
  return `${cia || '(sin cia)'}::${(moneda || 'MXN').toUpperCase()}`;
}

function scopedKey(cia: string, moneda: string, value: string): string {
  return `${indexKey(cia, moneda)}::${value}`;
}

function amountBucket(value: number): number {
  return Math.round(value / AMOUNT_BUCKET_SIZE);
}

function normalizeCode(value: string): string {
  return normalizeName(value).replace(/[^A-Z0-9]/g, '');
}

function amountCents(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100);
}

function normalizeAccountKey(value: string | undefined): string {
  return (value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function paymentMatchKey(cia: string, cuenta: string, fecha: string, importe: number): string {
  return `${cia || '(sin cia)'}::${normalizeAccountKey(cuenta)}::${fecha}::${amountCents(importe)}`;
}

function bankPaymentMatchKeys(line: BankStatementLine): string[] {
  const cuentas = new Set([
    normalizeAccountKey(line.cuentaContable),
    normalizeAccountKey(line.cuentaBancos),
    normalizeAccountKey(line.cuenta),
  ]);
  cuentas.delete('');
  // Fecha de cruce contra cobranzaindicadores.fechaCobro:
  //   • `fechaEstadoCuenta` del banco siempre coincide con `Fecha_Cobro` de
  //     cobranzaindicadores — es la llave de fecha primaria.
  //   • `fechaOperacion` se mantiene como llave alterna por compatibilidad
  //     con escenarios donde el banco fechó la operación distinto al estado
  //     de cuenta.
  const fechas = new Set<string>(
    [line.fechaEstadoCuenta, line.fechaOperacion].filter((d): d is string => !!d),
  );
  const keys: string[] = [];
  for (const cuenta of cuentas) {
    for (const fecha of fechas) {
      keys.push(paymentMatchKey(line.cia, cuenta, fecha, line.importe));
    }
  }
  return keys;
}

/**
 * Llave laxa de respaldo cuando No_Recibo no funciona y la cuenta no cruza
 * entre banco y cobranzaindicadores: solo `(cía + fecha + importe)`.
 *
 * Sigue exigiendo importe + fecha juntos para que el match sea confiable;
 * la única dimensión que se afloja es la cuenta. Si dos pagos diferentes
 * caen aquí en el mismo día, mismo importe y misma cía, el motor los marca
 * como AMBIGUOUS y los manda a revisión manual.
 */
function bankDateAmountKeys(line: BankStatementLine): string[] {
  const fechas = new Set<string>(
    [line.fechaEstadoCuenta, line.fechaOperacion].filter((d): d is string => !!d),
  );
  return Array.from(fechas).map(fecha =>
    `${line.cia || '(sin cia)'}::${fecha}::${amountCents(line.importe)}`,
  );
}

function dateAmountKey(cia: string, fecha: string, importe: number): string {
  return `${cia || '(sin cia)'}::${fecha}::${amountCents(importe)}`;
}

function bankReferenceText(line: BankStatementLine): string {
  return normalizeCode([
    line.gsaid,
    line.referencia,
    line.noRecibo,
    line.referenciaCliente,
    line.concepto,
    line.infAdi1,
    line.infAdi2,
    line.infAdi3,
    line.codigoTransaccionBanco,
  ].filter(Boolean).join(' '));
}

function reciboTokens(noRecibo: string): string[] {
  const tokens = new Set<string>();
  const compact = normalizeCode(noRecibo);
  if (/^\d{4,}$/.test(compact)) tokens.add(compact.replace(/^0+/, '') || '0');
  for (const match of noRecibo.matchAll(/\d{4,}/g)) {
    const token = match[0];
    if (token === '2024' || token === '2025' || token === '2026') continue;
    tokens.add(token.replace(/^0+/, '') || '0');
  }
  return Array.from(tokens).filter(token => token.length >= 4);
}

function reciboMatchKeys(cia: string, noRecibo: string): string[] {
  const keys = new Set<string>();
  const compact = normalizeCode(noRecibo);
  if (compact.length >= 4) keys.add(compact);
  for (const token of reciboTokens(noRecibo)) keys.add(token);
  return Array.from(keys).map(key => `${cia || '(sin cia)'}::${key}`);
}

function bankContainsNoRecibo(line: BankStatementLine, noRecibo: string): boolean {
  const text = bankReferenceText(line);
  return reciboTokens(noRecibo).some(token => text.includes(token));
}

function significantNameTokens(value: string): string[] {
  const stopwords = new Set([
    'SA', 'CV', 'SAB', 'SAPI', 'SC', 'AC', 'RL', 'DE', 'EL', 'LA', 'LOS', 'LAS',
    'DEL', 'Y', 'E', 'O', 'SR', 'SRA', 'COMPANIA', 'COMPANIAS', 'GRUPO',
    'CLIENTE', 'CORPORATIVO', 'INTERNACIONAL', 'NACIONAL', 'SERVICIOS',
    'TRANSPORTES', 'MEXICO',
  ]);
  return normalizeName(value)
    .split(' ')
    .filter(t => t.length >= 4 && !stopwords.has(t));
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

function addToListMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function buildFacturaIndexes(facturas: CobranzaRecord[]): IndexedFacturas {
  const targetsByAmount = new Map<string, FacturaTarget[]>();
  const targetsByFactura = new Map<string, FacturaTarget[]>();
  const targetsByCliente = new Map<string, FacturaTarget[]>();
  const invoiceRefs = new Map<string, Set<string>>();
  const customerRefs = new Map<string, Set<string>>();
  const customerTokens = new Map<string, Set<string>>();

  for (const r of facturas) {
    const moneda = (r.moneda || 'MXN').toUpperCase();
    const facturaKey = `${r.cia}::${r.noFactura}`;
    const clienteKey = `${r.cia}::${r.noCliente}`;
    const invoiceRef = normalizeCode(r.noFactura);
    if (invoiceRef.length >= 4) addToSetMap(invoiceRefs, scopedKey(r.cia, moneda, invoiceRef), facturaKey);
    const customerRef = normalizeCode(r.noCliente);
    if (customerRef.length >= 4) addToSetMap(customerRefs, scopedKey(r.cia, moneda, customerRef), clienteKey);
    for (const token of significantNameTokens(r.nombreCliente)) {
      addToSetMap(customerTokens, scopedKey(r.cia, moneda, token), clienteKey);
    }

    const { bruto, pendiente } = selectFacturaImporte(r, moneda === 'USD');
    const pagado = bruto - pendiente;
    const targets: Array<{ amount: number; kind: TargetKind }> = [{ amount: bruto, kind: 'bruto' }];
    if (pagado > 0 && Math.abs(pagado - bruto) > 0.01) targets.push({ amount: pagado, kind: 'pagado' });
    if (pendiente > 0 && Math.abs(pendiente - bruto) > 0.01) targets.push({ amount: pendiente, kind: 'pendiente' });

    for (const target of targets) {
      if (target.amount <= 0) continue;
      const refDate = r.fechaCobro || r.fechaVence;
      if (!refDate) continue;
      const entry: FacturaTarget = {
        id: `${facturaKey}::${target.kind}`,
        record: r,
        facturaKey,
        clienteKey,
        amount: target.amount,
        kind: target.kind,
        refDate,
        windowDays: r.fechaCobro ? COBRO_WINDOW_DAYS : DATE_WINDOW_DAYS,
      };
      addToListMap(targetsByFactura, facturaKey, entry);
      addToListMap(targetsByCliente, clienteKey, entry);
      addToListMap(targetsByAmount, `${indexKey(r.cia, moneda)}::${amountBucket(target.amount)}`, entry);
    }
  }

  return { targetsByAmount, targetsByFactura, targetsByCliente, invoiceRefs, customerRefs, customerTokens };
}

function textNeedles(abono: BankStatementLine): {
  normalized: string;
  compact: string;
  tokens: string[];
} {
  const normalized = normalizeName(`${abono.concepto || ''} ${abono.referencia || ''}`);
  const compact = normalized.replace(/[^A-Z0-9]/g, '');
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return { normalized, compact, tokens };
}

function candidateFacturaKeysFromText(
  indexes: IndexedFacturas,
  abono: BankStatementLine,
): Set<string> {
  const { normalized, compact, tokens } = textNeedles(abono);
  const moneda = (abono.moneda || 'MXN').toUpperCase();
  const out = new Set<string>();
  const invoiceLike = new Set<string>();
  for (const match of normalized.matchAll(/\b[A-Z]{1,5}\s*-?\s*\d{3,}\b/g)) {
    invoiceLike.add(normalizeCode(match[0]));
  }
  for (const token of tokens) {
    const clean = normalizeCode(token);
    if (clean.length >= 5) invoiceLike.add(clean);
  }

  for (const ref of invoiceLike) {
    const keys = indexes.invoiceRefs.get(scopedKey(abono.cia, moneda, ref));
    for (const key of keys ?? []) out.add(key);
    if (compact.includes(ref)) {
      const compactKeys = indexes.invoiceRefs.get(scopedKey(abono.cia, moneda, ref));
      for (const key of compactKeys ?? []) out.add(key);
    }
  }
  return out;
}

function candidateClienteKeysFromText(
  indexes: IndexedFacturas,
  abono: BankStatementLine,
): Set<string> {
  const { tokens } = textNeedles(abono);
  const moneda = (abono.moneda || 'MXN').toUpperCase();
  const out = new Set<string>();

  for (const token of tokens) {
    const clean = normalizeCode(token);
    if (clean.length >= 4 && /^\d+$/.test(clean)) {
      for (const key of indexes.customerRefs.get(scopedKey(abono.cia, moneda, clean)) ?? []) out.add(key);
    }
    if (clean.length >= 4 && !/^\d+$/.test(clean)) {
      const keys = indexes.customerTokens.get(scopedKey(abono.cia, moneda, clean));
      // Conservador: un token de nombre sólo identifica cliente si es único
      // dentro de esa cía/moneda. Tokens compartidos como "NORTE" ayudan a
      // revisión vía monto, pero no elevan a auto-cruce.
      if (keys?.size === 1) {
        for (const key of keys) out.add(key);
      }
    }
  }
  return out;
}

function amountCandidates(
  indexes: IndexedFacturas,
  abono: BankStatementLine,
): FacturaTarget[] {
  const moneda = (abono.moneda || 'MXN').toUpperCase();
  const base = indexKey(abono.cia, moneda);
  // Search for the bank amount AND IVA variants (bank might show
  // IVA-inclusive while factura is subtotal, or vice versa).
  const ivaRate = 0.16;
  const searchAmounts = [
    abono.importe,
    abono.importe / (1 + ivaRate),
    abono.importe * (1 + ivaRate),
  ];
  const seen = new Set<string>();
  const out: FacturaTarget[] = [];
  for (const amt of searchAmounts) {
    const bucket = amountBucket(amt);
    const tol = Math.ceil(amountTolerance(amt) / AMOUNT_BUCKET_SIZE) + 1;
    for (let i = bucket - tol; i <= bucket + tol; i++) {
      for (const target of indexes.targetsByAmount.get(`${base}::${i}`) ?? []) {
        if (!seen.has(target.id)) {
          seen.add(target.id);
          out.push(target);
        }
      }
    }
  }
  return out;
}

function evaluateTarget(
  target: FacturaTarget,
  abono: BankStatementLine,
  identity: 'invoice' | 'customer' | 'none',
): CandidateEvaluation | null {
  if (!mismaMoneda(target.record, abono)) return null;

  const daysDelta = daysBetween(target.refDate, abono.fechaOperacion);
  if (Math.abs(daysDelta) > target.windowDays) return null;

  // Try IVA variants: base amount, with IVA (16%), without IVA.
  // JDE may report subtotal while bank shows IVA-inclusive, or vice versa.
  const ivaRate = target.record.importeIVA && target.record.subTotal && target.record.subTotal > 0
    ? target.record.importeIVA / target.record.subTotal
    : 0.16;
  const amountVariants = [
    target.amount,
    target.amount * (1 + ivaRate),
    target.amount / (1 + ivaRate),
  ];

  let bestAmount = target.amount;
  let exact = false;
  let tolerated = false;
  for (const variant of amountVariants) {
    if (importesCoinciden(variant, abono.importe, true)) {
      exact = true;
      bestAmount = variant;
      break;
    }
    if (!tolerated && importesCoinciden(variant, abono.importe, false)) {
      tolerated = true;
      bestAmount = variant;
    }
  }
  if (!exact && !tolerated) return null;

  const amountDiffPct = Math.abs(bestAmount - abono.importe) / Math.max(bestAmount, 1);
  const tier: MatchTier =
    identity === 'invoice' ? 'invoice-reference' :
    identity === 'customer' ? 'customer-reference' :
    exact ? 'exact' :
    'tolerance';
  let confidence = computeConfidence(tier, amountDiffPct, daysDelta, target.windowDays);

  if (identity === 'invoice') confidence = Math.max(confidence, exact ? 0.98 : 0.92);
  else if (identity === 'customer') confidence = Math.max(confidence, exact ? 0.93 : 0.9);
  else confidence = Math.min(confidence, exact ? 0.92 : 0.82);

  const ivaNote = bestAmount !== target.amount ? ' (ajuste IVA)' : '';
  const reason =
    identity === 'invoice' ? `Referencia bancaria contiene factura ${target.record.noFactura}${ivaNote}.` :
    identity === 'customer' ? `Referencia/concepto menciona cliente ${target.record.noCliente || target.record.nombreCliente}${ivaNote}.` :
    exact ? `Monto exacto y fecha en ventana${ivaNote}; sin identidad fuerte de cliente.` :
    `Monto dentro de tolerancia y fecha en ventana${ivaNote}; sin identidad fuerte de cliente.`;

  return { target, tier, confidence, daysDelta, amountDiffPct, exact, reason };
}

function movementSnapshot(abono: BankStatementLine): BankMovementSnapshot {
  return {
    movementKey: bankMovementKey(abono),
    cia: abono.cia,
    cuenta: abono.cuenta,
    fechaOperacion: abono.fechaOperacion,
    importe: abono.importe,
    concepto: abono.concepto,
    referencia: abono.referencia,
    noRecibo: abono.noRecibo,
    banco: abono.banco,
    nombreBanco: abono.nombreBanco,
  };
}

function paymentApplicationView(
  app: CobranzaPayment['applications'][number],
  payment: CobranzaPayment,
  facturaState: Map<string, RealReconciliationMatch>,
  facturaKeyByNormalized: Map<string, string>,
): PaymentApplicationReconciliation {
  const appCia = app.cia || payment.cia;
  const facturaKey = facturaKeyByNormalized.get(`${appCia}::${normalizeCode(app.noFactura)}`);
  const state = facturaKey ? facturaState.get(facturaKey) : undefined;
  const original = Math.max(0, app.importeOriginalFactura || 0);
  const ivaOriginal = Math.max(0, app.importeIvaFacturaOriginal || 0);
  const ratio = original > 0 ? Math.min(1, Math.max(0, app.importeCobrado / original)) : 0;
  return {
    cia: appCia,
    noFactura: app.noFactura,
    noFacturaNormalizada: app.noFacturaNormalizada,
    noCliente: app.noCliente,
    cliente: app.cliente,
    tipoDocto: app.tipoDocto,
    fechaAplicacion: app.fechaAplicacion,
    fechaFactura: app.fechaFactura,
    fechaVencimiento: app.fechaVencimiento,
    importeCobrado: app.importeCobrado,
    importeOriginalFactura: app.importeOriginalFactura,
    importePteFactura: app.importePteFactura,
    tasaIva: app.tasaIva,
    importeIvaFacturaOriginal: app.importeIvaFacturaOriginal,
    ivaCausadoProporcional: ivaOriginal * ratio,
    facturaStatus: state?.status,
  };
}

function paymentReconciliationView(
  payment: CobranzaPayment,
  meta: PaymentMatchMeta | undefined,
  facturaState: Map<string, RealReconciliationMatch>,
  facturaKeyByNormalized: Map<string, string>,
): PaymentReconciliation {
  const applications = payment.applications.map(app =>
    paymentApplicationView(app, payment, facturaState, facturaKeyByNormalized),
  );
  return {
    idPago: payment.idPago,
    cia: payment.cia,
    fechaCobro: payment.fechaCobro,
    fechaContable: payment.fechaContable,
    cuentaBancaria: payment.cuentaBancaria,
    banco: payment.banco,
    noRecibo: payment.noRecibo,
    importeRecibo: payment.importeRecibo,
    pendienteAplicar: payment.pendienteAplicar,
    noCliente: payment.noCliente,
    cliente: payment.cliente,
    noBatch: payment.noBatch,
    tipoCambio: payment.tipoCambio,
    applicationCount: applications.length,
    importeAplicado: applications.reduce((sum, app) => sum + app.importeCobrado, 0),
    status: meta?.status ?? 'UNMATCHED',
    matchTier: meta?.matchTier,
    confidence: meta?.confidence,
    matchReason: meta?.matchReason,
    bankMovement: meta?.bankMovement,
    applications,
  };
}

function candidateFromEvaluation(ev: CandidateEvaluation): ReconciliationCandidateFactura {
  const r = ev.target.record;
  return {
    cia: r.cia,
    noFactura: r.noFactura,
    noCliente: r.noCliente,
    nombreCliente: r.nombreCliente,
    importeBruto: r.importeBrutoPesos,
    importePendiente: r.importePendientePesos,
    fechaFactura: r.fechaFactura,
    fechaVence: r.fechaVence,
    confidence: ev.confidence,
    matchTier: ev.tier,
    matchReason: ev.reason,
  };
}

function buildBankCoverage(bankStatements: BankAccountStatement[], abonos: BankStatementLine[]): RealReconciliationBankCoverage {
  const loadedDates = new Set<string>();
  let totalMovements = 0;
  for (const account of bankStatements) {
    for (const mov of account.movimientos) {
      totalMovements++;
      if (mov.fechaOperacion) loadedDates.add(mov.fechaOperacion);
    }
  }
  const dates = Array.from(loadedDates).sort();
  return {
    loadedDates: dates,
    from: dates[0],
    to: dates[dates.length - 1],
    totalMovements,
    totalAbonos: abonos.length,
  };
}

function searchBankSubset(
  abonos: UnmatchedAbono[],
  target: number,
): UnmatchedAbono[] | null {
  const tol = amountTolerance(target);
  const usable = abonos
    .filter(a => a.line.importe > 0 && a.line.importe <= target + tol)
    .sort((a, b) => b.line.importe - a.line.importe)
    .map(a => ({ ...a, bruto: a.line.importe }));
  for (let size = 2; size <= SUBSET_MAX_INVOICES; size++) {
    const found = searchK(usable, size, target, tol);
    if (found) return found;
  }
  return null;
}

// ── Motor principal ───────────────────────────────────────────────────────

export interface RealReconcileOptions {
  /**
   * Solo cruzar facturas cuya cía esté en este set. `undefined` = todas.
   * Útil para acotar al filtro de empresa activa en la UI.
   */
  ciaFilter?: Set<string>;
  /**
   * Cuando `true`, también probamos `importeBrutoDolares` cuando moneda===USD.
   * Default true.
   */
  enableUSD?: boolean;
  /** Pagos/recibos de IndicadoresCobranza para conciliación banco → recibo → facturas. */
  cobranzaPayments?: CobranzaPayment[];
}

/**
 * Cruza facturas reales (CXC) contra ABONOs bancarios. Salida etiquetada
 * por factura y por ABONO con el tier de match.
 */
export function reconcileRealCollections(
  cobranzaRecords: CobranzaRecord[],
  bankStatements: BankAccountStatement[],
  options: RealReconcileOptions = {},
): RealReconciliationResult {
  const startedAt = nowMs();
  const { ciaFilter, enableUSD = true, cobranzaPayments = [] } = options;

  // ── 1. Filtrar facturas relevantes (con saldo abierto Y cia permitida) ──
  const facturas = cobranzaRecords.filter(r => {
    if (ciaFilter && !ciaFilter.has(r.cia)) return false;
    return true;
  });

  // ── 2. Pool de ABONOs (descartar traspasos internos) ──
  const indexStartedAt = nowMs();
  const detector = buildOwnAccountDetector(buildOwnAccountsIndex(bankStatements));
  const pairedKeys = buildPairMatchedKeys(bankStatements);
  const abonos: BankStatementLine[] = [];
  let abonosTraspasoInterno = 0;
  for (const account of bankStatements) {
    if (ciaFilter && !ciaFilter.has(account.cia)) continue;
    for (const mov of account.movimientos) {
      const line: BankStatementLine = {
        ...mov,
        cia: mov.cia || account.cia,
        banco: mov.banco || account.banco,
        nombreBanco: mov.nombreBanco || account.nombreBanco,
        cuenta: mov.cuenta || account.cuenta,
        moneda: mov.moneda || account.moneda,
      };
      if (line.tipoMovimiento !== 'ABONO') continue;
      const classification = classifyMovement(
        line,
        { ownAccountDetector: detector, pairedKeys },
        account.cia,
        account.cuenta,
      );
      if (classification.kind === 'internal') {
        abonosTraspasoInterno++;
        continue;
      }
      abonos.push(line);
    }
  }
  // Orden cronológico — ABONO más antiguo primero. Evita que un ABONO
  // reciente "robe" un match que pertenece a un cobro previo del mismo
  // monto.
  abonos.sort((a, b) => a.fechaOperacion.localeCompare(b.fechaOperacion));

  // ── 3. Agrupar e indexar facturas por identidad + monto ───────────────
  const facturasPorCliente = new Map<string, CobranzaRecord[]>();
  const facturaState = new Map<string, RealReconciliationMatch>();
  const facturaKeyByNormalized = new Map<string, string>();
  for (const r of facturas) {
    const key = `${r.cia}::${r.noCliente}`;
    if (!facturasPorCliente.has(key)) facturasPorCliente.set(key, []);
    facturasPorCliente.get(key)!.push(r);

    const facturaKey = `${r.cia}::${r.noFactura}`;
    facturaKeyByNormalized.set(`${r.cia}::${normalizeCode(r.noFactura)}`, facturaKey);
    facturaState.set(facturaKey, {
      cia: r.cia,
      noFactura: r.noFactura,
      noCliente: r.noCliente,
      nombreCliente: r.nombreCliente,
      importeBruto: r.importeBrutoPesos,
      importePendiente: r.importePendientePesos,
      fechaFactura: r.fechaFactura,
      fechaVence: r.fechaVence,
      diasVencida: r.diasVencida,
      moneda: r.moneda,
      // Default: pendiente = saldo > 0; cobrada-jde si pendiente == 0 ya en ERP
      status: r.importePendientePesos > 0
        ? 'pendiente'
        : 'cobrada-jde-sin-banco',
      reviewStatus: 'unmatched',
    });
  }
  const scopedPayments = cobranzaPayments.filter(payment => !ciaFilter || ciaFilter.has(payment.cia));
  const paymentMatchMeta = new Map<string, PaymentMatchMeta>();
  const paymentsByBankKey = new Map<string, CobranzaPayment[]>();
  const paymentsByNoRecibo = new Map<string, CobranzaPayment[]>();
  // Índice laxo: (cía + fechaCobro + importeRecibo). Se usa solo como
  // respaldo cuando No_Recibo no cruza y la cuenta no logra alinearse
  // entre banco y cobranzaindicadores. La fecha (Fecha_Cobro ↔
  // Fecha_Estado_Cuenta) siempre debe coincidir, y el importe filtra falsos
  // positivos. Ambigüedades reales caen en la rama AMBIGUOUS de abajo.
  const paymentsByDateAmount = new Map<string, CobranzaPayment[]>();
  for (const payment of scopedPayments) {
    if (payment.noRecibo) {
      for (const key of reciboMatchKeys(payment.cia, payment.noRecibo)) {
        addToListMap(paymentsByNoRecibo, key, payment);
      }
    }
    if (payment.cuentaBancaria && payment.fechaCobro && payment.importeRecibo > 0) {
      addToListMap(
        paymentsByBankKey,
        paymentMatchKey(payment.cia, payment.cuentaBancaria, payment.fechaCobro, payment.importeRecibo),
        payment,
      );
    }
    if (payment.fechaCobro && payment.importeRecibo > 0) {
      addToListMap(
        paymentsByDateAmount,
        dateAmountKey(payment.cia, payment.fechaCobro, payment.importeRecibo),
        payment,
      );
    }
  }
  const indexes = buildFacturaIndexes(facturas);
  const indexMs = nowMs() - indexStartedAt;

  // ── 4. Set de facturas ya consumidas por algún ABONO ──
  const consumedFactura = new Set<string>(); // `${cia}::${noFactura}`
  const consumedAbono = new Set<string>();
  const consumedPayment = new Set<string>();
  const enrichments: AbonoEnrichment[] = [];
  const unmatchedAbonos: UnmatchedAbono[] = [];

  // ── 5. Iterar ABONOs y buscar matches ──
  const matchStartedAt = nowMs();
  let subsetCounter = 0;
  const uniquePayments = (payments: CobranzaPayment[]): CobranzaPayment[] =>
    Array.from(new Map(payments.map(payment => [payment.idPago, payment])).values());

  const markPaymentAmbiguous = (
    enrichment: AbonoEnrichment,
    abono: BankStatementLine,
    payments: CobranzaPayment[],
    reason: string,
  ) => {
    enrichment.matchTier = 'payment-ambiguous';
    enrichment.confidence = 0.55;
    enrichment.matchReason = reason;
    enrichment.paymentMatchStatus = 'AMBIGUOUS';
    for (const payment of payments) {
      if (!paymentMatchMeta.has(payment.idPago)) {
        paymentMatchMeta.set(payment.idPago, {
          status: 'AMBIGUOUS',
          matchTier: 'payment-ambiguous',
          confidence: 0.55,
          matchReason: reason,
          bankMovement: movementSnapshot(abono),
        });
      }
    }
  };

  const applyPaymentMatch = (
    enrichment: AbonoEnrichment,
    abono: BankStatementLine,
    selectedPayment: CobranzaPayment,
    matchStatus: Exclude<PaymentReconciliationStatus, 'UNMATCHED' | 'AMBIGUOUS'>,
    tier: Extract<MatchTier, 'payment-confirmed-ref' | 'payment-auto-unique'>,
    confidence: number,
    reason: string,
  ) => {
    const paidFacturas: AbonoEnrichment['facturas'] = [];

    consumedPayment.add(selectedPayment.idPago);
    paymentMatchMeta.set(selectedPayment.idPago, {
      status: matchStatus,
      matchTier: tier,
      confidence,
      matchReason: reason,
      bankMovement: movementSnapshot(abono),
    });
    consumedAbono.add(enrichment.movementKey);
    for (const app of selectedPayment.applications) {
      const facturaKey = facturaKeyByNormalized.get(`${app.cia || selectedPayment.cia}::${normalizeCode(app.noFactura)}`);
      const state = facturaKey ? facturaState.get(facturaKey) : undefined;
      if (!facturaKey || !state) continue;
      consumedFactura.add(facturaKey);
      state.status = 'cobrada-banco';
      state.matchTier = tier;
      state.confidence = confidence;
      state.reviewStatus = 'auto';
      state.matchReason = reason;
      state.bankRef = abono.referencia;
      state.bankAmount = app.importeCobrado || selectedPayment.importeRecibo;
      state.bankDate = abono.fechaOperacion;
      state.bankConcept = abono.concepto;
      state.bankAccount = abono.cuenta;
      state.bankCia = abono.cia;
      state.bankMovements = [movementSnapshot(abono)];
      state.idPago = selectedPayment.idPago;
      state.noRecibo = selectedPayment.noRecibo;
      state.paymentMatchStatus = matchStatus;
      paidFacturas.push({
        cia: state.cia,
        noFactura: state.noFactura,
        noCliente: state.noCliente,
        nombreCliente: state.nombreCliente,
        importeBruto: app.importeCobrado || state.importeBruto,
      });
    }

    enrichment.status = paidFacturas.length > 0 ? 'factura-cobrada' : 'cobranza-sin-factura';
    enrichment.matchTier = tier;
    enrichment.confidence = confidence;
    enrichment.matchReason = paidFacturas.length > 0
      ? reason
      : `${reason} No se encontró factura CXC correspondiente en /cobranza.`;
    enrichment.facturas = paidFacturas.length > 0 ? paidFacturas : undefined;
    enrichment.idPago = selectedPayment.idPago;
    enrichment.noRecibo = selectedPayment.noRecibo;
    enrichment.paymentMatchStatus = matchStatus;
  };

  for (const abono of abonos) {
    const moneda = (abono.moneda || 'MXN').toUpperCase();
    const useUSD = enableUSD && moneda === 'USD';

    const enrichment: AbonoEnrichment = {
      movementKey: bankMovementKey(abono),
      status: 'cobranza-sin-factura',
      cia: abono.cia,
      cuenta: abono.cuenta,
      fechaOperacion: abono.fechaOperacion,
      importe: abono.importe,
      concepto: abono.concepto,
      referencia: abono.referencia,
    };

    const bankNoReciboCandidates = uniquePayments(
      abono.noRecibo
        ? reciboMatchKeys(abono.cia, abono.noRecibo).flatMap(key => paymentsByNoRecibo.get(key) ?? [])
        : [],
    ).filter(payment => !consumedPayment.has(payment.idPago));
    if (bankNoReciboCandidates.length > 0) {
      const matchingAmount = bankNoReciboCandidates.filter(payment =>
        importesCoinciden(payment.importeRecibo, abono.importe, false),
      );
      const selectedPayment = matchingAmount.length === 1 ? matchingAmount[0] : null;
      if (selectedPayment) {
        applyPaymentMatch(
          enrichment,
          abono,
          selectedPayment,
          'CONFIRMED_REF',
          'payment-confirmed-ref',
          0.99,
          `Banco cruza con Id Pago ${selectedPayment.idPago} por No_Recibo bancario ${abono.noRecibo}.`,
        );
        enrichments.push(enrichment);
        continue;
      }
      const reason = matchingAmount.length > 1
        ? `${matchingAmount.length} Id Pago comparten No_Recibo bancario ${abono.noRecibo} e importe ${abono.importe}; requiere revisión.`
        : `No_Recibo bancario ${abono.noRecibo} apunta a Id Pago ${bankNoReciboCandidates[0].idPago}, pero el importe banco ${abono.importe} no coincide con recibo ${bankNoReciboCandidates[0].importeRecibo}.`;
      markPaymentAmbiguous(enrichment, abono, matchingAmount.length > 1 ? matchingAmount : bankNoReciboCandidates, reason);
      enrichments.push(enrichment);
      continue;
    }

    let paymentCandidates = uniquePayments(
      bankPaymentMatchKeys(abono).flatMap(key => paymentsByBankKey.get(key) ?? []),
    ).filter(payment => !consumedPayment.has(payment.idPago));
    // Fallback laxo cuando el cuenta-key no encontró candidatos: cruzamos
    // solo por (cía + fecha + importe). Sigue exigiendo fecha + importe
    // juntos — sin esto el match sería ruidoso — pero permite que el cruce
    // funcione cuando el banco y cobranzaindicadores no expresan la cuenta
    // de la misma forma.
    if (paymentCandidates.length === 0) {
      paymentCandidates = uniquePayments(
        bankDateAmountKeys(abono).flatMap(key => paymentsByDateAmount.get(key) ?? []),
      ).filter(payment => !consumedPayment.has(payment.idPago));
    }
    const refPayment = paymentCandidates.find(payment => bankContainsNoRecibo(abono, payment.noRecibo));
    const selectedPayment = refPayment ?? (paymentCandidates.length === 1 ? paymentCandidates[0] : null);
    if (selectedPayment) {
      const confirmedByRef = selectedPayment === refPayment;
      const matchStatus = confirmedByRef ? 'CONFIRMED_REF' : 'AUTO_UNIQUE';
      const tier = confirmedByRef ? 'payment-confirmed-ref' : 'payment-auto-unique';
      const confidence = confirmedByRef ? 0.99 : 0.94;
      const reason = confirmedByRef
        ? `Banco cruza con Id Pago ${selectedPayment.idPago} y No Recibo ${selectedPayment.noRecibo}.`
        : `Banco cruza con Id Pago ${selectedPayment.idPago} por cuenta contable, fecha e importe únicos.`;
      applyPaymentMatch(enrichment, abono, selectedPayment, matchStatus, tier, confidence, reason);
      enrichments.push(enrichment);
      continue;
    }

    if (paymentCandidates.length > 1) {
      markPaymentAmbiguous(
        enrichment,
        abono,
        paymentCandidates,
        `${paymentCandidates.length} Id Pago comparten cuenta, fecha e importe; requiere revisión.`,
      );
      enrichments.push(enrichment);
      continue;
    }

    const invoiceFacturaKeys = candidateFacturaKeysFromText(indexes, abono);
    const strongClienteKeys = candidateClienteKeysFromText(indexes, abono);

    const evaluations = new Map<string, CandidateEvaluation>();
    const addEvaluation = (target: FacturaTarget, identity: 'invoice' | 'customer' | 'none') => {
      if (consumedFactura.has(target.facturaKey)) return;
      const ev = evaluateTarget(target, abono, identity);
      if (!ev) return;
      const current = evaluations.get(target.id);
      if (!current || ev.confidence > current.confidence) evaluations.set(target.id, ev);
    };

    for (const facturaKey of invoiceFacturaKeys) {
      for (const target of indexes.targetsByFactura.get(facturaKey) ?? []) addEvaluation(target, 'invoice');
    }
    for (const clienteKey of strongClienteKeys) {
      for (const target of indexes.targetsByCliente.get(clienteKey) ?? []) addEvaluation(target, 'customer');
    }
    for (const target of amountCandidates(indexes, abono)) {
      const identity = invoiceFacturaKeys.has(target.facturaKey)
        ? 'invoice'
        : strongClienteKeys.has(target.clienteKey)
          ? 'customer'
          : 'none';
      addEvaluation(target, identity);
    }

    const ranked = Array.from(evaluations.values()).sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return Math.abs(a.daysDelta) - Math.abs(b.daysDelta);
    });

    let bestMatch = ranked.find(ev => ev.confidence >= AUTO_CONFIDENCE_THRESHOLD) ?? null;
    let bestSubset: { records: CobranzaRecord[]; confidence: number; reason: string } | null = null;

    if (!bestMatch) {
      const triedClienteKeys = new Set<string>();
      const trySubsetForCliente = (
        clienteKey: string,
        identified: boolean,
      ): { records: CobranzaRecord[]; confidence: number; reason: string } | null => {
        if (triedClienteKeys.has(clienteKey)) return null;
        triedClienteKeys.add(clienteKey);
        const clienteFacturas = (facturasPorCliente.get(clienteKey) ?? []).filter(r => !consumedFactura.has(`${r.cia}::${r.noFactura}`));
        if (clienteFacturas.length < 2) return null;
        const sample = clienteFacturas[0];
        if (!mismaMoneda(sample, abono)) return null;
        const subset = findSubset(clienteFacturas, abono.importe, useUSD);
        if (!subset) return null;
        const fechas = subset.map(r => r.fechaCobro || r.fechaVence).filter(Boolean);
        if (fechas.length === 0) return null;
        const closestDelta = fechas
          .map(f => Math.abs(daysBetween(f, abono.fechaOperacion)))
          .reduce((min, d) => Math.min(min, d), Number.POSITIVE_INFINITY);
        if (closestDelta > DATE_WINDOW_DAYS) return null;
        const sumBruto = subset.reduce((s, r) => s + selectFacturaImporte(r, useUSD).bruto, 0);
        const amountDiffPct = Math.abs(sumBruto - abono.importe) / Math.max(sumBruto, 1);
        const confidence = Math.max(identified ? 0.9 : 0.8, computeConfidence('subset', amountDiffPct, closestDelta, DATE_WINDOW_DAYS));
        return {
          records: subset,
          confidence,
          reason: identified
            ? `Un ABONO cubre ${subset.length} facturas del mismo cliente identificado en banco.`
            : `Un ABONO cubre ${subset.length} facturas del mismo cliente (${sample.nombreCliente.trim()}).`,
        };
      };

      for (const clienteKey of strongClienteKeys) {
        const result = trySubsetForCliente(clienteKey, true);
        if (result && (!bestSubset || result.confidence > bestSubset.confidence)) {
          bestSubset = result;
        }
      }

      if (!bestSubset && abono.importe >= 10000) {
        for (const [clienteKey] of facturasPorCliente) {
          if (!clienteKey.startsWith(`${abono.cia}::`)) continue;
          const result = trySubsetForCliente(clienteKey, false);
          if (result) { bestSubset = result; break; }
        }
      }
    }

    if (bestMatch) {
      const r: CobranzaRecord = bestMatch.target.record;
      const tier = bestMatch.tier;
      const confidence = bestMatch.confidence;
      const facturaKey = `${r.cia}::${r.noFactura}`;
      consumedFactura.add(facturaKey);
      consumedAbono.add(enrichment.movementKey);
      const m = facturaState.get(facturaKey);
      if (m) {
        m.status = 'cobrada-banco';
        m.matchTier = tier;
        m.confidence = confidence;
        m.reviewStatus = 'auto';
        m.matchReason = bestMatch.reason;
        m.bankRef = abono.referencia;
        m.bankAmount = abono.importe;
        m.bankDate = abono.fechaOperacion;
        m.bankConcept = abono.concepto;
        m.bankAccount = abono.cuenta;
        m.bankCia = abono.cia;
        m.bankMovements = [movementSnapshot(abono)];
      }
      enrichment.status = 'factura-cobrada';
      enrichment.matchTier = tier;
      enrichment.confidence = confidence;
      enrichment.matchReason = bestMatch.reason;
      enrichment.facturas = [{
        cia: r.cia,
        noFactura: r.noFactura,
        noCliente: r.noCliente,
        nombreCliente: r.nombreCliente,
        importeBruto: r.importeBrutoPesos,
      }];
    } else if (bestSubset) {
      const subsetGroupId = `subset-${++subsetCounter}`;
      const consumed: Array<{
        cia: string; noFactura: string; noCliente: string; nombreCliente: string; importeBruto: number;
      }> = [];
      consumedAbono.add(enrichment.movementKey);
      for (const r of bestSubset.records) {
        const facturaKey = `${r.cia}::${r.noFactura}`;
        consumedFactura.add(facturaKey);
        const m = facturaState.get(facturaKey);
        if (m) {
          m.status = 'cobrada-banco';
          m.matchTier = 'subset';
          m.confidence = bestSubset.confidence;
          m.reviewStatus = 'auto';
          m.matchReason = bestSubset.reason;
          m.bankRef = abono.referencia;
          m.bankAmount = abono.importe;
          m.bankDate = abono.fechaOperacion;
          m.bankConcept = abono.concepto;
          m.bankAccount = abono.cuenta;
          m.bankCia = abono.cia;
          m.bankMovements = [movementSnapshot(abono)];
          m.subsetGroupId = subsetGroupId;
          m.subsetSize = bestSubset.records.length;
        }
        consumed.push({
          cia: r.cia,
          noFactura: r.noFactura,
          noCliente: r.noCliente,
          nombreCliente: r.nombreCliente,
          importeBruto: r.importeBrutoPesos,
        });
      }
      enrichment.status = 'factura-cobrada';
      enrichment.matchTier = 'subset';
      enrichment.confidence = bestSubset.confidence;
      enrichment.matchReason = bestSubset.reason;
      enrichment.facturas = consumed;
    } else {
      const reviews = ranked
        .filter(ev => ev.confidence >= REVIEW_CONFIDENCE_THRESHOLD)
        .slice(0, MAX_REVIEW_CANDIDATES_PER_ABONO)
        .map(candidateFromEvaluation);
      if (reviews.length > 0) {
        enrichment.candidateFacturas = reviews;
        enrichment.matchReason = reviews[0].matchReason;
      }
      unmatchedAbonos.push({
        line: abono,
        movementKey: enrichment.movementKey,
        enrichment,
        strongClienteKeys,
      });
    }
    // status default 'cobranza-sin-factura' ya fue puesto al iniciar.

    enrichments.push(enrichment);
  }

  // ── 5.c Multi-abono: varios abonos del mismo cliente cubren una factura ──
  for (const r of facturas) {
    const facturaKey = `${r.cia}::${r.noFactura}`;
    if (consumedFactura.has(facturaKey)) continue;
    const clienteKey = `${r.cia}::${r.noCliente}`;
    const moneda = (r.moneda || 'MXN').toUpperCase();
    const useUSD = enableUSD && moneda === 'USD';
    const { bruto, pendiente } = selectFacturaImporte(r, useUSD);
    const targets = [bruto];
    if (pendiente > 0 && Math.abs(pendiente - bruto) > 0.01) targets.push(pendiente);
    const refDate = r.fechaCobro || r.fechaVence;
    if (!refDate) continue;

    const candidateAbonos = unmatchedAbonos.filter(entry => {
      if (consumedAbono.has(entry.movementKey)) return false;
      if (entry.line.cia !== r.cia) return false;
      if ((entry.line.moneda || 'MXN').toUpperCase() !== moneda) return false;
      if (!entry.strongClienteKeys.has(clienteKey)) return false;
      return Math.abs(daysBetween(refDate, entry.line.fechaOperacion)) <= DATE_WINDOW_DAYS;
    });
    if (candidateAbonos.length < 2) continue;

    for (const target of targets) {
      const subset = searchBankSubset(candidateAbonos, target);
      if (!subset) continue;
      const total = subset.reduce((s, entry) => s + entry.line.importe, 0);
      const amountDiffPct = Math.abs(total - target) / Math.max(target, 1);
      const confidence = Math.max(0.9, computeConfidence('multi-abono', amountDiffPct, 0, DATE_WINDOW_DAYS));
      const reason = `${subset.length} ABONOs del mismo cliente cubren la factura.`;
      const snapshots = subset.map(entry => movementSnapshot(entry.line));
      const state = facturaState.get(facturaKey);
      if (state) {
        state.status = 'cobrada-banco';
        state.matchTier = 'multi-abono';
        state.confidence = confidence;
        state.reviewStatus = 'auto';
        state.matchReason = reason;
        state.bankRef = subset.map(entry => entry.line.referencia).filter(Boolean).join(' + ');
        state.bankAmount = total;
        state.bankDate = subset.map(entry => entry.line.fechaOperacion).sort()[0];
        state.bankConcept = reason;
        state.bankAccount = subset.map(entry => entry.line.cuenta).filter(Boolean).join(' + ');
        state.bankCia = r.cia;
        state.bankMovements = snapshots;
      }
      consumedFactura.add(facturaKey);
      for (const entry of subset) {
        consumedAbono.add(entry.movementKey);
        entry.enrichment.status = 'factura-cobrada';
        entry.enrichment.matchTier = 'multi-abono';
        entry.enrichment.confidence = confidence;
        entry.enrichment.matchReason = reason;
        entry.enrichment.candidateFacturas = undefined;
        entry.enrichment.facturas = [{
          cia: r.cia,
          noFactura: r.noFactura,
          noCliente: r.noCliente,
          nombreCliente: r.nombreCliente,
          importeBruto: r.importeBrutoPesos,
        }];
      }
      break;
    }
  }

  const reviewCandidates: ReconciliationReviewCandidate[] = [];
  for (const enrichment of enrichments) {
    if (enrichment.status !== 'cobranza-sin-factura' || !enrichment.candidateFacturas?.length) continue;
    const candidates = enrichment.candidateFacturas.filter(c => {
      const state = facturaState.get(`${c.cia}::${c.noFactura}`);
      return state?.status !== 'cobrada-banco';
    });
    if (candidates.length === 0) {
      enrichment.candidateFacturas = undefined;
      continue;
    }
    enrichment.candidateFacturas = candidates;
    for (const c of candidates) {
      const state = facturaState.get(`${c.cia}::${c.noFactura}`);
      if (state && state.reviewStatus !== 'auto') {
        state.reviewStatus = 'review';
        state.confidence = Math.max(state.confidence ?? 0, c.confidence);
        state.matchTier = c.matchTier;
        state.matchReason = c.matchReason;
      }
    }
    reviewCandidates.push({
      movement: {
        movementKey: enrichment.movementKey,
        cia: enrichment.cia,
        cuenta: enrichment.cuenta,
        fechaOperacion: enrichment.fechaOperacion,
        importe: enrichment.importe,
        concepto: enrichment.concepto,
        referencia: enrichment.referencia,
      },
      candidateFacturas: candidates,
      matchReason: enrichment.matchReason ?? candidates[0].matchReason,
    });
  }

  // ── 6. Construir summary ──
  const matches = Array.from(facturaState.values());
  const cobradas = matches.filter(m => m.status === 'cobrada-banco');
  const cobradasJde = matches.filter(m => m.status === 'cobrada-jde-sin-banco');
  const pendientes = matches.filter(m => m.status === 'pendiente');
  const totalSaldoBruto = matches.reduce((s, m) => s + m.importeBruto, 0);
  const totalSaldoPendiente = matches.reduce((s, m) => s + m.importePendiente, 0);
  const totalCobradoBanco = cobradas.reduce((s, m) => s + (m.bankAmount ?? 0), 0);

  const totalAbonoMonto = abonos.reduce((s, m) => s + m.importe, 0);
  const abonosFacturaCobrada = enrichments.filter(e => e.status === 'factura-cobrada').length;
  const abonosSinFactura = enrichments.filter(e => e.status === 'cobranza-sin-factura').length;
  const paymentReconciliations = scopedPayments
    .map(payment => paymentReconciliationView(payment, paymentMatchMeta.get(payment.idPago), facturaState, facturaKeyByNormalized))
    .sort((a, b) => a.fechaCobro.localeCompare(b.fechaCobro) || a.idPago.localeCompare(b.idPago));
  const pagosConciliadosBanco = paymentReconciliations.filter(payment =>
    payment.status === 'CONFIRMED_REF' || payment.status === 'AUTO_UNIQUE',
  );
  const pagosAmbiguos = paymentReconciliations.filter(payment => payment.status === 'AMBIGUOUS');
  const pagosSinBanco = paymentReconciliations.filter(payment => payment.status === 'UNMATCHED');
  const pagosMultiFactura = paymentReconciliations.filter(payment => payment.applicationCount > 1);
  const montoPagosMultiFacturaConciliado = pagosMultiFactura
    .filter(payment => payment.status === 'CONFIRMED_REF' || payment.status === 'AUTO_UNIQUE')
    .reduce((sum, payment) => sum + payment.importeRecibo, 0);

  // Para el % de facturas cruzadas, denominador = facturas con saldo > 0.
  // Las que ya estaban cerradas en JDE no cuentan (no había nada que cruzar).
  const facturasConSaldo = matches.filter(m => m.importePendiente > 0 || m.status === 'cobrada-banco');

  // Breakdown por cia para debugging — mostramos cuántas facturas y abonos
  // hay por cia y cuántos matches resultaron.
  const ciaCounts = new Map<string, { facturas: number; abonos: number; matches: number }>();
  for (const f of facturas) {
    const c = f.cia || '(sin cia)';
    const cur = ciaCounts.get(c) ?? { facturas: 0, abonos: 0, matches: 0 };
    cur.facturas++;
    ciaCounts.set(c, cur);
  }
  for (const a of abonos) {
    const c = a.cia || '(sin cia)';
    const cur = ciaCounts.get(c) ?? { facturas: 0, abonos: 0, matches: 0 };
    cur.abonos++;
    ciaCounts.set(c, cur);
  }
  for (const m of cobradas) {
    const c = m.cia || '(sin cia)';
    const cur = ciaCounts.get(c) ?? { facturas: 0, abonos: 0, matches: 0 };
    cur.matches++;
    ciaCounts.set(c, cur);
  }
  const ciaBreakdown = Array.from(ciaCounts.entries())
    .map(([cia, v]) => ({ cia, ...v }))
    .sort((a, b) => (b.facturas + b.abonos) - (a.facturas + a.abonos));

  const summary: RealReconciliationSummary = {
    totalFacturas: matches.length,
    facturasCobradasBanco: cobradas.length,
    facturasCobradasJdeSinBanco: cobradasJde.length,
    facturasPendientes: pendientes.length,
    totalSaldoBruto,
    totalSaldoPendiente,
    totalCobradoBanco,
    totalAbonos: abonos.length,
    totalAbonoMonto,
    abonosFacturaCobrada,
    abonosSinFactura,
    abonosTraspasoInterno,
    totalPagosIndicadores: scopedPayments.length,
    pagosConciliadosBanco: pagosConciliadosBanco.length,
    pagosSinBanco: pagosSinBanco.length,
    pagosAmbiguos: pagosAmbiguos.length,
    pagosMultiFactura: pagosMultiFactura.length,
    montoPagosMultiFacturaConciliado,
    pctAbonosCruzados: abonos.length > 0 ? abonosFacturaCobrada / abonos.length : 0,
    pctFacturasCruzadas: facturasConSaldo.length > 0
      ? cobradas.length / facturasConSaldo.length
      : 0,
    ciaBreakdown,
  };

  const matchMs = nowMs() - matchStartedAt;
  const totalMs = nowMs() - startedAt;

  return {
    matches,
    abonoEnrichments: enrichments,
    paymentReconciliations,
    summary,
    reviewCandidates,
    bankCoverage: buildBankCoverage(bankStatements, abonos),
    timingsMs: {
      totalMs,
      indexMs,
      matchMs,
    },
  };
}

// ── Lookups útiles para la UI ──────────────────────────────────────────────

/**
 * Indexa los matches por (cia, noFactura) para que la UI consulte el estado
 * de cobranza de una factura en O(1).
 */
export function buildFacturaIndex(
  matches: RealReconciliationMatch[],
): Map<string, RealReconciliationMatch> {
  const map = new Map<string, RealReconciliationMatch>();
  for (const m of matches) {
    map.set(`${m.cia}::${m.noFactura}`, m);
  }
  return map;
}

/**
 * Indexa los enrichments por movement key para que la pestaña Bancos pueda
 * pintar badges en cada ABONO.
 */
export function buildAbonoIndex(
  enrichments: AbonoEnrichment[],
): Map<string, AbonoEnrichment> {
  const map = new Map<string, AbonoEnrichment>();
  for (const e of enrichments) {
    map.set(e.movementKey, e);
  }
  return map;
}
