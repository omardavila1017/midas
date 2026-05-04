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

import type { BankAccountStatement, BankStatementLine, CobranzaRecord } from '../services/jdeTypes';
import {
  isInternalTransfer,
  buildOwnAccountsIndex,
  buildOwnAccountDetector,
} from './netCashFlowEngine';

// ── Configuración ──────────────────────────────────────────────────────────

/** Tolerancia en monto para cobertura "tolerancia" y "subset". */
const AMOUNT_TOLERANCE_PCT = 0.005; // 0.5%
/** Tolerancia absoluta mínima — un ABONO de $100 debe poder ajustar ±$1. */
const AMOUNT_TOLERANCE_MIN_ABS = 1;
/** Máximo de facturas en una combinación subset-sum. */
const SUBSET_MAX_INVOICES = 4;
/** Ventana de fecha alrededor de fechaVence (±N días) — capa 1/2. */
const DATE_WINDOW_DAYS = 60;
/** Ventana de fecha alrededor de fechaCobro cuando ya viene del ERP (±N días). */
const COBRO_WINDOW_DAYS = 5;

const DAY_MS = 86_400_000;

// ── Tipos públicos ─────────────────────────────────────────────────────────

export type MatchTier = 'exact' | 'tolerance' | 'subset';
export type FacturaStatus = 'cobrada-banco' | 'cobrada-jde-sin-banco' | 'pendiente';
export type AbonoStatus = 'factura-cobrada' | 'cobranza-sin-factura' | 'no-cobranza';

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

  /** Datos del movimiento bancario que cubrió la factura. */
  bankRef?: string;
  bankAmount?: number;
  bankDate?: string;
  bankConcept?: string;
  bankAccount?: string;
  bankCia?: string;

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

  /** Datos básicos del ABONO para que el caller no tenga que cruzar. */
  cia: string;
  cuenta: string;
  fechaOperacion: string;
  importe: number;
  concepto: string;
  referencia: string;
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

  /** KPI principal: % de ABONOs que tienen una factura JDE asociada. */
  pctAbonosCruzados: number;

  /** KPI secundario: % de facturas (con saldo > 0) que cruzan a banco. */
  pctFacturasCruzadas: number;
}

export interface RealReconciliationResult {
  /** Una entrada por factura del input. */
  matches: RealReconciliationMatch[];
  /** Una entrada por ABONO bancario (después de filtrar internos). */
  abonoEnrichments: AbonoEnrichment[];
  /** Métricas top-level para KPIs. */
  summary: RealReconciliationSummary;
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

function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T12:00:00Z').getTime();
  const db = new Date(b + 'T12:00:00Z').getTime();
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
  const baseByTier = tier === 'exact' ? 1.0 : tier === 'tolerance' ? 0.85 : 0.7;
  // Penalización por monto: 0% diff → 1, 0.5% → ~0.5
  const amountFactor = Math.max(0, 1 - amountDiffPct / AMOUNT_TOLERANCE_PCT);
  // Penalización por días: 0d → 1, fuera de ventana → 0
  const dateFactor = Math.max(0, 1 - Math.abs(daysDelta) / Math.max(1, windowDays));
  // Confidence = base * (0.7 amount + 0.3 date)
  const c = baseByTier * (0.7 * amountFactor + 0.3 * dateFactor);
  return Math.max(0, Math.min(1, c));
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

/**
 * Match entre un ABONO y un cliente:
 *   - Si el `concepto` del ABONO contiene el `noCliente` o un fragmento del
 *     `nombreCliente` (≥3 palabras significativas), es compatible.
 *   - Si no hay match textual, todavía aceptamos cuando es la única factura
 *     candidata por monto+fecha (último recurso, marca confidence menor).
 *
 * NOTA: el match textual es un BOOST de confianza, no un requisito duro.
 * Bancos a veces ponen solo "TRANSFERENCIA SPEI" en el concepto y dejan
 * el monto y la fecha hablar.
 */
function abonoMencionaCliente(abono: BankStatementLine, record: CobranzaRecord): boolean {
  const concepto = normalizeName(abono.concepto || '');
  const referencia = normalizeName(abono.referencia || '');
  const haystack = `${concepto} ${referencia}`;

  // 1. noCliente exacto (palabra-frontera). Cuidado: noCliente "1234" coincidiría
  //    accidentalmente con cualquier referencia de 4 dígitos. Solo si tiene
  //    longitud ≥4 y no es 100% numérico de 4 dígitos.
  const noCliente = (record.noCliente || '').trim();
  if (noCliente.length >= 5) {
    const re = new RegExp(`\\b${noCliente.replace(/[^A-Z0-9]/g, '')}\\b`);
    if (re.test(haystack)) return true;
  }

  // 2. Token significativo del nombre (longitud ≥4 letras, no genérico).
  const stopwords = new Set([
    'SA', 'CV', 'SAB', 'SAPI', 'SC', 'AC', 'RL', 'DE', 'EL', 'LA', 'LOS', 'LAS',
    'DEL', 'Y', 'E', 'O', 'SR', 'SRA', 'COMPANIA', 'COMPANIAS', 'GRUPO',
    'CLIENTE', 'CORPORATIVO', 'INTERNACIONAL', 'NACIONAL',
  ]);
  const tokens = normalizeName(record.nombreCliente || '')
    .split(' ')
    .filter(t => t.length >= 4 && !stopwords.has(t));

  for (const t of tokens) {
    if (haystack.includes(t)) return true;
  }
  return false;
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
  const { ciaFilter, enableUSD = true } = options;

  // ── 1. Filtrar facturas relevantes (con saldo abierto Y cia permitida) ──
  const facturas = cobranzaRecords.filter(r => {
    if (ciaFilter && !ciaFilter.has(r.cia)) return false;
    return true;
  });

  // ── 2. Pool de ABONOs (descartar traspasos internos) ──
  const detector = buildOwnAccountDetector(buildOwnAccountsIndex(bankStatements));
  const abonos: BankStatementLine[] = [];
  let abonosTraspasoInterno = 0;
  for (const account of bankStatements) {
    if (ciaFilter && !ciaFilter.has(account.cia)) continue;
    for (const mov of account.movimientos) {
      if (mov.tipoMovimiento !== 'ABONO') continue;
      if (isInternalTransfer(mov, detector)) {
        abonosTraspasoInterno++;
        continue;
      }
      abonos.push(mov);
    }
  }
  // Orden cronológico — ABONO más antiguo primero. Evita que un ABONO
  // reciente "robe" un match que pertenece a un cobro previo del mismo
  // monto.
  abonos.sort((a, b) => a.fechaOperacion.localeCompare(b.fechaOperacion));

  // ── 3. Agrupar facturas por (cia, noCliente) para búsqueda rápida ──
  const facturasPorCliente = new Map<string, CobranzaRecord[]>();
  const facturaState = new Map<string, RealReconciliationMatch>();
  for (const r of facturas) {
    const key = `${r.cia}::${r.noCliente}`;
    if (!facturasPorCliente.has(key)) facturasPorCliente.set(key, []);
    facturasPorCliente.get(key)!.push(r);

    const facturaKey = `${r.cia}::${r.noFactura}`;
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
    });
  }

  // ── 4. Set de facturas ya consumidas por algún ABONO ──
  const consumedFactura = new Set<string>(); // `${cia}::${noFactura}`
  const enrichments: AbonoEnrichment[] = [];

  // ── 5. Iterar ABONOs y buscar matches ──
  let subsetCounter = 0;
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

    // Identificar candidatos por cía. Si el ABONO viene sin cia, intentar
    // contra TODAS las cías presentes en facturas — es raro pero pasa.
    const cias = abono.cia ? [abono.cia] : Array.from(new Set(facturas.map(f => f.cia)));

    type BestMatch = { tier: MatchTier; record: CobranzaRecord; daysDelta: number; confidence: number };
    type BestSubset = { records: CobranzaRecord[]; cia: string; daysDelta: number; confidence: number };
    let bestMatch: BestMatch | null = null;
    let bestSubset: BestSubset | null = null;

    for (const cia of cias) {
      // 5.a — Iterar candidatos por cliente, priorizando los que el ABONO
      // menciona textualmente.
      const clientesEnCia = new Set<string>();
      for (const [k] of facturasPorCliente) {
        if (k.startsWith(`${cia}::`)) clientesEnCia.add(k);
      }

      for (const clienteKey of clientesEnCia) {
        const clienteFacturas = facturasPorCliente.get(clienteKey)!;
        const sample = clienteFacturas[0];
        if (!mismaMoneda(sample, abono)) continue;

        const facturasAbiertas = clienteFacturas.filter(r => {
          const fk = `${r.cia}::${r.noFactura}`;
          return !consumedFactura.has(fk);
        });
        if (facturasAbiertas.length === 0) continue;

        const mencion = abonoMencionaCliente(abono, sample);

        // Capa 1 + 2: match individual
        for (const r of facturasAbiertas) {
          const { bruto, pendiente } = selectFacturaImporte(r, useUSD);
          // Probar bruto y pendiente como targets posibles.
          for (const target of [bruto, pendiente]) {
            if (target <= 0) continue;

            const exact = importesCoinciden(target, abono.importe, true);
            const tolerated = !exact && importesCoinciden(target, abono.importe, false);
            if (!exact && !tolerated) continue;

            // Ventana de fecha — usar fechaCobro si existe, sino fechaVence.
            const refDate = r.fechaCobro || r.fechaVence;
            if (!refDate) continue;
            const daysDelta = daysBetween(refDate, abono.fechaOperacion);
            const window = r.fechaCobro ? COBRO_WINDOW_DAYS : DATE_WINDOW_DAYS;
            if (Math.abs(daysDelta) > window) continue;

            const tier: MatchTier = exact ? 'exact' : 'tolerance';
            const amountDiffPct = Math.abs(target - abono.importe) / Math.max(target, 1);
            let confidence = computeConfidence(tier, amountDiffPct, daysDelta, window);
            // Boost por mención textual.
            if (mencion) confidence = Math.min(1, confidence + 0.1);

            if (!bestMatch || confidence > bestMatch.confidence) {
              bestMatch = { tier, record: r, daysDelta, confidence };
            }
          }
        }
      }

      // 5.b — Si capa 1/2 no produjo nada, intentar subset-sum por cliente.
      if (!bestMatch) {
        for (const clienteKey of clientesEnCia) {
          const clienteFacturas = facturasPorCliente.get(clienteKey)!;
          const sample = clienteFacturas[0];
          if (!mismaMoneda(sample, abono)) continue;

          const facturasAbiertas = clienteFacturas.filter(r => {
            const fk = `${r.cia}::${r.noFactura}`;
            return !consumedFactura.has(fk);
          });
          if (facturasAbiertas.length < 2) continue;

          const mencion = abonoMencionaCliente(abono, sample);
          // Para subset-sum priorizamos cuando hay mención textual; sin
          // mención el riesgo de falso positivo es alto.
          if (!mencion) continue;

          const subset = findSubset(facturasAbiertas, abono.importe, useUSD);
          if (!subset) continue;

          // Validar fecha: la factura más vieja del subset debe estar dentro
          // de la ventana ±DATE_WINDOW_DAYS de la fecha del ABONO.
          const fechas = subset.map(r => r.fechaCobro || r.fechaVence).filter(Boolean);
          if (fechas.length === 0) continue;
          const closestDelta = fechas
            .map(f => Math.abs(daysBetween(f, abono.fechaOperacion)))
            .reduce((min, d) => Math.min(min, d), Number.POSITIVE_INFINITY);
          if (closestDelta > DATE_WINDOW_DAYS) continue;

          const sumBruto = subset.reduce(
            (s, r) => s + selectFacturaImporte(r, useUSD).bruto,
            0,
          );
          const amountDiffPct = Math.abs(sumBruto - abono.importe) / Math.max(sumBruto, 1);
          const confidence = Math.min(
            1,
            computeConfidence('subset', amountDiffPct, closestDelta, DATE_WINDOW_DAYS) + 0.1,
          );

          if (!bestSubset || confidence > bestSubset.confidence) {
            bestSubset = { records: subset, cia, daysDelta: closestDelta, confidence };
          }
        }
      }
    }

    // ── Aplicar el mejor resultado ──
    // NOTA TS: el control-flow analyzer de TS 5.5 narrowea `bestMatch` a
    // `never` después de los bucles anidados — un known issue cuando el
    // mismo `let` se asigna y se usa en condicionales dentro de cierres.
    // Forzamos la forma con `as` para sortearlo (la lógica del runtime
    // sigue siendo correcta).
    const mb = bestMatch as BestMatch | null;
    const sb = bestSubset as BestSubset | null;
    if (mb) {
      const r: CobranzaRecord = mb.record;
      const tier = mb.tier;
      const daysDelta = mb.daysDelta;
      const confidence = mb.confidence;
      const facturaKey = `${r.cia}::${r.noFactura}`;
      consumedFactura.add(facturaKey);
      const m = facturaState.get(facturaKey);
      if (m) {
        m.status = 'cobrada-banco';
        m.matchTier = tier;
        m.confidence = confidence;
        m.bankRef = abono.referencia;
        m.bankAmount = abono.importe;
        m.bankDate = abono.fechaOperacion;
        m.bankConcept = abono.concepto;
        m.bankAccount = abono.cuenta;
        m.bankCia = abono.cia;
      }
      enrichment.status = 'factura-cobrada';
      enrichment.matchTier = tier;
      enrichment.confidence = confidence;
      enrichment.facturas = [{
        cia: r.cia,
        noFactura: r.noFactura,
        noCliente: r.noCliente,
        nombreCliente: r.nombreCliente,
        importeBruto: r.importeBrutoPesos,
      }];
      // daysDelta no se persiste por factura en esta fase; útil en logs.
      void daysDelta;
    } else if (sb) {
      const subsetGroupId = `subset-${++subsetCounter}`;
      const consumed: Array<{
        cia: string; noFactura: string; noCliente: string; nombreCliente: string; importeBruto: number;
      }> = [];
      for (const r of sb.records) {
        const facturaKey = `${r.cia}::${r.noFactura}`;
        consumedFactura.add(facturaKey);
        const m = facturaState.get(facturaKey);
        if (m) {
          m.status = 'cobrada-banco';
          m.matchTier = 'subset';
          m.confidence = sb.confidence;
          m.bankRef = abono.referencia;
          m.bankAmount = abono.importe;
          m.bankDate = abono.fechaOperacion;
          m.bankConcept = abono.concepto;
          m.bankAccount = abono.cuenta;
          m.bankCia = abono.cia;
          m.subsetGroupId = subsetGroupId;
          m.subsetSize = sb.records.length;
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
      enrichment.confidence = sb.confidence;
      enrichment.facturas = consumed;
    }
    // status default 'cobranza-sin-factura' ya fue puesto al iniciar.

    enrichments.push(enrichment);
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

  // Para el % de facturas cruzadas, denominador = facturas con saldo > 0.
  // Las que ya estaban cerradas en JDE no cuentan (no había nada que cruzar).
  const facturasConSaldo = matches.filter(m => m.importePendiente > 0 || m.status === 'cobrada-banco');

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
    pctAbonosCruzados: abonos.length > 0 ? abonosFacturaCobrada / abonos.length : 0,
    pctFacturasCruzadas: facturasConSaldo.length > 0
      ? cobradas.length / facturasConSaldo.length
      : 0,
  };

  return { matches, abonoEnrichments: enrichments, summary };
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
