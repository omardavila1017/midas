/**
 * Per-day localStorage cache para responses de JDE que aceptan rango de fechas.
 *
 * Pattern:
 *   • Chunk del fetch a 1 día por request.
 *   • Cada día se guarda bajo una key estable `midas.daily.{api}.{cia}.{YYYY-MM-DD}`.
 *   • Días pasados se sirven del cache sin tocar la red. Hoy siempre se re-fetch
 *     (la data del día cambia intradía).
 *   • Si la respuesta de un día está vacía, igual cacheamos un array vacío para
 *     no re-pegar al endpoint los días que históricamente no tienen datos.
 *
 * Errores se silencian (cache es best-effort; nunca debe tirar la app).
 */

const CACHE_KEY_PREFIX = 'midas.daily';
const DEFAULT_CIA_BUCKET = '__all__';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** YYYY-MM-DD ≤ today (UTC) → considerado "pasado e inmutable". */
export function isPastDay(day: string, today: string = todayIso()): boolean {
  return day < today;
}

function cacheKey(api: string, day: string, cia?: string): string {
  const ciaBucket = cia && cia.trim() !== '' ? cia : DEFAULT_CIA_BUCKET;
  return `${CACHE_KEY_PREFIX}.${api}.${ciaBucket}.${day}`;
}

/**
 * Lee un día cacheado. Devuelve null si no hay nada en cache.
 *
 * Nunca tira: cualquier JSON corrupto se ignora y se retorna null para que el
 * caller cuele al fetcher.
 */
export function getDailyCached<T>(api: string, day: string, cia?: string): T[] | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(cacheKey(api, day, cia));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { records?: T[] } | T[];
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.records)) return parsed.records;
    return null;
  } catch {
    return null;
  }
}

/**
 * Guarda los registros de un día. Solo cachea días pasados — hoy nunca se
 * persiste, para no servir datos intradía staleados en el siguiente boot.
 */
export function setDailyCached<T>(
  api: string,
  day: string,
  records: T[],
  cia?: string,
  today: string = todayIso(),
): void {
  if (typeof localStorage === 'undefined') return;
  if (!isPastDay(day, today)) return;
  try {
    const payload = JSON.stringify({ records, savedAt: new Date().toISOString() });
    localStorage.setItem(cacheKey(api, day, cia), payload);
  } catch {
    // QuotaExceededError o similar: ignoramos. El cache es best-effort.
  }
}

interface FetchRangeOptions<T> {
  /** YYYY-MM-DD inclusive. */
  from: string;
  /** YYYY-MM-DD inclusive. */
  to: string;
  /** Bucket por compañía (omitir para endpoints globales como /compras). */
  cia?: string;
  /**
   * Función que va a buscar UN día específico. Recibe el día y debe devolver
   * los registros para ese día. Si el endpoint requiere un rango, mandar
   * (day, day) como fechaInicial/fechaFinal.
   */
  fetchDay: (day: string) => Promise<T[]>;
  /** Callback de progreso. */
  onProgress?: (done: number, total: number) => void;
  /** Concurrency de los fetches que sí van a la red (default 3). */
  concurrency?: number;
  /** Override para "hoy" — útil para tests. */
  today?: string;
}

/**
 * Recupera registros para [from..to] usando el cache por día. Sólo va a la
 * red para los días no cacheados y para "hoy". Devuelve la concatenación de
 * todos los días.
 *
 * El caller debe pasar `cia` cuando el endpoint sea per-cía (cobranza,
 * indicadores). Para endpoints globales (compras) omitirlo.
 */
export async function fetchRangeWithDailyCache<T>(
  api: string,
  options: FetchRangeOptions<T>,
): Promise<T[]> {
  const { from, to, cia, fetchDay, onProgress, concurrency = 3, today = todayIso() } = options;

  const days = buildDayList(from, to);
  if (days.length === 0) return [];

  // 1. Construye plan: días con cache se sirven directo; el resto va a la red.
  const cached: Array<T[] | null> = new Array(days.length);
  const toFetch: number[] = [];
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    if (isPastDay(day, today)) {
      const hit = getDailyCached<T>(api, day, cia);
      if (hit !== null) {
        cached[i] = hit;
        continue;
      }
    }
    toFetch.push(i);
  }

  let done = days.length - toFetch.length;
  onProgress?.(done, days.length);

  // 2. Fetch en paralelo con concurrencia acotada.
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const slot = cursor++;
      if (slot >= toFetch.length) return;
      const idx = toFetch[slot];
      const day = days[idx];
      try {
        const records = await fetchDay(day);
        cached[idx] = records;
        setDailyCached(api, day, records, cia, today);
      } catch {
        // Día falló — guardamos array vacío para no abortar el merge. El
        // cache helper NO persiste fallas; en el próximo refresh se reintenta.
        cached[idx] = [];
      } finally {
        done++;
        onProgress?.(done, days.length);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, toFetch.length)) }, worker),
  );

  // 3. Concatena en orden cronológico.
  const merged: T[] = [];
  for (const day of cached) {
    if (day && day.length > 0) merged.push(...day);
  }
  return merged;
}

function buildDayList(from: string, to: string): string[] {
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return [];
  }
  const out: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/**
 * Borra todas las entradas del cache por día para un API (y opcionalmente cía).
 * Útil para el botón "Forzar refresh" o para diagnóstico.
 */
export function clearDailyCache(api: string, cia?: string): number {
  if (typeof localStorage === 'undefined') return 0;
  const prefix = cia
    ? `${CACHE_KEY_PREFIX}.${api}.${cia}.`
    : `${CACHE_KEY_PREFIX}.${api}.`;
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) toRemove.push(key);
  }
  for (const key of toRemove) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
  return toRemove.length;
}

/** Estadísticas del cache: cuántos días tiene guardados por (api, cia). */
export function dailyCacheStats(api: string, cia?: string): { count: number; days: string[] } {
  if (typeof localStorage === 'undefined') return { count: 0, days: [] };
  const prefix = cia
    ? `${CACHE_KEY_PREFIX}.${api}.${cia}.`
    : `${CACHE_KEY_PREFIX}.${api}.`;
  const days: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(prefix)) {
      days.push(key.slice(prefix.length));
    }
  }
  days.sort();
  return { count: days.length, days };
}
