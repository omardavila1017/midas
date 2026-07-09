import { isoDaysBefore } from '../services/dailyApiCache';
import type { CobranzaRecord } from '../services/jdeTypes';

/**
 * Planeación pura y testeable de la ventana de refresh de Cobranza (CXC).
 *
 * Contexto (Bloque 2, jul-2026): a diferencia de Compras/Pagos/Bancos —que
 * cachean por día y revalidan los últimos N días con `revalidateSince`—,
 * `/cobranza` es UNA llamada por cía sobre el rango completo (sin cache
 * diario). La frescura se gobierna con un TTL por cía: en el auto-fetch de
 * boot una cía consultada hace < TTL se SALTABA por completo. Consecuencia:
 * facturas que Cobranza da de alta en JDE DESPUÉS del último fetch (caso 6-jul,
 * clientes Headsheet/ABB/Copamex ausentes) no aparecían hasta que expiraba el
 * TTL o el usuario daba refresh manual — el mismo hueco de "registros de días
 * recientes que llegan con atraso" que Pagos/Bancos ya cierran con su ventana
 * de revalidación.
 *
 * Nota de alcance: el salto sólo era observable cuando el heavy-store SOBREVIVE
 * el boot (config `VITE_CACHE_MAX_AGE_MIN > 0` dentro de ventana, o modo
 * snapshot). En el default (`clear-on-entry` en cada ingreso) `cobranzaRecords`
 * arranca vacío → `heavyHydrated=false` → refetch FULL de todas las cías y el
 * TTL nunca aplica. Este planner arregla la config persistente sin tocar el
 * comportamiento del default (ahí todas las cías salen `full`).
 *
 * El planner reemplaza el salto binario "skip vs full" por dos modos:
 *   - 'full'       — refetch del histórico completo (cía nueva/stale, o force,
 *                    o heavy-store vacío). REEMPLAZA los records de la cía y
 *                    RE-ESTAMPA su timestamp.
 *   - 'revalidate' — cía fresca: re-pide SÓLO la ventana reciente
 *                    [today - revalidateDays, today] y hace un merge
 *                    date-particionado (ver `mergeCobranzaRevalidationWindow`).
 *                    Barato (una llamada acotada por cía) y garantiza que las
 *                    altas recientes aparezcan. NO re-estampa el timestamp: el
 *                    watermark del full-load sigue mandando cuándo corre el
 *                    próximo REPLACE completo (que purga cancelaciones/pagos de
 *                    facturas viejas fuera de la ventana → evita "facturas
 *                    fantasma").
 */

/** 2 años de historia — Holt-Winters requiere ≥24 meses (antes inline `- 730`). */
export const COBRANZA_LOOKBACK_DAYS = 730;
/**
 * Días recientes que una cía fresca REVALIDA aunque su TTL siga vigente.
 * Cubre más de un ciclo de facturación mensual + el atraso de captura de
 * Cobranza. Ventana amplia porque el merge date-particionado la reemplaza en
 * bloque y no llavea por folio (barato y sin riesgo de colapsar duplicados).
 */
export const COBRANZA_REVALIDATE_DAYS = 45;
/** TTL de frescura por cía (espejo de `COBRANZA_AUTO_REFRESH_TTL_MS` en AppCore). */
export const COBRANZA_AUTO_REFRESH_TTL_MS = 6 * 60 * 60 * 1000;

export type CobranzaCiaRefreshMode = 'full' | 'revalidate';

export interface CobranzaCiaRefreshPlan {
  cia: string;
  mode: CobranzaCiaRefreshMode;
  /** YYYY-MM-DD inclusive. */
  from: string;
  /** YYYY-MM-DD inclusive (hoy). */
  to: string;
}

export interface PlanCobranzaRefreshInput {
  activeCias: string[];
  /** Refresh manual: todas las cías `full`. */
  force: boolean;
  /**
   * ¿El heavy-store hidrató con records? Si no (`false`), los timestamps light
   * de localStorage no son de fiar (desync guard) → todas las cías `full`.
   */
  heavyHydrated: boolean;
  /** Timestamp ISO por cía del último fetch FULL de `/cobranza`. */
  recordsLoadedCias: Record<string, string | undefined>;
  /** Timestamp ISO por cía del último fetch de `/cobranzaindicadores`. */
  paymentsLoadedCias: Record<string, string | undefined>;
  /** `Date.now()` inyectado por el caller (testeable). */
  nowMs: number;
  ttlMs?: number;
  lookbackDays?: number;
  revalidateDays?: number;
}

/**
 * Espejo `nowMs`-inyectado de `isFreshTimestamp` de AppCore (misma regla, sin
 * `Date.now()` interno para poder testear el planner con reloj fijo).
 */
export function isFreshTimestamp(value: string | undefined, ttlMs: number, nowMs: number): boolean {
  if (!value) return false;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts < ttlMs;
}

function isoDayFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Decide, por cía, si se hace un refetch completo (`full`) o sólo se revalida
 * la ventana reciente (`revalidate`), y con qué rango de fechas. Reproduce
 * exactamente el gate previo (`force || !heavyHydrated || records-stale ||
 * payments-stale`), pero en vez de SALTAR la cía fresca, la manda a
 * `revalidate`.
 */
export function planCobranzaRefresh(input: PlanCobranzaRefreshInput): CobranzaCiaRefreshPlan[] {
  const ttlMs = input.ttlMs ?? COBRANZA_AUTO_REFRESH_TTL_MS;
  const lookbackDays = input.lookbackDays ?? COBRANZA_LOOKBACK_DAYS;
  const revalidateDays = input.revalidateDays ?? COBRANZA_REVALIDATE_DAYS;
  const to = isoDayFromMs(input.nowMs);
  const fullFrom = isoDaysBefore(to, lookbackDays);
  const revalidateFrom = isoDaysBefore(to, revalidateDays);

  return input.activeCias.map((cia): CobranzaCiaRefreshPlan => {
    const freshRecords = isFreshTimestamp(input.recordsLoadedCias[cia], ttlMs, input.nowMs);
    const freshPayments = isFreshTimestamp(input.paymentsLoadedCias[cia], ttlMs, input.nowMs);
    const needsFull = input.force || !input.heavyHydrated || !freshRecords || !freshPayments;
    return needsFull
      ? { cia, mode: 'full', from: fullFrom, to }
      : { cia, mode: 'revalidate', from: revalidateFrom, to };
  });
}

function cobranzaRecordFolioKey(r: CobranzaRecord): string | null {
  const folio = (r.noFactura || '').trim();
  return folio ? `${r.cia}::${folio}` : null;
}

/**
 * Merge date-particionado de la ventana de revalidación sobre los records ya
 * hidratados de UNA cía.
 *
 * Regla: conserva del set previo TODO lo estrictamente anterior a la ventana
 * (por `fechaFactura`) y reemplaza en bloque el rango con el fetch reciente.
 * NO llavea por `noFactura` para partir (así facturas multi-línea o con folio
 * vacío no se colapsan y no se sub-cuenta Venta/CXC), pero SÍ excluye del
 * "conservado" cualquier factura vieja cuyo folio reaparezca en la ventana —
 * eso cubre (a) la actualización de una factura (mismo folio, nuevo importe)
 * y (b) el caso en que el servidor filtre por una fecha distinta de
 * `fechaFactura` y devuelva en la ventana una factura de emisión vieja (evita
 * duplicarla). Lo removido en JDE dentro de la ventana desaparece porque el
 * rango se reemplaza completo; lo removido FUERA de la ventana se sanea en el
 * próximo REPLACE full al expirar el TTL (por eso el planner no re-estampa el
 * timestamp en `revalidate`).
 */
export function mergeCobranzaRevalidationWindow(
  existing: CobranzaRecord[],
  windowRecords: CobranzaRecord[],
  windowFrom: string,
): CobranzaRecord[] {
  const windowFolios = new Set<string>();
  for (const r of windowRecords) {
    const key = cobranzaRecordFolioKey(r);
    if (key) windowFolios.add(key);
  }
  const kept = existing.filter(r => {
    if ((r.fechaFactura || '') >= windowFrom) return false; // dentro de la ventana → lo manda el fetch
    const key = cobranzaRecordFolioKey(r);
    if (key && windowFolios.has(key)) return false;          // supersedida por la ventana (update/boundary)
    return true;
  });
  return [...kept, ...windowRecords];
}
