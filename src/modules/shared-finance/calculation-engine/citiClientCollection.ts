/**
 * Selección canónica de la cobranza Citi por (cía, mes) y cliente.
 *
 * FUENTE ÚNICA de dos consumidores que TIENEN que coincidir:
 *
 *   1. `prorateCitiConcentradoraByClient` (canonicalProjection.ts) — usa el
 *      importe por cliente como PESO para atribuir el depósito real de la
 *      concentradora.
 *   2. El drilldown de un movimiento `citi-prorrateo:` en la UI — lista las
 *      facturas que respaldan la cifra que el motor atribuyó.
 *
 * Si cada lado seleccionara la cobranza por su cuenta, el panel podría listar
 * un set de facturas distinto al que produjo el número (deriva silenciosa: sin
 * error, sin test rojo, y el usuario auditando contra un desglose que no
 * corresponde). Por eso la selección vive aquí y la llave de cliente sale del
 * MISMO `clientDisplayCounterparty` que el motor usa para `counterpartyId` —
 * es lo que permite al panel encontrar su entrada por ese id.
 *
 * NO decide montos ni fechas: sólo selecciona y agrupa. El reparto (pasos A/B/C
 * y el descuento de lo ya atribuido) sigue siendo del motor.
 */
import type { Client } from '../../../domain/types';
import type { CobranzaRecord } from '../../../services/jdeTypes';
import { buildClientLookup, findClientForCobranza } from '../../../domain/collectionCalendarEngine';
import { isInternalCounterparty } from '../../../domain/netCashFlowEngine';
import { isPersonName } from '../../../domain/personNameHeuristic';
import { VIAJES_ESPECIALES_GROUP_ID } from '../../../domain/viajesEspecialesCatalog';
import { normalizeCia } from '../../../domain/cia';
import { cleanDate, clientDisplayCounterparty } from './canonicalProjectionShared';

/** Factura que respalda el importe de un cliente en el periodo. */
export interface CitiCollectionInvoice {
  noFactura: string;
  fechaFactura: string;
  fechaCobro: string;
  noRecibo?: string;
  importeBrutoPesos: number;
}

/**
 * Cobranza de un cliente en un (cía, mes). `amount` arranca como Σ de
 * `invoices` — el motor la MUTA al descontar lo ya atribuido por cruce
 * directo, así que después de esa resta ya no son iguales (y eso es correcto:
 * la parte cruzada se atribuyó por su propio ABONO). Cada llamada devuelve
 * objetos nuevos, así que un consumidor no ve las mutaciones del otro.
 */
export interface CitiClientCollection {
  clientId: string;
  name: string;
  amount: number;
  invoices: CitiCollectionInvoice[];
}

/** Llave del join (cía, mes). La cía SIEMPRE normalizada a 5 dígitos. */
export function citiCollectionGroupKey(cia: string | undefined, yearMonth: string): string {
  return `${normalizeCia(cia ?? '')}::${yearMonth}`;
}

export type CitiClientResolver = (record: CobranzaRecord) => { id: string; name: string } | null;

/**
 * Resolutor cliente→llave de display. Encapsula las tres exclusiones del
 * criterio Citi (intercompañía, Viajes Especiales, nombre de persona) para que
 * motor y UI descarten exactamente lo mismo.
 */
export function createCitiClientResolver(clients: Client[]): CitiClientResolver {
  const lookup = buildClientLookup(clients);
  return (record) => {
    if (isInternalCounterparty(record.rfc, record.nombreCliente)) return null;
    const match = findClientForCobranza(record, lookup);
    // Viajes Especiales no son clientes comerciales Citi — fuera del peso.
    if (match?.client.commercialGroupId === VIAJES_ESPECIALES_GROUP_ID) return null;
    const display = match
      ? clientDisplayCounterparty(match.client)
      : { id: record.noCliente, name: record.nombreCliente || 'Cliente sin nombre' };
    if (!display.id) return null;
    const name = display.name ?? 'Cliente';
    if (isPersonName(name)) return null;
    return { id: display.id, name };
  };
}

/**
 * Un solo pase sobre `records`, agrupando por (cía, mes) → cliente. `wantsGroup`
 * acota a los periodos de interés: el motor pasa `groups.has` (decenas de
 * meses), la UI pasa la igualdad contra un solo mes. Se mantiene el pase único
 * a propósito — esto corre en el recómputo del motor con ~23k facturas.
 */
export function selectCitiCollectionByClient(args: {
  records: CobranzaRecord[];
  wantsGroup: (groupKey: string) => boolean;
  resolveClient: CitiClientResolver;
}): Map<string, Map<string, CitiClientCollection>> {
  const byGroup = new Map<string, Map<string, CitiClientCollection>>();
  for (const record of args.records) {
    const cobroDate = cleanDate(record.fechaCobro);
    if (!cobroDate) continue;
    const key = citiCollectionGroupKey(record.cia, cobroDate.slice(0, 7));
    if (!args.wantsGroup(key)) continue;
    const amount = Math.abs(record.importeBrutoPesos);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const client = args.resolveClient(record);
    if (!client) continue;

    let byClient = byGroup.get(key);
    if (!byClient) { byClient = new Map(); byGroup.set(key, byClient); }
    const invoice: CitiCollectionInvoice = {
      noFactura: record.noFactura,
      fechaFactura: record.fechaFactura,
      fechaCobro: cobroDate,
      noRecibo: record.noReciboSePagoFactura?.trim() || undefined,
      importeBrutoPesos: amount,
    };
    const existing = byClient.get(client.id);
    if (existing) {
      existing.amount += amount;
      existing.invoices.push(invoice);
    } else {
      byClient.set(client.id, {
        clientId: client.id,
        name: client.name,
        amount,
        invoices: [invoice],
      });
    }
  }
  return byGroup;
}

/**
 * Respaldo de UNA celda: las facturas del cliente en ese (cía, mes) + el factor
 * que el motor aplicó.
 *
 * `factor = importe atribuido / Σ facturas`. Vale 1 cuando el depósito se
 * acreditó completo (coincidencia exacta o remanente cubierto) y < 1 por DOS
 * causas distintas: el reparto proporcional, o que el motor haya descontado del
 * peso lo que ya se atribuyó a ese cliente por su propio depósito identificado
 * (ese caso NO es dilución: la parte faltante ya está en otro movimiento de la
 * MISMA celda, porque el `bank:` cruzado cae en la fila del mismo cliente).
 * Publicarlo es lo que evita que el desglose MIENTA: sin él, unas facturas que
 * no suman el total del renglón se leen como error de captura.
 *
 * `invoices` es SIEMPRE el set completo del cliente en el periodo — se lee de
 * los records, no del peso ya mutado por el motor. Eso es deliberado: es lo que
 * el usuario pidió auditar ("ese monto total respaldado en facturas").
 */
export interface CitiCellBreakdown {
  invoices: CitiCollectionInvoice[];
  invoicedTotal: number;
  attributedAmount: number;
  factor: number;
}

export function buildCitiCellBreakdown(args: {
  records: CobranzaRecord[];
  clients: Client[];
  cia: string | undefined;
  yearMonth: string;
  clientId: string;
  attributedAmount: number;
}): CitiCellBreakdown | null {
  const key = citiCollectionGroupKey(args.cia, args.yearMonth);
  const byGroup = selectCitiCollectionByClient({
    records: args.records,
    wantsGroup: (candidate) => candidate === key,
    resolveClient: createCitiClientResolver(args.clients),
  });
  const entry = byGroup.get(key)?.get(args.clientId);
  if (!entry || entry.invoices.length === 0) return null;
  const invoicedTotal = entry.amount;
  return {
    invoices: [...entry.invoices].sort((a, b) => a.fechaCobro.localeCompare(b.fechaCobro)
      || a.noFactura.localeCompare(b.noFactura)),
    invoicedTotal,
    attributedAmount: args.attributedAmount,
    factor: invoicedTotal > 0 ? args.attributedAmount / invoicedTotal : 0,
  };
}
