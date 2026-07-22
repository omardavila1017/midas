/**
 * salesCalendarService — agrega "lo VENDIDO" para el calendario de Venta.
 *
 * Mide cuánto se VENDIÓ, no cuánto se cobró/ingresó. Dos capas que NO se
 * doble-cuentan:
 *   1. Facturado: facturas de cobranza (CXC) fechadas por su `fechaFactura`.
 *      Toda venta termina en factura → es la verdad contable de la venta.
 *   2. Por facturar: viajes YA ejecutados pero AÚN sin factura — ROL CITI
 *      (`efectuado` && sin `factura`) + Viajes Especiales (sin `facturaJDE`).
 *      Se excluye lo ya facturado, así que no se solapa con la capa 1.
 *
 * Importes en venta NETA (sin IVA) para que las tres fuentes sean comparables
 * (ROL/Especiales reportan subtotal sin IVA).
 */

import type { CobranzaRecord, RolRecord, ViajeEspecialRecord } from '../../../services/jde';
import { buildRolCobranzaCross, normFactura } from '../../../domain/rolCobranzaMatch';
import { segmentOf, SEGMENT_UNCLASSIFIED } from '../../../domain/cobranzaSegment';
import { csvDate } from '../../../utils/export';
import { sourceOf, type SourceAttribution, type SourceId } from '../../../domain/sourceAttribution';

export type SaleStatus = 'facturado' | 'por-facturar';
export type SaleSource = 'cobranza' | 'rol' | 'especial';

/** SaleSource → id canónico de fuente del datalake. */
const SALE_SOURCE_ID: Record<SaleSource, SourceId> = {
  cobranza: 'cobranza',
  rol: 'rol',
  especial: 'viajes-especiales',
};

/**
 * Fuente de un renglón de Venta. NO es un cruce: el dedup contra cobranza corre
 * aguas arriba (sólo el bucket `predicted` de ROL y los VE sin factura
 * sobreviven), así que cada renglón es de una sola fuente.
 */
export function saleSourceAttribution(source: SaleSource): SourceAttribution {
  const note =
    source === 'cobranza'
      ? 'Venta ya facturada (factura de cobranza por fecha de factura).'
      : source === 'rol'
        ? 'Viaje ejecutado aún por facturar (ROL sin factura cruzada).'
        : 'Viaje especial aún por facturar (sin factura JDE).';
  return sourceOf(SALE_SOURCE_ID[source], note);
}

export interface SaleEntry {
  /** Fecha de la venta (YYYY-MM-DD): fecha de factura, o de viaje si no facturado. */
  date: string;
  /** Importe de venta SIN IVA, en pesos. */
  amount: number;
  status: SaleStatus;
  cliente: string;
  /** Folio de factura o identificador del viaje. */
  referencia: string;
  cia: string;
  source: SaleSource;
  /**
   * Segmento / tipo de servicio (C.1, sólo capa facturado): `segmentOf` de la
   * factura de cobranza. ROL/Especiales aún no traen el dato → `undefined`.
   */
  segmento?: string;
}

export interface DayTotal {
  date: string;
  facturado: number;
  porFacturar: number;
  total: number;
  count: number;
}

export interface MonthTotal {
  /** "YYYY-MM". */
  ym: string;
  facturado: number;
  porFacturar: number;
  total: number;
  count: number;
}

/** Normaliza a YYYY-MM-DD; acepta fechas con hora ("...T..."). `null` si inválida. */
export function toISODate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 10) return null;
  const candidate = trimmed.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  // Rechaza fechas centinela JDE ("1899-12-31", "0001-01-01").
  const year = Number(candidate.slice(0, 4));
  if (year < 1990 || year > 2100) return null;
  const time = Date.parse(candidate);
  return Number.isFinite(time) ? candidate : null;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Venta NETA (sin IVA) de una factura de cobranza, con fallbacks tolerantes:
 *   1. `subTotal` directo si viene poblado.
 *   2. `importeBrutoPesos - importeIVA` cuando el IVA viene explícito (incluye
 *      el caso exento, IVA=0 → regresa el bruto, que ya es sin IVA).
 *   3. Sin dato de IVA: estima asumiendo 16% (estándar MX) — `bruto / 1.16`.
 * Mantener todo en base sin-IVA para que las tres fuentes sean comparables.
 */
function cobranzaVenta(r: CobranzaRecord): number {
  if (isFinitePositive(r.subTotal)) return r.subTotal;
  const bruto = Number.isFinite(r.importeBrutoPesos) ? r.importeBrutoPesos : 0;
  if (typeof r.importeIVA === 'number' && Number.isFinite(r.importeIVA)) {
    const net = bruto - r.importeIVA;
    return net > 0 ? net : bruto;
  }
  return bruto > 0 ? bruto / 1.16 : 0;
}

export interface SaleSourceInputs {
  cobranza: CobranzaRecord[];
  rol: RolRecord[];
  viajesEspeciales: ViajeEspecialRecord[];
}

/**
 * Construye la lista de ventas (facturado + por facturar) sin doble conteo.
 */
export function buildSaleEntries({ cobranza, rol, viajesEspeciales }: SaleSourceInputs): SaleEntry[] {
  const entries: SaleEntry[] = [];

  // 1. Facturado — cada factura de cobranza es una venta, fechada por fechaFactura.
  for (const r of cobranza) {
    const date = toISODate(r.fechaFactura);
    if (!date) continue;
    const amount = cobranzaVenta(r);
    if (!(amount > 0)) continue;
    entries.push({
      date,
      amount,
      status: 'facturado',
      cliente: cleanString(r.nombreClientePadre) || cleanString(r.nombreCliente) || cleanString(r.noCliente),
      referencia: cleanString(r.noFactura),
      cia: cleanString(r.cia),
      source: 'cobranza',
      segmento: segmentOf(r),
    });
  }

  // 2a. Por facturar — ROL: viaje ejecutado que AÚN no se factura.
  //
  // El "aún no facturado" NO puede leerse solo del campo `r.factura`: un viaje
  // ya facturado en cobranza puede llegar de ROL con `factura` vacío (o con un
  // placeholder "-"/"0"/"N/A"), lo que lo contaría DOBLE — una vez aquí como
  // "por facturar" y otra en la capa 1 (facturado) vía su factura de cobranza.
  // Reusamos el cruce canónico ROL↔cobranza (`buildRolCobranzaCross`, misma
  // verdad que la pestaña Cobranza): su bucket `predicted` es exactamente el
  // conjunto de viajes SIN factura en cobranza (predicho→por facturar); los
  // `matches` (ya facturados) y `invoicedOrphans` (traen folio) se excluyen,
  // matando el doble conteo. Un viaje predicho que después se factura salta de
  // `predicted` a `matches`, así que su venta migra sola de "por facturar" a
  // "facturado" sin re-contarse.
  const rolCross = buildRolCobranzaCross(rol, cobranza);
  for (const r of rolCross.predicted) {
    if (!r.efectuado) continue;
    const date = toISODate(r.fechaViaje);
    if (!date) continue;
    if (!isFinitePositive(r.subTotal)) continue;
    entries.push({
      date,
      amount: r.subTotal,
      status: 'por-facturar',
      cliente: cleanString(r.dCliente) || cleanString(r.cCliente) || cleanString(r.claveJDE),
      referencia: cleanString(r.ruta),
      cia: cleanString(r.cia),
      source: 'rol',
    });
  }

  // 2b. Por facturar — Viajes Especiales sin factura. `normFactura` (canónico)
  // trata los placeholders JDE ("-"/"0"/"N/A") como SIN factura, así que un
  // viaje genuinamente no facturado ya no se cae por un folio placeholder.
  for (const v of viajesEspeciales) {
    if (normFactura(v.facturaJDE)) continue; // ya facturado → vive en cobranza
    const date = toISODate(v.fSalidaPrimera) ?? toISODate(v.fRegresoUltima);
    if (!date) continue;
    if (!isFinitePositive(v.totalNegociado)) continue;
    entries.push({
      date,
      amount: v.totalNegociado,
      status: 'por-facturar',
      cliente: cleanString(v.dCliente) || cleanString(v.claveJDE),
      referencia: `Viaje ${v.kRenta}`,
      cia: cleanString(v.cia),
      source: 'especial',
    });
  }

  return entries;
}

function emptyDay(date: string): DayTotal {
  return { date, facturado: 0, porFacturar: 0, total: 0, count: 0 };
}

function addToDay(day: DayTotal, entry: SaleEntry): void {
  if (entry.status === 'facturado') day.facturado += entry.amount;
  else day.porFacturar += entry.amount;
  day.total += entry.amount;
  day.count += 1;
}

/** Suma por día (YYYY-MM-DD). */
export function aggregateByDay(entries: SaleEntry[]): Map<string, DayTotal> {
  const map = new Map<string, DayTotal>();
  for (const entry of entries) {
    let day = map.get(entry.date);
    if (!day) {
      day = emptyDay(entry.date);
      map.set(entry.date, day);
    }
    addToDay(day, entry);
  }
  return map;
}

/** Suma por mes (YYYY-MM). */
export function aggregateByMonth(entries: SaleEntry[]): Map<string, MonthTotal> {
  const map = new Map<string, MonthTotal>();
  for (const entry of entries) {
    const ym = entry.date.slice(0, 7);
    let month = map.get(ym);
    if (!month) {
      month = { ym, facturado: 0, porFacturar: 0, total: 0, count: 0 };
      map.set(ym, month);
    }
    if (entry.status === 'facturado') month.facturado += entry.amount;
    else month.porFacturar += entry.amount;
    month.total += entry.amount;
    month.count += 1;
  }
  return map;
}

/** Entradas de un mes (YYYY-MM), ordenadas por fecha asc. */
export function entriesForMonth(entries: SaleEntry[], ym: string): SaleEntry[] {
  return entries
    .filter((e) => e.date.slice(0, 7) === ym)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));
}

export interface CompanyTotal {
  cia: string;
  facturado: number;
  porFacturar: number;
  total: number;
  count: number;
}

/**
 * Bucket del desglose por segmento para lo aún no facturado: los viajes
 * ROL/Especiales no traen tipo de servicio hasta que se facturan.
 */
export const SEGMENT_POR_FACTURAR = 'Por facturar (sin segmento)';

export interface SegmentVentaTotal {
  segment: string;
  facturado: number;
  porFacturar: number;
  total: number;
  count: number;
}

/**
 * Segmentos presentes en la capa facturado (distintos), clasificados en orden
 * alfabético con "Sin clasificar" al final. Para poblar el filtro; vacío de
 * clasificados ⇒ el API aún no manda el dato y el filtro no se pinta.
 */
export function listVentaSegments(entries: SaleEntry[]): string[] {
  const seen = new Map<string, string>();
  for (const e of entries) {
    if (!e.segmento) continue;
    const key = e.segmento.toUpperCase();
    if (!seen.has(key)) seen.set(key, e.segmento);
  }
  return Array.from(seen.values()).sort((a, b) => {
    const aUn = a === SEGMENT_UNCLASSIFIED;
    const bUn = b === SEGMENT_UNCLASSIFIED;
    if (aUn !== bUn) return aUn ? 1 : -1;
    return a.localeCompare(b, 'es');
  });
}

/**
 * Filtra por segmento. `null` ⇒ sin filtro. Un segmento específico sólo puede
 * empatar la capa FACTURADO (los por-facturar no traen segmento y se caen) —
 * la UI lo advierte cuando el filtro está activo.
 */
export function filterEntriesBySegment(entries: SaleEntry[], segment: string | null): SaleEntry[] {
  if (!segment) return entries;
  return entries.filter((e) => e.segmento === segment);
}

/**
 * Desglose por segmento: clasificados por total desc, "Sin clasificar" después
 * y el bucket "Por facturar (sin segmento)" siempre al final.
 */
export function aggregateBySegment(entries: SaleEntry[]): SegmentVentaTotal[] {
  const map = new Map<string, SegmentVentaTotal>();
  for (const entry of entries) {
    const segment = entry.segmento ?? SEGMENT_POR_FACTURAR;
    let row = map.get(segment.toUpperCase());
    if (!row) {
      row = { segment, facturado: 0, porFacturar: 0, total: 0, count: 0 };
      map.set(segment.toUpperCase(), row);
    }
    if (entry.status === 'facturado') row.facturado += entry.amount;
    else row.porFacturar += entry.amount;
    row.total += entry.amount;
    row.count += 1;
  }
  const rank = (s: string) => (s === SEGMENT_POR_FACTURAR ? 2 : s === SEGMENT_UNCLASSIFIED ? 1 : 0);
  return Array.from(map.values()).sort((a, b) => rank(a.segment) - rank(b.segment) || b.total - a.total);
}

/** Suma por compañía (cia), ordenada por total desc. */
export function aggregateByCompany(entries: SaleEntry[]): CompanyTotal[] {
  const map = new Map<string, CompanyTotal>();
  for (const entry of entries) {
    const cia = entry.cia || '—';
    let row = map.get(cia);
    if (!row) {
      row = { cia, facturado: 0, porFacturar: 0, total: 0, count: 0 };
      map.set(cia, row);
    }
    if (entry.status === 'facturado') row.facturado += entry.amount;
    else row.porFacturar += entry.amount;
    row.total += entry.amount;
    row.count += 1;
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serializa entradas a CSV (es-MX: encabezados legibles, importe con 2 decimales). */
export function toCsv(entries: SaleEntry[]): string {
  const header = ['Fecha', 'Estatus', 'Cliente', 'Referencia', 'Compañía', 'Fuente', 'Segmento', 'Importe sin IVA'];
  const rows = entries
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((e) =>
      [
        csvDate(e.date),
        e.status === 'facturado' ? 'Facturado' : 'Por facturar',
        e.cliente,
        e.referencia,
        e.cia,
        saleSourceAttribution(e.source).label,
        e.segmento ?? '',
        e.amount.toFixed(2),
      ]
        .map(csvCell)
        .join(','),
    );
  return [header.map(csvCell).join(','), ...rows].join('\n');
}
