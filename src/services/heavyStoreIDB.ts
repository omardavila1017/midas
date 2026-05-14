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
} from './jdeTypes';
import type { PayrollCostRecord } from '../modules/shared-finance/types';
import type { CXPRecord } from '../domain/persistence';

const DB_NAME = 'midas-heavy-store';
const DB_VERSION = 1;
const STORE_NAME = 'records';

export const HEAVY_KEYS = [
  'cxpRecords',
  'cobranzaRecords',
  'cobranzaPayments',
  'comprasRecords',
  'pagoProveedorRecords',
  'nominaRecords',
] as const;

export type HeavyKey = (typeof HEAVY_KEYS)[number];

export interface HeavyStore {
  cxpRecords: CXPRecord[];
  cobranzaRecords: CobranzaRecord[];
  cobranzaPayments: CobranzaPayment[];
  comprasRecords: ComprasRecord[];
  pagoProveedorRecords: PagoProveedorRecord[];
  nominaRecords: PayrollCostRecord[];
}

export function emptyHeavyStore(): HeavyStore {
  return {
    cxpRecords: [],
    cobranzaRecords: [],
    cobranzaPayments: [],
    comprasRecords: [],
    pagoProveedorRecords: [],
    nominaRecords: [],
  };
}

interface IdbEntry {
  key: HeavyKey;
  records: unknown[];
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let idbWarned = false;

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
  const db = await openDb();
  if (!db) return out;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const val = cursor.value as IdbEntry;
          if (val && val.key && Array.isArray(val.records) && HEAVY_KEYS.includes(val.key)) {
            // Cast guiado por la HEAVY_KEYS check — schemas validados river-río
            // arriba en normalizeStore (heavies migrados pasan por ahí).
            (out as Record<HeavyKey, unknown[]>)[val.key] = val.records;
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
  return out;
}

export async function saveHeavyRecords(key: HeavyKey, records: unknown[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put({ key, records });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function saveHeavyStore(store: HeavyStore): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const os = tx.objectStore(STORE_NAME);
      for (const key of HEAVY_KEYS) {
        os.put({ key, records: store[key] });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function clearHeavyStore(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const os = tx.objectStore(STORE_NAME);
      os.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
