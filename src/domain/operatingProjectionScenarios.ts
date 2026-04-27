import type {
  ManualExpenseEvent,
  OperatingAdjustment,
  OperatingSupplierPaymentOverride,
} from './operatingProjectionModule';
import {
  normalizeOperatingTaxDebt,
  type OperatingTaxDebt,
} from './operatingProjectionTaxes';

const STORAGE_KEY = 'midas.operating.scenarios.v1';
const ACTIVE_KEY = 'midas.operating.activeScenario.v1';

export interface OperatingProjectionScenario {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  owner?: string;
  role?: string;
  auditLog?: Array<{
    id: string;
    at: string;
    user: string;
    scenarioId: string;
    action: string;
    reason: string;
    detail: string;
    impact: string;
  }>;
  manualExpenseEvents: ManualExpenseEvent[];
  operatingAdjustments: OperatingAdjustment[];
  supplierPaymentOverrides: OperatingSupplierPaymentOverride[];
  taxDebts: OperatingTaxDebt[];
}

export function createOperatingProjectionScenario(
  name: string,
  seed?: Partial<OperatingProjectionScenario>,
): OperatingProjectionScenario {
  const now = new Date().toISOString();
  return {
    id: `scenario-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: now,
    updatedAt: now,
    owner: seed?.owner,
    role: seed?.role,
    auditLog: seed?.auditLog ?? [],
    manualExpenseEvents: seed?.manualExpenseEvents ?? [],
    operatingAdjustments: seed?.operatingAdjustments ?? [],
    supplierPaymentOverrides: seed?.supplierPaymentOverrides ?? [],
    taxDebts: seed?.taxDebts ?? [],
  };
}

export function baseOperatingProjectionScenario(
  manualExpenseEvents: ManualExpenseEvent[] = [],
  operatingAdjustments: OperatingAdjustment[] = [],
): OperatingProjectionScenario {
  const now = new Date().toISOString();
  return {
    id: 'base',
    name: 'Base',
    createdAt: now,
    updatedAt: now,
    owner: 'Sistema',
    role: 'base',
    auditLog: [],
    manualExpenseEvents,
    operatingAdjustments,
    supplierPaymentOverrides: [],
    taxDebts: [],
  };
}

export function loadOperatingProjectionScenarios(
  fallbackManualEvents: ManualExpenseEvent[] = [],
  fallbackAdjustments: OperatingAdjustment[] = [],
): OperatingProjectionScenario[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [baseOperatingProjectionScenario(fallbackManualEvents, fallbackAdjustments)];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [baseOperatingProjectionScenario(fallbackManualEvents, fallbackAdjustments)];
    const scenarios = parsed
      .map((value, index) => normalizeScenario(value, index))
      .filter((value): value is OperatingProjectionScenario => value !== null)
      .map((scenario) => (
        scenario.id === 'base' && scenario.manualExpenseEvents.length === 0 && fallbackManualEvents.length > 0
          ? { ...scenario, manualExpenseEvents: fallbackManualEvents }
          : scenario
      ))
      .map((scenario) => (
        scenario.id === 'base' && scenario.operatingAdjustments.length === 0 && fallbackAdjustments.length > 0
          ? { ...scenario, operatingAdjustments: fallbackAdjustments }
          : scenario
      ));
    return scenarios.length > 0 ? scenarios : [baseOperatingProjectionScenario(fallbackManualEvents, fallbackAdjustments)];
  } catch {
    return [baseOperatingProjectionScenario(fallbackManualEvents, fallbackAdjustments)];
  }
}

export function saveOperatingProjectionScenarios(scenarios: OperatingProjectionScenario[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scenarios));
  } catch {
    // quota o serialization — ignoramos, la app sigue viva.
  }
}

export function loadActiveOperatingScenarioId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function saveActiveOperatingScenarioId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, id);
  } catch {
    // quota o serialization — ignoramos, la app sigue viva.
  }
}

function normalizeScenario(value: unknown, index: number): OperatingProjectionScenario | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `scenario-${index}`;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Escenario ${index + 1}`;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
  const manualExpenseEvents = Array.isArray(raw.manualExpenseEvents)
    ? raw.manualExpenseEvents.map(normalizeManualExpenseEvent).filter((item): item is ManualExpenseEvent => item !== null)
    : [];
  const operatingAdjustments = Array.isArray(raw.operatingAdjustments)
    ? raw.operatingAdjustments.map(normalizeAdjustment).filter((item): item is OperatingAdjustment => item !== null)
    : [];
  const supplierPaymentOverrides = Array.isArray(raw.supplierPaymentOverrides)
    ? raw.supplierPaymentOverrides.map(normalizeSupplierOverride).filter((item): item is OperatingSupplierPaymentOverride => item !== null)
    : [];
  const taxDebts = Array.isArray(raw.taxDebts)
    ? raw.taxDebts.map(normalizeOperatingTaxDebt).filter((item): item is OperatingTaxDebt => item !== null)
    : [];
  const auditLog = Array.isArray(raw.auditLog)
    ? raw.auditLog.map(normalizeAuditEntry).filter((item): item is NonNullable<OperatingProjectionScenario['auditLog']>[number] => item !== null)
    : [];

  return {
    id,
    name,
    createdAt,
    updatedAt,
    owner: typeof raw.owner === 'string' && raw.owner.trim() ? raw.owner.trim() : undefined,
    role: typeof raw.role === 'string' && raw.role.trim() ? raw.role.trim() : undefined,
    auditLog,
    manualExpenseEvents,
    operatingAdjustments,
    supplierPaymentOverrides,
    taxDebts,
  };
}

function normalizeAuditEntry(value: unknown): NonNullable<OperatingProjectionScenario['auditLog']>[number] | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  const at = typeof raw.at === 'string' && raw.at.trim() ? raw.at.trim() : null;
  const user = typeof raw.user === 'string' && raw.user.trim() ? raw.user.trim() : null;
  const scenarioId = typeof raw.scenarioId === 'string' && raw.scenarioId.trim() ? raw.scenarioId.trim() : null;
  const action = typeof raw.action === 'string' && raw.action.trim() ? raw.action.trim() : null;
  if (!id || !at || !user || !scenarioId || !action) return null;
  return {
    id,
    at,
    user,
    scenarioId,
    action,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    detail: typeof raw.detail === 'string' ? raw.detail : '',
    impact: typeof raw.impact === 'string' ? raw.impact : '',
  };
}

function normalizeManualExpenseEvent(value: unknown): ManualExpenseEvent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const concept = typeof raw.concept === 'string' && raw.concept.trim() ? raw.concept.trim() : null;
  const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  const amount = typeof raw.amount === 'number' ? raw.amount : typeof raw.amount === 'string' ? Number(raw.amount) : NaN;
  if (!concept || !date || !Number.isFinite(amount) || amount < 0) return null;
  if (amount === 0 && concept !== 'Impuestos') return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined,
    concept,
    date,
    amount,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined,
    allowPartial: Boolean(raw.allowPartial),
  };
}

function normalizeAdjustment(value: unknown): OperatingAdjustment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  const direction = raw.direction === 'inflow' || raw.direction === 'outflow' ? raw.direction : null;
  const amount = typeof raw.amount === 'number' ? raw.amount : typeof raw.amount === 'string' ? Number(raw.amount) : NaN;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : null;
  if (!date || !direction || !Number.isFinite(amount) || amount <= 0 || !label) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined,
    date,
    label,
    amount,
    direction,
    affectsCash: raw.affectsCash !== false,
    category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : undefined,
  };
}

function normalizeSupplierOverride(value: unknown): OperatingSupplierPaymentOverride | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const invoiceKey = typeof raw.invoiceKey === 'string' && raw.invoiceKey.trim() ? raw.invoiceKey.trim() : null;
  const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  const amount = typeof raw.amount === 'number' ? raw.amount : typeof raw.amount === 'string' ? Number(raw.amount) : NaN;
  if (!invoiceKey || !date || !Number.isFinite(amount) || amount < 0) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined,
    invoiceKey,
    providerName: typeof raw.providerName === 'string' && raw.providerName.trim() ? raw.providerName.trim() : undefined,
    supplierNumber: typeof raw.supplierNumber === 'string' && raw.supplierNumber.trim() ? raw.supplierNumber.trim() : undefined,
    invoiceNumber: typeof raw.invoiceNumber === 'string' && raw.invoiceNumber.trim() ? raw.invoiceNumber.trim() : undefined,
    date,
    amount,
    note: typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined,
  };
}
