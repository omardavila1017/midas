import type { CobranzaRecord } from '../services/jdeTypes';

/**
 * Segmento / tipo de servicio de cobranza (B2.3).
 *
 * `CobranzaRecord.tipoServicio` se mapea de forma tolerante desde el API y
 * puede venir vacío; aquí lo colapsamos a una etiqueta de segmento estable,
 * agrupando lo no clasificado bajo `SEGMENT_UNCLASSIFIED`. Todo es display-only
 * — no toca el motor de proyección ni de conciliación.
 */
export const SEGMENT_UNCLASSIFIED = 'Sin clasificar';

/** Etiqueta de segmento de una factura; `Sin clasificar` cuando no hay dato. */
export function segmentOf(r: CobranzaRecord): string {
  const raw = (r.tipoServicio ?? '').replace(/\s+/g, ' ').trim();
  return raw || SEGMENT_UNCLASSIFIED;
}

export interface SegmentTotal {
  /** Etiqueta mostrada (primer casing visto para el segmento). */
  segment: string;
  invoiceCount: number;
  /** Σ importe bruto en pesos. */
  bruto: number;
  /** Σ importe pendiente en pesos. */
  pendiente: number;
}

/**
 * Lista de segmentos presentes, ordenada: los clasificados por bruto desc,
 * con "Sin clasificar" siempre al final. Útil para poblar el filtro.
 */
export function listSegments(records: CobranzaRecord[]): string[] {
  const seen = new Map<string, string>(); // key (upper) → label (first seen)
  for (const r of records) {
    const label = segmentOf(r);
    const key = label.toUpperCase();
    if (!seen.has(key)) seen.set(key, label);
  }
  return orderSegments(Array.from(seen.values()));
}

/**
 * Desglose por segmento: cuenta + bruto + pendiente por segmento, ordenado
 * (clasificados por bruto desc, "Sin clasificar" al final). Agrupa por el
 * segmento en mayúsculas para no fragmentar por casing, mostrando el primer
 * casing visto.
 */
export function buildSegmentBreakdown(records: CobranzaRecord[]): SegmentTotal[] {
  const byKey = new Map<string, SegmentTotal>();
  for (const r of records) {
    const label = segmentOf(r);
    const key = label.toUpperCase();
    let row = byKey.get(key);
    if (!row) {
      row = { segment: label, invoiceCount: 0, bruto: 0, pendiente: 0 };
      byKey.set(key, row);
    }
    row.invoiceCount += 1;
    row.bruto += Number.isFinite(r.importeBrutoPesos) ? r.importeBrutoPesos : 0;
    row.pendiente += Number.isFinite(r.importePendientePesos) ? r.importePendientePesos : 0;
  }
  const rows = Array.from(byKey.values());
  rows.sort((a, b) => {
    const aUn = a.segment === SEGMENT_UNCLASSIFIED;
    const bUn = b.segment === SEGMENT_UNCLASSIFIED;
    if (aUn !== bUn) return aUn ? 1 : -1; // "Sin clasificar" al final
    return b.bruto - a.bruto;
  });
  return rows;
}

function orderSegments(labels: string[]): string[] {
  return labels.sort((a, b) => {
    const aUn = a === SEGMENT_UNCLASSIFIED;
    const bUn = b === SEGMENT_UNCLASSIFIED;
    if (aUn !== bUn) return aUn ? 1 : -1;
    return a.localeCompare(b, 'es');
  });
}
