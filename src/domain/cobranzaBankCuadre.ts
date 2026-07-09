import type { PaymentReconciliation } from './realReconciliationEngine';

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
  | 'revisar';

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
  /** % del importe aplicado que cuadró con banco (cuadrado / totalEdwards). */
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

function glConfirmedFor(
  p: PaymentReconciliation,
  glKeys: ReadonlySet<string> | undefined,
): boolean | undefined {
  if (!glKeys) return undefined;
  if (p.applications.length === 0) return false;
  return p.applications.every(app => glKeys.has(`${app.cia}::${app.noFactura}`));
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
}, status: CuadreStatus): CuadreBucket {
  switch (status) {
    case 'cuadrado': return agg.cuadrado;
    case 'descuadre-importe': return agg.descuadreImporte;
    case 'sin-banco': return agg.sinBanco;
    case 'revisar': return agg.revisar;
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
  const { glConfirmedInvoiceKeys, ciaFilter } = options;
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
    pctCuadradoImporte: 0,
  };

  for (const p of paymentReconciliations) {
    if (useCiaFilter && !ciaFilter!.has(p.cia)) continue;
    const status = classify(p);
    const importeEdwards = p.importeRecibo;
    const importeBanco = p.bankMovement?.importe ?? 0;
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

  totals.pctCuadradoImporte = totals.totalEdwards > 0
    ? (totals.cuadrado.importe / totals.totalEdwards) * 100
    : 0;

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
    keys.add(key.slice('factura:'.length));
  }
  return keys;
}
