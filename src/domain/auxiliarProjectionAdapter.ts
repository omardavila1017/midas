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

import type { AuxiliarReconResult } from './auxiliarReconciliationEngine';
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
  /** `bankMovementKey` → enriquecimiento del CARGO. */
  cargoEnrichments: Map<string, BankOutflowEnrichment>;
  /** Enriquecimiento de cada ABONO cruzado a una factura. */
  abonoEnrichments: BankInflowEnrichment[];
}

const FACTURA_PREFIX = 'factura:';

export function emptyAuxiliarProjectionBridge(): AuxiliarProjectionBridge {
  return {
    cobradaBancoKeys: new Set(),
    paidCxpKeys: new Set(),
    cargoEnrichments: new Map(),
    abonoEnrichments: [],
  };
}

export function adaptAuxiliarForProjection(
  result: AuxiliarReconResult | undefined,
  cxpRecords: CXPRecord[],
  cobranzaRecords: CobranzaRecord[],
): AuxiliarProjectionBridge {
  const bridge = emptyAuxiliarProjectionBridge();
  if (!result) return bridge;

  // Documentos confirmados contra banco, separados por dirección de flujo.
  const confirmedEgresoFacturas = new Set<string>();
  for (const [key, conf] of result.sourceConfirmation) {
    if (!conf.confirmed || !key.startsWith(FACTURA_PREFIX)) continue;
    const facturaId = key.slice(FACTURA_PREFIX.length); // `${cia}::${noFactura}`
    if (conf.flujo === 'ingreso') bridge.cobradaBancoKeys.add(facturaId);
    else confirmedEgresoFacturas.add(facturaId);
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
  for (const line of result.lines) {
    if (!line.bankMovementKey) continue;
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
