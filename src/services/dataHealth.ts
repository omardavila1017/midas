/**
 * dataHealth — visibilidad de la convergencia del data lake local.
 *
 * Midas construye un "data lake" POR NAVEGADOR (IDB daily-cache + heavy
 * store). JDE recibe capturas con ATRASO, así que un día/mes cacheado cuando
 * el upstream estaba incompleto quedaba congelado y cada usuario veía una foto
 * distinta del mismo día ("a mí me salen 300 movimientos, a él 330"). La
 * REVALIDACIÓN que cura eso vive en los loaders (AppCore) + los helpers de
 * `dailyApiCache.ts` (`revalidateSince`/`revalidateMonths`). Este módulo NO
 * decide ventanas — solo hace VISIBLE el estado:
 *
 *   1. Registro de huecos de la SESIÓN (`reportDataGap`): los fetchers ya no
 *      se tragan errores en silencio — cada día/mes/chunk/ventana que falló
 *      queda registrado y se muestra en el panel "Salud de datos".
 *   2. Inventario del cache local (`summarizeLocalCache` / `countCachedRecords*`)
 *      para que dos usuarios comparen en segundos dónde divergen sus máquinas.
 *
 * Todo se publica en `window.__midas__.dataHealth` para soporte por consola.
 */

import {
  listDailyCacheKeys,
  getDailyCachedAsync,
  getMonthCachedAsync,
} from './dailyApiCache';

// ── Registro de huecos de la sesión ─────────────────────────────────────

export type DataGapKind =
  | 'day-failed'
  | 'month-failed'
  | 'chunk-failed'
  | 'window-failed'
  | 'cia-failed';

export interface DataGap {
  dataset: string;
  kind: DataGapKind;
  /** Qué falló: día/mes/rango/cía, en texto legible. */
  detail: string;
  /** ISO timestamp del reporte. */
  at: string;
}

const GAP_CAP = 500;
const sessionGaps: DataGap[] = [];

/**
 * Registra un hueco de datos de ESTA sesión (día/mes/chunk que falló su
 * fetch y se está sirviendo incompleto o desde el fallback del cache). Los
 * fetchers lo llaman en vez de tragarse el error en silencio; la UI y el
 * diagnóstico (`window.__midas__.dataHealth.gaps()`) lo leen.
 */
export function reportDataGap(dataset: string, kind: DataGapKind, detail: string): void {
  if (sessionGaps.length >= GAP_CAP) sessionGaps.shift();
  sessionGaps.push({ dataset, kind, detail, at: new Date().toISOString() });
  // eslint-disable-next-line no-console
  console.warn(`[data-health] hueco de datos · ${dataset} · ${kind} · ${detail}`);
}

export function getDataGaps(): DataGap[] {
  return [...sessionGaps];
}

/** Solo para tests. */
export function __resetDataGapsForTests(): void {
  sessionGaps.length = 0;
}

// ── Resync: limpiar markers de saneo para forzar el re-pull amplio ───────

/**
 * Borra los markers de saneo de bancos (one-time empty-day heal). Combinar
 * con `clearAllDailyCache()` + reload para forzar un re-pull completo desde
 * JDE. Lo usa la acción "Resincronizar todo" del panel de Salud de datos.
 */
export function clearDataLakeMarkers(): void {
  for (const key of ['midas.banks.emptyDayHeal.v1', 'midas.banks.emptyDayHeal.v2']) {
    try { localStorage.removeItem(key); } catch { /* acceso falló — el boot revalida igual */ }
  }
}

// ── Diagnóstico comparable entre máquinas ───────────────────────────────

interface ParsedCacheKey {
  api: string;
  cia: string;
  /** YYYY-MM-DD (daily) o YYYY-MM (monthly). */
  bucket: string;
  monthly: boolean;
}

function parseCacheKey(key: string): ParsedCacheKey | null {
  const monthly = key.startsWith('M:');
  const body = monthly ? key.slice(2) : key;
  // El api puede contener puntos ('banks.SWIFT') — partir desde el FINAL:
  // último segmento = fecha, penúltimo = cia, el resto = api.
  const lastDot = body.lastIndexOf('.');
  if (lastDot < 0) return null;
  const bucket = body.slice(lastDot + 1);
  const datePattern = monthly ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(bucket)) return null;
  const rest = body.slice(0, lastDot);
  const ciaDot = rest.lastIndexOf('.');
  if (ciaDot < 0) return null;
  return { api: rest.slice(0, ciaDot), cia: rest.slice(ciaDot + 1), bucket, monthly };
}

export interface CacheCoverageEntry {
  api: string;
  cia: string;
  days: number;
  months: number;
  first: string | null;
  last: string | null;
}

/**
 * Inventario del cache local por (api, cia): cuántos días/meses hay y el
 * rango cubierto. Solo keys (barato). Dos usuarios corren esto y el diff de
 * la salida apunta directo a los huecos.
 */
export async function summarizeLocalCache(): Promise<CacheCoverageEntry[]> {
  const keys = await listDailyCacheKeys();
  const byScope = new Map<string, CacheCoverageEntry>();
  for (const key of keys) {
    const parsed = parseCacheKey(key);
    if (!parsed) continue;
    const scope = `${parsed.api}::${parsed.cia}`;
    let entry = byScope.get(scope);
    if (!entry) {
      entry = { api: parsed.api, cia: parsed.cia, days: 0, months: 0, first: null, last: null };
      byScope.set(scope, entry);
    }
    if (parsed.monthly) entry.months += 1;
    else entry.days += 1;
    if (entry.first === null || parsed.bucket < entry.first) entry.first = parsed.bucket;
    if (entry.last === null || parsed.bucket > entry.last) entry.last = parsed.bucket;
  }
  return Array.from(byScope.values()).sort((a, b) =>
    a.api.localeCompare(b.api) || a.cia.localeCompare(b.cia));
}

/**
 * Conteo de registros cacheados por día para un api (+cia opcional) en un
 * rango. Lee payloads de IDB — usarlo on-demand desde consola, no en el hot
 * path. Es la herramienta de soporte para el caso "300 vs 330 movimientos":
 * cada usuario corre `__midas__.dataHealth.counts('banks.SWIFT')` y el diff
 * por día localiza el día divergente.
 */
export async function countCachedRecordsByDay(
  api: string,
  cia?: string,
  from?: string,
  to?: string,
): Promise<Record<string, number>> {
  const keys = await listDailyCacheKeys();
  const out: Record<string, number> = {};
  for (const key of keys) {
    const parsed = parseCacheKey(key);
    if (!parsed || parsed.monthly) continue;
    if (parsed.api !== api) continue;
    if (cia !== undefined && parsed.cia !== cia) continue;
    if (from !== undefined && parsed.bucket < from) continue;
    if (to !== undefined && parsed.bucket > to) continue;
    const records = await getDailyCachedAsync<unknown>(
      parsed.api,
      parsed.bucket,
      parsed.cia === '__all__' ? undefined : parsed.cia,
    );
    out[`${parsed.cia}::${parsed.bucket}`] = records === null ? -1 : records.length;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Como `countCachedRecordsByDay` pero para caches mensuales (compras). */
export async function countCachedRecordsByMonth(
  api: string,
  cia?: string,
): Promise<Record<string, number>> {
  const keys = await listDailyCacheKeys();
  const out: Record<string, number> = {};
  for (const key of keys) {
    const parsed = parseCacheKey(key);
    if (!parsed || !parsed.monthly) continue;
    if (parsed.api !== api) continue;
    if (cia !== undefined && parsed.cia !== cia) continue;
    const records = await getMonthCachedAsync<unknown>(
      parsed.api,
      parsed.bucket,
      parsed.cia === '__all__' ? undefined : parsed.cia,
    );
    out[`${parsed.cia}::${parsed.bucket}`] = records === null ? -1 : records.length;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Publica `window.__midas__.dataHealth` (idempotente). Llamar una vez desde
 * AppCore; los getters leen estado vivo del módulo.
 */
export function publishDataHealthDiagnostics(): void {
  if (typeof window === 'undefined') return;
  try {
    const w = window as unknown as { __midas__?: Record<string, unknown> };
    w.__midas__ = {
      ...(w.__midas__ ?? {}),
      dataHealth: {
        /** Huecos de fetch de ESTA sesión (días/meses/chunks fallidos). */
        gaps: () => getDataGaps(),
        /** Inventario del cache local por (api, cia). */
        coverage: () => summarizeLocalCache(),
        /** Conteo de registros por día — comparar entre dos máquinas. */
        counts: (api: string, cia?: string, from?: string, to?: string) =>
          countCachedRecordsByDay(api, cia, from, to),
        /** Conteo de registros por mes (caches mensuales: compras). */
        countsByMonth: (api: string, cia?: string) => countCachedRecordsByMonth(api, cia),
      },
    };
  } catch {
    /* diagnóstico best-effort */
  }
}
