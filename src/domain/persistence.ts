/**
 * Persistence layer for FlowSense.
 *
 * v2 migrates the legacy "proposal impact" model into:
 *   Proposal -> Scenario -> Simulation
 * and moves forecast overrides to scenario scope.
 */

import {
  BASE_SCENARIO_ID,
  FlowPlan,
  Proposal,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_INCOME,
  Scenario,
  ScenarioCellOverride,
  Simulation,
  SimulationCategory,
  scenarioCellKey,
} from '../types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './types';
import { buildSimulationEffects, ensureBaseScenario } from './simulationCompiler';
import { DEFAULT_ACTIVE_KPI_IDS, type CustomKpiDefinition } from './kpiCatalog';

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
  plan: FlowPlan | null;
  proposals: Proposal[];
  scenarios: Scenario[];
  simulations: Simulation[];
  activeKpiIds: string[];
  customKpis: CustomKpiDefinition[];
  scenarioCellOverrides: ScenarioCellOverride[];
  activeProposalId: string | null;
  activeScenarioId: string | null;
  providers: Provider[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  cxpRecords: CXPRecord[];
  /** ISO timestamp of last JDE sync per cia. Empty when only CSV upload was used. */
  cxpLoadedCias: Record<string, string>;
  lastSaved: string;
}

interface LegacyProposal {
  id: string;
  category: SimulationCategory;
  name: string;
  monthlyAmount: number;
  probability: number;
  startMonth: number;
  distribution: 'Mensual' | 'Semestral' | 'Único';
  status: Proposal['status'];
  annualImpact: number;
  monthlyImpact: number[];
  responsible: string;
  notes: string;
  createdAt: string;
}

interface LegacyScenario {
  id: string;
  name: string;
  description: string;
  selectedProposalIds: string[];
  createdAt: string;
}

interface LegacyForecastOverride {
  key: string;
  conceptId: string;
  yearMonth: string;
  originalValue: number;
  overrideValue: number;
  comment?: string;
  editedAt: string;
}

interface LegacyFlowSenseStore {
  plan: FlowPlan | null;
  proposals: LegacyProposal[];
  scenarios: LegacyScenario[];
  providers: Provider[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  cxpRecords: CXPRecord[];
  forecastOverrides: LegacyForecastOverride[];
  lastSaved: string;
}

const STORE_VERSION = 2;
const STORAGE_KEY = 'flowsense-v2';
const LEGACY_STORAGE_KEY = 'flowsense-v1';

function isoNow(): string {
  return new Date().toISOString();
}

function startOfMonthIso(yearMonth: string): string {
  return `${yearMonth}-01`;
}

function endOfMonthIso(yearMonth: string): string {
  const [yearRaw, monthRaw] = yearMonth.split('-');
  const year = Number(yearRaw);
  const monthIndex = Math.max(0, Math.min(11, Number(monthRaw) - 1));
  const date = new Date(Date.UTC(year, monthIndex + 1, 0));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function firstPlanMonth(plan: FlowPlan | null): string {
  return `${plan?.year ?? new Date().getFullYear()}-01`;
}

function expenseLikeCategory(category: SimulationCategory): boolean {
  return category !== 'Incremento de Ingresos';
}

function migrateLegacyProposalToSimulation(
  legacy: LegacyProposal,
  plan: FlowPlan | null,
): Simulation {
  const baseYear = plan?.year ?? new Date().getFullYear();
  const impactedMonths = legacy.monthlyImpact
    .map((value, monthOffset) => ({ value, monthOffset }))
    .filter((item) => item.value !== 0);

  const effects = legacy.monthlyImpact
    .map((value, monthOffset) => ({ value, monthOffset }))
    .filter((item) => item.value !== 0)
    .map((item, index) => ({
      id: `${legacy.id}-effect-${index}`,
      type: 'concept_delta' as const,
      conceptId: expenseLikeCategory(legacy.category)
        ? ROLE_TARGET_EXPENSE
        : ROLE_TARGET_INCOME,
      monthOffsets: [item.monthOffset],
      mode: 'absolute' as const,
      value: expenseLikeCategory(legacy.category) ? -item.value : item.value,
    }));

  return {
    id: `simulation-${legacy.id}`,
    name: legacy.name,
    description: legacy.notes || `${legacy.category}${legacy.responsible ? ` · ${legacy.responsible}` : ''}`,
    category: legacy.category,
    type: 'amount_adjustment',
    targetIds: [
      expenseLikeCategory(legacy.category)
        ? ROLE_TARGET_EXPENSE
        : ROLE_TARGET_INCOME,
    ],
    startYearMonth: `${baseYear}-${String((impactedMonths[0]?.monthOffset ?? 0) + 1).padStart(2, '0')}`,
    endYearMonth: impactedMonths.length > 0
      ? `${baseYear}-${String((impactedMonths[impactedMonths.length - 1]?.monthOffset ?? 0) + 1).padStart(2, '0')}`
      : `${baseYear}-${String(Math.max(1, legacy.startMonth)).padStart(2, '0')}`,
    startDate: startOfMonthIso(`${baseYear}-${String((impactedMonths[0]?.monthOffset ?? 0) + 1).padStart(2, '0')}`),
    endDate: impactedMonths.length > 0
      ? endOfMonthIso(`${baseYear}-${String((impactedMonths[impactedMonths.length - 1]?.monthOffset ?? 0) + 1).padStart(2, '0')}`)
      : endOfMonthIso(`${baseYear}-${String(Math.max(1, legacy.startMonth)).padStart(2, '0')}`),
    frequency: legacy.distribution === 'Mensual'
      ? 'monthly'
      : legacy.distribution === 'Semestral'
        ? 'semiannual'
        : 'once',
    operation: expenseLikeCategory(legacy.category) ? 'decrease' : 'increase',
    amount: legacy.monthlyAmount * legacy.probability,
    comments: legacy.notes,
    effects,
    createdAt: legacy.createdAt ?? isoNow(),
    updatedAt: legacy.createdAt ?? isoNow(),
  };
}

function migrateLegacyStore(legacy: Partial<LegacyFlowSenseStore>): FlowSenseStore {
  const plan = legacy.plan ?? null;
  const now = isoNow();
  const simulations = (legacy.proposals ?? []).map((proposal) => migrateLegacyProposalToSimulation(proposal, plan));

  const needsMigratedContainer =
    simulations.length > 0 ||
    (legacy.scenarios?.length ?? 0) > 0 ||
    (legacy.forecastOverrides?.length ?? 0) > 0;

  const proposals: Proposal[] = needsMigratedContainer
    ? [
        {
          id: 'proposal-migrated',
          name: 'Propuesta migrada',
          description: 'Contenedor generado automáticamente desde el modelo legacy.',
          status: 'Pendiente',
          createdAt: now,
          updatedAt: now,
        },
      ]
    : [];

  const migratedScenariosFromLegacy = (legacy.scenarios ?? []).map<Scenario>((scenario) => ({
    id: scenario.id,
    proposalId: 'proposal-migrated',
    kind: 'proposal',
    name: scenario.name,
    description: scenario.description,
    probability: 1,
    startYearMonth: firstPlanMonth(plan),
    horizonMonths: 12,
    simulationIds: scenario.selectedProposalIds.map((proposalId) => `simulation-${proposalId}`),
    createdAt: scenario.createdAt ?? now,
    updatedAt: scenario.createdAt ?? now,
  }));

  const fallbackScenario: Scenario | null = needsMigratedContainer && migratedScenariosFromLegacy.length === 0
      ? {
        id: 'scenario-migrated-default',
        proposalId: 'proposal-migrated',
        kind: 'proposal',
        name: 'Escenario migrado',
        description: 'Escenario generado para conservar simulaciones y overrides legacy.',
        probability: 1,
        startYearMonth: firstPlanMonth(plan),
        horizonMonths: 12,
        simulationIds: [],
        createdAt: now,
        updatedAt: now,
      }
    : null;

  const proposalScenarios = fallbackScenario
    ? [fallbackScenario]
    : migratedScenariosFromLegacy;
  const scenarios = ensureBaseScenario(plan, proposalScenarios);

  if (proposals[0] && scenarios[0]) {
    proposals[0].activeScenarioId = scenarios[0].id;
  }

  const defaultScenarioId = proposalScenarios[0]?.id ?? BASE_SCENARIO_ID;
  const scenarioCellOverrides: ScenarioCellOverride[] = (legacy.forecastOverrides ?? []).map((override) => ({
    key: scenarioCellKey(
      defaultScenarioId ?? 'scenario-migrated-default',
      override.conceptId,
      override.yearMonth,
    ),
    scenarioId: defaultScenarioId ?? 'scenario-migrated-default',
    conceptId: override.conceptId,
    yearMonth: override.yearMonth,
    baseValue: override.originalValue,
    simulatedValue: override.originalValue,
    manualValue: override.overrideValue,
    comment: override.comment,
    editedAt: override.editedAt ?? now,
  }));

  return {
    plan,
    proposals,
    scenarios,
    simulations,
    activeKpiIds: [...DEFAULT_ACTIVE_KPI_IDS],
    customKpis: [],
    scenarioCellOverrides,
    activeProposalId: null,
    activeScenarioId: BASE_SCENARIO_ID,
    providers: Array.isArray(legacy.providers) ? legacy.providers : [],
    clients: Array.isArray(legacy.clients) ? legacy.clients : [],
    assumptions: validateAssumptions(legacy.assumptions),
    confirmedPayments: Array.isArray(legacy.confirmedPayments) ? legacy.confirmedPayments : [],
    cxpRecords: Array.isArray(legacy.cxpRecords) ? legacy.cxpRecords : [],
    cxpLoadedCias: {},
    lastSaved: legacy.lastSaved ?? now,
  };
}

export function getDefaultStore(): FlowSenseStore {
  const currentYear = new Date().getFullYear();
  return {
    plan: null,
    proposals: [],
    scenarios: ensureBaseScenario(null, []),
    simulations: [],
    activeKpiIds: [...DEFAULT_ACTIVE_KPI_IDS],
    customKpis: [],
    scenarioCellOverrides: [],
    activeProposalId: null,
    activeScenarioId: BASE_SCENARIO_ID,
    providers: [],
    clients: [],
    assumptions: {
      year: currentYear,
      globalCompliance: 1,
      factorajeDays: 30,
    },
    confirmedPayments: [],
    cxpRecords: [],
    cxpLoadedCias: {},
    lastSaved: isoNow(),
  };
}

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
      `Failed to save app state: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

function parseStoredPayload(raw: string): { version: number; data: unknown } | null {
  try {
    const payload = JSON.parse(raw) as { version?: number; data?: unknown };
    if (typeof payload.version !== 'number' || payload.data === undefined) return null;
    return { version: payload.version, data: payload.data };
  } catch {
    return null;
  }
}

function normalizeV2Store(data: Partial<FlowSenseStore>): FlowSenseStore {
  const plan = data.plan ?? null;

  const proposals = validateArray<Proposal>(data.proposals, 'proposals');
  const scenarios = ensureBaseScenario(
    plan,
    validateArray<Scenario>(data.scenarios, 'scenarios').map((scenario) => ({
      ...scenario,
      kind: scenario.kind ?? (scenario.id === BASE_SCENARIO_ID ? 'base' : 'proposal'),
      proposalId: scenario.id === BASE_SCENARIO_ID ? null : scenario.proposalId,
      locked: scenario.id === BASE_SCENARIO_ID ? true : scenario.locked,
    })),
  );
  const simulations = validateArray<Simulation>(data.simulations, 'simulations').map((simulation) =>
    normalizeSimulation(simulation, plan),
  );

  return {
    plan,
    proposals,
    scenarios,
    simulations,
    activeKpiIds: Array.isArray(data.activeKpiIds)
      ? data.activeKpiIds.filter((value): value is string => typeof value === 'string')
      : [...DEFAULT_ACTIVE_KPI_IDS],
    customKpis: validateArray<CustomKpiDefinition>(data.customKpis, 'customKpis').map(normalizeCustomKpi),
    scenarioCellOverrides: validateArray<ScenarioCellOverride>(
      data.scenarioCellOverrides,
      'scenarioCellOverrides',
    ),
    activeProposalId: data.activeScenarioId === BASE_SCENARIO_ID
      ? null
      : (data.activeProposalId ?? proposals[0]?.id ?? null),
    activeScenarioId: data.activeScenarioId ?? BASE_SCENARIO_ID,
    providers: validateArray<Provider>(data.providers, 'providers'),
    clients: validateArray<Client>(data.clients, 'clients'),
    assumptions: validateAssumptions(data.assumptions),
    confirmedPayments: validateArray<ConfirmedPayment>(
      data.confirmedPayments,
      'confirmedPayments',
    ),
    cxpRecords: validateArray<CXPRecord>(data.cxpRecords, 'cxpRecords'),
    cxpLoadedCias: validateStringMap(data.cxpLoadedCias),
    lastSaved: validateISODate(data.lastSaved, 'lastSaved'),
  };
}

function firstSimulationYearMonth(
  simulation: Partial<Simulation>,
  plan: FlowPlan | null,
): string {
  if (typeof simulation.startYearMonth === 'string' && simulation.startYearMonth.includes('-')) {
    return simulation.startYearMonth;
  }

  const effectYearMonths = (simulation.effects ?? [])
    .flatMap((effect) => effect.yearMonths ?? [])
    .filter((value): value is string => typeof value === 'string' && value.includes('-'))
    .sort();

  if (effectYearMonths[0]) return effectYearMonths[0];

  const firstMonthOffset = (simulation.effects ?? [])
    .flatMap((effect) => effect.monthOffsets ?? [])
    .find((value): value is number => typeof value === 'number' && value >= 0);

  if (firstMonthOffset !== undefined) {
    const baseYear = plan?.year ?? new Date().getFullYear();
    return `${baseYear}-${String(firstMonthOffset + 1).padStart(2, '0')}`;
  }

  return firstPlanMonth(plan);
}

function normalizeSimulation(
  simulation: Partial<Simulation>,
  plan: FlowPlan | null,
): Simulation {
  const category = simulation.category ?? 'Incremento de Ingresos';
  const defaultTargetId = expenseLikeCategory(category)
    ? ROLE_TARGET_EXPENSE
    : ROLE_TARGET_INCOME;
  const startYearMonth = firstSimulationYearMonth(simulation, plan);
  const endYearMonth =
    typeof simulation.endYearMonth === 'string' && simulation.endYearMonth.includes('-')
      ? simulation.endYearMonth
      : startYearMonth;
  const startDate =
    typeof simulation.startDate === 'string' && simulation.startDate.length === 10
      ? simulation.startDate
      : startOfMonthIso(startYearMonth);
  const endDate =
    typeof simulation.endDate === 'string' && simulation.endDate.length === 10
      ? simulation.endDate
      : endOfMonthIso(endYearMonth);

  const normalized: Simulation = {
    id: simulation.id ?? `simulation-${Date.now()}`,
    name: simulation.name ?? 'Simulación sin nombre',
    description: simulation.description ?? '',
    category,
    type: simulation.type ?? 'amount_adjustment',
    targetIds: Array.isArray(simulation.targetIds) && simulation.targetIds.length > 0
      ? simulation.targetIds
      : [defaultTargetId],
    startYearMonth,
    endYearMonth,
    startDate,
    endDate,
    frequency: simulation.frequency ?? 'monthly',
    operation: simulation.operation ?? (expenseLikeCategory(category) ? 'decrease' : 'increase'),
    amount: typeof simulation.amount === 'number' ? simulation.amount : undefined,
    percent: typeof simulation.percent === 'number' ? simulation.percent : undefined,
    installments: typeof simulation.installments === 'number' ? simulation.installments : undefined,
    customAllocation: Array.isArray(simulation.customAllocation)
      ? simulation.customAllocation.filter((value): value is number => typeof value === 'number')
      : undefined,
    shiftMonths: typeof simulation.shiftMonths === 'number' ? simulation.shiftMonths : undefined,
    shiftRatio: typeof simulation.shiftRatio === 'number' ? simulation.shiftRatio : undefined,
    paymentLabel: typeof simulation.paymentLabel === 'string' ? simulation.paymentLabel : undefined,
    comments: typeof simulation.comments === 'string' ? simulation.comments : undefined,
    effects: Array.isArray(simulation.effects) ? simulation.effects : [],
    createdAt: validateISODate(simulation.createdAt, 'simulation.createdAt'),
    updatedAt: validateISODate(simulation.updatedAt, 'simulation.updatedAt'),
  };

  if (normalized.effects.length === 0 && plan) {
    normalized.effects = buildSimulationEffects(plan, normalized);
  }

  return normalized;
}

export function loadStore(): FlowSenseStore | null {
  const sources = [STORAGE_KEY, LEGACY_STORAGE_KEY];

  for (const key of sources) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;

    const payload = parseStoredPayload(raw);
    if (!payload) continue;

    if (payload.version === STORE_VERSION) {
      return normalizeV2Store(payload.data as Partial<FlowSenseStore>);
    }

    if (payload.version === 1) {
      return migrateLegacyStore(payload.data as Partial<LegacyFlowSenseStore>);
    }
  }

  return null;
}

export function clearStore(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear store from localStorage:', error);
  }
}

export function exportStore(store: FlowSenseStore): string {
  const payload = {
    version: STORE_VERSION,
    exportedAt: isoNow(),
    data: store,
  };

  return JSON.stringify(payload, null, 2);
}

export function importStore(json: string): FlowSenseStore {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new Error('JSON must be an object');
  }

  const obj = payload as Record<string, unknown>;
  if (typeof obj.version !== 'number') {
    throw new Error('Missing or invalid "version" field');
  }
  if (typeof obj.data !== 'object' || obj.data === null) {
    throw new Error('Missing or invalid "data" field');
  }

  if (obj.version === STORE_VERSION) {
    return normalizeV2Store(obj.data as Partial<FlowSenseStore>);
  }

  if (obj.version === 1) {
    return migrateLegacyStore(obj.data as Partial<LegacyFlowSenseStore>);
  }

  throw new Error(`Unsupported version: ${obj.version}`);
}

function validateArray<T>(value: unknown, fieldName: string): T[] {
  if (!Array.isArray(value)) {
    console.warn(`Field "${fieldName}" is not an array; using default empty array`);
    return [];
  }
  return value;
}

function normalizeCustomKpi(value: CustomKpiDefinition): CustomKpiDefinition {
  const anyValue = value as CustomKpiDefinition & { targetSource?: unknown; targetSourceVariable?: unknown };
  const rawSource = anyValue.targetSource;
  const targetSource: CustomKpiDefinition['targetSource'] = rawSource === 'auto' ? 'auto' : 'manual';
  const targetSourceVariable = typeof anyValue.targetSourceVariable === 'string' && anyValue.targetSourceVariable.length > 0
    ? anyValue.targetSourceVariable
    : undefined;
  return {
    ...value,
    targetSource,
    targetSourceVariable: targetSource === 'auto' ? targetSourceVariable : undefined,
  };
}

function validateAssumptions(value: unknown): CashFlowAssumptions {
  if (typeof value !== 'object' || value === null) {
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

function validateStringMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function validateISODate(value: unknown, fieldName: string): string {
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return value;
  }

  console.warn(`Field "${fieldName}" is not a valid ISO date; using current time`);
  return isoNow();
}
