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
 * Algoritmo PAGO ↔ CARGO:
 *
 *   1a pasada (por pago): EXACTO (misma cuenta, misma fecha, mismo importe)
 *   → TOLERANCIA (misma cuenta, ventana de fecha, ±0.5%).
 *   2a pasada (pagos sin cargo): BATCH (N pagos del mismo `batchPago` cuya
 *   suma ≈ UN cargo agregado de la misma cuenta — tesorería dispersa el lote
 *   como un solo SPEI) → CROSS-ACCOUNT (el cargo salió de otra cuenta) →
 *   SUBSET (un pago partido en 2-4 cargos).
 *
 * Además, cada pago lleva `bankCoverage`: si la cuenta que nombra el pago ni
 * siquiera tiene estados de cuenta cargados (o la fecha cae fuera del rango
 * cargado), un UNMATCHED NO es un huérfano real — es falta de datos para
 * cruzar. La UI los separa.
 */

import type { PagoProveedorRecord, BankAccountStatement, BankStatementLine } from '../services/jdeTypes';
import type { CXPRecord } from './persistence';
import { bankMovementKey } from './bankMovementKey';
import { normalizeCia } from './cia';
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
// Ventana original era 2d, ahora ±120d (4 meses). Indemnizaciones, fideicomisos
// y arrendamientos AFP salen por banco con lag de semanas/meses contra el
// registro JDE; abrir 4m permite cazarlos. El tier `exact` sigue exigiendo
// mismo día calendario, y `findCargoMatch` elige el cargo MÁS CERCANO en
// fecha dentro del rango — así una ventana ancha no roba matches a otros
// pagos: el más cercano gana siempre.
const BANK_DATE_WINDOW_DAYS = 120;
// Ventana de la 2a pasada (cross-account + subset CARGO). Más estrecha que la
// de mismo-cuenta: estos cruces son de menor confianza, así que exigimos
// cercanía temporal para no robar un CARGO a un pago legítimo de otra cuenta.
const SECONDARY_DATE_WINDOW_DAYS = 7;
const SUBSET_MAX_INVOICES = 4;
// Máx CARGOs que puede sumar un pago partido (`tier === 'subset'`).
const SUBSET_MAX_CARGOS = 4;
// Ventana para el CARGO-candidato del diagnóstico de pagos UNMATCHED. Más
// ancha que la del cruce real: aquí no confirmamos nada, solo mostramos la
// pista más cercana en el drill-down.
const UNMATCHED_CANDIDATE_WINDOW_DAYS = 45;
const DAY_MS = 86_400_000;

const CARGO_TIER_CONFIDENCE: Record<Exclude<CargoMatchTier, 'unmatched'>, number> = {
  exact: 0.95,
  tolerance: 0.75,
  batch: 0.7,
  'cross-account': 0.55,
  subset: 0.5,
};

// ── Tipos públicos ────────────────────────────────────────────────────────

export type CxpMatchTier =
  | 'folio-exact'
  | 'invoice-amount'
  | 'amount-tolerance'
  | 'subset-sum'
  | 'unmatched';

/**
 * Tier del cruce PAGO ↔ CARGO bancario:
 *   - exact / tolerance: CARGO en la MISMA cuenta del registro de pago.
 *   - batch: N pagos del mismo `batchPago` cubiertos por UN CARGO agregado
 *     cuyo importe ≈ la suma del lote (dispersión SPEI en lote).
 *   - cross-account: el CARGO salió de OTRA cuenta (tesorería paga desde
 *     cuentas concentradoras; JDE registra la cuenta nominal de la cía).
 *   - subset: el pago se dispersó en 2-4 CARGOs de la misma cuenta.
 * cross-account y subset son cruces de menor confianza — "revisar".
 */
export type CargoMatchTier =
  | 'exact'
  | 'tolerance'
  | 'batch'
  | 'cross-account'
  | 'subset'
  | 'unmatched';

/**
 * Cobertura bancaria de la cuenta que nombra el registro de pago:
 *   - covered: la cuenta tiene movimientos cargados y `fechaPago` cae dentro
 *     del rango [min, max] de sus `fechaOperacion`.
 *   - no-account: la cuenta NO aparece en los estados de cuenta cargados
 *     (cuenta cerrada, banco no incluido en /bancos, o clave irreconocible).
 *   - out-of-range: la cuenta existe pero `fechaPago` cae fuera del rango
 *     cargado (p.ej. backfill bancario recortado a 120d con pagos de 365d).
 * Solo es significativo cuando NO hay `cargoMatch`: distingue el huérfano
 * REAL (había banco contra qué cruzar y el cargo no apareció) del pago sin
 * datos para cruzar. Los segundos no deben alarmar como huérfanos.
 */
export type BankCoverage = 'covered' | 'no-account' | 'out-of-range';

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

  /** Ver `BankCoverage` — separa huérfano real de "sin banco contra qué cruzar". */
  bankCoverage: BankCoverage;

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
    /**
     * CARGOs adicionales cuando `tier === 'subset'` (el pago se dispersó en
     * varios cargos). `movement` es el primero; aquí van el resto. La suma de
     * `movement` + `extraMovements` ≈ `payment.importePesos`.
     */
    extraMovements?: BankStatementLine[];
  };

  /** Comentario explicativo del cruce (para tooltip/auditoría). */
  reason: string;

  /**
   * Solo para `status === 'UNMATCHED'` (no interno): el CARGO bancario más
   * parecido que el motor halló pero NO pudo confirmar como cruce — fuera de
   * la ventana de fecha de la 2a pasada, o ya reclamado por otro pago. Es la
   * pista de "rastreo" para el drill-down de conciliación. `undefined` cuando
   * no existe ningún CARGO de importe parecido en el rango.
   */
  unmatchedCandidate?: {
    movement: BankStatementLine;
    cuenta: string;
    /** |fecha del CARGO − fecha del pago| en días. */
    daysOff: number;
    /** El CARGO está en la misma cuenta que nombra el registro de pago. */
    sameAccount: boolean;
    /** El CARGO ya quedó cruzado a otro pago (no estaba libre). */
    claimed: boolean;
  };
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
    /** Clave JDE del proveedor — = `numProveedor` del catálogo. Necesaria
     *  para que el cruce con el catálogo de proveedores resuelva por id
     *  (counterpartyId) en vez de caer al match por nombre crudo. */
    claveProveedor: string;
    nombreProveedor: string;
    /** Clasificación operativa que viene directo de PagoProveedor/JDE. */
    clasificacionProveedor?: string;
    /** Clasificación financiera que viene directo de PagoProveedor/JDE. */
    clasificacionProveedorFinanciera?: string;
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
    /** TODOS los UNMATCHED no-internos (incluye los sin cobertura bancaria). */
    unmatched: number;
    /** Subconjunto de `unmatched` cuya cuenta no tiene banco cargado para cruzar. */
    unmatchedNoBankData: number;
    totalPaidPesos: number;
    totalInternalPesos: number;
    totalUnmatchedPesos: number;
    totalUnmatchedNoBankDataPesos: number;
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
      unmatchedNoBankData: 0,
      totalPaidPesos: 0,
      totalInternalPesos: 0,
      totalUnmatchedPesos: 0,
      totalUnmatchedNoBankDataPesos: 0,
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
  const accountCoverage = buildAccountCoverage(bankStatements);
  const { real: cargoMovements, internal: internalCargoMovements } = collectCargoMovements(bankStatements);
  const cargoByAccount = indexCargosByAccount(cargoMovements);
  const internalCargoByAccount = indexCargosByAccount(internalCargoMovements);
  // Índice global por importe (asc) para el cruce cross-account de la 2a
  // pasada — se construye DESPUÉS de `indexCargosByAccount` porque ése estampa
  // `seq` (tiebreaker). `lowerBoundByImporte` binbusca la banda de importe.
  const cargosByImporte = [...cargoMovements].sort(
    (a, b) => a.movement.importe - b.movement.importe,
  );

  // Tracking ─────────────────────────────────────────────────────────────
  const claimedCxp = new Set<string>();         // CXPs ya asignadas a un pago
  const claimedCargo = new Set<string>();       // movimientos CARGO ya asignados
  const claimedInternalCargo = new Set<string>();
  const cxpCoverage = new Map<string, CxpPaymentCoverage>();
  const cargoEnrichments = new Map<string, CargoPaymentEnrichment>();
  const internalPaymentKeys = new Set<string>();

  const paymentMatches: PaymentMatch[] = [];

  for (const payment of payments) {
    const isEmployee = isEmployeePayment(payment);
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
          confidence: CARGO_TIER_CONFIDENCE[cargo.tier],
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

    const bankCoverage = resolveBankCoverage(payment, accountCoverage);
    const reason = isInternalPayment
      ? 'Pago interno detectado por CARGO bancario interno; se excluye de conciliacion CXP y egreso proveedor.'
      : buildReason(status, cxpHits, cargoMatch, isEmployee, bankCoverage);
    paymentMatches.push({ payment, status, bankCoverage, cxpMatches: cxpHits, cargoMatch, reason });

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
          claveProveedor: payment.claveProveedor,
          nombreProveedor: payment.nombreProveedor,
          clasificacionProveedor: payment.clasificacionProveedor,
          clasificacionProveedorFinanciera: payment.clasificacionProveedorFinanciera,
          importe: payment.importePesos,
          tier: cargoMatch.tier,
        }],
      });
    }
  }

  // ── 2a pasada BATCH: N pagos del mismo lote → 1 CARGO agregado ───────────
  // JDE registra un pago por proveedor/factura, pero tesorería dispersa el
  // lote como UN solo CARGO por el total (`batchPago` agrupa). Ningún pago
  // individual cuadra por monto contra ese cargo agregado, así que sin esta
  // capa el lote ENTERO caía huérfano — era la causa #1 de huérfanos. Agrupa
  // los pagos aún sin cargo por (cia, batch, cuenta, fecha) y busca un CARGO
  // ≈ Σ del grupo en la misma cuenta. Corre ANTES de cross-account/subset:
  // la suma del lote en la cuenta propia es señal más fuerte que un importe
  // individual en otra cuenta. Grupos de 1 ya los cubrió la 1a pasada.
  const batchGroups = new Map<string, PaymentMatch[]>();
  for (const pm of paymentMatches) {
    if (pm.cargoMatch) continue;
    if (internalPaymentKeys.has(paymentKey(pm.payment))) continue;
    const batch = (pm.payment.batchPago || '').trim();
    if (!batch) continue;
    const groupKey = `${pm.payment.cia}::${batch}::${resolvePaymentAccountKey(pm.payment)}::${cleanIsoDate(pm.payment.fechaPago) ?? ''}`;
    const arr = batchGroups.get(groupKey);
    if (arr) arr.push(pm);
    else batchGroups.set(groupKey, [pm]);
  }
  for (const group of batchGroups.values()) {
    if (group.length < 2) continue;
    const total = group.reduce((acc, pm) => acc + pm.payment.importePesos, 0);
    if (total <= 0) continue;
    const refPayment = group[0].payment;
    const cargo = findBatchCargo(
      resolvePaymentAccountKey(refPayment),
      total,
      parseDateEpoch(cleanIsoDate(refPayment.fechaPago) ?? ''),
      cargoByAccount,
      claimedCargo,
    );
    if (!cargo) continue;
    claimedCargo.add(cargo.key);
    for (const pm of group) {
      pm.cargoMatch = {
        movement: cargo.movement,
        cia: cargo.cia,
        cuenta: cargo.cuenta,
        tier: 'batch',
        confidence: CARGO_TIER_CONFIDENCE.batch,
      };
      pm.status = pm.cxpMatches.length > 0 ? 'MATCHED_FULL' : 'MATCHED_BANK_ONLY';
      pm.reason = buildReason(pm.status, pm.cxpMatches, pm.cargoMatch, isEmployeePayment(pm.payment), pm.bankCoverage);
    }
    const movKey = bankMovementKey(cargo.movement);
    cargoEnrichments.set(movKey, {
      movementKey: movKey,
      status: 'MATCHED',
      payments: group.map((pm) => ({
        noPago: pm.payment.noPago,
        claveProveedor: pm.payment.claveProveedor,
        nombreProveedor: pm.payment.nombreProveedor,
        clasificacionProveedor: pm.payment.clasificacionProveedor,
        clasificacionProveedorFinanciera: pm.payment.clasificacionProveedorFinanciera,
        importe: pm.payment.importePesos,
        tier: 'batch' as const,
      })),
    });
  }

  // ── 2a pasada CARGO: cross-account + subset ──────────────────────────────
  // Corre DESPUÉS del loop principal a propósito: el cruce de misma-cuenta
  // (exact/tolerance) reclama primero TODOS sus CARGOs, así un cruce débil
  // nunca le roba un movimiento a un pago de alta confianza.
  for (const pm of paymentMatches) {
    if (pm.cargoMatch) continue;
    if (internalPaymentKeys.has(paymentKey(pm.payment))) continue;

    let resolved: PaymentMatch['cargoMatch'] | undefined;
    const cross = findCrossAccountCargo(pm.payment, cargosByImporte, claimedCargo);
    if (cross) {
      claimedCargo.add(cross.key);
      resolved = {
        movement: cross.movement,
        cia: cross.cia,
        cuenta: cross.cuenta,
        tier: 'cross-account',
        confidence: CARGO_TIER_CONFIDENCE['cross-account'],
      };
    } else {
      const subset = findCargoSubset(pm.payment, cargoByAccount, claimedCargo);
      if (subset.length >= 2) {
        for (const c of subset) claimedCargo.add(c.key);
        resolved = {
          movement: subset[0].movement,
          cia: subset[0].cia,
          cuenta: subset[0].cuenta,
          tier: 'subset',
          confidence: CARGO_TIER_CONFIDENCE.subset,
          extraMovements: subset.slice(1).map((c) => c.movement),
        };
      }
    }
    if (!resolved) continue;

    pm.cargoMatch = resolved;
    pm.status = pm.cxpMatches.length > 0 ? 'MATCHED_FULL' : 'MATCHED_BANK_ONLY';
    pm.reason = buildReason(pm.status, pm.cxpMatches, resolved, isEmployeePayment(pm.payment), pm.bankCoverage);

    for (const mv of [resolved.movement, ...(resolved.extraMovements ?? [])]) {
      const key = bankMovementKey(mv);
      cargoEnrichments.set(key, {
        movementKey: key,
        status: 'MATCHED',
        payments: [{
          noPago: pm.payment.noPago,
          claveProveedor: pm.payment.claveProveedor,
          nombreProveedor: pm.payment.nombreProveedor,
          clasificacionProveedor: pm.payment.clasificacionProveedor,
          clasificacionProveedorFinanciera: pm.payment.clasificacionProveedorFinanciera,
          importe: pm.payment.importePesos,
          tier: resolved.tier,
        }],
      });
    }
  }

  // ── Marcar CARGOs huérfanos (no asignados a ningún pago) ──
  for (const c of cargoMovements) {
    if (cargoEnrichments.has(c.key)) continue;
    cargoEnrichments.set(c.key, { movementKey: c.key, status: 'ORPHAN' });
  }

  // ── Diagnóstico de pagos UNMATCHED: rastrea el CARGO más parecido ─────────
  // No confirma cruce — solo deja una pista para el drill-down. `claimedCargo`
  // ya es final, así que `claimed` distingue "CARGO libre pero lejos en fecha"
  // de "CARGO ya tomado por otro pago".
  for (const pm of paymentMatches) {
    if (pm.status !== 'UNMATCHED') continue;
    if (internalPaymentKeys.has(paymentKey(pm.payment))) continue;
    const candidate = findUnmatchedCandidate(pm.payment, cargosByImporte, claimedCargo);
    if (candidate) pm.unmatchedCandidate = candidate;
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
    unmatchedNoBankData: nonInternalMatches
      .filter((m) => m.status === 'UNMATCHED' && m.bankCoverage !== 'covered').length,
    totalPaidPesos: nonInternalMatches.reduce((acc, m) => acc + m.payment.importePesos, 0),
    totalInternalPesos: internalMatches.reduce((acc, m) => acc + m.payment.importePesos, 0),
    totalUnmatchedPesos: nonInternalMatches
      .filter((m) => m.status === 'UNMATCHED')
      .reduce((acc, m) => acc + m.payment.importePesos, 0),
    totalUnmatchedNoBankDataPesos: nonInternalMatches
      .filter((m) => m.status === 'UNMATCHED' && m.bankCoverage !== 'covered')
      .reduce((acc, m) => acc + m.payment.importePesos, 0),
  };

  return { paymentMatches, cxpCoverage, cargoEnrichments, internalPaymentKeys, totals };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function paymentKey(payment: PagoProveedorRecord): string {
  return `${payment.cia}::${payment.noPago}`;
}

/** Pago de nómina/empleado — no se cruza con CXP (no pasa por el módulo). */
function isEmployeePayment(payment: PagoProveedorRecord): boolean {
  return payment.tipoBusqueda.trim().toLowerCase().startsWith('employee');
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
  /** `fechaOperacion` pre-parsed to epoch ms once — avoids `new Date()` per compare. NaN if absent. */
  fechaOpEpoch: number;
  key: string;
  /** Per-account insertion order — tiebreaker so sorting by importe keeps original match selection. */
  seq: number;
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
      const fechaOp = cleanIsoDate(line.fechaOperacion) ?? '';
      const entry: IndexedCargo = {
        movement: line,
        cia: stmt.cia,
        cuenta: stmt.cuenta,
        fechaOperacion: fechaOp,
        fechaOpEpoch: parseDateEpoch(fechaOp),
        key: bankMovementKey(line),
        seq: 0,
      };
      const classification = classifyMovement(line, classificationContext, stmt.cia, stmt.cuenta);
      if (classification.kind === 'internal') internal.push(entry);
      else real.push(entry);
    }
  }
  return { real, internal };
}

interface AccountDateCoverage { min: string; max: string }

/**
 * Rango de fechas con movimientos cargados por cuenta (cualquier tipo de
 * movimiento, no solo CARGO — un día con puros ABONOs también es cobertura).
 * Alimenta `resolveBankCoverage`.
 */
function buildAccountCoverage(statements: BankAccountStatement[]): Map<string, AccountDateCoverage> {
  const map = new Map<string, AccountDateCoverage>();
  for (const stmt of statements) {
    for (const m of stmt.movimientos ?? []) {
      const key = normalizeAccountKey(m.cuenta || stmt.cuenta);
      if (!key) continue;
      const fecha = cleanIsoDate(m.fechaOperacion);
      if (!fecha) continue;
      const cur = map.get(key);
      if (!cur) map.set(key, { min: fecha, max: fecha });
      else {
        if (fecha < cur.min) cur.min = fecha;
        if (fecha > cur.max) cur.max = fecha;
      }
    }
  }
  return map;
}

function resolveBankCoverage(
  payment: PagoProveedorRecord,
  coverage: Map<string, AccountDateCoverage>,
): BankCoverage {
  const acc = coverage.get(resolvePaymentAccountKey(payment));
  if (!acc) return 'no-account';
  const fecha = cleanIsoDate(payment.fechaPago);
  // Fecha de pago ilegible: no podemos afirmar falta de cobertura — que el
  // cruce normal (que también fallará por fecha) lo reporte como huérfano.
  if (!fecha) return 'covered';
  if (fecha < acc.min || fecha > acc.max) return 'out-of-range';
  return 'covered';
}

function indexCargosByAccount(cargos: IndexedCargo[]): Map<string, IndexedCargo[]> {
  const map = new Map<string, IndexedCargo[]>();
  for (const c of cargos) {
    const key = normalizeAccountKey(c.cuenta);
    const arr = map.get(key);
    if (arr) arr.push(c);
    else map.set(key, [c]);
  }
  // Stamp insertion order, then sort each account ascending by importe so
  // `findCargoMatch` can binary-search the amount-tolerance window instead of
  // scanning every cargo. `seq` preserves the original iteration order as a
  // tiebreaker → identical match selection, just faster.
  for (const arr of map.values()) {
    for (let i = 0; i < arr.length; i++) arr[i].seq = i;
    arr.sort((a, b) => a.movement.importe - b.movement.importe);
  }
  return map;
}

/**
 * Algunos pagos llegan con `Cuenta_Banco` vacío y el número de cuenta sólo
 * vive dentro de `Cuenta_Bancaria` (caso típico: BanBajio, donde JDE empaca
 * "BANBAJIO 33850201" como un solo segmento). Sin fallback el join contra el
 * índice de cargos falla y todo cae a huérfano. Extraemos el cluster numérico
 * más largo como cuenta de respaldo.
 */
function resolvePaymentAccountKey(payment: PagoProveedorRecord): string {
  // BanBajio: el banco statement guarda cuenta-sentinela "BANBAJIO"; aquí
  // detectamos el banco por nombre en cuentaBancaria (ej. "BANBAJIO 33850201")
  // antes que cualquier otra heurística, para que ambos lados caigan al
  // mismo key sintético.
  if (BAJIO_PATTERN.test(payment.cuentaBancaria || '')) return BANBAJIO_KEY;
  const primary = normalizeAccountKey(payment.cuentaBanco);
  if (primary && primary.length >= 4) return primary;
  // Fallback: digit cluster within cuentaBancaria. Pick the longest run so we
  // don't grab a 2-digit cía code by accident.
  const digitRuns = (payment.cuentaBancaria || '').match(/\d+/g) ?? [];
  let longest = '';
  for (const run of digitRuns) if (run.length > longest.length) longest = run;
  return longest.replace(/^0+/, '');
}

/** First index in `cargos` (sorted asc by importe) whose importe >= target. */
function lowerBoundByImporte(cargos: IndexedCargo[], target: number): number {
  let lo = 0;
  let hi = cargos.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cargos[mid].movement.importe < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function findCargoMatch(
  payment: PagoProveedorRecord,
  cargosByAccount: Map<string, IndexedCargo[]>,
  claimedCargo: Set<string>,
): (IndexedCargo & { tier: Exclude<CargoMatchTier, 'unmatched'> }) | undefined {
  const accountKey = resolvePaymentAccountKey(payment);
  const accountCargos = cargosByAccount.get(accountKey) ?? [];
  if (accountCargos.length === 0) return undefined;

  const payAmt = payment.importePesos;
  const payEpoch = parseDateEpoch(payment.fechaPago);
  // `cargoMatchTier` only matches an amount within ±0.5% (or ±$1). The cargos
  // are sorted by importe, so we binary-search a generous superset of that
  // band — 4× the tolerance + $1 slack — and scan only that slice. The real
  // match gate stays inside `cargoMatchTier`; widening here just guarantees no
  // in-band cargo is skipped. O(payments × cargos) → O(payments × log + slice).
  const amountWindow = Math.max(AMOUNT_TOLERANCE_MIN_ABS, payAmt * AMOUNT_TOLERANCE_PCT) * 4 + 1;
  const hiBound = payAmt + amountWindow;

  // Recolecta TODOS los matches dentro de la ventana y devuelve el mejor por
  // (tier exact > tolerance) y, dentro de cada tier, el más cercano en fecha.
  // Con la ventana abierta a ±15d, "primer match" se vuelve no determinístico
  // y permite que un cargo lejano robe el slot a uno cercano del siguiente
  // pago; ranking lo evita. Empate de tier+días → menor `seq` (orden original).
  let best: (IndexedCargo & { tier: Exclude<CargoMatchTier, 'unmatched'>; days: number }) | undefined;
  for (let i = lowerBoundByImporte(accountCargos, payAmt - amountWindow); i < accountCargos.length; i++) {
    const cargo = accountCargos[i];
    if (cargo.movement.importe > hiBound) break;
    if (claimedCargo.has(cargo.key)) continue;
    const rawDays = (cargo.fechaOpEpoch - payEpoch) / DAY_MS;
    const tier = cargoMatchTier(payAmt, cargo.movement.importe, rawDays);
    if (tier === 'unmatched') continue;
    const days = Math.abs(rawDays);
    if (!best) {
      best = { ...cargo, tier, days };
      continue;
    }
    // exact siempre gana sobre tolerance; con mismo tier, gana menor días, y
    // a igualdad de días gana el de menor `seq` (= primero en orden original).
    let better = false;
    if (tier === 'exact' && best.tier !== 'exact') {
      better = true;
    } else if (tier === best.tier) {
      if (days < best.days) better = true;
      else if (days === best.days && cargo.seq < best.seq) better = true;
    }
    if (better) best = { ...cargo, tier, days };
  }
  if (!best) return undefined;
  const { days: _days, ...rest } = best;
  void _days;
  return rest;
}

/**
 * 2a pasada — cross-account: busca el CARGO en CUALQUIER cuenta, no solo la
 * del registro de pago. Cubre el patrón de cuentas concentradoras: tesorería
 * dispersa desde una cuenta maestra y JDE registra la cuenta nominal de la
 * cía. Importe ±0.5%, fecha dentro de ±SECONDARY_DATE_WINDOW_DAYS, gana el
 * más cercano en fecha (empate → menor `seq`).
 */
function findCrossAccountCargo(
  payment: PagoProveedorRecord,
  cargosByImporte: IndexedCargo[],
  claimedCargo: Set<string>,
): IndexedCargo | undefined {
  const payAmt = payment.importePesos;
  const payEpoch = parseDateEpoch(payment.fechaPago);
  if (!Number.isFinite(payEpoch) || payAmt <= 0) return undefined;
  const amountWindow = Math.max(AMOUNT_TOLERANCE_MIN_ABS, payAmt * AMOUNT_TOLERANCE_PCT);
  const hiBound = payAmt + amountWindow;
  let best: { cargo: IndexedCargo; days: number } | undefined;
  for (let i = lowerBoundByImporte(cargosByImporte, payAmt - amountWindow); i < cargosByImporte.length; i++) {
    const cargo = cargosByImporte[i];
    if (cargo.movement.importe > hiBound) break;
    if (claimedCargo.has(cargo.key)) continue;
    if (!amountsClose(cargo.movement.importe, payAmt, AMOUNT_TOLERANCE_PCT)) continue;
    const days = Math.abs((cargo.fechaOpEpoch - payEpoch) / DAY_MS);
    if (!Number.isFinite(days) || days > SECONDARY_DATE_WINDOW_DAYS) continue;
    if (!best || days < best.days || (days === best.days && cargo.seq < best.cargo.seq)) {
      best = { cargo, days };
    }
  }
  return best?.cargo;
}

/**
 * 2a pasada — batch: UN CARGO agregado cuyo importe ≈ la suma de N pagos del
 * mismo lote, en la MISMA cuenta del registro de pago. Ventana estrecha
 * (±SECONDARY_DATE_WINDOW_DAYS): la dispersión del lote sale por banco el
 * mismo día o a días del registro JDE. Gana el más cercano en fecha (empate
 * → menor `seq`).
 */
function findBatchCargo(
  accountKey: string,
  totalAmt: number,
  refEpoch: number,
  cargosByAccount: Map<string, IndexedCargo[]>,
  claimedCargo: Set<string>,
): IndexedCargo | undefined {
  if (!Number.isFinite(refEpoch) || totalAmt <= 0) return undefined;
  const accountCargos = cargosByAccount.get(accountKey) ?? [];
  if (accountCargos.length === 0) return undefined;
  const amountWindow = Math.max(AMOUNT_TOLERANCE_MIN_ABS, totalAmt * AMOUNT_TOLERANCE_PCT);
  const hiBound = totalAmt + amountWindow;
  let best: { cargo: IndexedCargo; days: number } | undefined;
  for (let i = lowerBoundByImporte(accountCargos, totalAmt - amountWindow); i < accountCargos.length; i++) {
    const cargo = accountCargos[i];
    if (cargo.movement.importe > hiBound) break;
    if (claimedCargo.has(cargo.key)) continue;
    if (!amountsClose(cargo.movement.importe, totalAmt, AMOUNT_TOLERANCE_PCT)) continue;
    const days = Math.abs((cargo.fechaOpEpoch - refEpoch) / DAY_MS);
    if (!Number.isFinite(days) || days > SECONDARY_DATE_WINDOW_DAYS) continue;
    if (!best || days < best.days || (days === best.days && cargo.seq < best.cargo.seq)) {
      best = { cargo, days };
    }
  }
  return best?.cargo;
}

/**
 * 2a pasada — subset: el pago se dispersó en 2-SUBSET_MAX_CARGOS CARGOs de la
 * MISMA cuenta (tranches). Suma cargos no reclamados dentro de la ventana de
 * fecha cuyo total ≈ importe del pago (±0.5%). Un cargo que por sí solo cuadra
 * ya lo habría cazado `findCargoMatch`, así que se excluye de los candidatos.
 */
function findCargoSubset(
  payment: PagoProveedorRecord,
  cargosByAccount: Map<string, IndexedCargo[]>,
  claimedCargo: Set<string>,
): IndexedCargo[] {
  const payAmt = payment.importePesos;
  const payEpoch = parseDateEpoch(payment.fechaPago);
  if (!Number.isFinite(payEpoch) || payAmt <= 0) return [];
  const accountCargos = cargosByAccount.get(resolvePaymentAccountKey(payment)) ?? [];
  const tol = Math.max(AMOUNT_TOLERANCE_MIN_ABS, payAmt * AMOUNT_TOLERANCE_PCT);
  const candidates = accountCargos
    .filter((c) =>
      !claimedCargo.has(c.key) &&
      Number.isFinite(c.fechaOpEpoch) &&
      // Cada tranche debe ser material: un cargo ≤ la tolerancia no altera si
      // la suma cuadra — incluirlo solo mete ruido (comisiones SPEI, etc.) y
      // arma subsets espurios. Exigir > tol fuerza tranches reales.
      c.movement.importe > tol &&
      Math.abs((c.fechaOpEpoch - payEpoch) / DAY_MS) <= SECONDARY_DATE_WINDOW_DAYS &&
      !amountsClose(c.movement.importe, payAmt, AMOUNT_TOLERANCE_PCT))
    .slice(0, 30); // cap combinatorial space

  if (candidates.length < 2) return [];

  // Backtrack acotado a SUBSET_MAX_CARGOS. `candidates` viene ordenado asc por
  // importe → `remaining < -tol` poda ramas que ya se pasaron.
  function search(start: number, remaining: number, picks: IndexedCargo[]): IndexedCargo[] | null {
    if (Math.abs(remaining) <= tol && picks.length >= 2) return picks;
    if (picks.length >= SUBSET_MAX_CARGOS) return null;
    if (remaining < -tol) return null;
    for (let i = start; i < candidates.length; i++) {
      const found = search(i + 1, remaining - candidates[i].movement.importe, [...picks, candidates[i]]);
      if (found) return found;
    }
    return null;
  }
  return search(0, payAmt, []) ?? [];
}

/**
 * Diagnóstico (no es cruce): el CARGO de importe parecido (±0.5%) más cercano
 * en fecha a un pago UNMATCHED, dentro de ±UNMATCHED_CANDIDATE_WINDOW_DAYS.
 * A diferencia de `findCrossAccountCargo` NO descarta los CARGOs reclamados —
 * los devuelve con `claimed: true` para que el drill-down explique el caso.
 */
function findUnmatchedCandidate(
  payment: PagoProveedorRecord,
  cargosByImporte: IndexedCargo[],
  claimedCargo: Set<string>,
): PaymentMatch['unmatchedCandidate'] {
  const payAmt = payment.importePesos;
  const payEpoch = parseDateEpoch(payment.fechaPago);
  if (!Number.isFinite(payEpoch) || payAmt <= 0) return undefined;
  const amountWindow = Math.max(AMOUNT_TOLERANCE_MIN_ABS, payAmt * AMOUNT_TOLERANCE_PCT);
  const hiBound = payAmt + amountWindow;
  const acctKey = resolvePaymentAccountKey(payment);
  let best: { cargo: IndexedCargo; days: number } | undefined;
  for (let i = lowerBoundByImporte(cargosByImporte, payAmt - amountWindow); i < cargosByImporte.length; i++) {
    const cargo = cargosByImporte[i];
    if (cargo.movement.importe > hiBound) break;
    if (!amountsClose(cargo.movement.importe, payAmt, AMOUNT_TOLERANCE_PCT)) continue;
    const days = Math.abs((cargo.fechaOpEpoch - payEpoch) / DAY_MS);
    if (!Number.isFinite(days) || days > UNMATCHED_CANDIDATE_WINDOW_DAYS) continue;
    if (!best || days < best.days) best = { cargo, days };
  }
  if (!best) return undefined;
  return {
    movement: best.cargo.movement,
    cuenta: best.cargo.cuenta,
    daysOff: Math.round(best.days),
    sameAccount: normalizeAccountKey(best.cargo.cuenta) === acctKey,
    claimed: claimedCargo.has(best.cargo.key),
  };
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

// `rawDays` = signed day delta cargo − pago (NaN if either date missing/bad).
function cargoMatchTier(payAmt: number, movementImporte: number, rawDays: number): CargoMatchTier {
  if (!Number.isFinite(rawDays)) return 'unmatched';
  const days = Math.abs(rawDays);
  if (days > BANK_DATE_WINDOW_DAYS) return 'unmatched';
  if (days < 0.5 && Math.abs(movementImporte - payAmt) < 0.01) return 'exact';
  if (amountsClose(movementImporte, payAmt, AMOUNT_TOLERANCE_PCT)) return 'tolerance';
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
  coverage: BankCoverage,
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
    if (cargo.tier === 'subset') {
      const n = 1 + (cargo.extraMovements?.length ?? 0);
      parts.push(`Pago partido en ${n} CARGOs bancarios (cuenta ${cargo.cuenta}).`);
    } else if (cargo.tier === 'batch') {
      parts.push(`CARGO agregado del lote — un cargo cubre la suma de los pagos del batch (cuenta ${cargo.cuenta}).`);
    } else {
      const lab = cargo.tier === 'exact' ? 'exacto'
        : cargo.tier === 'tolerance' ? 'tolerancia'
        : 'desde otra cuenta (concentradora)';
      parts.push(`CARGO bancario ${lab} (cuenta ${cargo.cuenta}).`);
    }
  } else if (coverage === 'no-account') {
    parts.push('La cuenta del pago no tiene estados de cuenta cargados — no hay banco contra qué cruzar.');
  } else if (coverage === 'out-of-range') {
    parts.push('La fecha del pago cae fuera del rango bancario cargado para su cuenta.');
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

// El statement bancario guarda `cuenta` ya normalizada por
// `normalizeBankAccountNumber` → forma zero-padded del API JDE /bancos
// (Banamex 11 díg, Banorte 10). PagoProveedor `cuentaBanco` viene crudo sin
// ese padding. Quitar no-dígitos NO basta: "877732401" (pago) ≠ "00877732401"
// (banco) → el join fallaba silenciosamente y todo CARGO caía a ORPHAN /
// "Otros egresos". Quitamos también ceros a la izquierda en AMBOS lados
// (simétrico, bank-agnóstico). Santander as-is no se ve afectado. El falso
// match es improbable: `cargoMatchTier` ya exige importe exacto/±0.5% y fecha
// ±2 días.
/**
 * Bajío forza un cuenta-sentinela "BANBAJIO" en `BankStatementLine.cuenta`
 * (ver `src/services/jde.ts:420` — JDE no envía el número real porque el campo
 * `Cuenta_Bancos` viene rotando por folio SPEI). El pago, en cambio, sí trae
 * los dígitos reales ("33850201") en `cuentaBancaria`. Para que ambos lados
 * conviertan al mismo key, detectamos BAJIO en cualquier lado y colapsamos a
 * "BANK:BANBAJIO". Caso normal: solo dígitos, sin ceros líderes. (Riesgo nulo
 * de colisión: ninguna cuenta numérica empieza con "BANK:".)
 */
const BANBAJIO_KEY = 'BANK:BANBAJIO';
const BAJIO_PATTERN = /BAJ[IÍ]O/i;

function normalizeAccountKey(value: string): string {
  const raw = (value || '').toString();
  if (BAJIO_PATTERN.test(raw) || /^BANBAJIO$/i.test(raw.trim())) return BANBAJIO_KEY;
  return raw.replace(/\D+/g, '').replace(/^0+/, '');
}

function sameCia(a: string, b: string): boolean {
  return normalizeCia(a) === normalizeCia(b);
}

function cleanIsoDate(value?: string): string | undefined {
  const trimmed = (value || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : undefined;
}

function parseDateEpoch(value: string): number {
  return new Date(`${value}T00:00:00.000Z`).getTime();
}

function daysBetween(a: string, b: string): number {
  return (parseDateEpoch(b) - parseDateEpoch(a)) / DAY_MS;
}
