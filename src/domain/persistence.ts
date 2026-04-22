/**
 * Persistence layer for Midas — v5 (clean slate).
 *
 * Este archivo reemplaza a la persistencia vieja (v1..v4). El modelo anterior
 * tenía Simulación > Escenario > Propuesta con un compilador de efectos; se
 * reemplazó por un modelo mucho más simple:
 *
 *   Proposal: id + name + kind ('income_increase' | 'expense_saving') +
 *             amount + startYearMonth + frequency + enabled
 *   Scenario: id + name + proposalStates (snapshot de {proposalId -> enabled})
 *
 * Al cargar desde un store antiguo (flowsense-v1..v4) se descarta el contenido
 * de propuestas/escenarios/simulaciones — el modelo es incompatible. Se
 * conservan los demás campos (clientes, proveedores, confirmedPayments,
 * cxpRecords, assumptions) para no perder trabajo del usuario.
 *
 * El store `flowsense-v5` se migra como-está porque comparte esquema (rebrand
 * a Midas).
 */

import { Proposal, Scenario, CashFlowOverrides } from '../types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './types';

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
  proposals: Proposal[];
  scenarios: Scenario[];
  activeScenarioId: string | null; // null = sin escenario cargado (base)
  providers: Provider[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  cxpRecords: CXPRecord[];
  cxpLoadedCias: Record<string, string>;
  cashFlowOverrides: CashFlowOverrides;
  lastSaved: string;
}

const STORE_VERSION = 5;
const STORAGE_KEY = 'midas-v5';
const SAME_SCHEMA_LEGACY_KEY = 'flowsense-v5';
const LEGACY_KEYS = ['flowsense-v4', 'flowsense-v3', 'flowsense-v2', 'flowsense-v1'];

function isoNow(): string {
  return new Date().toISOString();
}

export function getDefaultStore(): MidasStore {
  return {
    proposals: [],
    scenarios: [],
    activeScenarioId: null,
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
    cashFlowOverrides: {},
    lastSaved: isoNow(),
  };
}

// ── Normalizadores defensivos ────────────────────────────────────────────

function normalizeProposal(v: unknown): Proposal | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  const kind =
    o.kind === 'income_increase' || o.kind === 'expense_saving'
      || o.kind === 'new_expense' || o.kind === 'revenue_loss'
      ? o.kind : null;
  if (!kind) return null;
  const frequency = (o.frequency === 'one_time' || o.frequency === 'monthly'
    || o.frequency === 'quarterly' || o.frequency === 'semiannual')
    ? o.frequency : 'monthly';
  const amount = typeof o.amount === 'number' && isFinite(o.amount) ? Math.abs(o.amount) : 0;
  const startYearMonth = typeof o.startYearMonth === 'string' && /^\d{4}-\d{2}$/.test(o.startYearMonth)
    ? o.startYearMonth
    : new Date().toISOString().slice(0, 7);
  return {
    id: o.id,
    name: typeof o.name === 'string' && o.name.trim() ? o.name : 'Propuesta sin nombre',
    description: typeof o.description === 'string' ? o.description : undefined,
    kind,
    amount,
    startYearMonth,
    frequency,
    enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : isoNow(),
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : isoNow(),
  };
}

function normalizeScenario(v: unknown): Scenario | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  const states: Record<string, boolean> = {};
  if (o.proposalStates && typeof o.proposalStates === 'object') {
    for (const [k, val] of Object.entries(o.proposalStates as Record<string, unknown>)) {
      if (typeof val === 'boolean') states[k] = val;
    }
  }
  return {
    id: o.id,
    name: typeof o.name === 'string' && o.name.trim() ? o.name : 'Escenario sin nombre',
    description: typeof o.description === 'string' ? o.description : undefined,
    proposalStates: states,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : isoNow(),
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : isoNow(),
  };
}

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

  const proposals = Array.isArray(o.proposals)
    ? (o.proposals.map(normalizeProposal).filter(Boolean) as Proposal[])
    : [];
  const scenarios = Array.isArray(o.scenarios)
    ? (o.scenarios.map(normalizeScenario).filter(Boolean) as Scenario[])
    : [];

  const activeScenarioId = typeof o.activeScenarioId === 'string'
    && scenarios.some((s) => s.id === o.activeScenarioId)
    ? (o.activeScenarioId as string)
    : null;

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

  return {
    proposals,
    scenarios,
    activeScenarioId,
    providers: Array.isArray(o.providers) ? (o.providers as Provider[]) : [],
    clients: Array.isArray(o.clients) ? (o.clients as Client[]) : [],
    confirmedPayments: Array.isArray(o.confirmedPayments) ? (o.confirmedPayments as ConfirmedPayment[]) : [],
    cxpRecords: Array.isArray(o.cxpRecords) ? (o.cxpRecords as CXPRecord[]) : [],
    cxpLoadedCias: typeof o.cxpLoadedCias === 'object' && o.cxpLoadedCias !== null
      ? (o.cxpLoadedCias as Record<string, string>)
      : {},
    cashFlowOverrides: normalizeOverrides(o.cashFlowOverrides),
    assumptions: (o.assumptions && typeof o.assumptions === 'object')
      ? (o.assumptions as CashFlowAssumptions)
      : base.assumptions,
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

  // Rebrand: flowsense-v5 comparte esquema con midas-v5, se migra tal cual.
  try {
    const raw = localStorage.getItem(SAME_SCHEMA_LEGACY_KEY);
    if (raw) {
      const payload = JSON.parse(raw) as { version?: number; data?: unknown };
      if (payload && typeof payload === 'object' && payload.data !== undefined) {
        const migrated = normalizeStore(payload.data);
        saveStore(migrated);
        try { localStorage.removeItem(SAME_SCHEMA_LEGACY_KEY); } catch { /* ignore */ }
        return migrated;
      }
    }
  } catch {
    // fallthrough
  }

  // Si hay un store legacy (v1..v4), NO intentamos migrar propuestas /
  // escenarios — el modelo es incompatible. Conservamos sólo los datos
  // independientes (clientes, proveedores, cxp, assumptions, confirmedPayments).
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
      // Persistir la nueva forma y borrar la vieja para que el mensaje no
      // vuelva a salir en el próximo load.
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
    localStorage.removeItem(SAME_SCHEMA_LEGACY_KEY);
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
