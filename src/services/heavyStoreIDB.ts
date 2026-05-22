/**
 * IndexedDB-backed storage for heavy record collections.
 *
 * Por qué existe: localStorage tiene cuota de ~5MB por origin. Cobranza (2
 * años × N cías), CXP, compras, pagoproveedor, nómina y payments juntos
 * pasan ese límite con facilidad — el save anterior tiraba
 * QuotaExceededError silenciado en persistence.ts:saveStore, dejaba el
 * payload sin escribir, y el próximo boot refetcheaba todo desde JDE.
 *
 * Pattern (igual a dailyApiCache.ts):
 *   • Object store `records` con keyPath `key`.
 *   • Una entry por colección: `{ key: 'cobranzaRecords', records: [...] }`.
 *   • Lecturas async one-shot (no se precarga todo a memoria — los arrays
 *     son grandes y solo se leen en boot).
 *   • Writes async fire-and-forget desde el caller (debounce externo).
 *
 * Errores se silencian (cache es best-effort; nunca debe tirar la app).
 */

import type {
  CobranzaPayment,
  CobranzaRecord,
  ComprasRecord,
  PagoProveedorRecord,
  RolRecord,
} from './jdeTypes';
import type { PayrollCostRecord } from '../modules/shared-finance/types';
import type { CXPRecord } from '../domain/persistence';

const DB_NAME = 'midas-heavy-store';
const DB_VERSION = 2;
const STORE_NAME = 'records';
const CHUNK_STORE_NAME = 'recordChunks';
const CHUNK_SIZE = 1_000;

export const HEAVY_KEYS = [
  'cxpRecords',
  'cobranzaRecords',
  'cobranzaPayments',
  'comprasRecords',
  'pagoProveedorRecords',
  'nominaRecords',
  'rolRecords',
] as const;

export type HeavyKey = (typeof HEAVY_KEYS)[number];

export interface HeavyStore {
  cxpRecords: CXPRecord[];
  cobranzaRecords: CobranzaRecord[];
  cobranzaPayments: CobranzaPayment[];
  comprasRecords: ComprasRecord[];
  pagoProveedorRecords: PagoProveedorRecord[];
  nominaRecords: PayrollCostRecord[];
  rolRecords: RolRecord[];
}

export function emptyHeavyStore(): HeavyStore {
  return {
    cxpRecords: [],
    cobranzaRecords: [],
    cobranzaPayments: [],
    comprasRecords: [],
    pagoProveedorRecords: [],
    nominaRecords: [],
    rolRecords: [],
  };
}

interface IdbEntry {
  key: string;
  records: unknown[];
}

interface ChunkedEntry {
  key: string;
  chunked: true;
  chunkCount: number;
  total: number;
}

interface ChunkEntry {
  key: string;
  records: unknown[];
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let idbWarned = false;
const saveQueues = new Map<string, Promise<void>>();

function chunkKey(key: string, index: number): string {
  return `${key}::${index}`;
}

function isChunkedEntry(value: unknown): value is ChunkedEntry {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as ChunkedEntry).chunked === true &&
    typeof (value as ChunkedEntry).chunkCount === 'number',
  );
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve();
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

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
        resolve(db);
      }
    };
    // Safety net: 5s timeout para no colgar el boot si otra pestaña tiene
    // la DB locked. Fallback memory-only sin persistencia hasta reload.
    const timeoutId = window.setTimeout(() => {
      if (!resolved && !idbWarned) {
        idbWarned = true;
        // eslint-disable-next-line no-console
        console.warn('[heavyStoreIDB] IDB open timeout — sin persistencia esta sesión');
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
        if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
          db.createObjectStore(CHUNK_STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => stamp(req.result);
      req.onerror = () => {
        if (!idbWarned) {
          idbWarned = true;
          // eslint-disable-next-line no-console
          console.warn('[heavyStoreIDB] IDB open failed', req.error);
        }
        stamp(null);
      };
      req.onblocked = () => stamp(null);
    } catch (err) {
      if (!idbWarned) {
        idbWarned = true;
        // eslint-disable-next-line no-console
        console.warn('[heavyStoreIDB] IDB no disponible', err);
      }
      stamp(null);
    }
  });
  return dbPromise;
}

export async function loadHeavyStore(): Promise<HeavyStore> {
  const out = emptyHeavyStore();
  for (const key of HEAVY_KEYS) {
    out[key] = await loadHeavyRecords(key) as never;
  }
  // eslint-disable-next-line no-console
  console.info(`[heavyStoreIDB] loadHeavyStore · ${HEAVY_KEYS.map(k => `${k}=${out[k].length}`).join(' · ')}`);
  return out;
}

async function readRecords(key: string): Promise<unknown[]> {
  const db = await openDb();
  if (!db) return [];
  const entry = await new Promise<IdbEntry | ChunkedEntry | undefined>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result as IdbEntry | ChunkedEntry | undefined);
      req.onerror = () => resolve(undefined);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  if (!entry) return [];
  if (!isChunkedEntry(entry)) {
    return Array.isArray((entry as IdbEntry).records) ? (entry as IdbEntry).records : [];
  }
  const records: unknown[] = [];
  for (let i = 0; i < entry.chunkCount; i++) {
    const chunk = await new Promise<unknown[]>((resolve) => {
      try {
        const tx = db.transaction(CHUNK_STORE_NAME, 'readonly');
        const store = tx.objectStore(CHUNK_STORE_NAME);
        const req = store.get(chunkKey(key, i));
        req.onsuccess = () => {
          const value = req.result as ChunkEntry | undefined;
          resolve(value && Array.isArray(value.records) ? value.records : []);
        };
        req.onerror = () => resolve([]);
        tx.onerror = () => resolve([]);
        tx.onabort = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    for (const record of chunk) {
      records.push(record);
    }
    await yieldToMain();
  }
  return records;
}

export async function loadHeavyRecords<K extends HeavyKey>(key: K): Promise<HeavyStore[K]> {
  const records = await readRecords(key);
  if (records.length === 0 && !(await openDb())) {
    // eslint-disable-next-line no-console
    console.warn(`[heavyStoreIDB] loadHeavyRecords(${key}): DB no disponible`);
  }
  // eslint-disable-next-line no-console
  console.info(`[heavyStoreIDB] loadHeavyRecords(${key}) · ${records.length}`);
  return records as HeavyStore[K];
}

async function saveChunkedRecords(key: string, records: unknown[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const previous = await new Promise<ChunkedEntry | undefined>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const value = req.result;
        resolve(isChunkedEntry(value) ? value : undefined);
      };
      req.onerror = () => resolve(undefined);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  const chunkCount = Math.ceil(records.length / CHUNK_SIZE);
  for (let i = 0; i < chunkCount; i++) {
    const chunk = records.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(CHUNK_STORE_NAME, 'readwrite');
        const store = tx.objectStore(CHUNK_STORE_NAME);
        store.put({ key: chunkKey(key, i), records: chunk });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
    await yieldToMain();
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ key, chunked: true, chunkCount, total: records.length });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  const oldChunkCount = previous?.chunkCount ?? 0;
  if (oldChunkCount > chunkCount) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(CHUNK_STORE_NAME, 'readwrite');
        const store = tx.objectStore(CHUNK_STORE_NAME);
        for (let i = chunkCount; i < oldChunkCount; i++) {
          store.delete(chunkKey(key, i));
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

export async function saveHeavyRecords(key: HeavyKey, records: unknown[]): Promise<void> {
  const previous = saveQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => saveChunkedRecords(key, records))
    .finally(() => {
      if (saveQueues.get(key) === next) saveQueues.delete(key);
    });
  saveQueues.set(key, next);
  await next;
}

export async function saveHeavyStore(store: HeavyStore): Promise<void> {
  const db = await openDb();
  if (!db) {
    // eslint-disable-next-line no-console
    console.warn('[heavyStoreIDB] saveHeavyStore: DB no disponible — heavies no persisten esta sesión');
    return;
  }
  // Anti-wipe: si TODOS los heavies están vacíos, casi siempre es state-en-tránsito
  // durante boot (loadStore no terminó / refetch no llegó). Persistir ceros pisaría
  // la copia buena que ya está en IDB. Skip silencioso — la próxima save con
  // datos reales sí escribe. Para borrar intencional usar `clearHeavyStore()`.
  const allEmpty = HEAVY_KEYS.every(key => (store[key]?.length ?? 0) === 0);
  if (allEmpty) {
    // eslint-disable-next-line no-console
    console.info('[heavyStoreIDB] saveHeavyStore: state vacío, skip para no pisar IDB existente');
    return;
  }
  await new Promise<void>((resolve, reject) => {
    try {
      const written: HeavyKey[] = [];
      const writeAll = async () => {
        for (const key of HEAVY_KEYS) {
          const records = store[key];
          // Per-key anti-wipe: never overwrite a persisted collection with an
          // empty array. The heavy state hydrates incrementally during boot,
          // so a flush (beforeunload / visibilitychange) can call this while
          // some collections are still empty — writing those zeros would wipe
          // data that simply hasn't loaded from IDB yet. Intentional clears
          // must go through clearHeavyStore().
          if (!records || records.length === 0) continue;
          await saveHeavyRecords(key, records);
          written.push(key);
        }
      };
      writeAll().then(() => {
        // eslint-disable-next-line no-console
        console.info(`[heavyStoreIDB] saveHeavyStore ok · ${written.map(k => `${k}=${store[k]?.length ?? 0}`).join(' · ') || '(nada — todo vacío, skip)'}`);
        resolve();
      }).catch(reject);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[heavyStoreIDB] saveHeavyStore throw:', err);
      reject(err);
    }
  }).catch(() => { /* swallow, ya loggeado arriba */ });
}

// ── Bank statements ────────────────────────────────────────────────────
// Comparten DB con los heavies de MidasStore, pero NO viven en MidasStore
// — los maneja App.tsx directamente. Antes vivían en localStorage
// `midas.bankStatements.v2` y `midas.bankSupplementalStatements.v1`, que
// reventaban la cuota ~5MB con 2 años de movimientos y dejaban al usuario
// con un cache truncado. IDB tiene cuota dinámica en GB.

export const BANK_JDE_IDB_KEY = 'bankJdeStatements';
export const BANK_SUPPLEMENTAL_IDB_KEY = 'bankSupplementalStatements';

export interface BankStatementsCache {
  jde: unknown[];
  supplemental: unknown[];
}

export async function loadBankStatementsFromIDB(): Promise<BankStatementsCache> {
  try { performance.mark?.('bankStatements:idb:start'); } catch { /* noop */ }
  const [jde, supplemental] = await Promise.all([
    readRecords(BANK_JDE_IDB_KEY),
    readRecords(BANK_SUPPLEMENTAL_IDB_KEY),
  ]);
  try {
    performance.mark?.('bankStatements:idb:end');
    performance.measure?.('bankStatements:idb', 'bankStatements:idb:start', 'bankStatements:idb:end');
  } catch { /* noop */ }
  const out: BankStatementsCache = { jde, supplemental };
  if (jde.length === 0 && supplemental.length === 0 && !(await openDb())) {
    // eslint-disable-next-line no-console
    console.warn('[heavyStoreIDB] loadBankStatementsFromIDB: DB no disponible');
  }
  // eslint-disable-next-line no-console
  console.info(`[heavyStoreIDB] loadBankStatementsFromIDB · jde=${out.jde.length} · supplemental=${out.supplemental.length}`);
  return out;
}

async function saveBankKey(key: string, records: unknown[]): Promise<void> {
  if (!(await openDb())) {
    // eslint-disable-next-line no-console
    console.warn(`[heavyStoreIDB] saveBankKey(${key}): DB no disponible`);
    return;
  }
  const previous = saveQueues.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => saveChunkedRecords(key, records))
    .finally(() => {
      if (saveQueues.get(key) === next) saveQueues.delete(key);
    });
  saveQueues.set(key, next);
  await next;
  // eslint-disable-next-line no-console
  console.info(`[heavyStoreIDB] saveBankKey(${key}) ok · count=${records.length}`);
}

export async function saveBankJdeStatementsToIDB(records: unknown[]): Promise<void> {
  // Anti-wipe: si state está vacío durante boot, no pisar IDB existente.
  if (records.length === 0) {
    // eslint-disable-next-line no-console
    console.info('[heavyStoreIDB] saveBankJdeStatementsToIDB: state vacío, skip');
    return;
  }
  await saveBankKey(BANK_JDE_IDB_KEY, records);
}

export async function saveBankSupplementalStatementsToIDB(records: unknown[]): Promise<void> {
  // A diferencia del JDE: aquí sí permitimos guardar vacío. El usuario puede
  // borrar todos los uploads supplemental — ese estado debe persistir.
  await saveBankKey(BANK_SUPPLEMENTAL_IDB_KEY, records);
}

export async function clearHeavyStore(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction([STORE_NAME, CHUNK_STORE_NAME], 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.objectStore(CHUNK_STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
