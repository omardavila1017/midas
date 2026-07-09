import type { PaymentReconciliation } from './realReconciliationEngine';
import { normFactura } from './rolCobranzaMatch';
import {
  COMPENSATION_CLIENT_RULES,
  resolveCompensationRule,
  type CompensationClientRule,
  type CompensationScheme,
} from '../config/compensationClientsCatalog';

/**
 * Cuadre de la cobranza APLICADA en Edwards contra el BANCO (y, opcionalmente,
 * corroborada en el Auxiliar Contable). Capa de agregación pura y read-only
 * sobre `RealReconciliationResult.paymentReconciliations` — NO recruza nada ni
 * toca el motor; sólo clasifica y agrupa lo que el motor ya resolvió.
 *
 * Contexto (Bloque 2, jul-2026): Verito aplica los cobros en JDE
 * (/cobranzaindicadores → `CobranzaPayment`, un recibo por `idPago` con
 * `importeRecibo`, `cuentaBancaria`, `noRecibo`, cliente). El motor
 * `reconcileRealCollections` ya cruza ese recibo contra los ABONOs bancarios y
 * marca cada uno con un `status`:
 *   - CONFIRMED_REF / AUTO_UNIQUE → apareció en el banco.
 *   - UNMATCHED                   → aplicado en Edwards pero SIN depósito en banco.
 *   - AMBIGUOUS                   → varios candidatos, requiere revisión.
 *
 * Este helper traduce eso a la pregunta de negocio "¿el cobro aplicado sí entró
 * al banco?" con desglose por cliente e importe: cuadrado vs descuadre.
 *
 * Excepción de COMPENSACIONES (junta 2026-07-09): los clientes del catálogo
 * `compensationClientsCatalog.ts` (TLJ, APTIV, CMI) liquidan por compensación y
 * su faltante bancario es ESPERADO — se clasifican en el bucket `compensacion`
 * (fuera del % de descuadre) en vez de `sin-banco`/`descuadre-importe`. Ver
 * `docs/COMPENSACIONES-COBRANZA.md`.
 */

/** Clasificación de cuadre de un recibo aplicado contra el banco. */
export type CuadreStatus =
  /** Aplicado en Edwards y confirmado en banco con importe coincidente. */
  | 'cuadrado'
  /** Confirmado en banco pero el importe del recibo difiere del depósito. */
  | 'descuadre-importe'
  /** Aplicado en Edwards pero SIN depósito bancario (o cuenta sin estado de cuenta). */
  | 'sin-banco'
  /** Varios candidatos en banco — requiere revisión manual. */
  | 'revisar'
  /**
   * Cliente con esquema de compensación (junta 2026-07-09): el cobro se liquida
   * total o parcialmente por compensación y NO entra (completo) al banco como
   * abono de cobranza. Esperado, no accionable — fuera del % de descuadre.
   * Catálogo: `src/config/compensationClientsCatalog.ts`.
   */
  | 'compensacion';

/** Detalle de la regla de compensación aplicada a un recibo. */
export interface PaymentCompensacion {
  scheme: CompensationScheme;
  /** Nombre corto de la regla (p.ej. "TLJ"). */
  label: string;
  /** Cuenta de compensación asociada, cuando el catálogo la conoce. */
  cuentaCompensacion?: string;
}

export interface PaymentCuadre {
  idPago: string;
  cia: string;
  noCliente: string;
  cliente: string;
  fechaCobro: string;
  noRecibo: string;
  banco: string;
  cuentaBancaria: string;
  /** Importe del recibo aplicado en Edwards. */
  importeEdwards: number;
  /** Importe del movimiento bancario cruzado (0 si no cruzó). */
  importeBanco: number;
  /** importeEdwards − importeBanco (>0 = Edwards cobró de más vs banco). */
  diferencia: number;
  status: CuadreStatus;
  /** Status crudo del motor (trazabilidad). */
  paymentStatus: PaymentReconciliation['status'];
  /** Presente sólo cuando `status === 'compensacion'`. */
  compensacion?: PaymentCompensacion;
  /**
   * Corroboración en Auxiliar Contable: `true` si TODAS las facturas del recibo
   * están confirmadas como cobradas en el libro mayor; `false` si el set de
   * llaves GL se proporcionó pero no todas cuadran; `undefined` si no se pasó
   * la señal GL (auxiliar no cargado en este tab).
   */
  glConfirmado?: boolean;
}

export interface CuadreBucket {
  count: number;
  importe: number;
}

export interface ClientCuadre {
  clientKey: string;
  noCliente: string;
  cliente: string;
  totalPagos: number;
  totalEdwards: number;
  totalBanco: number;
  cuadrado: CuadreBucket;
  descuadreImporte: CuadreBucket;
  sinBanco: CuadreBucket;
  revisar: CuadreBucket;
  compensacion: CuadreBucket;
  /** Suma de |diferencia| de los recibos con descuadre de importe. */
  diferenciaAbs: number;
}

export interface CobranzaBankCuadreTotals {
  totalPagos: number;
  totalEdwards: number;
  totalBanco: number;
  cuadrado: CuadreBucket;
  descuadreImporte: CuadreBucket;
  sinBanco: CuadreBucket;
  revisar: CuadreBucket;
  /** Recibos de clientes con esquema de compensación (esperado, no accionable). */
  compensacion: CuadreBucket;
  /**
   * % del importe aplicado que cuadró con banco. La base EXCLUYE el importe de
   * compensación (no es bancarizable por diseño): `cuadrado / (totalEdwards −
   * compensacion)`. Si toda la base es compensación no hay nada que cuadrar →
   * 100 (no hay descuadre accionable).
   */
  pctCuadradoImporte: number;
}

export interface CobranzaBankCuadreResult {
  payments: PaymentCuadre[];
  byClient: ClientCuadre[];
  totals: CobranzaBankCuadreTotals;
}

export interface CobranzaBankCuadreOptions {
  /**
   * Llaves `${cia}::${noFactura}` de facturas confirmadas como cobradas en el
   * Auxiliar Contable (p.ej. `AuxiliarProjectionBridge.cobradaBancoKeys`). Si se
   * pasa, cada recibo se marca `glConfirmado` cuando TODAS sus facturas cuadran.
   */
  glConfirmedInvoiceKeys?: ReadonlySet<string>;
  /** Restringe a estas cías (vacío/omitido = todas). */
  ciaFilter?: ReadonlySet<string>;
  /**
   * Reglas de clientes con esquema de compensación. Inyectable para tests;
   * default: el catálogo declarativo `COMPENSATION_CLIENT_RULES`.
   */
  compensationRules?: readonly CompensationClientRule[];
}

/** Tolerancia para considerar que el recibo y el depósito bancario cuadran. */
const CUADRE_TOLERANCE_PCT = 0.005; // 0.5%
const CUADRE_TOLERANCE_MIN_ABS = 1; // 1 peso

function importesCuadran(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(CUADRE_TOLERANCE_MIN_ABS, Math.abs(a) * CUADRE_TOLERANCE_PCT);
}

function classify(p: PaymentReconciliation): CuadreStatus {
  if (p.status === 'AMBIGUOUS') return 'revisar';
  if (p.status === 'UNMATCHED' || !p.bankMovement) return 'sin-banco';
  // CONFIRMED_REF / AUTO_UNIQUE con movimiento bancario asociado.
  return importesCuadran(p.importeRecibo, p.bankMovement.importe) ? 'cuadrado' : 'descuadre-importe';
}

/**
 * Re-clasifica a `compensacion` los descuadres ESPERADOS de un cliente con
 * esquema de compensación:
 *  - `sin-banco` → compensación en ambos esquemas (el cobro no entra al banco:
 *    aplica-a-proveedor liquida contra deuda; descuento-en-origen puede
 *    compensar el 100%).
 *  - `descuadre-importe` con Edwards > banco → compensación SÓLO en
 *    descuento-en-origen (el cliente depositó el neto; el faltante es el
 *    descuento). Banco > Edwards NO es explicable por compensación y se queda
 *    como descuadre real.
 * `cuadrado` y `revisar` nunca se tocan: si el depósito sí apareció completo
 * (p.ej. Corning pagando a Bajío) el cuadre normal manda.
 */
function applyCompensacion(
  base: CuadreStatus,
  rule: CompensationClientRule,
  importeEdwards: number,
  importeBanco: number,
): CuadreStatus {
  if (base === 'sin-banco') return 'compensacion';
  if (base === 'descuadre-importe' && rule.scheme === 'descuento-en-origen' && importeEdwards > importeBanco) {
    return 'compensacion';
  }
  return base;
}

/**
 * El folio de /cobranzaindicadores y el del ledger GL vienen de APIs distintas
 * y su formato deriva ("RI - 305405" vs "RI-305405") — el cruce crudo producía
 * falsos "no corroborado". Ambos lados se pasan por el normalizador CANÓNICO
 * (`normFactura`); folio placeholder/vacío normaliza a `''` y se trata como
 * no-corroborable (nunca cruza).
 */
function glConfirmedFor(
  p: PaymentReconciliation,
  glKeys: ReadonlySet<string> | undefined,
): boolean | undefined {
  if (!glKeys) return undefined;
  if (p.applications.length === 0) return false;
  return p.applications.every(app => {
    const folio = normFactura(app.noFactura);
    if (!folio) return false;
    return glKeys.has(`${app.cia}::${folio}`);
  });
}

function emptyBucket(): CuadreBucket {
  return { count: 0, importe: 0 };
}

function addTo(bucket: CuadreBucket, importe: number): void {
  bucket.count += 1;
  bucket.importe += importe;
}

function bucketForStatus(agg: {
  cuadrado: CuadreBucket;
  descuadreImporte: CuadreBucket;
  sinBanco: CuadreBucket;
  revisar: CuadreBucket;
  compensacion: CuadreBucket;
}, status: CuadreStatus): CuadreBucket {
  switch (status) {
    case 'cuadrado': return agg.cuadrado;
    case 'descuadre-importe': return agg.descuadreImporte;
    case 'sin-banco': return agg.sinBanco;
    case 'revisar': return agg.revisar;
    case 'compensacion': return agg.compensacion;
  }
}

/**
 * Construye el cuadre de cobranza aplicada vs banco a partir de las
 * `paymentReconciliations` del motor. Read-only, determinista.
 */
export function buildCobranzaBankCuadre(
  paymentReconciliations: readonly PaymentReconciliation[],
  options: CobranzaBankCuadreOptions = {},
): CobranzaBankCuadreResult {
  const { glConfirmedInvoiceKeys, ciaFilter, compensationRules = COMPENSATION_CLIENT_RULES } = options;
  const useCiaFilter = ciaFilter && ciaFilter.size > 0;

  const payments: PaymentCuadre[] = [];
  const clientMap = new Map<string, ClientCuadre>();
  const totals: CobranzaBankCuadreTotals = {
    totalPagos: 0,
    totalEdwards: 0,
    totalBanco: 0,
    cuadrado: emptyBucket(),
    descuadreImporte: emptyBucket(),
    sinBanco: emptyBucket(),
    revisar: emptyBucket(),
    compensacion: emptyBucket(),
    pctCuadradoImporte: 0,
  };

  for (const p of paymentReconciliations) {
    if (useCiaFilter && !ciaFilter!.has(p.cia)) continue;
    const baseStatus = classify(p);
    const importeEdwards = p.importeRecibo;
    // AMBIGUOUS: el motor cuelga el MISMO abono candidato en cada recibo del
    // grupo (markPaymentAmbiguous) — sumarlo por recibo multi-contaba un solo
    // depósito en `totalBanco` y presentaba el candidato sin confirmar como
    // cruzado en el CSV. Un candidato no es un cruce: banco = 0, como sin-banco
    // (consistente con el contrato "0 si no cruzó" de `importeBanco`).
    const importeBanco = baseStatus === 'revisar' ? 0 : (p.bankMovement?.importe ?? 0);
    const compRule = resolveCompensationRule(p.noCliente, p.cliente, compensationRules);
    const status = compRule
      ? applyCompensacion(baseStatus, compRule, importeEdwards, importeBanco)
      : baseStatus;
    const cuadre: PaymentCuadre = {
      idPago: p.idPago,
      cia: p.cia,
      noCliente: p.noCliente,
      cliente: p.cliente,
      fechaCobro: p.fechaCobro,
      noRecibo: p.noRecibo,
      banco: p.banco,
      cuentaBancaria: p.cuentaBancaria,
      importeEdwards,
      importeBanco,
      diferencia: importeEdwards - importeBanco,
      status,
      paymentStatus: p.status,
      compensacion: status === 'compensacion' && compRule
        ? { scheme: compRule.scheme, label: compRule.label, cuentaCompensacion: compRule.cuentaCompensacion }
        : undefined,
      glConfirmado: glConfirmedFor(p, glConfirmedInvoiceKeys),
    };
    payments.push(cuadre);

    // Totales globales.
    totals.totalPagos += 1;
    totals.totalEdwards += importeEdwards;
    totals.totalBanco += importeBanco;
    addTo(bucketForStatus(totals, status), importeEdwards);

    // Agregación por cliente. Agrupamos por número de cliente (identidad JDE);
    // si viene vacío caemos al nombre para no fundir clientes distintos en "".
    const clientKey = p.noCliente || `nombre:${p.cliente}`;
    let entry = clientMap.get(clientKey);
    if (!entry) {
      entry = {
        clientKey,
        noCliente: p.noCliente,
        cliente: p.cliente,
        totalPagos: 0,
        totalEdwards: 0,
        totalBanco: 0,
        cuadrado: emptyBucket(),
        descuadreImporte: emptyBucket(),
        sinBanco: emptyBucket(),
        revisar: emptyBucket(),
        compensacion: emptyBucket(),
        diferenciaAbs: 0,
      };
      clientMap.set(clientKey, entry);
    }
    entry.totalPagos += 1;
    entry.totalEdwards += importeEdwards;
    entry.totalBanco += importeBanco;
    addTo(bucketForStatus(entry, status), importeEdwards);
    if (status === 'descuadre-importe') entry.diferenciaAbs += Math.abs(cuadre.diferencia);
  }

  // La base del % excluye la compensación (esperada, no bancarizable): un
  // cliente TLJ/APTIV/CMI no debe hundir el indicador de descuadre.
  const baseBancarizable = totals.totalEdwards - totals.compensacion.importe;
  totals.pctCuadradoImporte = baseBancarizable > 0
    ? (totals.cuadrado.importe / baseBancarizable) * 100
    : totals.totalEdwards > 0 ? 100 : 0;

  // Orden: más descuadre primero (sin-banco + descuadre-importe por importe),
  // para que lo accionable quede arriba.
  const byClient = Array.from(clientMap.values()).sort((a, b) => {
    const descuadreA = a.sinBanco.importe + a.descuadreImporte.importe;
    const descuadreB = b.sinBanco.importe + b.descuadreImporte.importe;
    if (descuadreB !== descuadreA) return descuadreB - descuadreA;
    return b.totalEdwards - a.totalEdwards;
  });

  return { payments, byClient, totals };
}

/** Facturas GL-confirmadas (ingreso) desde el resultado del auxiliar. Set de `${cia}::${noFactura}`. */
export function glConfirmedInvoiceKeysFromSourceConfirmation(
  sourceConfirmation: ReadonlyMap<string, { confirmed: boolean; flujo: string }>,
): Set<string> {
  const keys = new Set<string>();
  for (const [key, conf] of sourceConfirmation) {
    if (!conf.confirmed || conf.flujo !== 'ingreso') continue;
    if (!key.startsWith('factura:')) continue;
    // La llave viene `factura:${cia}::${noFactura}` con el folio GL crudo;
    // se re-emite con el folio canónico (`normFactura`) para que cruce con
    // el lado de /cobranzaindicadores aunque el formato derive.
    const rest = key.slice('factura:'.length);
    const sep = rest.indexOf('::');
    if (sep < 0) continue;
    const folio = normFactura(rest.slice(sep + 2));
    if (!folio) continue;
    keys.add(`${rest.slice(0, sep)}::${folio}`);
  }
  return keys;
}
