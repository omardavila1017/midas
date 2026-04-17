/**
 * Persistence Layer — localStorage-based state management for FlowSense
 *
 * Handles serialization, deserialization, and validation of the entire app state.
 * All data is stored under the key 'flowsense-v1' with version tracking for
 * future migration support.
 *
 * Usage:
 *   - On app init: const store = loadStore() ?? getDefaultStore()
 *   - After state change: saveStore({ plan, proposals, ... })
 *   - For data export: const json = exportStore()
 *   - For data import: const store = importStore(json)
 */

import { FlowPlan, Proposal, Scenario } from '../types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './types';

/**
 * CXP Record — represents a single accounts payable entry.
 * Extracted from CSV uploads in CXP.tsx.
 */
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

/**
 * Complete app state shape — contains all mutable user data.
 */
export interface FlowSenseStore {
  plan: FlowPlan | null;
  proposals: Proposal[];
  scenarios: Scenario[];
  providers: Provider[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  cxpRecords: CXPRecord[];
  lastSaved: string; // ISO 8601 datetime
}

/**
 * Current storage schema version.
 * Increment when making breaking changes to FlowSenseStore shape.
 */
const STORE_VERSION = 1;

/**
 * localStorage key for all FlowSense data.
 */
const STORAGE_KEY = 'flowsense-v1';

/**
 * Returns a fresh, empty store with sensible defaults.
 * Use this as a fallback when loading fails or on first run.
 */
export function getDefaultStore(): FlowSenseStore {
  const currentYear = new Date().getFullYear();
  return {
    plan: null,
    proposals: [],
    scenarios: [],
    providers: [],
    clients: [],
    assumptions: {
      year: currentYear,
      globalCompliance: 1,
      factorajeDays: 30,
    },
    confirmedPayments: [],
    cxpRecords: [],
    lastSaved: new Date().toISOString(),
  };
}

/**
 * Saves the complete store to localStorage.
 *
 * @param store The current application state
 * @throws May throw if localStorage is full or unavailable
 */
export function saveStore(store: FlowSenseStore): void {
  const payload = {
    version: STORE_VERSION,
    data: store,
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.error('Failed to save store to localStorage:', error);
    throw new Error(
      `Failed to save app state: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Loads the store from localStorage.
 * Returns null if the key doesn't exist, is empty, or corrupt.
 * Falls back to defaults for missing fields.
 *
 * @returns The loaded store, or null if not found/corrupt
 */
export function loadStore(): FlowSenseStore | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const payload = JSON.parse(raw);

    // Validate version
    if (payload.version !== STORE_VERSION) {
      console.warn(
        `Store version mismatch: found ${payload.version}, expected ${STORE_VERSION}. ` +
        'Using defaults and discarding old data.'
      );
      return null;
    }

    const data = payload.data as Partial<FlowSenseStore>;

    // Merge with defaults for any missing fields
    const store: FlowSenseStore = {
      plan: data.plan ?? null,
      proposals: Array.isArray(data.proposals) ? data.proposals : [],
      scenarios: Array.isArray(data.scenarios) ? data.scenarios : [],
      providers: Array.isArray(data.providers) ? data.providers : [],
      clients: Array.isArray(data.clients) ? data.clients : [],
      assumptions: {
        year: data.assumptions?.year ?? new Date().getFullYear(),
        globalCompliance: data.assumptions?.globalCompliance ?? 1,
        factorajeDays: data.assumptions?.factorajeDays ?? 30,
      },
      confirmedPayments: Array.isArray(data.confirmedPayments)
        ? data.confirmedPayments
        : [],
      cxpRecords: Array.isArray(data.cxpRecords) ? data.cxpRecords : [],
      lastSaved: data.lastSaved ?? new Date().toISOString(),
    };

    return store;
  } catch (error) {
    console.error('Failed to load store from localStorage:', error);
    return null;
  }
}

/**
 * Removes the store from localStorage entirely.
 * Use when the user explicitly clears/resets the app.
 */
export function clearStore(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear store from localStorage:', error);
  }
}

/**
 * Exports the store as a JSON string suitable for download or sharing.
 * Includes version info and pretty formatting for readability.
 *
 * @param store The store to export
 * @returns JSON string with 2-space indentation
 */
export function exportStore(store: FlowSenseStore): string {
  const payload = {
    version: STORE_VERSION,
    exportedAt: new Date().toISOString(),
    data: store,
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Imports a previously exported store from a JSON string.
 * Validates structure and version before accepting.
 *
 * @param json A JSON string previously generated by exportStore()
 * @returns The parsed and validated store
 * @throws If JSON is invalid, version mismatch, or required fields are missing
 */
export function importStore(json: string): FlowSenseStore {
  let payload: unknown;

  // Parse JSON
  try {
    payload = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  // Validate structure
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('JSON must be an object');
  }

  const obj = payload as Record<string, unknown>;

  // Check version
  if (obj.version !== STORE_VERSION) {
    throw new Error(
      `Version mismatch: imported data is v${obj.version}, app expects v${STORE_VERSION}`
    );
  }

  if (typeof obj.data !== 'object' || obj.data === null) {
    throw new Error('Missing or invalid "data" field');
  }

  const data = obj.data as Partial<FlowSenseStore>;

  // Validate and reconstruct
  const store: FlowSenseStore = {
    plan: data.plan ?? null,
    proposals: validateArray(data.proposals, 'proposals'),
    scenarios: validateArray(data.scenarios, 'scenarios'),
    providers: validateArray(data.providers, 'providers'),
    clients: validateArray(data.clients, 'clients'),
    assumptions: validateAssumptions(data.assumptions),
    confirmedPayments: validateArray(data.confirmedPayments, 'confirmedPayments'),
    cxpRecords: validateArray(data.cxpRecords, 'cxpRecords'),
    lastSaved: validateISODate(data.lastSaved, 'lastSaved'),
  };

  return store;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers — validation and type guards
// ─────────────────────────────────────────────────────────────────────────

/**
 * Validates that a value is an array, returning it or an empty array.
 */
function validateArray<T>(value: unknown, fieldName: string): T[] {
  if (!Array.isArray(value)) {
    console.warn(
      `Field "${fieldName}" is not an array; using default empty array`
    );
    return [];
  }
  return value;
}

/**
 * Validates CashFlowAssumptions structure, using defaults for missing fields.
 */
function validateAssumptions(
  value: unknown
): CashFlowAssumptions {
  if (typeof value !== 'object' || value === null) {
    console.warn('assumptions is not an object; using defaults');
    return {
      year: new Date().getFullYear(),
      globalCompliance: 1,
      factorajeDays: 30,
    };
  }

  const obj = value as Record<string, unknown>;

  return {
    year:
      typeof obj.year === 'number' && obj.year > 1900
        ? obj.year
        : new Date().getFullYear(),
    globalCompliance:
      typeof obj.globalCompliance === 'number' && obj.globalCompliance >= 0
        ? obj.globalCompliance
        : 1,
    factorajeDays:
      typeof obj.factorajeDays === 'number' && obj.factorajeDays > 0
        ? obj.factorajeDays
        : 30,
  };
}

/**
 * Validates that a value is a valid ISO 8601 datetime string.
 */
function validateISODate(value: unknown, fieldName: string): string {
  if (typeof value === 'string') {
    try {
      new Date(value).toISOString();
      return value;
    } catch {
      // Fall through to default
    }
  }

  console.warn(`Field "${fieldName}" is not a valid ISO date; using current time`);
  return new Date().toISOString();
}
