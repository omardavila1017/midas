/**
 * Per-day cache para responses de JDE que aceptan rango de fechas.
 *
 * Pattern:
 *   • Chunk del fetch a 1 día por request.
 *   • Cada día se guarda bajo una key estable `{api}.{cia}.{YYYY-MM-DD}`.
 *   • Días pasados se sirven del cache sin tocar la red. Hoy siempre se re-fetch.
 *   • Días vacíos guardan `[]` para no repetir el fetch en cada boot.
 *
 * Storage backend:
 *   IndexedDB (object store `entries`). localStorage tiene quota de ~5-10MB que
 *   se rompe al primer año de bank statements (~20MB). IDB tiene quota dinámica
 *   en cientos de MB / GB, suficiente para todo el histórico.
 *
 *   Para mantener boots rápidos: tras abrir la DB cargamos todas las keys en un
 *   Map en memoria (`memoryIndex`). Las lecturas son sync (consultan el map);
 *   sólo el GET del payload completo va a IDB (async). Writes son async pero
 *   fire-and-forget.
 *
 * Errores se silencian (cache es best-effort; nunca debe tirar la app).
 */

const DB_NAME = 'midas-daily-cache';
// v2: bump para forzar onupgradeneeded en clientes que hayan abierto la DB v1
// sin el object store (regression de un debug eval pre-deploy).
const DB_VERSION = 2;
const STORE_NAME = 'entries';
const DEFAULT_CIA_BUCKET = '__all__';
const LEGACY_PREFIX = 'midas.daily';

interface IdbEntry {
  key: string;
  day: string;
  records: unknown[];
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let memoryIndex: Map<string, unknown[]> | null = null;
let memoryReady: Promise<void> | null = null;
let idbWarned = false;
// null = aún sin resolver openDb. true = IDB persiste. false = memory-only
// (lock de otra pestaña, IDB no disponible, o timeout de apertura). El boot
// usa esto para NO machacar JDE con 731 días cuando el cache no persiste.
let idbAvailable: boolean | null = null;

/**
 * ¿El cache diario persiste en IDB? false = memory-only (otra pestaña tiene
 * la DB lockeada, IDB deshabilitado, o `open` venció su timeout). En ese
 * estado el cache NO sobrevive recargas, así que el caller debe recortar
 * rangos largos en vez de re-fetchearlos en cada boot.
 *
 * Requiere que `primeDailyCache()` haya resuelto; antes devuelve false.
 */
export function isDailyCachePersistent(): boolean {
  return idbAvailable === true;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function isPastDay(day: string, today: string = todayIso()): boolean {
  return day < today;
}

function cacheKey(api: string, day: string, cia?: string): string {
  const ciaBucket = cia && cia.trim() !== '' ? cia : DEFAULT_CIA_BUCKET;
  return `${api}.${ciaBucket}.${day}`;
}

function dayFromKey(key: string): string | null {
  const m = /\.(\d{4}-\d{2}-\d{2})$/.exec(key);
  return m ? m[1] : null;
}

// ── IDB plumbing ────────────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    let resolved = false;
    const finish = (db: IDBDatabase | null) => {
      if (!resolved) {
        resolved = true;
        if (idbAvailable === null) idbAvailable = db !== null;
        resolve(db);
      }
    };
    // Safety net: si otra pestaña tiene la DB locked, `open` se cuelga
    // indefinidamente. 5s suficiente para arranque normal; si vence, caemos
    // a memory-only y la sesión sigue sin cache persistente.
    const timeoutId = window.setTimeout(() => {
      if (!resolved && !idbWarned) {
        idbWarned = true;
        // eslint-disable-next-line no-console
        console.warn('[dailyApiCache] IDB open timeout — corriendo memory-only');
      }
      finish(null);
    }, 5000);
    const stamp = (db: IDBDatabase | null) => {
      window.clearTimeout(timeoutId);
      finish(db);
    };
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Si otra pestaña abre una versión nueva, cerramos para no provocar
        // `onblocked` allá (que la degradaría a memory-only → refetch de 731
        // días). El refresh natural de esa pestaña reabrirá la DB.
        db.onversionchange = () => db.close();
        stamp(db);
      };
      req.onerror = () => {
        if (!idbWarned) {
          idbWarned = true;
          // eslint-disable-next-line no-console
          console.warn('[dailyApiCache] IDB open failed', req.error);
        }
        stamp(null);
      };
      req.onblocked = () => stamp(null);
    } catch (err) {
      if (!idbWarned) {
        idbWarned = true;
        // eslint-disable-next-line no-console
        console.warn('[dailyApiCache] IDB no disponible', err);
      }
      stamp(null);
    }
  });
  return dbPromise;
}

/**
 * Carga TODAS las entries en `memoryIndex` para lookups sync. Se llama lazy
 * desde getDailyCached. Una sola pasada por sesión.
 */
function ensureMemoryReady(): Promise<void> {
  if (memoryReady) return memoryReady;
  memoryReady = (async () => {
    const db = await openDb();
    memoryIndex = new Map();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const val = cursor.value as IdbEntry;
            if (val && val.key && Array.isArray(val.records)) {
              memoryIndex!.set(val.key, val.records);
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
    // Migración silenciosa: si quedan keys daily en localStorage de versiones
    // pre-IDB, las leemos al map en memoria y las borramos para liberar quota.
    migrateLegacyLocalStorage();
  })();
  return memoryReady;
}

function migrateLegacyLocalStorage(): void {
  if (typeof localStorage === 'undefined' || !memoryIndex) return;
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(LEGACY_PREFIX + '.')) continue;
    toRemove.push(k);
  }
  for (const k of toRemove) {
    try {
      const raw = localStorage.getItem(k);
      if (raw !== null && raw !== '') {
        const parsed = JSON.parse(raw) as { records?: unknown[] } | unknown[];
        const records = Array.isArray(parsed)
          ? parsed
          : parsed && Array.isArray(parsed.records)
            ? parsed.records
            : null;
        if (records) {
          const slim = k.slice(LEGACY_PREFIX.length + 1);
          memoryIndex.set(slim, records);
          // Persistir en IDB en background (no await).
          void persistEntry(slim, records);
        }
      }
    } catch { /* ignore corrupt entries */ }
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
  if (toRemove.length > 0) {
    // eslint-disable-next-line no-console
    console.info(`[dailyApiCache] migré ${toRemove.length} keys legacy localStorage → IDB`);
  }
}

async function persistEntry(key: string, records: unknown[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const day = dayFromKey(key) ?? '';
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ key, day, records });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Lee un día cacheado. Sync — consulta el `memoryIndex` precargado.
 *
 * IMPORTANTE: requiere haber llamado `primeDailyCache()` antes de usarse.
 * Si no, devuelve null (cache miss) y el caller cuela al fetcher.
 */
export function getDailyCached<T>(api: string, day: string, cia?: string): T[] | null {
  if (!memoryIndex) return null;
  const hit = memoryIndex.get(cacheKey(api, day, cia));
  return hit ? (hit as T[]) : null;
}

/**
 * Guarda los registros de un día. Solo cachea días pasados — hoy nunca se
 * persiste, para no servir datos intradía staleados en el siguiente boot.
 *
 * Sync API (fire-and-forget): actualiza el map en memoria de inmediato y
 * escribe a IDB en background.
 */
export function setDailyCached<T>(
  api: string,
  day: string,
  records: T[],
  cia?: string,
  today: string = todayIso(),
): void {
  if (!isPastDay(day, today)) return;
  if (!memoryIndex) memoryIndex = new Map();
  const key = cacheKey(api, day, cia);
  memoryIndex.set(key, records);
  void persistEntry(key, records);
}

/**
 * Inicializa el cache (abre IDB + carga memoryIndex). Llamar una vez al boot
 * antes de hacer get/set. Devuelve una promesa que resuelve cuando está lista.
 */
export function primeDailyCache(): Promise<void> {
  return ensureMemoryReady();
}

interface FetchRangeOptions<T> {
  from: string;
  to: string;
  cia?: string;
  fetchDay: (day: string) => Promise<T[]>;
  onProgress?: (done: number, total: number) => void;
  concurrency?: number;
  today?: string;
}

export async function fetchRangeWithDailyCache<T>(
  api: string,
  options: FetchRangeOptions<T>,
): Promise<T[]> {
  const { from, to, cia, fetchDay, onProgress, concurrency = 3, today = todayIso() } = options;

  // Asegura que memoryIndex esté listo antes de planear cache hits.
  await ensureMemoryReady();

  const days = buildDayList(from, to);
  if (days.length === 0) return [];

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
 */
export async function clearDailyCache(api: string, cia?: string): Promise<number> {
  await ensureMemoryReady();
  if (!memoryIndex) return 0;
  const prefix = cia ? `${api}.${cia}.` : `${api}.`;
  const toRemove: string[] = [];
  for (const key of memoryIndex.keys()) {
    if (key.startsWith(prefix)) toRemove.push(key);
  }
  for (const key of toRemove) memoryIndex.delete(key);
  const db = await openDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const key of toRemove) store.delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  return toRemove.length;
}

export function dailyCacheStats(api: string, cia?: string): { count: number; days: string[] } {
  if (!memoryIndex) return { count: 0, days: [] };
  const prefix = cia ? `${api}.${cia}.` : `${api}.`;
  const days: string[] = [];
  for (const key of memoryIndex.keys()) {
    if (key.startsWith(prefix)) {
      const day = dayFromKey(key);
      if (day) days.push(day);
    }
  }
  days.sort();
  return { count: days.length, days };
}

/**
 * Último YYYY-MM-DD con entry persistida para `api` (opcionalmente filtrado por
 * `cia`). Útil para boot: si tenemos cache hasta ayer, sólo pedir desde hoy.
 *
 * SYNC — requiere que `primeDailyCache()` ya haya completado. Si memoryIndex
 * no está listo, devuelve null (caller debe asumir cache miss y hacer full
 * backfill).
 *
 * Si se pasa `cia`, busca el prefijo `${api}.${cia}.`. Si no se pasa, busca
 * cualquier cía (incluyendo el bucket por defecto `__all__` para endpoints
 * globales como `/compras` y `/pagoproveedor`).
 */
export function getMaxCachedDay(api: string, cia?: string): string | null {
  if (!memoryIndex) return null;
  const prefix = cia ? `${api}.${cia}.` : `${api}.`;
  let max: string | null = null;
  for (const key of memoryIndex.keys()) {
    if (!key.startsWith(prefix)) continue;
    const day = dayFromKey(key);
    if (!day) continue;
    if (max === null || day > max) max = day;
  }
  return max;
}

/**
 * Devuelve el día siguiente a `day` en formato YYYY-MM-DD.
 * Útil para construir el `from` de un fetch incremental tras un cache hit.
 */
export function nextIsoDay(day: string): string {
  const d = new Date(day + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return day;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export async function clearAllDailyCache(): Promise<number> {
  await ensureMemoryReady();
  const count = memoryIndex ? memoryIndex.size : 0;
  if (memoryIndex) memoryIndex.clear();
  const db = await openDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  return count;
}
