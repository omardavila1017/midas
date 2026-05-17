/**
 * Persistence layer for Midas — v7.
 *
 * v7 adds CXC support (cobranza) alongside the existing CXP records. The
 * cobranza endpoint (POST /v1/erp/tesoreria/cobranza) was liberated to
 * production on 2026-05-01 by the JDE team; we persist the response so the
 * dashboard can show real receivables (and cross them against bank
 * movements) without re-fetching every load.
 *
 * v6 removes the legacy simulation model (proposals/scenarios/activeScenarioId)
 * that lived alongside the financial-planning native scenarios. Anything
 * scenario-related now lives in the financial-planning module storage; this
 * store only carries shared application data (catalogs, CXP, assumptions,
 * cash-flow overrides).
 *
 * Migrations:
 *   - midas-v6 → midas-v7: ADD cobranzaRecords / cobranzaLoadedCias as empty
 *     defaults. Existing v6 stores load fine — `normalizeStore` defaults the
 *     new arrays to empty.
 *   - midas-v5 → midas-v7: drop proposals/scenarios/activeScenarioId, keep
 *     the rest as-is.
 *   - flowsense-v5 → midas-v7: same shape rebrand, dropping the simulation
 *     fields.
 *   - flowsense-v1..v4 → midas-v7: incompatible simulation models; keep only
 *     the catalog/CXP/assumptions data.
 */

import { CashFlowOverrides } from '../types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './types';
import type { CobranzaRecord } from '../services/jdeTypes';

export interface CXPRecord {
  cia: string;
  noProveedor: string;
  nombre: string;
  noFactura: string;
  fechaFactura: string;
  fechaVence: string;
  fechaProgramacionPago: string;
  diasVencida: number;
  importeBrutoPesos: number;
  importePendientePesos: number;
  importeSubtotalPesos: number;
  importeImpuestosPesos: number;
  importeBrutoDolares: number;
  importePendienteDolares: number;
  moneda: string;
  condPago: string;
  clasifica: string;
  clasificacionProveedor: string;
  edoPago: string;
  tipoCambio: number;
  porVencer: number;
  v1_30: number;
  v31_60: number;
  v61_90: number;
  v91_120: number;
  v121_150: number;
  v151_180: number;
  mas180: number;
}

export interface MidasStore {
  providers: Provider[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  cxpRecords: CXPRecord[];
  cxpLoadedCias: Record<string, string>;
  /**
   * Cobranza (CXC) records cached from POST /v1/erp/tesoreria/cobranza.
   * One row per (cia, noFactura). Reset by clearStore() and refreshed
   * sequentially per cia at app boot — same pattern as cxpRecords.
   */
  cobranzaRecords: CobranzaRecord[];
  /**
   * Per-cia ISO timestamp of the last successful /cobranza response. Drives
   * the staleness UI badge in the Cobranza tab and lets us skip fetches
   * that were just refreshed in another browser tab.
   */
  cobranzaLoadedCias: Record<string, string>;
  cashFlowOverrides: CashFlowOverrides;
  lastSaved: string;
}

const STORE_VERSION = 7;
const STORAGE_KEY = 'midas-v7';
// v6 lives at the same shape minus the cobranza fields — `normalizeStore`
// defaults them to empty arrays, so v6 payloads load transparently.
const SAME_SCHEMA_LEGACY_KEYS = ['midas-v6', 'midas-v5', 'flowsense-v5'];
const LEGACY_KEYS = ['flowsense-v4', 'flowsense-v3', 'flowsense-v2', 'flowsense-v1'];

function isoNow(): string {
  return new Date().toISOString();
}

export function getDefaultStore(): MidasStore {
  return {
    providers: [],
    clients: [],
    assumptions: {
      year: new Date().getFullYear(),
      globalCompliance: 1,
      factorajeDays: 30,
    },
    confirmedPayments: [],
    cxpRecords: [],
    cxpLoadedCias: {},
    cobranzaRecords: [],
    cobranzaLoadedCias: {},
    cashFlowOverrides: {},
    lastSaved: isoNow(),
  };
}

// ── Normalizadores defensivos ────────────────────────────────────────────

function isObjectWithStringId(v: unknown): v is Record<string, unknown> & { id: string } {
  return !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string';
}

function normalizeAssumptions(v: unknown, fallback: CashFlowAssumptions): CashFlowAssumptions {
  if (!v || typeof v !== 'object') return fallback;
  const o = v as Record<string, unknown>;
  const year = typeof o.year === 'number' && Number.isFinite(o.year) && o.year > 1900 && o.year < 3000
    ? Math.floor(o.year)
    : fallback.year;
  // globalCompliance debe estar en [0, 1].
  const rawCompliance = typeof o.globalCompliance === 'number' && Number.isFinite(o.globalCompliance)
    ? o.globalCompliance
    : fallback.globalCompliance;
  const globalCompliance = Math.min(1, Math.max(0, rawCompliance));
  const factorajeDays = typeof o.factorajeDays === 'number' && Number.isFinite(o.factorajeDays) && o.factorajeDays >= 0
    ? Math.floor(o.factorajeDays)
    : fallback.factorajeDays;
  return { year, globalCompliance, factorajeDays };
}

function normalizeConfirmedPayment(v: unknown): ConfirmedPayment | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.key !== 'string' || typeof o.clientId !== 'string') return null;
  if (typeof o.realDate !== 'string' || typeof o.invoiceDate !== 'string') return null;
  if (typeof o.amount !== 'number' || !Number.isFinite(o.amount)) return null;
  if (typeof o.confirmedAt !== 'string') return null;
  return {
    key: o.key, clientId: o.clientId, realDate: o.realDate,
    invoiceDate: o.invoiceDate, amount: o.amount, confirmedAt: o.confirmedAt,
  };
}

function normalizeStore(raw: unknown): MidasStore {
  const base = getDefaultStore();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;

  // Filtramos por shape mínima: cualquier item que no tenga `id: string` se
  // descarta. CXPRecords no se modela con id; aceptamos cualquier objeto.
  const providers = Array.isArray(o.providers)
    ? (o.providers.filter(isObjectWithStringId) as unknown as Provider[])
    : [];
  const clients = Array.isArray(o.clients)
    ? (o.clients.filter(isObjectWithStringId) as unknown as Client[])
    : [];
  const confirmedPayments = Array.isArray(o.confirmedPayments)
    ? (o.confirmedPayments.map(normalizeConfirmedPayment).filter(Boolean) as ConfirmedPayment[])
    : [];
  const cxpRecords = Array.isArray(o.cxpRecords)
    ? (o.cxpRecords.filter((r) => !!r && typeof r === 'object') as CXPRecord[])
    : [];
  const cxpLoadedCias: Record<string, string> = {};
  if (o.cxpLoadedCias && typeof o.cxpLoadedCias === 'object') {
    for (const [k, val] of Object.entries(o.cxpLoadedCias as Record<string, unknown>)) {
      if (typeof val === 'string') cxpLoadedCias[k] = val;
    }
  }

  // Cobranza (CXC) — v7+. v6 payloads simply lack these keys and fall back to
  // empty defaults, which lets the auto-fetch effect populate them on boot.
  // Importante: si el record cargado trae `raw` (heredado de un cache de
  // antes del fix de crash), lo eliminamos al cargar para que el siguiente
  // save no vuelva a persistirlo. Esto cura los browsers de los usuarios
  // que ya tenían un store inflado en localStorage.
  const cobranzaRecords = Array.isArray(o.cobranzaRecords)
    ? (o.cobranzaRecords
        .filter((r) => !!r && typeof r === 'object')
        .map((r) => {
          const rec = r as Record<string, unknown>;
          if ('raw' in rec) {
            const { raw: _drop, ...rest } = rec;
            void _drop;
            return rest as unknown as CobranzaRecord;
          }
          return r as CobranzaRecord;
        }) as CobranzaRecord[])
    : [];
  const cobranzaLoadedCias: Record<string, string> = {};
  if (o.cobranzaLoadedCias && typeof o.cobranzaLoadedCias === 'object') {
    for (const [k, val] of Object.entries(o.cobranzaLoadedCias as Record<string, unknown>)) {
      if (typeof val === 'string') cobranzaLoadedCias[k] = val;
    }
  }

  return {
    providers,
    clients,
    confirmedPayments,
    cxpRecords,
    cxpLoadedCias,
    cobranzaRecords,
    cobranzaLoadedCias,
    cashFlowOverrides: normalizeOverrides(o.cashFlowOverrides),
    assumptions: normalizeAssumptions(o.assumptions, base.assumptions),
    lastSaved: typeof o.lastSaved === 'string' ? o.lastSaved : base.lastSaved,
  };
}

function normalizeOverrides(v: unknown): CashFlowOverrides {
  if (!v || typeof v !== 'object') return {};
  const out: CashFlowOverrides = {};
  for (const [ym, val] of Object.entries(v as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}$/.test(ym) || !val || typeof val !== 'object') continue;
    const entry = val as Record<string, unknown>;
    const income = typeof entry.income === 'number' && isFinite(entry.income) ? entry.income : undefined;
    const expense = typeof entry.expense === 'number' && isFinite(entry.expense) ? entry.expense : undefined;
    if (income === undefined && expense === undefined) continue;
    out[ym] = { ...(income !== undefined ? { income } : {}), ...(expense !== undefined ? { expense } : {}) };
  }
  return out;
}

// ── Backend IndexedDB (preferido) ────────────────────────────────────────
// localStorage tiene un cap de ~5MB y serializa/parsea SÍNCRONAMENTE en el
// main thread. Con datasets grandes (cobranza productiva: ~30k facturas en
// las 8 cías → ~6-8MB serializado) chocábamos contra el quota y, aunque el
// catch silenciaba el throw, el costo del JSON.stringify de 4MB ya bloqueaba
// el thread varios cientos de ms en cada escritura. IndexedDB no tiene cap
// práctico (cuotas por origen del orden de cientos de MB) y la transacción
// corre fuera del main thread una vez disparada. Mantenemos localStorage
// como fallback sincrónico (tests, browsers viejos, unload flush).

const IDB_NAME = 'midas-db';
const IDB_VERSION = 1;
const IDB_STORE = 'kv';
const IDB_KEY = STORAGE_KEY; // mismo nombre que en localStorage para simetría.

function openIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(IDB_NAME, IDB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

async function idbPut(value: unknown): Promise<boolean> {
  const db = await openIdb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, IDB_KEY);
      tx.oncomplete = () => { db.close(); resolve(true); };
      tx.onerror = () => { db.close(); resolve(false); };
      tx.onabort = () => { db.close(); resolve(false); };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

async function idbGet(): Promise<unknown> {
  const db = await openIdb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => { db.close(); resolve(req.result); };
      req.onerror = () => { db.close(); resolve(undefined); };
    } catch {
      db.close();
      resolve(undefined);
    }
  });
}

async function idbDelete(): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); resolve(); };
    } catch {
      db.close();
      resolve();
    }
  });
}

// ── API pública ──────────────────────────────────────────────────────────

/**
 * Persiste el store en localStorage (síncrono).
 *
 * Mantenido por compatibilidad: tests y el path de unload sincrónico siguen
 * usándolo. En runtime de la app preferimos `saveStoreAsync` que escribe en
 * IndexedDB y NO bloquea el main thread.
 */
export function saveStore(store: MidasStore): void {
  const payload = { version: STORE_VERSION, data: store };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    // Silenciar quota — la app debe seguir viva aunque persistencia falle.
    // eslint-disable-next-line no-console
    console.warn('[persistence] saveStore failed:', err);
  }
}

/**
 * Persiste el store en IndexedDB. Async-safe, sin cap de 5MB.
 *
 * Si IDB no está disponible (Node tests, modo incógnito en algunos browsers
 * viejos), cae a `saveStore` para que la app siga funcional.
 */
export async function saveStoreAsync(store: MidasStore): Promise<void> {
  const payload = { version: STORE_VERSION, data: store };
  const ok = await idbPut(payload);
  if (!ok) {
    // Fallback sincrónico — peor pero al menos algo persiste.
    saveStore(store);
  } else {
    // Si la escritura a IDB tuvo éxito, limpiamos la copia legacy en
    // localStorage para no dejarlas desincronizadas. Después de la primera
    // migración exitosa esto es no-op.
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }
}

/**
 * Lee el store desde IndexedDB. Si IDB no tiene datos pero localStorage sí,
 * migra automáticamente y devuelve el store migrado. Esto cubre el primer
 * boot tras adoptar IDB sin perder datos del usuario.
 */
export async function loadStoreAsync(): Promise<MidasStore | null> {
  // 1. IDB primero — fuente de verdad post-migración.
  try {
    const raw = await idbGet();
    if (raw && typeof raw === 'object') {
      const payload = raw as { version?: number; data?: unknown };
      if (payload.data !== undefined) {
        return normalizeStore(payload.data);
      }
    }
  } catch {
    // fallthrough a localStorage
  }

  // 2. localStorage — fallback y origen para migración.
  const fromLs = loadStore();
  if (fromLs) {
    // Migrar a IDB para que las próximas escrituras vayan ahí.
    void saveStoreAsync(fromLs);
    return fromLs;
  }

  return null;
}

/**
 * Carga sincrónica desde localStorage. Mantenida para tests y para el
 * unload-flush cuando no podemos esperar a IDB. Maneja todas las migraciones
 * de stores legacy (midas-v6/v5, flowsense-v5, flowsense-v1..v4).
 */
export function loadStore(): MidasStore | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const payload = JSON.parse(raw) as { version?: number; data?: unknown };
      if (payload && typeof payload === 'object' && payload.data !== undefined) {
        return normalizeStore(payload.data);
      }
    }
  } catch {
    // fallthrough
  }

  // Same-shape migrations — el normalizer ya rellena los campos nuevos de v7
  // (cobranzaRecords/cobranzaLoadedCias) con defaults vacíos, así que basta
  // con re-guardar bajo la nueva clave y limpiar la vieja.
  //
  //   midas-v6 → midas-v7: solo agregamos cobranza (no se descarta nada).
  //   midas-v5 / flowsense-v5 → midas-v7: descartar propuestas/escenarios
  //     legacy (`normalizeStore` los ignora) y agregar cobranza vacía.
  for (const legacyKey of SAME_SCHEMA_LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(legacyKey);
      if (!raw) continue;
      const payload = JSON.parse(raw) as { version?: number; data?: unknown };
      if (payload && typeof payload === 'object' && payload.data !== undefined) {
        const isV6 = legacyKey === 'midas-v6';
        // eslint-disable-next-line no-console
        console.info(
          `[persistence] migrando ${legacyKey} → ${STORAGE_KEY}` +
            (isV6 ? '; agregando cobranza vacía.' : '; descartando propuestas/escenarios legacy.'),
        );
        const migrated = normalizeStore(payload.data);
        saveStore(migrated);
        try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
        return migrated;
      }
    } catch {
      // fallthrough
    }
  }

  // Stores legacy v1..v4: modelo de propuestas/escenarios totalmente
  // incompatible. Conservamos los datos independientes (clientes, proveedores,
  // cxp, assumptions, confirmedPayments).
  for (const legacyKey of LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(legacyKey);
      if (!raw) continue;
      const payload = JSON.parse(raw) as { version?: number; data?: unknown };
      const legacy = (payload && typeof payload === 'object' && payload.data
        ? payload.data
        : payload) as Record<string, unknown>;
      // eslint-disable-next-line no-console
      console.info(`[persistence] encontrado store legacy ${legacyKey}; migrando datos independientes y descartando propuestas/escenarios.`);
      const seed: MidasStore = {
        ...getDefaultStore(),
        providers: Array.isArray(legacy.providers) ? (legacy.providers as Provider[]) : [],
        clients: Array.isArray(legacy.clients) ? (legacy.clients as Client[]) : [],
        confirmedPayments: Array.isArray(legacy.confirmedPayments) ? (legacy.confirmedPayments as ConfirmedPayment[]) : [],
        cxpRecords: Array.isArray(legacy.cxpRecords) ? (legacy.cxpRecords as CXPRecord[]) : [],
        cxpLoadedCias: (legacy.cxpLoadedCias && typeof legacy.cxpLoadedCias === 'object'
          ? (legacy.cxpLoadedCias as Record<string, string>) : {}),
        assumptions: (legacy.assumptions && typeof legacy.assumptions === 'object'
          ? (legacy.assumptions as CashFlowAssumptions)
          : getDefaultStore().assumptions),
      };
      saveStore(seed);
      try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
      return seed;
    } catch {
      // try next legacy key
    }
  }

  return null;
}

export function clearStore(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    for (const k of SAME_SCHEMA_LEGACY_KEYS) localStorage.removeItem(k);
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  } catch {
    // ignore
  }
  // Best-effort fire-and-forget: limpia IDB también. Si falla no importa
  // (la app re-fetchea data del API en el próximo boot).
  void idbDelete();
}

export function exportStore(store: MidasStore): string {
  return JSON.stringify({ version: STORE_VERSION, data: store }, null, 2);
}

export function importStore(json: string): MidasStore {
  const parsed = JSON.parse(json) as { version?: number; data?: unknown };
  if (!parsed || typeof parsed !== 'object' || parsed.data === undefined) {
    throw new Error('Formato de respaldo inválido.');
  }
  return normalizeStore(parsed.data);
}
