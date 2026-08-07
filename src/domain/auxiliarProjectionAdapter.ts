/**
 * Adaptador AuxiliarContable → pipeline de proyección.
 *
 * El motor canónico (`canonicalProjection.ts`) y el servicio de proyección
 * NO conocen al motor de conciliación nuevo. Este adaptador traduce un
 * `AuxiliarReconResult` a las señales mínimas que la proyección consume:
 *
 *   • cobradaBancoKeys — facturas de cobranza ya confirmadas en banco. La
 *     proyección NO las re-proyecta como CXC pendiente (evita doble conteo).
 *   • paidCxpKeys      — CXPs cuya factura aparece como egreso confirmado.
 *     La proyección NO las re-proyecta como egreso futuro.
 *   • cargoEnrichments — por movimiento bancario CARGO, el proveedor real.
 *     Reclasifica egresos históricos en vez de "Otros Egresos".
 *   • abonoEnrichments — por movimiento bancario ABONO, la factura/cliente.
 *     Reclasifica ingresos históricos por cliente.
 *
 * Reemplaza a `buildCobradaBancoKeySet` + `abonoEnrichments` de
 * `realReconciliationEngine` y a `cargoEnrichments`/`cxpCoverage` de
 * `paymentReconciliationEngine`.
 */

import type { AuxiliarReconResult, ReconciledMonthTotals } from './auxiliarReconciliationEngine';
import type { CXPRecord } from './persistence';
import type { CobranzaRecord } from '../services/jdeTypes';

/** Enriquecimiento de un movimiento bancario ABONO con su factura/cliente. */
export interface BankInflowEnrichment {
  movementKey: string;
  status: 'factura-cobrada';
  facturas?: Array<{
    cia: string;
    noFactura: string;
    noCliente: string;
    nombreCliente: string;
    importeBruto: number;
  }>;
  catalogClientId?: string;
  catalogClientName?: string;
}

/** Enriquecimiento de un movimiento bancario CARGO con su pago a proveedor. */
export interface BankOutflowEnrichment {
  status: 'MATCHED' | 'ORPHAN';
  payments?: Array<{
    claveProveedor?: string;
    nombreProveedor: string;
    /** Clasificación operativa de JDE (`Clasificacion_Proveedor`). */
    clasificacionProveedor?: string;
    /** Clasificación financiera de JDE (`Clasificacion_Proveedor_Financiera`). */
    clasificacionProveedorFinanciera?: string;
    importe: number;
  }>;
}

/**
 * Une los DOS productores de enriquecimiento de CARGO histórico.
 *
 * El puente auxiliar (libro mayor × banco) sabe QUÉ movimientos son pago a
 * proveedor, pero sólo puede nombrar la contraparte con el texto del GL
 * (`line.source.contraparte`, a veces el nombre de la CUENTA): no trae la clave
 * del proveedor ni la clasificación de JDE. `paymentReconciliationEngine` sí las
 * trae —vienen directo de `PagoProveedor`— pero cruza por su cuenta y cubre otro
 * subconjunto de CARGOs.
 *
 * Sin esta unión, `matchedPaymentProviderCategory` (historicalReconciledEngine)
 * salía `undefined` para TODO CARGO histórico cruzado, así que el bucket del
 * egreso lo acababa decidiendo un lookup por NOMBRE contra el catálogo de
 * proveedores (cobertura ~23%, y con el nombre del mayor, no el de JDE): la
 * clasificación real de JDE nunca llegaba a Planeación y el egreso se apilaba en
 * "Proveedores sin categoría". El motor YA leía los campos; lo que faltaba era
 * que alguien los pusiera.
 *
 * Precedencia: gana el pago (dato de JDE) sobre el texto del mayor. La unión
 * NUNCA quita ni degrada un `MATCHED` —sólo enriquece— así que ningún movimiento
 * pierde su condición de AP_PAYMENT. Es re-etiquetado de presentación: no toca
 * monto ni fecha, así que el cuadre Planeación↔banco no se mueve.
 *
 * Alcance real (más amplio que "el mayor dice QUÉ y el pago dice QUIÉN"): los dos
 * conjuntos de llaves se solapan pero ninguno contiene al otro, así que un CARGO
 * cruzado SÓLO por el motor de pagos entra como llave NUEVA y pasa a AP_PAYMENT
 * aunque el mayor no lo hubiera cruzado. Es consistente con la precedencia
 * documentada del motor (pagoProveedor > tipo_docto > cuenta contable > rol de
 * cuenta > impuesto-por-concepto), no un efecto colateral: un pago de JDE cruzado
 * al CARGO es señal más específica que el regex de concepto o el tipo de documento.
 */
export function mergeCargoEnrichments(
  fromLedger: Map<string, BankOutflowEnrichment>,
  fromPayments?: Map<string, BankOutflowEnrichment>,
): Map<string, BankOutflowEnrichment> {
  if (!fromPayments || fromPayments.size === 0) return fromLedger;
  const merged = new Map(fromLedger);
  for (const [key, fromPayment] of fromPayments) {
    // Un ORPHAN del motor de pagos NO degrada lo que el mayor ya probó (el
    // CARGO está posteado contra un proveedor); y sin pago no hay nada que
    // aportar, así que esas llaves se omiten — su ausencia se comporta igual
    // que un ORPHAN en el motor (`status !== 'MATCHED'` → sin proveedor).
    if (fromPayment.status !== 'MATCHED' || !fromPayment.payments?.length) continue;
    merged.set(key, fromPayment);
  }
  return merged;
}

export interface AuxiliarProjectionBridge {
  /** `${cia}::${noFactura}` de facturas de cobranza confirmadas en banco. */
  cobradaBancoKeys: Set<string>;
  /** `${cia}::${noFactura}::${noProveedor}` de CXPs pagadas. */
  paidCxpKeys: Set<string>;
  /**
   * `${cia}::${noOrdenCompra}` de OCs cuya salida ya está posteada y cruzada
   * al banco vía AuxiliarContable. La proyección de compras NO las vuelve a
   * proyectar como egreso futuro — el dinero ya salió. Cierra el gap en que
   * una OC pagada queda fuera del CXP abierto (JDE cierra el saldo) y la
   * proyección la seguía mostrando como pendiente porque `purchaseMatchesCxp`
   * solo cruza vs CXP, no vs el libro mayor.
   */
  paidPurchaseOrderKeys: Set<string>;
  /** `bankMovementKey` → enriquecimiento del CARGO. */
  cargoEnrichments: Map<string, BankOutflowEnrichment>;
  /** Enriquecimiento de cada ABONO cruzado a una factura. */
  abonoEnrichments: BankInflowEnrichment[];
  /**
   * Ingreso/egreso reconciliado por (cía, `yyyy-mm`) — verdad histórica de
   * MOTOR 1. La proyección la usa para re-sourcear los brutos históricos
   * (income/expense del `monthly[]`) desde Auxiliar Contable × Bancos en vez
   * de sólo Σ ABONO/CARGO bancario. Llave `${cia}::${yyyy-mm}`.
   */
  reconciledByCompanyMonth: Map<string, ReconciledMonthTotals>;
}

const FACTURA_PREFIX = 'factura:';
const OC_PREFIX = 'oc:';

export function emptyAuxiliarProjectionBridge(): AuxiliarProjectionBridge {
  return {
    cobradaBancoKeys: new Set(),
    paidCxpKeys: new Set(),
    paidPurchaseOrderKeys: new Set(),
    cargoEnrichments: new Map(),
    abonoEnrichments: [],
    reconciledByCompanyMonth: new Map(),
  };
}

export function adaptAuxiliarForProjection(
  result: AuxiliarReconResult | undefined,
  cxpRecords: CXPRecord[],
  cobranzaRecords: CobranzaRecord[],
): AuxiliarProjectionBridge {
  const bridge = emptyAuxiliarProjectionBridge();
  if (!result) return bridge;

  // Totales reconciliados por (cía, mes) — verdad histórica de MOTOR 1.
  bridge.reconciledByCompanyMonth = result.reconciledByCompanyMonth ?? new Map();

  // Documentos confirmados contra banco, separados por dirección de flujo.
  const confirmedEgresoFacturas = new Set<string>();
  for (const [key, conf] of result.sourceConfirmation) {
    if (!conf.confirmed) continue;
    if (key.startsWith(FACTURA_PREFIX)) {
      const facturaId = key.slice(FACTURA_PREFIX.length); // `${cia}::${noFactura}`
      if (conf.flujo === 'ingreso') bridge.cobradaBancoKeys.add(facturaId);
      else confirmedEgresoFacturas.add(facturaId);
    } else if (key.startsWith(OC_PREFIX) && conf.flujo === 'egreso') {
      // `${cia}::${noOrdenCompra}` — la OC ya cruzó como salida en banco.
      bridge.paidPurchaseOrderKeys.add(key.slice(OC_PREFIX.length));
    }
  }

  // CXP pagada: su factura aparece como egreso confirmado en el libro mayor.
  for (const cxp of cxpRecords) {
    if (confirmedEgresoFacturas.has(`${cxp.cia}::${cxp.noFactura}`)) {
      bridge.paidCxpKeys.add(`${cxp.cia}::${cxp.noFactura}::${cxp.noProveedor}`);
    }
  }

  // Cobranza indexada por factura para recuperar cliente (AuxiliarContable
  // no trae número de cliente).
  const cobranzaByFactura = new Map<string, CobranzaRecord>();
  for (const r of cobranzaRecords) {
    cobranzaByFactura.set(`${r.cia}::${r.noFactura}`, r);
  }

  // Enriquecimiento por línea GL emparejada con un movimiento bancario.
  // Las líneas `interno` pueden traer bankMovementKey (pata GL de un traspaso
  // emparejada para auditoría) pero NO son flujo económico: su movimiento
  // bancario se descarta como interno en MOTOR 1, así que no se enriquece.
  for (const line of result.lines) {
    if (!line.bankMovementKey || line.matchTier === 'interno') continue;
    const monto = Math.abs(line.importe);
    if (line.flujo === 'egreso') {
      bridge.cargoEnrichments.set(line.bankMovementKey, {
        status: 'MATCHED',
        payments: [{
          nombreProveedor: line.source.contraparte || line.nombreCuenta || 'Proveedor',
          importe: monto,
        }],
      });
    } else if (line.source.kind === 'factura') {
      const cob = cobranzaByFactura.get(`${line.cia}::${line.source.ref}`);
      bridge.abonoEnrichments.push({
        movementKey: line.bankMovementKey,
        status: 'factura-cobrada',
        facturas: [{
          cia: line.cia,
          noFactura: line.source.ref,
          noCliente: cob ? String(cob.noCliente) : '',
          nombreCliente: cob?.nombreCliente || line.source.contraparte || '',
          importeBruto: monto,
        }],
      });
    }
  }

  return bridge;
}
