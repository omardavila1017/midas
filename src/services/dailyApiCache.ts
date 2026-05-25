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
 *   Memoria: SOLO mantenemos el set de keys (`keyIndex`) en RAM, no los
 *   payloads. Un histórico de ~2 años pesa cientos de MB en disco; cargarlo
 *   entero al heap (lo que hacía la versión con `getAll()` + `memoryIndex`)
 *   dejaba el tab a >2GB en idle y reventaba el renderer ("Aw Snap", OOM) en
 *   cuanto el flip mes→día pedía más memoria. Ahora:
 *     • `keyIndex` (Set<string>) responde sync "¿está cacheado este día?".
 *     • el payload se lee de IDB on-demand y async (`getDailyCachedAsync`).
 *     • un buffer chico write-through (`recentWrites`, acotado) cubre el
 *       patrón escribe-y-relee dentro de la misma pasada sin esperar el commit
 *       de IDB, sin re-introducir retención ilimitada.
 *
 * Errores se silencian (cache es best-effort; nunca debe tirar la app).
 */

import { todayISO } from '../formatters';

const DB_NAME = 'midas-daily-cache';
// v2: bump para forzar onupgradeneeded en clientes que hayan abierto la DB v1
// sin el object store (regression de un debug eval pre-deploy).
const DB_VERSION = 2;
const STORE_NAME = 'entries';
const DEFAULT_CIA_BUCKET = '__all__';
const LEGACY_PREFIX = 'midas.daily';
// Bound unbounded growth: keep ~2.2 years. The predictors fetch a 2-year
// window (Holt-Winters needs ≥24 months), so retention must comfortably cover
// it; older daily entries are rarely read and simply re-fetch on demand.
// Sin prune, las keys + IDB crecen sin límite con el uso diario.
const CACHE_RETENTION_DAYS = 800;
// Write-through buffer cap. Solo cubre escribe-luego-relee en la misma pasada
// (p.ej. backfill que cachea un día y otro worker lo consulta antes de que el
// commit de IDB resuelva). Acotado por COUNT → heap trivial (no retiene el
// histórico). 256 días ≈ casi un año de un solo API en vuelo a la vez, de
// sobra para cualquier pasada concurrente real.
const RECENT_WRITE_CAP = 256;

interface IdbEntry {
  key: string;
  day: string;
  records: unknown[];
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
// Keys-only. NUNCA payloads — esa fue la fuga de ~2GB.
let keyIndex: Set<string> | null = null;
// Buffer chico write-through (key → records). Acotado a RECENT_WRITE_CAP por
// inserción FIFO. No es una cache de lectura general: solo evita una carrera
// escribe→relee antes del commit de IDB.
const recentWrites = new Map<string, unknown[]>();
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
  return todayISO();
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

function rememberWrite(key: string, records: unknown[]): void {
  // FIFO bound: si reinsertamos una key existente, refréscala al final.
  if (recentWrites.has(key)) recentWrites.delete(key);
  recentWrites.set(key, records);
  while (recentWrites.size > RECENT_WRITE_CAP) {
    const oldest = recentWrites.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    recentWrites.delete(oldest);
  }
}

// ── IDB plumbing ────────────────────────────────────────────────────────

// Un lock de IDB por otra pestaña (o un `onblocked` mientras el otro tab
// cierra su conexión por `onversionchange`) es TRANSITORIO. La versión
// anterior degradaba la sesión entera a memory-only al primer timeout/blocked
// (5s, un solo intento) → `isDailyCachePersistent()` falso → el boot recortaba
// el histórico de bancos a 120 días ("histórico inestable"). Ahora reintentamos
// las fallas transitorias con backoff antes de rendirnos; solo degradamos a
// memory-only tras agotar los reintentos o ante un error duro (IDB ausente).
const IDB_OPEN_TIMEOUT_MS = 2500;
const IDB_OPEN_MAX_ATTEMPTS = 3;
const IDB_RETRY_BACKOFF_MS = 600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Un intento de abrir la DB.
 *   - IDBDatabase → éxito.
 *   - 'retry'     → falla transitoria (timeout o `onblocked`); reintentar.
 *   - null        → falla dura (IDB ausente, onerror, excepción); no reintentar.
 */
function attemptOpenDb(): Promise<IDBDatabase | 'retry' | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: IDBDatabase | 'retry' | null) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timeoutId = window.setTimeout(() => done('retry'), IDB_OPEN_TIMEOUT_MS);
    const clearTo = () => window.clearTimeout(timeoutId);
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
        if (settled) {
          // El intento ya venció (timeout → 'retry'). Esta conexión llegó
          // tarde: ciérrala o quedaría colgada bloqueando los reintentos.
          db.close();
          return;
        }
        // Si otra pestaña abre una versión nueva, cerramos para no provocar
        // `onblocked` allá. El refresh natural de esa pestaña reabrirá la DB.
        db.onversionchange = () => db.close();
        clearTo();
        done(db);
      };
      req.onerror = () => {
        clearTo();
        if (!idbWarned) {
          idbWarned = true;
          // eslint-disable-next-line no-console
          console.warn('[dailyApiCache] IDB open failed', req.error);
        }
        done(null);
      };
      // `onblocked`: otra pestaña con conexión de versión menor aún no cierra.
      // Es transitorio — su `onversionchange` (arriba) la cerrará. NO matamos
      // la persistencia: dejamos que el timeout dispare un 'retry'.
      req.onblocked = () => { /* transient — timeout drives retry */ };
    } catch (err) {
      clearTo();
      if (!idbWarned) {
        idbWarned = true;
        // eslint-disable-next-line no-console
        console.warn('[dailyApiCache] IDB no disponible', err);
      }
      done(null);
    }
  });
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    idbAvailable = false;
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = (async () => {
    for (let attempt = 0; attempt < IDB_OPEN_MAX_ATTEMPTS; attempt++) {
      const r = await attemptOpenDb();
      if (r && r !== 'retry') {
        idbAvailable = true;
        return r;
      }
      if (r === null) break; // falla dura — no reintentar
      // 'retry': falla transitoria. Backoff lineal y reintentar.
      if (attempt < IDB_OPEN_MAX_ATTEMPTS - 1) {
        await sleep(IDB_RETRY_BACKOFF_MS * (attempt + 1));
      }
    }
    if (!idbWarned) {
      idbWarned = true;
      // eslint-disable-next-line no-console
      console.warn('[dailyApiCache] IDB open agotó reintentos — corriendo memory-only');
    }
    idbAvailable = false;
    return null;
  })();
  return dbPromise;
}

/**
 * Carga el SET DE KEYS (no payloads) en `keyIndex` para responder sync si un
 * día está cacheado. Se llama lazy desde los fetchers. Una sola pasada por
 * sesión. `getAllKeys()` deserializa solo strings → heap trivial aunque el
 * histórico pese cientos de MB en disco.
 */
function ensureMemoryReady(): Promise<void> {
  if (memoryReady) return memoryReady;
  memoryReady = (async () => {
    const db = await openDb();
    keyIndex = new Set();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        // Solo keys. La versión previa hacía getAll() y metía TODOS los
        // records al heap (~2GB en idle con 2 años de histórico → OOM).
        const req = store.getAllKeys();
        req.onsuccess = () => {
          const all = req.result as IDBValidKey[] | undefined;
          if (Array.isArray(all)) {
            for (const k of all) {
              if (typeof k === 'string') keyIndex!.add(k);
            }
          }
          resolve();
        };
        req.onerror = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
    // Migración silenciosa: si quedan keys daily en localStorage de versiones
    // pre-IDB, las persistimos a IDB y registramos su key.
    migrateLegacyLocalStorage();
    // Bound growth so years of daily use don't pin an ever-growing key set.
    pruneStaleEntries();
  })();
  return memoryReady;
}

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Lee el payload de un día directo de IDB. async — fuera del hot path sync.
 * El caller ya verificó (sync, vía keyIndex) que la key existe.
 */
function readEntryFromIdb(key: string): Promise<unknown[] | null> {
  return new Promise((resolve) => {
    void openDb().then((db) => {
      if (!db) {
        resolve(null);
        return;
      }
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => {
          const val = req.result as IdbEntry | undefined;
          resolve(val && Array.isArray(val.records) ? val.records : null);
        };
        req.onerror = () => resolve(null);
        tx.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Best-effort prune of entries older than the retention window. Bounds
 * `keyIndex` + IDB so years of daily use don't accumulate unbounded. La caída
 * en memoria es inmediata (barata); el delete en IDB corre fuera del path
 * crítico. Nunca bloquea boot; silencioso ante error.
 */
function pruneStaleEntries(): void {
  if (!keyIndex) return;
  const cutoff = isoDaysAgo(CACHE_RETENTION_DAYS);
  const stale: string[] = [];
  for (const key of keyIndex) {
    const day = dayFromKey(key);
    if (day && day < cutoff) stale.push(key);
  }
  if (stale.length === 0) return;
  for (const key of stale) {
    keyIndex.delete(key);
    recentWrites.delete(key);
  }
  const dropFromIdb = () => {
    void openDb().then((db) => {
      if (!db) return;
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const key of stale) store.delete(key);
      } catch { /* best-effort */ }
    });
  };
  const ric = typeof window !== 'undefined'
    ? (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => number }).requestIdleCallback
    : undefined;
  if (ric) ric(dropFromIdb, { timeout: 2000 });
  else setTimeout(dropFromIdb, 0);
  // eslint-disable-next-line no-console
  console.info(`[dailyApiCache] prune: ${stale.length} entries < ${cutoff} (retención ${CACHE_RETENTION_DAYS}d)`);
}

function migrateLegacyLocalStorage(): void {
  if (typeof localStorage === 'undefined' || !keyIndex) return;
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
          keyIndex.add(slim);
          // Persistir en IDB en background (no await). No retenemos records.
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
      tx.oncomplete = () => {
        // Commit confirmado: el payload ya vive en IDB; suéltalo del buffer
        // write-through para no retener nada.
        recentWrites.delete(key);
        resolve();
      };
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * ¿Hay un día cacheado? Sync — consulta el `keyIndex` precargado. Úsalo para
 * decidir sync si hace falta ir a la red; el payload se lee con
 * `getDailyCachedAsync`.
 *
 * Requiere haber llamado `primeDailyCache()` antes; si no, devuelve false.
 */
export function hasDailyCached(api: string, day: string, cia?: string): boolean {
  if (!keyIndex) return false;
  const key = cacheKey(api, day, cia);
  return recentWrites.has(key) || keyIndex.has(key);
}

/**
 * Lee un día cacheado. async — el payload vive en IDB, no en RAM. Devuelve
 * null si no está cacheado (o el cache no está listo): el caller cuela al
 * fetcher. Chequea primero el buffer write-through para cubrir el patrón
 * escribe→relee dentro de la misma pasada.
 *
 * IMPORTANTE: requiere haber llamado `primeDailyCache()` antes de usarse.
 */
export async function getDailyCachedAsync<T>(
  api: string,
  day: string,
  cia?: string,
): Promise<T[] | null> {
  if (!keyIndex) return null;
  const key = cacheKey(api, day, cia);
  const buffered = recentWrites.get(key);
  if (buffered) return buffered as T[];
  if (!keyIndex.has(key)) return null;
  const records = await readEntryFromIdb(key);
  return records ? (records as T[]) : null;
}

/**
 * Guarda los registros de un día. Solo cachea días pasados — hoy nunca se
 * persiste, para no servir datos intradía staleados en el siguiente boot.
 *
 * Sync API (fire-and-forget): registra la key + buffer write-through de
 * inmediato y escribe a IDB en background. El buffer se libera al confirmar
 * el commit (ver `persistEntry`).
 */
export function setDailyCached<T>(
  api: string,
  day: string,
  records: T[],
  cia?: string,
  today: string = todayIso(),
): void {
  if (!isPastDay(day, today)) return;
  if (!keyIndex) keyIndex = new Set();
  const key = cacheKey(api, day, cia);
  keyIndex.add(key);
  rememberWrite(key, records);
  void persistEntry(key, records);
}

/**
 * Inicializa el cache (abre IDB + carga keyIndex). Llamar una vez al boot
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
  /**
   * Llamado por CADA día que aporta records — tanto cache hits como fetches
   * frescos. Permite al caller acumular y persistir incrementalmente en
   * lugar de esperar a que toda la cía termine (cientos de días → minutos).
   * Si el caller recarga antes del final, los días ya emitidos no se pierden.
   */
  onDay?: (records: T[]) => void;
  concurrency?: number;
  today?: string;
}

export async function fetchRangeWithDailyCache<T>(
  api: string,
  options: FetchRangeOptions<T>,
): Promise<T[]> {
  const { from, to, cia, fetchDay, onProgress, concurrency = 3, today = todayIso() } = options;

  // Asegura que keyIndex esté listo antes de planear cache hits.
  await ensureMemoryReady();

  const days = buildDayList(from, to);
  if (days.length === 0) return [];

  const cached: Array<T[] | null> = new Array(days.length);
  const toFetch: number[] = [];
  // Membership sync vía keyIndex; payload async (IDB) y concurrente para los
  // hits — leer cientos de días en serie congelaría el boot.
  const cachedIdx: number[] = [];
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    if (isPastDay(day, today) && hasDailyCached(api, day, cia)) {
      cachedIdx.push(i);
    } else {
      toFetch.push(i);
    }
  }

  let done = days.length - toFetch.length - cachedIdx.length;
  onProgress?.(done, days.length);

  // Leer los hits de IDB concurrentemente (pool acotado).
  {
    let rc = 0;
    const READ_CONCURRENCY = 8;
    const reader = async () => {
      while (true) {
        const slot = rc++;
        if (slot >= cachedIdx.length) return;
        const idx = cachedIdx[slot];
        const hit = await getDailyCachedAsync<T>(api, days[idx], cia);
        if (hit !== null) {
          cached[idx] = hit;
          if (hit.length > 0) {
            try { options.onDay?.(hit); } catch { /* swallow — caller bug */ }
          }
        } else {
          // Entró en una carrera con un prune o un delete: re-fetch.
          toFetch.push(idx);
        }
        done++;
        onProgress?.(done, days.length);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(READ_CONCURRENCY, cachedIdx.length)) },
        reader,
      ),
    );
  }

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
        if (records.length > 0) {
          try { options.onDay?.(records); } catch { /* swallow — caller bug */ }
        }
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
  if (!keyIndex) return 0;
  const prefix = cia ? `${api}.${cia}.` : `${api}.`;
  const toRemove: string[] = [];
  for (const key of keyIndex) {
    if (key.startsWith(prefix)) toRemove.push(key);
  }
  for (const key of toRemove) {
    keyIndex.delete(key);
    recentWrites.delete(key);
  }
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
  if (!keyIndex) return { count: 0, days: [] };
  const prefix = cia ? `${api}.${cia}.` : `${api}.`;
  const days: string[] = [];
  for (const key of keyIndex) {
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
 * SYNC — requiere que `primeDailyCache()` ya haya completado. Si keyIndex
 * no está listo, devuelve null (caller debe asumir cache miss y hacer full
 * backfill).
 *
 * Si se pasa `cia`, busca el prefijo `${api}.${cia}.`. Si no se pasa, busca
 * cualquier cía (incluyendo el bucket por defecto `__all__` para endpoints
 * globales como `/compras` y `/pagoproveedor`).
 */
export function getMaxCachedDay(api: string, cia?: string): string | null {
  if (!keyIndex) return null;
  const prefix = cia ? `${api}.${cia}.` : `${api}.`;
  let max: string | null = null;
  for (const key of keyIndex) {
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

// ── Monthly cache (parallel a daily, mismo IDB store) ──────────────────
//
// Para endpoints donde pedir por día es desperdicio: la mayoría de los días
// devuelven `data: []` (fines de semana, festivos, baja densidad de OCs).
// Pedimos por mes calendario completo y cacheamos por `M:{api}.{cia}.{YYYY-MM}`.
//
// Reglas:
//   • Meses pasados se cachean y sirven sin tocar la red.
//   • El mes actual NUNCA se cachea (datos siguen llegando dentro del mes).
//   • La ventana de fetch siempre es [firstOfMonth, lastOfMonth] aunque el
//     caller pida un rango parcial — así el cache es estable.
//   • Dedup queda en manos del caller (puede haber overlap si el rango
//     original empezaba a mediados de mes y volvemos a pedir el mes entero).
//
// Conviven con keys daily en el mismo object store; el prefijo `M:` evita
// colisión y el pruner por día (`dayFromKey`) los ignora porque su regex no
// matchea `YYYY-MM` (solo `YYYY-MM-DD`). El conteo de meses es pequeño
// (~30/cia × ~30 cias ≈ 900 entries) así que no requiere prune dedicado.
const MONTH_KEY_TAG = 'M:';

function cacheKeyMonth(api: string, month: string, cia?: string): string {
  const ciaBucket = cia && cia.trim() !== '' ? cia : DEFAULT_CIA_BUCKET;
  return `${MONTH_KEY_TAG}${api}.${ciaBucket}.${month}`;
}

function monthFromKey(key: string): string | null {
  if (!key.startsWith(MONTH_KEY_TAG)) return null;
  const m = /\.(\d{4}-\d{2})$/.exec(key);
  return m ? m[1] : null;
}

function currentMonth(today: string = todayIso()): string {
  return today.slice(0, 7);
}

export function isPastMonth(month: string, today: string = todayIso()): boolean {
  return month < currentMonth(today);
}

function buildMonthList(from: string, to: string): string[] {
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return [];
  }
  const out: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= endMonth.getTime()) {
    out.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) {
    return { from: `${month}-01`, to: `${month}-28` };
  }
  const start = new Date(Date.UTC(y, m - 1, 1));
  // Day 0 of month+1 = last day of month m (handles 28/29/30/31).
  const end = new Date(Date.UTC(y, m, 0));
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
  };
}

export function hasMonthCached(api: string, month: string, cia?: string): boolean {
  if (!keyIndex) return false;
  const key = cacheKeyMonth(api, month, cia);
  return recentWrites.has(key) || keyIndex.has(key);
}

export async function getMonthCachedAsync<T>(
  api: string,
  month: string,
  cia?: string,
): Promise<T[] | null> {
  if (!keyIndex) return null;
  const key = cacheKeyMonth(api, month, cia);
  const buffered = recentWrites.get(key);
  if (buffered) return buffered as T[];
  if (!keyIndex.has(key)) return null;
  const records = await readEntryFromIdb(key);
  return records ? (records as T[]) : null;
}

export function setMonthCached<T>(
  api: string,
  month: string,
  records: T[],
  cia?: string,
  today: string = todayIso(),
): void {
  if (!isPastMonth(month, today)) return;
  if (!keyIndex) keyIndex = new Set();
  const key = cacheKeyMonth(api, month, cia);
  keyIndex.add(key);
  rememberWrite(key, records);
  void persistEntry(key, records);
}

interface FetchRangeMonthlyOptions<T> {
  from: string;
  to: string;
  cia?: string;
  fetchMonth: (from: string, to: string) => Promise<T[]>;
  onProgress?: (done: number, total: number) => void;
  concurrency?: number;
  today?: string;
}

/**
 * Fetch un rango pidiendo MES POR MES (con cache por mes).
 *
 * Para cada mes en [from..to]:
 *   • Pasado y cacheado → sirve del cache.
 *   • Pasado y no cacheado → pide [firstOfMonth, lastOfMonth] y cachea.
 *   • Mes actual → pide [firstOfMonth, today] y NO cachea (datos vivos).
 *
 * El dedup queda al caller — el rango pedido a la API siempre cubre el mes
 * completo, así que registros pueden repetirse si el caller llama con
 * rangos solapados.
 */
export async function fetchRangeWithMonthlyCache<T>(
  api: string,
  options: FetchRangeMonthlyOptions<T>,
): Promise<T[]> {
  const {
    from,
    to,
    cia,
    fetchMonth,
    onProgress,
    concurrency = 4,
    today = todayIso(),
  } = options;

  await ensureMemoryReady();

  const months = buildMonthList(from, to);
  if (months.length === 0) return [];

  const cached: Array<T[] | null> = new Array(months.length);
  const toFetch: number[] = [];
  const cachedIdx: number[] = [];
  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    if (isPastMonth(m, today) && hasMonthCached(api, m, cia)) {
      cachedIdx.push(i);
    } else {
      toFetch.push(i);
    }
  }

  let done = months.length - toFetch.length - cachedIdx.length;
  onProgress?.(done, months.length);

  {
    let rc = 0;
    const READ_CONCURRENCY = 8;
    const reader = async () => {
      while (true) {
        const slot = rc++;
        if (slot >= cachedIdx.length) return;
        const idx = cachedIdx[slot];
        const hit = await getMonthCachedAsync<T>(api, months[idx], cia);
        if (hit !== null) {
          cached[idx] = hit;
        } else {
          toFetch.push(idx);
        }
        done++;
        onProgress?.(done, months.length);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.max(1, Math.min(READ_CONCURRENCY, cachedIdx.length)) },
        reader,
      ),
    );
  }

  const todayMonth = currentMonth(today);

  let cursor = 0;
  const worker = async () => {
    while (true) {
      const slot = cursor++;
      if (slot >= toFetch.length) return;
      const idx = toFetch[slot];
      const m = months[idx];
      const { from: mFrom, to: mTo } = monthBounds(m);
      // Mes actual: cap a `today`, no pedir días futuros del mes en curso.
      const effectiveTo = m === todayMonth && mTo > today ? today : mTo;
      try {
        const records = await fetchMonth(mFrom, effectiveTo);
        cached[idx] = records;
        // setMonthCached internamente filtra mes actual — no cachea vivo.
        setMonthCached(api, m, records, cia, today);
      } catch {
        cached[idx] = [];
      } finally {
        done++;
        onProgress?.(done, months.length);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, toFetch.length)) }, worker),
  );

  const merged: T[] = [];
  for (const monthRecords of cached) {
    if (monthRecords && monthRecords.length > 0) merged.push(...monthRecords);
  }
  return merged;
}

/**
 * Último YYYY-MM cacheado para `api` (opcionalmente filtrado por `cia`).
 * Útil para delta-sync mensual.
 */
export function getMaxCachedMonth(api: string, cia?: string): string | null {
  if (!keyIndex) return null;
  const prefix = cia ? `${MONTH_KEY_TAG}${api}.${cia}.` : `${MONTH_KEY_TAG}${api}.`;
  let max: string | null = null;
  for (const key of keyIndex) {
    if (!key.startsWith(prefix)) continue;
    const month = monthFromKey(key);
    if (!month) continue;
    if (max === null || month > max) max = month;
  }
  return max;
}

export async function clearAllDailyCache(): Promise<number> {
  await ensureMemoryReady();
  const count = keyIndex ? keyIndex.size : 0;
  if (keyIndex) keyIndex.clear();
  recentWrites.clear();
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
