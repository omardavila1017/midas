import type { CobranzaPayment, CobranzaRecord } from '../services/jdeTypes';
import { receiptOverlayKey } from './cobranzaReceiptsOverlay';

/**
 * Segmento / tipo de servicio de cobranza (B2.3).
 *
 * `CobranzaRecord.tipoServicio` se mapea de forma tolerante desde el API y
 * puede venir vacío; aquí lo colapsamos a una etiqueta de segmento estable,
 * agrupando lo no clasificado bajo `SEGMENT_UNCLASSIFIED`. Todo es display-only
 * — no toca el motor de proyección ni de conciliación.
 *
 * DE DÓNDE SALE EL DATO (2026-09-07)
 * ----------------------------------
 * `jde.Cobranza_Citi` —la fuente de `/cobranza`— **no tiene** columna
 * `Tipo_Servicio`, así que `record.tipoServicio` viene vacío SIEMPRE y el
 * filtro "Segmento" (que sólo se pinta con ≥1 segmento clasificado) nunca
 * aparecía: el mecanismo estaba completo y muerto. La columna sí existe, y al
 * 100%, en `jde.Cobranza_Indicadores` — que Midas ya baja y ya mapea a
 * `CobranzaPayment.tipoServicio` (6 valores distintos medidos).
 *
 * Por eso el segmento admite un OVERLAY `factura → segmento` derivado de los
 * recibos (`buildSegmentByFactura`). **Semántica explícita:** es el segmento
 * del COBRO que liquidó (total o parcialmente) esa factura, atribuido a la
 * factura. Una factura sin recibo sigue en `Sin clasificar` — nunca se inventa.
 * El campo propio del registro MANDA cuando existe: si el backend algún día
 * publica `Tipo_Servicio` en `/cobranza`, ese dato gana sin tocar código.
 */
export const SEGMENT_UNCLASSIFIED = 'Sin clasificar';

/**
 * `cia::folio` → tipo de servicio del recibo que cobró esa factura.
 *
 * Llave con `receiptOverlayKey` (folio normalizado con la `normFactura`
 * canónica): los dos endpoints difieren de formato — Indicadores manda
 * `"RI - 92238"` y `/cobranza` manda `"RI-310071"`. Gana la PRIMERA aplicación
 * con segmento que se ve para el folio (determinista sobre la lista de entrada;
 * un folio cobrado por varios recibos del mismo cliente trae el mismo servicio).
 */
export function buildSegmentByFactura(
  payments: CobranzaPayment[] | undefined,
): Map<string, string> {
  const byFactura = new Map<string, string>();
  for (const payment of payments ?? []) {
    const segmento = (payment.tipoServicio ?? '').replace(/\s+/g, ' ').trim();
    if (!segmento) continue;
    for (const application of payment.applications ?? []) {
      const key = receiptOverlayKey(application.cia || payment.cia, application.noFactura);
      if (!key || byFactura.has(key)) continue;
      byFactura.set(key, segmento);
    }
  }
  return byFactura;
}

/**
 * Etiqueta de segmento de una factura; `Sin clasificar` cuando no hay dato.
 * El `overlay` (segmento del recibo) sólo se consulta si el registro no trae
 * el suyo — el dato propio de la factura siempre manda.
 */
export function segmentOf(r: CobranzaRecord, overlay?: Map<string, string>): string {
  const raw = (r.tipoServicio ?? '').replace(/\s+/g, ' ').trim();
  if (raw) return raw;
  if (overlay && overlay.size > 0) {
    const fromReceipt = overlay.get(receiptOverlayKey(r.cia, r.noFactura));
    if (fromReceipt) return fromReceipt;
  }
  return SEGMENT_UNCLASSIFIED;
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
export function listSegments(records: CobranzaRecord[], overlay?: Map<string, string>): string[] {
  const seen = new Map<string, string>(); // key (upper) → label (first seen)
  for (const r of records) {
    const label = segmentOf(r, overlay);
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
export function buildSegmentBreakdown(
  records: CobranzaRecord[],
  overlay?: Map<string, string>,
): SegmentTotal[] {
  const byKey = new Map<string, SegmentTotal>();
  for (const r of records) {
    const label = segmentOf(r, overlay);
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
