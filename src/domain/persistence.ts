/**
 * Persistence layer for FlowSense.
 *
 * Terminology (UI and code now match):
 *   Simulation: top-level container (UI: "Simulación")
 *   Scenario:   grouping inside a simulation (UI: "Escenario")
 *   Proposal:   reusable financial adjustment applied to scenarios (UI: "Propuesta")
 *
 * Version history:
 *   v1 legacy model (single-file "proposal impact") → migrated on load.
 *   v2 introduced Proposal/Scenario/Simulation triad but with swapped code names
 *       (code Proposal = UI Simulación, code Simulation = UI Propuesta).
 *   v3 (current) swaps the code names to match the UI:
 *       code Simulation = UI Simulación, code Proposal = UI Propuesta.
 *       Field renames: proposals↔simulations arrays; Scenario.proposalId→simulationId;
 *       Scenario.simulationIds→proposalIds; activeProposalId→activeSimulationId;
 *       ScenarioKind 'proposal' → 'simulation'.
 */

import {
  BASE_SCENARIO_ID,
  FlowPlan,
  ForecastConfidenceOverride,
  Simulation,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_INCOME,
  Scenario,
  ScenarioCellOverride,
  Proposal,
  ProposalCategory,
  scenarioCellKey,
} from '../types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './types';
import { buildProposalEffects, ensureBaseScenario } from './proposalCompiler';
import {
  DEFAULT_ACTIVE_KPI_IDS,
  type CustomKpiDefinition,
  type KpiConfigOverride,
  type KpiGoal,
  type KpiTargetHistoryEntry,
  type KpiTargetOwner,
  type KpiTargetSource,
} from './kpiCatalog';

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
  simulations: Simulation[];
  scenarios: Scenario[];
  proposals: Proposal[];
  activeKpiIds: string[];
  customKpis: CustomKpiDefinition[];
  kpiConfigs: KpiConfigOverride[];
  scenarioCellOverrides: ScenarioCellOverride[];
  forecastConfidenceOverrides: ForecastConfidenceOverride[];
  activeSimulationId: string | null;
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

interface LegacySimulation {
  id: string;
  category: ProposalCategory;
  name: string;
  monthlyAmount: number;
  probability: number;
  startMonth: number;
  distribution: 'Mensual' | 'Semestral' | 'Único';
  status: Simulation['status'];
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
  selectedSimulationIds: string[];
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
  simulations: LegacySimulation[];
  scenarios: LegacyScenario[];
  providers: Provider[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  cxpRecords: CXPRecord[];
  forecastOverrides: LegacyForecastOverride[];
  lastSaved: string;
}

const STORE_VERSION = 3;
const STORAGE_KEY = 'flowsense-v3';
const V2_STORAGE_KEY = 'flowsense-v2';
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

function expenseLikeCategory(category: ProposalCategory): boolean {
  return category !== 'Incremento de Ingresos';
}

function migrateLegacySimulationToProposal(
  legacy: LegacySimulation,
  plan: FlowPlan | null,
): Proposal {
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
    id: `proposal-${legacy.id}`,
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
  const proposals = (legacy.simulations ?? []).map((simulation) => migrateLegacySimulationToProposal(simulation, plan));

  const needsMigratedContainer =
    proposals.length > 0 ||
    (legacy.scenarios?.length ?? 0) > 0 ||
    (legacy.forecastOverrides?.length ?? 0) > 0;

  const simulations: Simulation[] = needsMigratedContainer
    ? [
        {
          id: 'simulation-migrated',
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
    simulationId: 'simulation-migrated',
    kind: 'simulation',
    name: scenario.name,
    description: scenario.description,
    probability: 1,
    startYearMonth: firstPlanMonth(plan),
    horizonMonths: 12,
    proposalIds: scenario.selectedSimulationIds.map((simulationId) => `proposal-${simulationId}`),
    createdAt: scenario.createdAt ?? now,
    updatedAt: scenario.createdAt ?? now,
  }));

  const fallbackScenario: Scenario | null = needsMigratedContainer && migratedScenariosFromLegacy.length === 0
      ? {
        id: 'scenario-migrated-default',
        simulationId: 'simulation-migrated',
        kind: 'simulation',
        name: 'Escenario migrado',
        description: 'Escenario generado para conservar simulaciones y overrides legacy.',
        probability: 1,
        startYearMonth: firstPlanMonth(plan),
        horizonMonths: 12,
        proposalIds: [],
        createdAt: now,
        updatedAt: now,
      }
    : null;

  const simulationScenarios = fallbackScenario
    ? [fallbackScenario]
    : migratedScenariosFromLegacy;
  const scenarios = ensureBaseScenario(plan, simulationScenarios);

  if (simulations[0] && scenarios[0]) {
    simulations[0].activeScenarioId = scenarios[0].id;
  }

  const defaultScenarioId = simulationScenarios[0]?.id ?? BASE_SCENARIO_ID;
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
    simulations,
    scenarios,
    proposals,
    activeKpiIds: [...DEFAULT_ACTIVE_KPI_IDS],
    customKpis: [],
    kpiConfigs: [],
    scenarioCellOverrides,
    forecastConfidenceOverrides: [],
    activeSimulationId: null,
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
    simulations: [],
    scenarios: ensureBaseScenario(null, []),
    proposals: [],
    activeKpiIds: [...DEFAULT_ACTIVE_KPI_IDS],
    customKpis: [],
    kpiConfigs: [],
    scenarioCellOverrides: [],
    forecastConfidenceOverrides: [],
    activeSimulationId: null,
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

function normalizeV3Store(data: Partial<FlowSenseStore>): FlowSenseStore {
  const plan = data.plan ?? null;

  const simulations = validateArray<Simulation>(data.simulations, 'simulations');
  const scenarios = ensureBaseScenario(
    plan,
    validateArray<Scenario>(data.scenarios, 'scenarios').map((scenario) => ({
      ...scenario,
      kind: scenario.kind ?? (scenario.id === BASE_SCENARIO_ID ? 'base' : 'simulation'),
      simulationId: scenario.id === BASE_SCENARIO_ID ? null : scenario.simulationId,
      locked: scenario.id === BASE_SCENARIO_ID ? true : scenario.locked,
    })),
  );
  const proposals = validateArray<Proposal>(data.proposals, 'proposals').map((proposal) =>
    normalizeProposal(proposal, plan),
  );

  return {
    plan,
    simulations,
    scenarios,
    proposals,
    activeKpiIds: Array.isArray(data.activeKpiIds)
      ? data.activeKpiIds.filter((value): value is string => typeof value === 'string')
      : [...DEFAULT_ACTIVE_KPI_IDS],
    customKpis: validateArray<CustomKpiDefinition>(data.customKpis, 'customKpis').map(normalizeCustomKpi),
    kpiConfigs: validateArray<KpiConfigOverride>(data.kpiConfigs, 'kpiConfigs').map(normalizeKpiConfig),
    scenarioCellOverrides: validateArray<ScenarioCellOverride>(
      data.scenarioCellOverrides,
      'scenarioCellOverrides',
    ),
    forecastConfidenceOverrides: validateArray<ForecastConfidenceOverride>(
      data.forecastConfidenceOverrides,
      'forecastConfidenceOverrides',
    ).map(normalizeForecastConfidenceOverride),
    activeSimulationId: data.activeScenarioId === BASE_SCENARIO_ID
      ? null
      : (data.activeSimulationId ?? simulations[0]?.id ?? null),
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

function normalizeForecastConfidenceOverride(
  value: ForecastConfidenceOverride,
): ForecastConfidenceOverride {
  const anyValue = value as ForecastConfidenceOverride & Record<string, unknown>;
  const score = normalizeNumber(anyValue.score, 0);
  const basis = anyValue.basis === 'manual_calculation'
    || anyValue.basis === 'human_criteria'
    || anyValue.basis === 'mixed'
    || anyValue.basis === 'system_calculation'
    ? anyValue.basis
    : 'mixed';

  return {
    scenarioId: typeof anyValue.scenarioId === 'string' && anyValue.scenarioId.length > 0
      ? anyValue.scenarioId
      : BASE_SCENARIO_ID,
    score: Math.max(0, Math.min(100, Math.round(score))),
    basis,
    comment: typeof anyValue.comment === 'string' && anyValue.comment.trim()
      ? anyValue.comment.trim()
      : undefined,
    editedAt: validateISODate(anyValue.editedAt, 'forecastConfidenceOverride.editedAt'),
  };
}

function firstProposalYearMonth(
  proposal: Partial<Proposal>,
  plan: FlowPlan | null,
): string {
  if (typeof proposal.startYearMonth === 'string' && proposal.startYearMonth.includes('-')) {
    return proposal.startYearMonth;
  }

  const effectYearMonths = (proposal.effects ?? [])
    .flatMap((effect) => effect.yearMonths ?? [])
    .filter((value): value is string => typeof value === 'string' && value.includes('-'))
    .sort();

  if (effectYearMonths[0]) return effectYearMonths[0];

  const firstMonthOffset = (proposal.effects ?? [])
    .flatMap((effect) => effect.monthOffsets ?? [])
    .find((value): value is number => typeof value === 'number' && value >= 0);

  if (firstMonthOffset !== undefined) {
    const baseYear = plan?.year ?? new Date().getFullYear();
    return `${baseYear}-${String(firstMonthOffset + 1).padStart(2, '0')}`;
  }

  return firstPlanMonth(plan);
}

function normalizeProposal(
  proposal: Partial<Proposal>,
  plan: FlowPlan | null,
): Proposal {
  const category = proposal.category ?? 'Incremento de Ingresos';
  const defaultTargetId = expenseLikeCategory(category)
    ? ROLE_TARGET_EXPENSE
    : ROLE_TARGET_INCOME;
  const startYearMonth = firstProposalYearMonth(proposal, plan);
  const endYearMonth =
    typeof proposal.endYearMonth === 'string' && proposal.endYearMonth.includes('-')
      ? proposal.endYearMonth
      : startYearMonth;
  const startDate =
    typeof proposal.startDate === 'string' && proposal.startDate.length === 10
      ? proposal.startDate
      : startOfMonthIso(startYearMonth);
  const endDate =
    typeof proposal.endDate === 'string' && proposal.endDate.length === 10
      ? proposal.endDate
      : endOfMonthIso(endYearMonth);

  const normalized: Proposal = {
    id: proposal.id ?? `proposal-${Date.now()}`,
    name: proposal.name ?? 'Simulación sin nombre',
    description: proposal.description ?? '',
    category,
    type: proposal.type ?? 'amount_adjustment',
    targetIds: Array.isArray(proposal.targetIds) && proposal.targetIds.length > 0
      ? proposal.targetIds
      : [defaultTargetId],
    startYearMonth,
    endYearMonth,
    startDate,
    endDate,
    frequency: proposal.frequency ?? 'monthly',
    operation: proposal.operation ?? (expenseLikeCategory(category) ? 'decrease' : 'increase'),
    amount: typeof proposal.amount === 'number' ? proposal.amount : undefined,
    percent: typeof proposal.percent === 'number' ? proposal.percent : undefined,
    installments: typeof proposal.installments === 'number' ? proposal.installments : undefined,
    customAllocation: Array.isArray(proposal.customAllocation)
      ? proposal.customAllocation.filter((value): value is number => typeof value === 'number')
      : undefined,
    shiftMonths: typeof proposal.shiftMonths === 'number' ? proposal.shiftMonths : undefined,
    shiftRatio: typeof proposal.shiftRatio === 'number' ? proposal.shiftRatio : undefined,
    paymentLabel: typeof proposal.paymentLabel === 'string' ? proposal.paymentLabel : undefined,
    comments: typeof proposal.comments === 'string' ? proposal.comments : undefined,
    effects: Array.isArray(proposal.effects) ? proposal.effects : [],
    createdAt: validateISODate(proposal.createdAt, 'proposal.createdAt'),
    updatedAt: validateISODate(proposal.updatedAt, 'proposal.updatedAt'),
  };

  if (normalized.effects.length === 0 && plan) {
    normalized.effects = buildProposalEffects(plan, normalized);
  }

  return normalized;
}

/**
 * Raw shape of a v2 store as persisted in localStorage before the Proposal/Simulation
 * code rename. Field names here reflect the pre-swap terminology:
 *   v2.proposals        -> v3.simulations (top-level container)
 *   v2.simulations      -> v3.proposals (reusable adjustment)
 *   v2.activeProposalId -> v3.activeSimulationId
 *   Scenario.proposalId -> Scenario.simulationId
 *   Scenario.simulationIds -> Scenario.proposalIds
 *   Scenario.kind 'proposal' -> 'simulation'
 */
interface V2RawScenario {
  id: string;
  proposalId?: string | null;
  kind?: 'base' | 'proposal' | string;
  simulationIds?: string[];
  [key: string]: unknown;
}

interface V2RawStore {
  proposals?: unknown[];
  simulations?: unknown[];
  scenarios?: V2RawScenario[];
  activeProposalId?: string | null;
  activeScenarioId?: string | null;
  [key: string]: unknown;
}

/**
 * Converts a v2 raw payload into a v3 shape by swapping the Proposal/Simulation
 * field names, then normalizes it through the standard v3 path so any missing
 * fields are filled and the base scenario is re-injected.
 */
function migrateV2ToV3Store(raw: V2RawStore): FlowSenseStore {
  const v2Proposals = Array.isArray(raw.proposals) ? raw.proposals : [];
  const v2Simulations = Array.isArray(raw.simulations) ? raw.simulations : [];
  const v2Scenarios = Array.isArray(raw.scenarios) ? raw.scenarios : [];

  const v3Scenarios = v2Scenarios.map((scenario) => {
    const anyScenario = scenario as V2RawScenario & Record<string, unknown>;
    const {
      proposalId,
      simulationIds,
      kind,
      ...rest
    } = anyScenario;
    return {
      ...rest,
      kind: kind === 'proposal' ? 'simulation' : kind,
      simulationId: proposalId ?? null,
      proposalIds: Array.isArray(simulationIds) ? simulationIds : [],
    };
  });

  const v3Data: Partial<FlowSenseStore> = {
    ...(raw as Partial<FlowSenseStore>),
    simulations: v2Proposals as Simulation[],
    proposals: v2Simulations as Proposal[],
    scenarios: v3Scenarios as Scenario[],
    activeSimulationId:
      typeof raw.activeProposalId === 'string' ? raw.activeProposalId : null,
    activeScenarioId:
      typeof raw.activeScenarioId === 'string' ? raw.activeScenarioId : null,
  };

  delete (v3Data as Record<string, unknown>).activeProposalId;

  return normalizeV3Store(v3Data);
}

export function loadStore(): FlowSenseStore | null {
  const sources: Array<{ key: string; expectedVersion: number }> = [
    { key: STORAGE_KEY, expectedVersion: 3 },
    { key: V2_STORAGE_KEY, expectedVersion: 2 },
    { key: LEGACY_STORAGE_KEY, expectedVersion: 1 },
  ];

  for (const { key, expectedVersion } of sources) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;

    const payload = parseStoredPayload(raw);
    if (!payload) continue;

    if (payload.version === 3 && expectedVersion === 3) {
      return normalizeV3Store(payload.data as Partial<FlowSenseStore>);
    }

    if (payload.version === 2 && expectedVersion === 2) {
      return migrateV2ToV3Store(payload.data as V2RawStore);
    }

    if (payload.version === 1 && expectedVersion === 1) {
      return migrateLegacyStore(payload.data as Partial<LegacyFlowSenseStore>);
    }
  }

  return null;
}

export function clearStore(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(V2_STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Ignore storage failures during reset.
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

  if (obj.version === 3) {
    return normalizeV3Store(obj.data as Partial<FlowSenseStore>);
  }

  if (obj.version === 2) {
    return migrateV2ToV3Store(obj.data as V2RawStore);
  }

  if (obj.version === 1) {
    return migrateLegacyStore(obj.data as Partial<LegacyFlowSenseStore>);
  }

  throw new Error(`Unsupported version: ${obj.version}`);
}

function validateArray<T>(value: unknown, _fieldName: string): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value;
}

function normalizeCustomKpi(value: CustomKpiDefinition): CustomKpiDefinition {
  const anyValue = value as CustomKpiDefinition & {
    targetSource?: unknown;
    targetSourceVariable?: unknown;
    targetOwner?: unknown;
    targetHistory?: unknown;
    goal?: unknown;
  };
  const rawSource = anyValue.targetSource;
  const targetSource: KpiTargetSource = rawSource === 'auto' ? 'auto' : 'manual';
  const targetSourceVariable = typeof anyValue.targetSourceVariable === 'string' && anyValue.targetSourceVariable.length > 0
    ? anyValue.targetSourceVariable
    : undefined;
  const targetOwner = normalizeTargetOwner(anyValue.targetOwner);
  return {
    ...value,
    targetSource,
    targetSourceVariable: targetSource === 'auto' ? targetSourceVariable : undefined,
    goal: normalizeKpiGoal(anyValue.goal),
    targetOwner,
    targetHistory: normalizeTargetHistory(anyValue.targetHistory),
  };
}

function normalizeTargetOwner(value: unknown): KpiTargetOwner {
  if (value === 'system' || value === 'historical' || value === 'user') return value;
  return 'user';
}

function normalizeTargetSource(value: unknown): KpiTargetSource {
  return value === 'auto' ? 'auto' : 'manual';
}

function normalizeKpiGoal(value: unknown): KpiGoal {
  return value === 'lower' ? 'lower' : 'higher';
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeTargetHistory(value: unknown): KpiTargetHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Partial<KpiTargetHistoryEntry> => typeof item === 'object' && item !== null)
    .map((item) => ({
      value: normalizeNumber(item.value, 0),
      warningThreshold: normalizeNumber(item.warningThreshold, 0),
      goal: normalizeKpiGoal(item.goal),
      targetSource: normalizeTargetSource(item.targetSource),
      targetSourceVariable: typeof item.targetSourceVariable === 'string' ? item.targetSourceVariable : undefined,
      targetOwner: normalizeTargetOwner(item.targetOwner),
      note: typeof item.note === 'string' ? item.note : undefined,
      changedAt: validateISODate(item.changedAt, 'kpiTargetHistory.changedAt'),
    }));
}

function normalizeKpiConfig(value: KpiConfigOverride): KpiConfigOverride {
  const anyValue = value as KpiConfigOverride & Record<string, unknown>;
  const targetSource = normalizeTargetSource(anyValue.targetSource);
  const targetSourceVariable = typeof anyValue.targetSourceVariable === 'string' && anyValue.targetSourceVariable.length > 0
    ? anyValue.targetSourceVariable
    : undefined;
  return {
    kpiId: typeof anyValue.kpiId === 'string' ? anyValue.kpiId : `kpi-${Date.now()}`,
    targetValue: normalizeNumber(anyValue.targetValue, 0),
    targetSource,
    targetSourceVariable: targetSource === 'auto' ? targetSourceVariable : undefined,
    targetOwner: normalizeTargetOwner(anyValue.targetOwner),
    goal: normalizeKpiGoal(anyValue.goal),
    warningThreshold: normalizeNumber(anyValue.warningThreshold, 0),
    notes: typeof anyValue.notes === 'string' ? anyValue.notes : '',
    updatedAt: validateISODate(anyValue.updatedAt, 'kpiConfig.updatedAt'),
    history: normalizeTargetHistory(anyValue.history),
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

function validateISODate(value: unknown, _fieldName: string): string {
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return value;
  }

  return isoNow();
}
