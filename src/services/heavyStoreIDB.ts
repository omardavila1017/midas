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
const DB_VERSION = 1;
const STORE_NAME = 'records';

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
  if (!db) {
    // eslint-disable-next-line no-console
    console.warn('[heavyStoreIDB] loadHeavyStore: DB no disponible — boot cold start');
    return out;
  }
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
  // eslint-disable-next-line no-console
  console.info(`[heavyStoreIDB] loadHeavyStore · ${HEAVY_KEYS.map(k => `${k}=${out[k].length}`).join(' · ')}`);
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
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const os = tx.objectStore(STORE_NAME);
      for (const key of HEAVY_KEYS) {
        os.put({ key, records: store[key] });
      }
      tx.oncomplete = () => {
        // eslint-disable-next-line no-console
        console.info(`[heavyStoreIDB] saveHeavyStore ok · ${HEAVY_KEYS.map(k => `${k}=${store[k]?.length ?? 0}`).join(' · ')}`);
        resolve();
      };
      tx.onerror = () => {
        // eslint-disable-next-line no-console
        console.warn('[heavyStoreIDB] saveHeavyStore tx error:', tx.error);
        reject(tx.error);
      };
      tx.onabort = () => {
        // eslint-disable-next-line no-console
        console.warn('[heavyStoreIDB] saveHeavyStore tx aborted:', tx.error);
        reject(tx.error);
      };
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
  const out: BankStatementsCache = { jde: [], supplemental: [] };
  const db = await openDb();
  if (!db) {
    // eslint-disable-next-line no-console
    console.warn('[heavyStoreIDB] loadBankStatementsFromIDB: DB no disponible');
    return out;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const os = tx.objectStore(STORE_NAME);
      const jdeReq = os.get(BANK_JDE_IDB_KEY);
      const supReq = os.get(BANK_SUPPLEMENTAL_IDB_KEY);
      jdeReq.onsuccess = () => {
        const v = jdeReq.result as { key: string; records: unknown[] } | undefined;
        if (v && Array.isArray(v.records)) out.jde = v.records;
      };
      supReq.onsuccess = () => {
        const v = supReq.result as { key: string; records: unknown[] } | undefined;
        if (v && Array.isArray(v.records)) out.supplemental = v.records;
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  // eslint-disable-next-line no-console
  console.info(`[heavyStoreIDB] loadBankStatementsFromIDB · jde=${out.jde.length} · supplemental=${out.supplemental.length}`);
  return out;
}

async function saveBankKey(key: string, records: unknown[]): Promise<void> {
  const db = await openDb();
  if (!db) {
    // eslint-disable-next-line no-console
    console.warn(`[heavyStoreIDB] saveBankKey(${key}): DB no disponible`);
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const os = tx.objectStore(STORE_NAME);
      os.put({ key, records });
      tx.oncomplete = () => {
        // eslint-disable-next-line no-console
        console.info(`[heavyStoreIDB] saveBankKey(${key}) ok · count=${records.length}`);
        resolve();
      };
      tx.onerror = () => {
        // eslint-disable-next-line no-console
        console.warn(`[heavyStoreIDB] saveBankKey(${key}) tx error:`, tx.error);
        resolve();
      };
      tx.onabort = () => {
        // eslint-disable-next-line no-console
        console.warn(`[heavyStoreIDB] saveBankKey(${key}) tx aborted:`, tx.error);
        resolve();
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[heavyStoreIDB] saveBankKey(${key}) throw:`, err);
      resolve();
    }
  });
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
