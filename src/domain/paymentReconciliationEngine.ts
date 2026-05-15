/**
 * Payment Reconciliation Engine — Pagos JDE ↔ CXP ↔ Bancos
 *
 * Espejo egreso de `realReconciliationEngine.ts` (cobranza ↔ banco ABONOS).
 * Cruza los pagos ejecutados (PagoProveedor) contra dos fuentes:
 *
 *   1. CXP (cuentas por pagar) → cierra la factura abierta, marca como
 *      pagada y permite excluirla del egreso proyectado.
 *   2. Movimientos bancarios (CARGOs) → confirma que el pago efectivamente
 *      salió de la cuenta. Detecta CARGOs huérfanos (sin pago asociado) y
 *      pagos huérfanos (sin CARGO bancario asociado).
 *
 * El loop OC → CXP → Pago → Banco queda completo: una OC se factura
 * (genera CXP), la CXP se paga (genera PagoProveedor), el pago sale
 * por banco (genera CARGO). El motor de proyección puede entonces
 * restar lo ya pagado del egreso futuro.
 *
 * Algoritmo PAGO ↔ CXP, 4 capas:
 *
 *   1. FOLIO EXACTO: `comentarioPago` contiene el `noFactura` de una CXP
 *      del mismo proveedor + cía. Más fuerte posible (folio único).
 *   2. PROVEEDOR + MONTO EXACTO: mismo proveedor, mismo monto, fecha
 *      de pago dentro de [fechaFactura - 7d, fechaVence + 60d].
 *   3. PROVEEDOR + MONTO TOLERANCIA: ±0.5% (comisiones, redondeo).
 *   4. SUBSET-SUM: un pago cubre 2-4 CXPs del mismo proveedor.
 *
 * Pagos a empleados (`tipoBusqueda === 'Employees'`) NO se cruzan con CXP
 * — son nómina/vales/reembolsos que no pasan por el módulo CXP. Sólo se
 * cruzan con bancos.
 *
 * Algoritmo PAGO ↔ CARGO, 2 capas:
 *
 *   1. EXACTO: mismo `cuentaBanco`, misma `fechaPago`, mismo `importePesos`.
 *   2. TOLERANCIA: misma cuenta, ±2 días, ±0.5% monto.
 */

import type { PagoProveedorRecord, BankAccountStatement, BankStatementLine } from '../services/jdeTypes';
import type { CXPRecord } from './persistence';
import { bankMovementKey } from './realReconciliationEngine';
import {
  buildOwnAccountDetector,
  buildOwnAccountsIndex,
  buildPairMatchedKeys,
  classifyMovement,
} from './netCashFlowEngine';

// ── Configuración ─────────────────────────────────────────────────────────

const AMOUNT_TOLERANCE_PCT = 0.005; // 0.5%
const AMOUNT_TOLERANCE_MIN_ABS = 1;
const CXP_DATE_WINDOW_BEFORE_DAYS = 7;
const CXP_DATE_WINDOW_AFTER_DAYS = 60;
const BANK_DATE_WINDOW_DAYS = 2;
const SUBSET_MAX_INVOICES = 4;
const DAY_MS = 86_400_000;

// ── Tipos públicos ────────────────────────────────────────────────────────

export type CxpMatchTier =
  | 'folio-exact'
  | 'invoice-amount'
  | 'amount-tolerance'
  | 'subset-sum'
  | 'unmatched';

export type CargoMatchTier =
  | 'exact'
  | 'tolerance'
  | 'unmatched';

/**
 * Estado de un pago tras la conciliación:
 *   - MATCHED_FULL: cruzado contra CXP y CARGO.
 *   - MATCHED_CXP_ONLY: cruzado contra CXP pero sin CARGO bancario visible
 *     (banco aún no procesado, falta movimiento, o pago a empleado).
 *   - MATCHED_BANK_ONLY: cruzado contra CARGO pero sin CXP (pago a empleado,
 *     CXP fuera del lookback, o pago no de factura).
 *   - UNMATCHED: ni CXP ni CARGO encontrados.
 */
export type PaymentStatus = 'MATCHED_FULL' | 'MATCHED_CXP_ONLY' | 'MATCHED_BANK_ONLY' | 'UNMATCHED';

export interface PaymentMatch {
  payment: PagoProveedorRecord;
  status: PaymentStatus;

  /** CXPs que cubre este pago (1 para folio/exact, N para subset-sum). */
  cxpMatches: Array<{
    cxp: CXPRecord;
    tier: CxpMatchTier;
    /** Confianza 0..1 derivada del tier. */
    confidence: number;
  }>;

  /** Movimiento bancario CARGO que originó este pago. */
  cargoMatch?: {
    movement: BankStatementLine;
    cia: string;
    cuenta: string;
    tier: CargoMatchTier;
    confidence: number;
  };

  /** Comentario explicativo del cruce (para tooltip/auditoría). */
  reason: string;
}

/** Estado de cobertura de una CXP — alimenta UI CXP y forecast exclusion. */
export interface CxpPaymentCoverage {
  cxpKey: string;        // `${cia}::${noFactura}::${noProveedor}`
  status: 'PAID' | 'PARTIAL' | 'OPEN';
  totalPaidPesos: number;
  payments: Array<{
    noPago: string;
    fechaPago: string;
    importe: number;
    tier: CxpMatchTier;
  }>;
}

/** Enriquecimiento de un CARGO bancario — alimenta UI Bancos. */
export interface CargoPaymentEnrichment {
  movementKey: string;   // `${cia}::${cuenta}::${fechaOperacion}::${importe}::${concepto}`
  status: 'MATCHED' | 'ORPHAN';
  /** Pagos que originaron este CARGO (normalmente 1; raro 2+ si batch). */
  payments?: Array<{
    noPago: string;
    nombreProveedor: string;
    importe: number;
    tier: CargoMatchTier;
  }>;
}

export interface PaymentReconciliationResult {
  paymentMatches: PaymentMatch[];
  cxpCoverage: Map<string, CxpPaymentCoverage>;
  cargoEnrichments: Map<string, CargoPaymentEnrichment>;
  /**
   * Pagos de PagoProveedor que empatan con un CARGO bancario clasificado
   * como interno. Se conservan para auditoria, pero no deben alimentar UI,
   * KPIs, CXP coverage ni proyecciones de proveedores.
   */
  internalPaymentKeys: Set<string>;
  totals: {
    payments: number;
    internalPayments: number;
    matchedCxp: number;
    matchedCargo: number;
    matchedFull: number;
    unmatched: number;
    totalPaidPesos: number;
    totalInternalPesos: number;
    totalUnmatchedPesos: number;
  };
}

export function emptyPaymentReconciliationResult(): PaymentReconciliationResult {
  return {
    paymentMatches: [],
    cxpCoverage: new Map(),
    cargoEnrichments: new Map(),
    internalPaymentKeys: new Set(),
    totals: {
      payments: 0,
      internalPayments: 0,
      matchedCxp: 0,
      matchedCargo: 0,
      matchedFull: 0,
      unmatched: 0,
      totalPaidPesos: 0,
      totalInternalPesos: 0,
      totalUnmatchedPesos: 0,
    },
  };
}

// ── API pública ───────────────────────────────────────────────────────────

export function reconcilePayments(input: {
  payments: PagoProveedorRecord[];
  cxpRecords: CXPRecord[];
  bankStatements: BankAccountStatement[];
}): PaymentReconciliationResult {
  const { payments, cxpRecords, bankStatements } = input;

  // Indexes ───────────────────────────────────────────────────────────────
  const cxpByProvider = indexCxpByProvider(cxpRecords);
  const { real: cargoMovements, internal: internalCargoMovements } = collectCargoMovements(bankStatements);
  const cargoByAccount = indexCargosByAccount(cargoMovements);
  const internalCargoByAccount = indexCargosByAccount(internalCargoMovements);

  // Tracking ─────────────────────────────────────────────────────────────
  const claimedCxp = new Set<string>();         // CXPs ya asignadas a un pago
  const claimedCargo = new Set<string>();       // movimientos CARGO ya asignados
  const claimedInternalCargo = new Set<string>();
  const cxpCoverage = new Map<string, CxpPaymentCoverage>();
  const cargoEnrichments = new Map<string, CargoPaymentEnrichment>();
  const internalPaymentKeys = new Set<string>();

  const paymentMatches: PaymentMatch[] = [];

  for (const payment of payments) {
    const isEmployee = payment.tipoBusqueda.trim().toLowerCase().startsWith('employee');
    const internalCargoMatch = findCargoMatch(payment, internalCargoByAccount, claimedInternalCargo);
    const isInternalPayment = !!internalCargoMatch;
    if (internalCargoMatch) {
      internalPaymentKeys.add(paymentKey(payment));
      claimedInternalCargo.add(internalCargoMatch.key);
    }

    // ── Match CXP ──
    const cxpHits: PaymentMatch['cxpMatches'] = [];
    if (!isEmployee && !isInternalPayment) {
      const proveedorCxps = cxpByProvider.get(normalizeJde(payment.claveProveedor)) ?? [];
      const eligibleCxps = proveedorCxps.filter((cxp) =>
        !claimedCxp.has(cxpKey(cxp)) &&
        sameCia(cxp.cia, payment.cia) &&
        cxp.importePendientePesos > 0,
      );

      // Capa 1: folio embedded en comentario.
      const folioMatch = findFolioMatch(eligibleCxps, payment.comentarioPago);
      if (folioMatch) {
        cxpHits.push({ cxp: folioMatch, tier: 'folio-exact', confidence: 0.98 });
        claimedCxp.add(cxpKey(folioMatch));
      } else {
        // Capa 2: monto exacto + fecha en ventana.
        const exactMatch = findAmountMatch(eligibleCxps, payment, /*tolerancePct=*/0);
        if (exactMatch) {
          cxpHits.push({ cxp: exactMatch, tier: 'invoice-amount', confidence: 0.85 });
          claimedCxp.add(cxpKey(exactMatch));
        } else {
          // Capa 3: monto con tolerancia.
          const toleranceMatch = findAmountMatch(eligibleCxps, payment, AMOUNT_TOLERANCE_PCT);
          if (toleranceMatch) {
            cxpHits.push({ cxp: toleranceMatch, tier: 'amount-tolerance', confidence: 0.7 });
            claimedCxp.add(cxpKey(toleranceMatch));
          } else {
            // Capa 4: subset-sum (pago cubre N facturas).
            const subset = findSubsetMatch(eligibleCxps, payment);
            if (subset.length > 0) {
              for (const cxp of subset) {
                cxpHits.push({ cxp, tier: 'subset-sum', confidence: 0.6 });
                claimedCxp.add(cxpKey(cxp));
              }
            }
          }
        }
      }
    }

    // ── Match CARGO ──
    let cargoMatch: PaymentMatch['cargoMatch'] | undefined;
    if (!isInternalPayment) {
      const cargo = findCargoMatch(payment, cargoByAccount, claimedCargo);
      if (cargo) {
        cargoMatch = {
          movement: cargo.movement,
          cia: cargo.cia,
          cuenta: cargo.cuenta,
          tier: cargo.tier,
          confidence: cargo.tier === 'exact' ? 0.95 : 0.75,
        };
        claimedCargo.add(cargo.key);
      }
    }

    // ── Status agregado ──
    const hasCxp = cxpHits.length > 0;
    const hasCargo = !!cargoMatch;
    const status: PaymentStatus = hasCxp && hasCargo
      ? 'MATCHED_FULL'
      : hasCxp
        ? 'MATCHED_CXP_ONLY'
        : hasCargo
          ? 'MATCHED_BANK_ONLY'
          : 'UNMATCHED';

    const reason = isInternalPayment
      ? 'Pago interno detectado por CARGO bancario interno; se excluye de conciliacion CXP y egreso proveedor.'
      : buildReason(status, cxpHits, cargoMatch, isEmployee);
    paymentMatches.push({ payment, status, cxpMatches: cxpHits, cargoMatch, reason });

    // ── Acumular coverage CXP ──
    for (const hit of cxpHits) {
      const key = cxpKey(hit.cxp);
      const existing = cxpCoverage.get(key);
      const paid = payment.importePesos;
      if (existing) {
        existing.totalPaidPesos += paid;
        existing.payments.push({
          noPago: payment.noPago,
          fechaPago: payment.fechaPago,
          importe: paid,
          tier: hit.tier,
        });
        existing.status = computeCxpStatus(existing.totalPaidPesos, hit.cxp.importeBrutoPesos);
      } else {
        cxpCoverage.set(key, {
          cxpKey: key,
          status: computeCxpStatus(paid, hit.cxp.importeBrutoPesos),
          totalPaidPesos: paid,
          payments: [{
            noPago: payment.noPago,
            fechaPago: payment.fechaPago,
            importe: paid,
            tier: hit.tier,
          }],
        });
      }
    }

    // ── Acumular enrichment CARGO ──
    if (cargoMatch) {
      const key = bankMovementKey(cargoMatch.movement);
      cargoEnrichments.set(key, {
        movementKey: key,
        status: 'MATCHED',
        payments: [{
          noPago: payment.noPago,
          nombreProveedor: payment.nombreProveedor,
          importe: payment.importePesos,
          tier: cargoMatch.tier,
        }],
      });
    }
  }

  // ── Marcar CARGOs huérfanos (no asignados a ningún pago) ──
  for (const c of cargoMovements) {
    if (cargoEnrichments.has(c.key)) continue;
    cargoEnrichments.set(c.key, { movementKey: c.key, status: 'ORPHAN' });
  }

  // ── Totals ──
  const nonInternalMatches = paymentMatches.filter((m) => !internalPaymentKeys.has(paymentKey(m.payment)));
  const internalMatches = paymentMatches.filter((m) => internalPaymentKeys.has(paymentKey(m.payment)));
  const totals = {
    payments: paymentMatches.length,
    internalPayments: internalMatches.length,
    matchedCxp: nonInternalMatches.filter((m) => m.cxpMatches.length > 0).length,
    matchedCargo: nonInternalMatches.filter((m) => m.cargoMatch).length,
    matchedFull: nonInternalMatches.filter((m) => m.status === 'MATCHED_FULL').length,
    unmatched: nonInternalMatches.filter((m) => m.status === 'UNMATCHED').length,
    totalPaidPesos: nonInternalMatches.reduce((acc, m) => acc + m.payment.importePesos, 0),
    totalInternalPesos: internalMatches.reduce((acc, m) => acc + m.payment.importePesos, 0),
    totalUnmatchedPesos: nonInternalMatches
      .filter((m) => m.status === 'UNMATCHED')
      .reduce((acc, m) => acc + m.payment.importePesos, 0),
  };

  return { paymentMatches, cxpCoverage, cargoEnrichments, internalPaymentKeys, totals };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function paymentKey(payment: PagoProveedorRecord): string {
  return `${payment.cia}::${payment.noPago}`;
}

function cxpKey(cxp: CXPRecord): string {
  return `${cxp.cia}::${cxp.noFactura}::${cxp.noProveedor}`;
}

function indexCxpByProvider(records: CXPRecord[]): Map<string, CXPRecord[]> {
  const map = new Map<string, CXPRecord[]>();
  for (const cxp of records) {
    const key = normalizeJde(cxp.noProveedor);
    if (!key) continue;
    const arr = map.get(key);
    if (arr) arr.push(cxp);
    else map.set(key, [cxp]);
  }
  return map;
}

interface IndexedCargo {
  movement: BankStatementLine;
  cia: string;
  cuenta: string;
  fechaOperacion: string;
  key: string;
}

function collectCargoMovements(statements: BankAccountStatement[]): { real: IndexedCargo[]; internal: IndexedCargo[] } {
  const real: IndexedCargo[] = [];
  const internal: IndexedCargo[] = [];
  const ownAccountDetector = buildOwnAccountDetector(buildOwnAccountsIndex(statements));
  const pairedKeys = buildPairMatchedKeys(statements);
  const classificationContext = { ownAccountDetector, pairedKeys };

  for (const stmt of statements) {
    for (const m of stmt.movimientos ?? []) {
      if (m.tipoMovimiento !== 'CARGO') continue;
      const line: BankStatementLine = {
        ...m,
        cia: m.cia || stmt.cia,
        banco: m.banco || stmt.banco,
        nombreBanco: m.nombreBanco || stmt.nombreBanco,
        cuenta: m.cuenta || stmt.cuenta,
        moneda: m.moneda || stmt.moneda,
      };
      const entry: IndexedCargo = {
        movement: line,
        cia: stmt.cia,
        cuenta: stmt.cuenta,
        fechaOperacion: cleanIsoDate(line.fechaOperacion) ?? '',
        key: bankMovementKey(line),
      };
      const classification = classifyMovement(line, classificationContext, stmt.cia, stmt.cuenta);
      if (classification.kind === 'internal') internal.push(entry);
      else real.push(entry);
    }
  }
  return { real, internal };
}

function indexCargosByAccount(cargos: IndexedCargo[]): Map<string, IndexedCargo[]> {
  const map = new Map<string, IndexedCargo[]>();
  for (const c of cargos) {
    const key = normalizeAccountKey(c.cuenta);
    const arr = map.get(key);
    if (arr) arr.push(c);
    else map.set(key, [c]);
  }
  return map;
}

function findCargoMatch(
  payment: PagoProveedorRecord,
  cargosByAccount: Map<string, IndexedCargo[]>,
  claimedCargo: Set<string>,
): (IndexedCargo & { tier: Exclude<CargoMatchTier, 'unmatched'> }) | undefined {
  const accountCargos = cargosByAccount.get(normalizeAccountKey(payment.cuentaBanco)) ?? [];
  for (const cargo of accountCargos) {
    if (claimedCargo.has(cargo.key)) continue;
    const tier = cargoMatchTier(payment, cargo.movement, cargo.fechaOperacion);
    if (tier === 'unmatched') continue;
    return { ...cargo, tier };
  }
  return undefined;
}

function findFolioMatch(cxps: CXPRecord[], comentario: string): CXPRecord | undefined {
  const haystack = normalizeInvoice(comentario);
  if (!haystack) return undefined;
  for (const cxp of cxps) {
    const needle = normalizeInvoice(cxp.noFactura);
    if (needle && needle.length >= 4 && haystack.includes(needle)) return cxp;
  }
  return undefined;
}

function findAmountMatch(cxps: CXPRecord[], payment: PagoProveedorRecord, tolerancePct: number): CXPRecord | undefined {
  const paid = payment.importePesos;
  for (const cxp of cxps) {
    if (!withinDateWindow(payment.fechaPago, cxp.fechaFactura, cxp.fechaVence)) continue;
    if (amountsClose(paid, cxp.importeBrutoPesos, tolerancePct) ||
        amountsClose(paid, cxp.importePendientePesos, tolerancePct)) {
      return cxp;
    }
  }
  return undefined;
}

function findSubsetMatch(cxps: CXPRecord[], payment: PagoProveedorRecord): CXPRecord[] {
  const paid = payment.importePesos;
  const candidates = cxps
    .filter((c) => withinDateWindow(payment.fechaPago, c.fechaFactura, c.fechaVence))
    .slice(0, 30); // cap combinatorial space
  if (candidates.length === 0) return [];

  // Greedy backtrack up to SUBSET_MAX_INVOICES.
  function search(start: number, remaining: number, picks: CXPRecord[]): CXPRecord[] | null {
    if (picks.length > SUBSET_MAX_INVOICES) return null;
    if (Math.abs(remaining) < Math.max(AMOUNT_TOLERANCE_MIN_ABS, paid * AMOUNT_TOLERANCE_PCT) && picks.length >= 2) {
      return picks;
    }
    if (remaining < -Math.max(AMOUNT_TOLERANCE_MIN_ABS, paid * AMOUNT_TOLERANCE_PCT)) return null;
    for (let i = start; i < candidates.length; i++) {
      const c = candidates[i];
      const amt = c.importePendientePesos > 0 ? c.importePendientePesos : c.importeBrutoPesos;
      const found = search(i + 1, remaining - amt, [...picks, c]);
      if (found) return found;
    }
    return null;
  }
  return search(0, paid, []) ?? [];
}

function cargoMatchTier(payment: PagoProveedorRecord, movement: BankStatementLine, fechaOpIso: string): CargoMatchTier {
  if (!fechaOpIso || !payment.fechaPago) return 'unmatched';
  const days = Math.abs(daysBetween(payment.fechaPago, fechaOpIso));
  const exactDate = days < 0.5;
  const closeDate = days <= BANK_DATE_WINDOW_DAYS;
  if (!closeDate) return 'unmatched';
  if (exactDate && Math.abs(movement.importe - payment.importePesos) < 0.01) return 'exact';
  if (amountsClose(movement.importe, payment.importePesos, AMOUNT_TOLERANCE_PCT)) return 'tolerance';
  return 'unmatched';
}

function amountsClose(a: number, b: number, tolerancePct: number): boolean {
  const diff = Math.abs(a - b);
  if (tolerancePct === 0) return diff < 0.01;
  const tol = Math.max(AMOUNT_TOLERANCE_MIN_ABS, Math.max(a, b) * tolerancePct);
  return diff <= tol;
}

function withinDateWindow(fechaPago: string, fechaFactura: string, fechaVence: string): boolean {
  const pago = cleanIsoDate(fechaPago);
  if (!pago) return false;
  const fac = cleanIsoDate(fechaFactura);
  const ven = cleanIsoDate(fechaVence);
  // Aceptamos cualquier pago entre (factura - 7d) y (vencimiento + 60d).
  // Si no hay fechas, default a una ventana amplia.
  if (!fac && !ven) return true;
  if (fac && daysBetween(fac, pago) < -CXP_DATE_WINDOW_BEFORE_DAYS) return false;
  if (ven && daysBetween(ven, pago) > CXP_DATE_WINDOW_AFTER_DAYS) return false;
  return true;
}

function computeCxpStatus(totalPaid: number, importeBruto: number): 'PAID' | 'PARTIAL' | 'OPEN' {
  if (importeBruto <= 0) return 'OPEN';
  const ratio = totalPaid / importeBruto;
  if (ratio >= 0.99) return 'PAID';
  if (ratio >= 0.05) return 'PARTIAL';
  return 'OPEN';
}

function buildReason(
  status: PaymentStatus,
  cxps: PaymentMatch['cxpMatches'],
  cargo: PaymentMatch['cargoMatch'],
  isEmployee: boolean,
): string {
  const parts: string[] = [];
  if (cxps.length === 1) {
    const tier = cxps[0].tier;
    const lab = tier === 'folio-exact' ? 'folio en comentario'
      : tier === 'invoice-amount' ? 'monto exacto'
      : tier === 'amount-tolerance' ? 'monto ±0.5%'
      : 'subset';
    parts.push(`CXP cubierta vía ${lab} (factura ${cxps[0].cxp.noFactura}).`);
  } else if (cxps.length > 1) {
    parts.push(`${cxps.length} CXPs cubiertas vía subset-sum.`);
  } else if (isEmployee) {
    parts.push('Pago a empleado — no aplica conciliación CXP.');
  } else {
    parts.push('CXP no encontrada en el rango cargado.');
  }
  if (cargo) {
    const lab = cargo.tier === 'exact' ? 'exacto' : 'tolerancia';
    parts.push(`CARGO bancario ${lab} (cuenta ${cargo.cuenta}).`);
  } else {
    parts.push('Sin CARGO bancario asociado en el rango.');
  }
  void status;
  return parts.join(' ');
}

// ── Normalizers / utils ───────────────────────────────────────────────────

function normalizeJde(value: string): string {
  const digits = (value || '').replace(/\D+/g, '');
  return digits ? String(Number(digits)) : '';
}

function normalizeInvoice(value: string): string {
  return (value || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, '');
}

function normalizeAccountKey(value: string): string {
  return (value || '').replace(/\D+/g, '');
}

function normalizeCia(value: string): string {
  const m = (value || '').match(/\d+/);
  return m ? m[0].padStart(5, '0') : (value || '').trim();
}

function sameCia(a: string, b: string): boolean {
  return normalizeCia(a) === normalizeCia(b);
}

function cleanIsoDate(value?: string): string | undefined {
  const trimmed = (value || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : undefined;
}

function daysBetween(a: string, b: string): number {
  const t1 = new Date(`${a}T00:00:00.000Z`).getTime();
  const t2 = new Date(`${b}T00:00:00.000Z`).getTime();
  return (t2 - t1) / DAY_MS;
}
