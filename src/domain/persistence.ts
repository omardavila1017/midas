/**
 * Persistence layer for Midas — v8.
 *
 * v8 adds IndicadoresCobranza payments (recibos/aplicaciones) as the
 * bridge between bank deposits and CXC invoices.
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
 *   - midas-v7 → midas-v8: ADD cobranzaPayments /
 *     cobranzaPaymentsLoadedCias as empty defaults.
 *   - midas-v6 → midas-v8: ADD cobranzaRecords/cobranzaLoadedCias and
 *     cobranzaPayments/cobranzaPaymentsLoadedCias as empty defaults.
 *   - midas-v5 → midas-v8: drop proposals/scenarios/activeScenarioId, keep
 *     the rest as-is and add the new cobranza caches.
 *   - flowsense-v5 → midas-v8: same shape rebrand, dropping the simulation
 *     fields and adding cobranza caches.
 *   - flowsense-v1..v4 → midas-v8: incompatible simulation models; keep only
 *     the catalog/CXP/assumptions data.
 */

import { CashFlowOverrides } from '../types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './types';
import type { CobranzaPayment, CobranzaRecord } from '../services/jdeTypes';

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
  /**
   * Pagos/recibos de IndicadoresCobranza, agrupados por Id Pago. Se usan
   * como capa intermedia banco → recibo → facturas.
   */
  cobranzaPayments: CobranzaPayment[];
  /** Per-cia ISO timestamp del último refresh exitoso de IndicadoresCobranza. */
  cobranzaPaymentsLoadedCias: Record<string, string>;
  cashFlowOverrides: CashFlowOverrides;
  lastSaved: string;
}

const STORE_VERSION = 8;
const STORAGE_KEY = 'midas-v8';
// v5-v7 live at compatible shapes minus newer cobranza fields — `normalizeStore`
// defaults them to empty arrays, so those payloads load transparently.
const SAME_SCHEMA_LEGACY_KEYS = ['midas-v7', 'midas-v6', 'midas-v5', 'flowsense-v5'];
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
    cobranzaPayments: [],
    cobranzaPaymentsLoadedCias: {},
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

  // Cobranza (CXC) — v7+. Older payloads simply lack these keys and fall back
  // to empty defaults, which lets the auto-fetch effect populate them on boot.
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
  const cobranzaPayments = Array.isArray(o.cobranzaPayments)
    ? (o.cobranzaPayments.filter((r) => !!r && typeof r === 'object') as CobranzaPayment[])
    : [];
  const cobranzaPaymentsLoadedCias: Record<string, string> = {};
  if (o.cobranzaPaymentsLoadedCias && typeof o.cobranzaPaymentsLoadedCias === 'object') {
    for (const [k, val] of Object.entries(o.cobranzaPaymentsLoadedCias as Record<string, unknown>)) {
      if (typeof val === 'string') cobranzaPaymentsLoadedCias[k] = val;
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
    cobranzaPayments,
    cobranzaPaymentsLoadedCias,
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

// ── API pública ──────────────────────────────────────────────────────────

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

  // Same-shape migrations — el normalizer ya rellena los campos nuevos
  // (cobranzaRecords/cobranzaLoadedCias y cobranzaPayments/
  // cobranzaPaymentsLoadedCias) con defaults vacíos, así que basta con
  // re-guardar bajo la nueva clave y limpiar la vieja.
  //
  //   midas-v6/v7 → midas-v8: solo agregamos caches de cobranza faltantes.
  //   midas-v5 / flowsense-v5 → midas-v8: descartar propuestas/escenarios
  //     legacy (`normalizeStore` los ignora) y agregar caches vacíos.
  for (const legacyKey of SAME_SCHEMA_LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(legacyKey);
      if (!raw) continue;
      const payload = JSON.parse(raw) as { version?: number; data?: unknown };
      if (payload && typeof payload === 'object' && payload.data !== undefined) {
        const dropsLegacySimulation = legacyKey === 'midas-v5' || legacyKey === 'flowsense-v5';
        // eslint-disable-next-line no-console
        console.info(
          `[persistence] migrando ${legacyKey} → ${STORAGE_KEY}` +
            (dropsLegacySimulation
              ? '; descartando propuestas/escenarios legacy.'
              : '; agregando caches de cobranza faltantes.'),
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
