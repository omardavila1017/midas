import type { ProjectionGranularity } from '../../../shared-finance/types';

export const ROW_HEIGHT = 34;
export const HEADER_HEIGHT = 32;
export const GROUP_HEADER_HEIGHT = 28;
export const ADD_ROW_HEIGHT = 32;
export const FOOTER_ROW_HEIGHT = 36;

export const GROUP_COL_WIDTH = 0;
export const LABEL_COL_WIDTH = 340;

export function colWidthForGranularity(granularity: ProjectionGranularity): number {
  if (granularity === 'daily') return 64;
  if (granularity === 'weekly') return 92;
  return 116;
}

export function parseNumericInput(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[, ]+/g, '');
  if (!cleaned) return null;
  const lastChar = cleaned[cleaned.length - 1];
  let multiplier = 1;
  let body = cleaned;
  if (lastChar === 'k') {
    multiplier = 1_000;
    body = cleaned.slice(0, -1);
  } else if (lastChar === 'm') {
    multiplier = 1_000_000;
    body = cleaned.slice(0, -1);
  } else if (lastChar === 'b') {
    multiplier = 1_000_000_000;
    body = cleaned.slice(0, -1);
  }
  const numeric = Number(body);
  if (!Number.isFinite(numeric)) return null;
  return numeric * multiplier;
}

export function isPastBucket(bucketKey: string, asOfDate: string): boolean {
  return bucketKey < asOfDate.slice(0, 10);
}

/**
 * Ventana de virtualización con aritmética exacta (tamaño de item uniforme).
 *
 * Invariante: `leadPx + (end - start) * itemSize + trailPx === count * itemSize`
 * para CUALQUIER `scrollOffset`, incluidos los que quedaron más allá del final
 * de la sección. `start` y `end` se acotan SIEMPRE a [0, count]: sin el clamp
 * superior de `start`, scrollear pasada una sección (lo normal con un bucket
 * gigante de Egresos expandido, o un flip de granularidad con scroll a la
 * derecha) producía `start > count` → el spacer inicial (`leadPx = start ×
 * itemSize`) inflaba la sección MÁS ALLÁ de su contenido real y crecía al
 * mismo ritmo que el scroll. Resultado: el fondo del grid era inalcanzable
 * (la barra "huía"), y al colapsar el bucket / cambiar granularidad el
 * viewport quedaba en blanco sin auto-recuperarse, porque el spacer impedía
 * que el navegador re-acotara scrollTop/scrollLeft.
 */
export interface VirtualWindow {
  /** Primer índice a renderizar (inclusive). */
  start: number;
  /** Índice final (exclusive). */
  end: number;
  /** Alto/ancho del spacer previo en px. */
  leadPx: number;
  /** Alto/ancho del spacer posterior en px. */
  trailPx: number;
}

export function computeVirtualWindow(args: {
  count: number;
  itemSize: number;
  /** scrollTop / scrollLeft del contenedor. */
  scrollOffset: number;
  /** clientHeight / clientWidth del contenedor. */
  viewportSize: number;
  /** Offset del primer item respecto al origen del scroll (offsetTop de la
   * sección, o el ancho de la columna sticky de labels). */
  originOffset?: number;
  overscan?: number;
  /** false (jsdom / primer paint sin medir) → render completo. */
  measured?: boolean;
}): VirtualWindow {
  const { count, itemSize, scrollOffset, viewportSize, originOffset = 0, overscan = 0, measured = true } = args;
  if (!measured || count <= 0 || itemSize <= 0) {
    return { start: 0, end: Math.max(0, count), leadPx: 0, trailPx: 0 };
  }
  const relative = scrollOffset - originOffset;
  const start = Math.min(count, Math.max(0, Math.floor(relative / itemSize) - overscan));
  const end = Math.max(start, Math.min(count, Math.ceil((relative + viewportSize) / itemSize) + overscan));
  return { start, end, leadPx: start * itemSize, trailPx: (count - end) * itemSize };
}

export interface BucketColumn {
  key: string;
  label: string;
  isPast: boolean;
  isCurrent: boolean;
}
