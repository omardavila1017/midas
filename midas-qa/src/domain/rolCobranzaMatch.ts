/**
 * Cruce ROL ↔ Cobranza.
 *
 * El ROL diario CITI (viajes ejecutados) y la cobranza JDE (facturas
 * emitidas) son dos vistas del mismo ingreso en momentos distintos del ciclo:
 *
 *   Viaje ejecutado  →  Factura emitida  →  Cobro recibido
 *   (ROL)               (Cobranza)          (Banco ABONO)
 *
 * Cuando el ROL trae `factura` o `uuidFiscal` poblados, podemos amarrar
 * directamente el viaje a la factura correspondiente en cobranza. Esto
 * permite distinguir 3 estados de ingreso:
 *
 *   - Predicho:  ROL ejecutado sin factura match en cobranza → predecir
 *                ingreso a partir de tripDate + creditDays + diaPago.
 *   - Facturado: ROL ejecutado CON factura match en cobranza → usar la
 *                fecha de vencimiento real de la factura.
 *   - Realizado: factura match Y cobranza muestra cobrada (Importe_Pendiente=0)
 *                → consultar también el match banco↔cobranza para fecha real.
 *
 * Este módulo SOLO maneja el primer cruce (ROL ↔ Cobranza); el cruce
 * Cobranza ↔ Banco vive en `realReconciliationEngine.ts`.
 */

import type { CobranzaRecord, RolRecord } from '../services/jdeTypes';

export type RolMatchSource = 'factura' | 'uuid';

export interface RolCobranzaMatch {
  rol: RolRecord;
  cobranza: CobranzaRecord;
  source: RolMatchSource;
}

export interface RolCobranzaCrossResult {
  matches: RolCobranzaMatch[];
  /** Viajes ROL sin factura en cobranza — proyección "predicha". */
  predicted: RolRecord[];
  /** Viajes ROL con factura pero match no encontrado (factura existe en ROL pero no en cobranza). */
  invoicedOrphans: RolRecord[];
}

function trim(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Normaliza la cadena de factura para comparación. JDE devuelve formatos
 * tipo "RI-305405" y el ROL idéntico — comparación case-insensitive con trim.
 */
function normFactura(value: string | undefined): string {
  return trim(value).toUpperCase();
}

/**
 * Normaliza UUID fiscal (SAT). Formato esperado:
 *   "85A17FEE-C11C-4F3A-8EC4-3896F8468AE3"
 * El API a veces lo padding con espacios; trimeamos y upcase.
 */
function normUuid(value: string | undefined): string {
  return trim(value).toUpperCase();
}

/**
 * Construye índices por factura y UUID desde un set de cobranza, y cruza
 * contra ROL. ROL records sin factura emitida quedan en `predicted`; ROL
 * con factura que no aparece en cobranza quedan en `invoicedOrphans`
 * (cobranza no se ha sincronizado todavía o el cliente no existe en CXC).
 */
export function buildRolCobranzaCross(
  rolRecords: RolRecord[],
  cobranzaRecords: CobranzaRecord[],
): RolCobranzaCrossResult {
  const cobranzaByFactura = new Map<string, CobranzaRecord>();
  const cobranzaByUuid = new Map<string, CobranzaRecord>();
  for (const c of cobranzaRecords) {
    const factura = normFactura(c.noFactura);
    if (factura) cobranzaByFactura.set(factura, c);
    const uuid = normUuid(c.uuidFiscal);
    if (uuid) cobranzaByUuid.set(uuid, c);
  }

  const matches: RolCobranzaMatch[] = [];
  const predicted: RolRecord[] = [];
  const invoicedOrphans: RolRecord[] = [];

  for (const r of rolRecords) {
    const factura = normFactura(r.factura);
    const uuid = normUuid(r.uuidFiscal);

    // Sin factura ni uuid → viaje aún no facturado, predicción.
    if (!factura && !uuid) {
      predicted.push(r);
      continue;
    }

    // 1. Match exacto por factura (precision alta).
    if (factura) {
      const hit = cobranzaByFactura.get(factura);
      if (hit) {
        matches.push({ rol: r, cobranza: hit, source: 'factura' });
        continue;
      }
    }
    // 2. Fallback a UUID fiscal (mismo viaje, otra emisión).
    if (uuid) {
      const hit = cobranzaByUuid.get(uuid);
      if (hit) {
        matches.push({ rol: r, cobranza: hit, source: 'uuid' });
        continue;
      }
    }
    // ROL marcado como facturado pero cobranza no lo tiene → huérfano.
    invoicedOrphans.push(r);
  }

  return { matches, predicted, invoicedOrphans };
}

/**
 * Resumen tabular por cliente — útil para dashboards y debug. Devuelve total
 * de viajes y subTotal del ROL en cada estado (predicho/facturado/huérfano).
 */
export interface RolCrossSummaryByClient {
  claveJDE: string;
  dCliente: string;
  predictedTrips: number;
  predictedAmount: number;
  invoicedTrips: number;
  invoicedAmount: number;
  orphanTrips: number;
  orphanAmount: number;
}

export function summarizeRolCrossByClient(result: RolCobranzaCrossResult): RolCrossSummaryByClient[] {
  const byClient = new Map<string, RolCrossSummaryByClient>();
  const ensure = (claveJDE: string, dCliente: string): RolCrossSummaryByClient => {
    let entry = byClient.get(claveJDE);
    if (!entry) {
      entry = {
        claveJDE, dCliente,
        predictedTrips: 0, predictedAmount: 0,
        invoicedTrips: 0, invoicedAmount: 0,
        orphanTrips: 0, orphanAmount: 0,
      };
      byClient.set(claveJDE, entry);
    }
    return entry;
  };
  for (const r of result.predicted) {
    const e = ensure(r.claveJDE, r.dCliente);
    e.predictedTrips += r.viajes;
    e.predictedAmount += r.subTotal;
  }
  for (const m of result.matches) {
    const e = ensure(m.rol.claveJDE, m.rol.dCliente);
    e.invoicedTrips += m.rol.viajes;
    e.invoicedAmount += m.rol.subTotal;
  }
  for (const r of result.invoicedOrphans) {
    const e = ensure(r.claveJDE, r.dCliente);
    e.orphanTrips += r.viajes;
    e.orphanAmount += r.subTotal;
  }
  return Array.from(byClient.values()).sort((a, b) =>
    (b.invoicedAmount + b.predictedAmount) - (a.invoicedAmount + a.predictedAmount)
  );
}
