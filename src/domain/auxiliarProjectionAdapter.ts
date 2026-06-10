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
  payments?: Array<{ claveProveedor?: string; nombreProveedor: string; importe: number }>;
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
