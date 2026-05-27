/**
 * Cruce Viajes Especiales ↔ Cobranza.
 *
 * Mismo patrón que `rolCobranzaMatch.ts`: un viaje especial puede estar
 * facturado (Factura_JDE / UUID poblados → cruzar contra cobranza JDE) o
 * sin facturar todavía. El API de Viajes Especiales devuelve siempre el
 * folio de factura cuando ya se emitió.
 *
 *   Viaje especial ejecutado  →  Factura emitida  →  Cobro recibido
 *   (Viajes Especiales API)      (Cobranza JDE)       (Banco ABONO)
 *
 * Estados resultantes:
 *   - matched:         viaje con factura empatada en cobranza. Usar fecha
 *                      de vencimiento real de la factura.
 *   - unmatched:       viaje con factura pero cobranza no la tiene aún
 *                      (sync no llegó o cliente fuera de cobranza JDE).
 *                      Proyectar usando Fecha_Factura + Dias_Credito del API.
 *   - withoutInvoice:  no debería pasar (el sample siempre trae factura);
 *                      si pasa, proyectar igual con fecha de viaje + Dias_Credito.
 *
 * El "cxc:especial:" en canonicalProjection emite movimiento solo si el
 * viaje NO está cruzado con cobranza — para no duplicar el ingreso (cobranza
 * ya emite `cxc:` por su lado).
 */

import type { CobranzaRecord, ViajeEspecialRecord } from '../services/jdeTypes';

export type ViajeEspecialMatchSource = 'factura' | 'uuid';

export interface ViajeEspecialCobranzaMatch {
  viaje: ViajeEspecialRecord;
  cobranza: CobranzaRecord;
  source: ViajeEspecialMatchSource;
}

export interface ViajeEspecialCobranzaCrossResult {
  /** Viaje con factura empatada en cobranza JDE. Cobranza manda en proyección. */
  matched: ViajeEspecialCobranzaMatch[];
  /** Viaje facturado pero cobranza no tiene la factura. Proyectar con API. */
  unmatched: ViajeEspecialRecord[];
  /** Viaje sin Factura_JDE ni UUID. Edge case; proyectar con fecha viaje + crédito. */
  withoutInvoice: ViajeEspecialRecord[];
}

function trim(v: string | undefined): string {
  return (v ?? '').trim();
}

function normFactura(v: string | undefined): string {
  const t = trim(v).toUpperCase();
  if (t === '-' || t === '0' || t === 'N/A' || t === 'NA') return '';
  return t;
}

function normUuid(v: string | undefined): string {
  const t = trim(v).toUpperCase();
  if (t === '-' || t === '0' || t === 'N/A' || t === 'NA') return '';
  return t;
}

export function buildViajesEspecialesCobranzaCross(
  viajes: ViajeEspecialRecord[],
  cobranzaRecords: CobranzaRecord[],
): ViajeEspecialCobranzaCrossResult {
  const byFactura = new Map<string, CobranzaRecord>();
  const byUuid = new Map<string, CobranzaRecord>();
  for (const c of cobranzaRecords) {
    const f = normFactura(c.noFactura);
    if (f) byFactura.set(f, c);
    const u = normUuid(c.uuidFiscal);
    if (u) byUuid.set(u, c);
  }

  const matched: ViajeEspecialCobranzaMatch[] = [];
  const unmatched: ViajeEspecialRecord[] = [];
  const withoutInvoice: ViajeEspecialRecord[] = [];

  for (const v of viajes) {
    const f = normFactura(v.facturaJDE);
    const u = normUuid(v.uuidFiscal);

    if (!f && !u) {
      withoutInvoice.push(v);
      continue;
    }

    if (f) {
      const hit = byFactura.get(f);
      if (hit) {
        matched.push({ viaje: v, cobranza: hit, source: 'factura' });
        continue;
      }
    }
    if (u) {
      const hit = byUuid.get(u);
      if (hit) {
        matched.push({ viaje: v, cobranza: hit, source: 'uuid' });
        continue;
      }
    }
    unmatched.push(v);
  }

  return { matched, unmatched, withoutInvoice };
}

/**
 * Set de `${cia}::${noFactura}` para que `canonicalProjection` sepa qué
 * facturas del cxc: son en realidad viajes especiales — y las re-etiquete
 * con subcategory='Viajes Especiales' (en vez de 'Clientes Citi').
 */
export function buildViajesEspecialesFacturaKeys(
  viajes: ViajeEspecialRecord[],
): Set<string> {
  const keys = new Set<string>();
  for (const v of viajes) {
    const factura = normFactura(v.facturaJDE);
    if (!factura) continue;
    keys.add(`${v.cia}::${factura}`);
  }
  return keys;
}

/**
 * Resumen por cliente — para dashboards y debug.
 */
export interface ViajeEspecialCrossSummaryByClient {
  claveJDE: string;
  dCliente: string;
  matchedTrips: number;
  matchedAmount: number;
  unmatchedTrips: number;
  unmatchedAmount: number;
  withoutInvoiceTrips: number;
  withoutInvoiceAmount: number;
}

export function summarizeViajesEspecialesByClient(
  result: ViajeEspecialCobranzaCrossResult,
): ViajeEspecialCrossSummaryByClient[] {
  const byClient = new Map<string, ViajeEspecialCrossSummaryByClient>();
  const ensure = (claveJDE: string, dCliente: string): ViajeEspecialCrossSummaryByClient => {
    let entry = byClient.get(claveJDE);
    if (!entry) {
      entry = {
        claveJDE, dCliente,
        matchedTrips: 0, matchedAmount: 0,
        unmatchedTrips: 0, unmatchedAmount: 0,
        withoutInvoiceTrips: 0, withoutInvoiceAmount: 0,
      };
      byClient.set(claveJDE, entry);
    }
    return entry;
  };
  for (const m of result.matched) {
    const e = ensure(m.viaje.claveJDE, m.viaje.dCliente);
    e.matchedTrips += 1;
    e.matchedAmount += m.viaje.totalNegociado;
  }
  for (const v of result.unmatched) {
    const e = ensure(v.claveJDE, v.dCliente);
    e.unmatchedTrips += 1;
    e.unmatchedAmount += v.totalNegociado;
  }
  for (const v of result.withoutInvoice) {
    const e = ensure(v.claveJDE, v.dCliente);
    e.withoutInvoiceTrips += 1;
    e.withoutInvoiceAmount += v.totalNegociado;
  }
  return Array.from(byClient.values()).sort((a, b) =>
    (b.matchedAmount + b.unmatchedAmount + b.withoutInvoiceAmount)
    - (a.matchedAmount + a.unmatchedAmount + a.withoutInvoiceAmount)
  );
}
