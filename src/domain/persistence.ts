/**
 * Persistence layer for FlowSense — v5 (clean slate).
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
 */

import { Proposal, Scenario } from '../types';
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

export interface FlowSenseStore {
  proposals: Proposal[];
  scenarios: Scenario[];
  activeScenarioId: string | null; // null = sin escenario cargado (base)
  providers: Provider[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  cxpRecords: CXPRecord[];
  cxpLoadedCias: Record<string, string>;
  lastSaved: string;
}

const STORE_VERSION = 5;
const STORAGE_KEY = 'flowsense-v5';
const LEGACY_KEYS = ['flowsense-v4', 'flowsense-v3', 'flowsense-v2', 'flowsense-v1'];

function isoNow(): string {
  return new Date().toISOString();
}

export function getDefaultStore(): FlowSenseStore {
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
    lastSaved: isoNow(),
  };
}

// ── Normalizadores defensivos ────────────────────────────────────────────

function normalizeProposal(v: unknown): Proposal | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  const kind = o.kind === 'income_increase' || o.kind === 'expense_saving' ? o.kind : null;
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

function normalizeStore(raw: unknown): FlowSenseStore {
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

  return {
    ...base,
    ...(o as Partial<FlowSenseStore>),
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
    assumptions: (o.assumptions && typeof o.assumptions === 'object')
      ? (o.assumptions as CashFlowAssumptions)
      : base.assumptions,
  };
}

// ── API pública ──────────────────────────────────────────────────────────

export function saveStore(store: FlowSenseStore): void {
  const payload = { version: STORE_VERSION, data: store };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    // Silenciar quota — la app debe seguir viva aunque persistencia falle.
    // eslint-disable-next-line no-console
    console.warn('[persistence] saveStore failed:', err);
  }
}

export function loadStore(): FlowSenseStore | null {
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
      const seed: FlowSenseStore = {
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
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

export function exportStore(store: FlowSenseStore): string {
  return JSON.stringify({ version: STORE_VERSION, data: store }, null, 2);
}

export function importStore(json: string): FlowSenseStore {
  const parsed = JSON.parse(json) as { version?: number; data?: unknown };
  if (!parsed || typeof parsed !== 'object' || parsed.data === undefined) {
    throw new Error('Formato de respaldo inválido.');
  }
  return normalizeStore(parsed.data);
}
