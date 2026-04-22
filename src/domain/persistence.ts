/**
 * Persistence layer for FlowSense.
 *
 * Terminology (UI and code match):
 *   Simulation: top-level container (UI: "Simulación")
 *   Scenario:   grouping inside a simulation (UI: "Escenario")
 *   Proposal:   reusable financial adjustment applied to scenarios (UI: "Propuesta")
 *
 * Version history:
 *   v1 legacy model (single-file "proposal impact") — migrated on load.
 *   v2 introduced Proposal/Scenario/Simulation triad with swapped code names.
 *   v3 swapped the code names to match the UI.
 *   v4 (current) drops the Escenario Base special case (no kind='base' scenarios
 *       anymore — "sin escenario" is represented by activeScenarioId === null)
 *       and simplifies the Proposal model to only category/amount/frequency/dates.
 *       Legacy proposals are converted to the new shape on load.
 */

import {
  FlowPlan,
  ForecastConfidenceOverride,
  PROPOSAL_CATEGORY_LABELS,
  Proposal,
  ProposalCategory,
  ProposalFrequency,
  Scenario,
  ScenarioCellOverride,
  Simulation,
  scenarioCellKey,
} from '../types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './types';
import { buildProposalEffects } from './proposalCompiler';
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

interface LegacySimulationV1 {
  id: string;
  category: string;
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

interface LegacyScenarioV1 {
  id: string;
  name: string;
  description: string;
  selectedSimulationIds: string[];
  createdAt: string;
}

interface LegacyForecastOverrideV1 {
  key: string;
  conceptId: string;
  yearMonth: string;
  originalValue: number;
  overrideValue: number;
  comment?: string;
  editedAt: string;
}

interface LegacyFlowSenseStoreV1 {
  plan: FlowPlan | null;
  simulations: LegacySimulationV1[];
  scenarios: LegacyScenarioV1[];
  providers: Provider[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  cxpRecords: CXPRecord[];
  forecastOverrides: LegacyForecastOverrideV1[];
  lastSaved: string;
}

const STORE_VERSION = 4;
const STORAGE_KEY = 'flowsense-v4';
const V3_STORAGE_KEY = 'flowsense-v3';
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

/**
 * Convert any legacy category string (from v1/v2/v3 stores) into the new
 * 4-value ProposalCategory enum.
 */
function coerceCategory(value: unknown, typeHint?: unknown, operationHint?: unknown): ProposalCategory {
  if (value === 'ahorro' || value === 'aumento_ingresos'
      || value === 'pausar_gasto' || value === 'timing_shift') {
    return value;
  }

  // Legacy v1/v2/v3 category strings.
  if (value === 'Reducción de Costos') return 'ahorro';
  if (value === 'Incremento de Ingresos') return 'aumento_ingresos';
  if (value === 'Diferimiento') return 'timing_shift';
  if (value === 'Renegociación') return 'ahorro';

  // Fallback: derive from type/operation hints.
  if (typeHint === 'pause_expense') return 'pausar_gasto';
  if (typeHint === 'timing_shift') return 'timing_shift';
  if (operationHint === 'increase') return 'aumento_ingresos';

  return 'ahorro';
}

function coerceFrequency(value: unknown): ProposalFrequency {
  if (value === 'once' || value === 'monthly' || value === 'bimonthly'
      || value === 'quarterly' || value === 'semiannual' || value === 'annual') {
    return value;
  }
  if (value === 'Mensual') return 'monthly';
  if (value === 'Semestral') return 'semiannual';
  if (value === 'Único') return 'once';
  return 'monthly';
}

function migrateLegacyV1Simulation(
  legacy: LegacySimulationV1,
  plan: FlowPlan | null,
): Proposal {
  const baseYear = plan?.year ?? new Date().getFullYear();
  const impactedMonths = legacy.monthlyImpact
    .map((value, monthOffset) => ({ value, monthOffset }))
    .filter((item) => item.value !== 0);

  const category = coerceCategory(legacy.category);
  const firstMonth = impactedMonths[0]?.monthOffset ?? Math.max(0, legacy.startMonth - 1);
  const lastMonth = impactedMonths[impactedMonths.length - 1]?.monthOffset ?? firstMonth;
  const startYm = `${baseYear}-${String(firstMonth + 1).padStart(2, '0')}`;
  const endYm = `${baseYear}-${String(lastMonth + 1).padStart(2, '0')}`;

  const base: Proposal = {
    id: `proposal-${legacy.id}`,
    name: legacy.name,
    description: legacy.notes || undefined,
    category,
    amount: Math.abs(legacy.monthlyAmount * legacy.probability),
    frequency: coerceFrequency(legacy.distribution),
    startDate: startOfMonthIso(startYm),
    endDate: endOfMonthIso(endYm),
    effects: [],
    createdAt: legacy.createdAt ?? isoNow(),
    updatedAt: legacy.createdAt ?? isoNow(),
  };

  if (plan) {
    base.effects = buildProposalEffects(plan, base);
  }

  return base;
}

function migrateV1Store(legacy: Partial<LegacyFlowSenseStoreV1>): FlowSenseStore {
  const plan = legacy.plan ?? null;
  const now = isoNow();
  const proposals = (legacy.simulations ?? []).map((simulation) => migrateLegacyV1Simulation(simulation, plan));

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

  const migratedScenarios = (legacy.scenarios ?? []).map<Scenario>((scenario) => ({
    id: scenario.id,
    simulationId: 'simulation-migrated',
    name: scenario.name,
    description: scenario.description,
    probability: 1,
    startYearMonth: firstPlanMonth(plan),
    horizonMonths: 12,
    proposalIds: scenario.selectedSimulationIds.map((simulationId) => `proposal-${simulationId}`),
    createdAt: scenario.createdAt ?? now,
    updatedAt: scenario.createdAt ?? now,
  }));

  const fallbackScenario: Scenario | null = needsMigratedContainer && migratedScenarios.length === 0
    ? {
        id: 'scenario-migrated-default',
        simulationId: 'simulation-migrated',
        name: 'Escenario migrado',
        description: 'Escenario generado para conservar propuestas y overrides legacy.',
        probability: 1,
        startYearMonth: firstPlanMonth(plan),
        horizonMonths: 12,
        proposalIds: [],
        createdAt: now,
        updatedAt: now,
      }
    : null;

  const scenarios = fallbackScenario ? [fallbackScenario] : migratedScenarios;

  if (simulations[0] && scenarios[0]) {
    simulations[0].activeScenarioId = scenarios[0].id;
  }

  const defaultScenarioId = scenarios[0]?.id ?? null;
  const scenarioCellOverrides: ScenarioCellOverride[] = (legacy.forecastOverrides ?? []).map((override) => ({
    key: scenarioCellKey(defaultScenarioId ?? 'scenario-migrated-default', override.conceptId, override.yearMonth),
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
    activeSimulationId: simulations[0]?.id ?? null,
    activeScenarioId: defaultScenarioId,
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
    scenarios: [],
    proposals: [],
    activeKpiIds: [...DEFAULT_ACTIVE_KPI_IDS],
    customKpis: [],
    kpiConfigs: [],
    scenarioCellOverrides: [],
    forecastConfidenceOverrides: [],
    activeSimulationId: null,
    activeScenarioId: null,
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

function normalizeScenario(value: Partial<Scenario>, plan: FlowPlan | null): Scenario | null {
  if (!value || typeof value.id !== 'string') return null;

  const startYearMonth = typeof value.startYearMonth === 'string' && value.startYearMonth.includes('-')
    ? value.startYearMonth
    : firstPlanMonth(plan);

  return {
    id: value.id,
    simulationId: typeof value.simulationId === 'string' ? value.simulationId : null,
    name: typeof value.name === 'string' && value.name ? value.name : 'Escenario sin nombre',
    description: typeof value.description === 'string' ? value.description : '',
    probability: typeof value.probability === 'number' ? value.probability : 1,
    startYearMonth,
    horizonMonths: typeof value.horizonMonths === 'number' ? Math.max(1, Math.min(24, value.horizonMonths)) : 12,
    proposalIds: Array.isArray(value.proposalIds)
      ? value.proposalIds.filter((id): id is string => typeof id === 'string')
      : [],
    locked: typeof value.locked === 'boolean' ? value.locked : undefined,
    createdAt: validateISODate(value.createdAt, 'scenario.createdAt'),
    updatedAt: validateISODate(value.updatedAt, 'scenario.updatedAt'),
  };
}

/**
 * Normalize a Proposal entry coming from any version of the persisted store.
 * Legacy v2/v3 proposals had extra fields (type, targetIds, operation, percent,
 * installments, customAllocation, shiftRatio, paymentLabel, comments); these
 * are collapsed into the new simplified shape.
 */
function normalizeProposal(
  proposal: Partial<Proposal> & Record<string, unknown>,
  plan: FlowPlan | null,
): Proposal {
  const category = coerceCategory(proposal.category, proposal.type, proposal.operation);

  // Derive startDate
  const rawStartDate = typeof proposal.startDate === 'string' && proposal.startDate.length === 10
    ? proposal.startDate
    : undefined;
  const rawStartYm = typeof proposal.startYearMonth === 'string' && proposal.startYearMonth.includes('-')
    ? proposal.startYearMonth
    : undefined;
  const startDate = rawStartDate
    ?? (rawStartYm ? startOfMonthIso(rawStartYm) : startOfMonthIso(firstPlanMonth(plan)));

  // Derive endDate
  const rawEndDate = typeof proposal.endDate === 'string' && proposal.endDate.length === 10
    ? proposal.endDate
    : undefined;
  const rawEndYm = typeof proposal.endYearMonth === 'string' && proposal.endYearMonth.includes('-')
    ? proposal.endYearMonth
    : undefined;
  const endDate = rawEndDate
    ?? (rawEndYm ? endOfMonthIso(rawEndYm) : undefined);

  // Derive amount — legacy proposals might only have `percent`. In that
  // case we can't recover the absolute value without recomputing against
  // the plan, so we default to 0 and let the user edit.
  let amount = 0;
  if (typeof proposal.amount === 'number' && Number.isFinite(proposal.amount)) {
    amount = Math.abs(proposal.amount);
  } else if (typeof (proposal as { monthlyAmount?: number }).monthlyAmount === 'number') {
    amount = Math.abs((proposal as { monthlyAmount: number }).monthlyAmount);
  }

  const shiftMonths = typeof proposal.shiftMonths === 'number' ? proposal.shiftMonths : undefined;

  const normalized: Proposal = {
    id: typeof proposal.id === 'string' ? proposal.id : `proposal-${Date.now()}`,
    name: typeof proposal.name === 'string' && proposal.name ? proposal.name : 'Propuesta sin nombre',
    description: typeof proposal.description === 'string' && proposal.description.trim()
      ? proposal.description.trim()
      : undefined,
    category,
    amount,
    frequency: coerceFrequency(proposal.frequency),
    startDate,
    endDate,
    shiftMonths,
    effects: Array.isArray(proposal.effects) ? (proposal.effects as Proposal['effects']) : [],
    createdAt: validateISODate(proposal.createdAt, 'proposal.createdAt'),
    updatedAt: validateISODate(proposal.updatedAt, 'proposal.updatedAt'),
  };

  // Always recompile effects from the current shape if a plan is available;
  // this keeps legacy effects in sync with the simplified model.
  if (plan) {
    normalized.effects = buildProposalEffects(plan, normalized);
  }

  return normalized;
}

function normalizeV4Store(data: Partial<FlowSenseStore>): FlowSenseStore {
  const plan = data.plan ?? null;

  const simulations = validateArray<Simulation>(data.simulations, 'simulations');
  const scenarios = validateArray<Partial<Scenario>>(data.scenarios, 'scenarios')
    .map((scenario) => normalizeScenario(scenario, plan))
    .filter((scenario): scenario is Scenario => scenario !== null);

  const proposals = validateArray<Partial<Proposal> & Record<string, unknown>>(data.proposals, 'proposals')
    .map((proposal) => normalizeProposal(proposal, plan));

  // Drop any lingering references to the obsolete base scenario ID.
  const cleanedActiveScenarioId = data.activeScenarioId === 'scenario-base'
    ? null
    : (data.activeScenarioId ?? null);

  const cleanedScenarios = scenarios.filter((scenario) => scenario.id !== 'scenario-base');

  return {
    plan,
    simulations,
    scenarios: cleanedScenarios,
    proposals,
    activeKpiIds: Array.isArray(data.activeKpiIds)
      ? data.activeKpiIds.filter((value): value is string => typeof value === 'string')
      : [...DEFAULT_ACTIVE_KPI_IDS],
    customKpis: validateArray<CustomKpiDefinition>(data.customKpis, 'customKpis').map(normalizeCustomKpi),
    kpiConfigs: validateArray<KpiConfigOverride>(data.kpiConfigs, 'kpiConfigs').map(normalizeKpiConfig),
    scenarioCellOverrides: validateArray<ScenarioCellOverride>(
      data.scenarioCellOverrides,
      'scenarioCellOverrides',
    ).filter((override) => override.scenarioId !== 'scenario-base'),
    forecastConfidenceOverrides: validateArray<ForecastConfidenceOverride>(
      data.forecastConfidenceOverrides,
      'forecastConfidenceOverrides',
    )
      .filter((override) => override.scenarioId !== 'scenario-base')
      .map(normalizeForecastConfidenceOverride),
    activeSimulationId: typeof data.activeSimulationId === 'string' ? data.activeSimulationId : null,
    activeScenarioId: cleanedActiveScenarioId,
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
      : '',
    score: Math.max(0, Math.min(100, Math.round(score))),
    basis,
    comment: typeof anyValue.comment === 'string' && anyValue.comment.trim()
      ? anyValue.comment.trim()
      : undefined,
    editedAt: validateISODate(anyValue.editedAt, 'forecastConfidenceOverride.editedAt'),
  };
}

/**
 * Raw shape of a v2/v3 store before the Proposal model simplification.
 * We collapse both into the v4 path: v3 shapes pass through with legacy
 * Proposals being normalized, v2 additionally has its proposals/simulations
 * arrays swapped (v2 code names were inverted vs UI).
 */
interface V2RawScenario {
  id: string;
  proposalId?: string | null;
  kind?: string;
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

function migrateV2ToV4Store(raw: V2RawStore): FlowSenseStore {
  const v2Proposals = Array.isArray(raw.proposals) ? raw.proposals : [];
  const v2Simulations = Array.isArray(raw.simulations) ? raw.simulations : [];
  const v2Scenarios = Array.isArray(raw.scenarios) ? raw.scenarios : [];

  const v4Scenarios = v2Scenarios.map((scenario) => {
    const anyScenario = scenario as V2RawScenario & Record<string, unknown>;
    const {
      proposalId,
      simulationIds,
      kind: _kind, // dropped — no more scenario kinds
      ...rest
    } = anyScenario;
    return {
      ...rest,
      simulationId: proposalId ?? null,
      proposalIds: Array.isArray(simulationIds) ? simulationIds : [],
    };
  });

  const v4Data: Partial<FlowSenseStore> = {
    ...(raw as Partial<FlowSenseStore>),
    simulations: v2Proposals as Simulation[],
    proposals: v2Simulations as Proposal[],
    scenarios: v4Scenarios as Scenario[],
    activeSimulationId:
      typeof raw.activeProposalId === 'string' ? raw.activeProposalId : null,
    activeScenarioId:
      typeof raw.activeScenarioId === 'string' ? raw.activeScenarioId : null,
  };

  delete (v4Data as Record<string, unknown>).activeProposalId;
  return normalizeV4Store(v4Data);
}

function migrateV3ToV4Store(raw: Partial<FlowSenseStore>): FlowSenseStore {
  return normalizeV4Store(raw);
}

export function loadStore(): FlowSenseStore | null {
  const sources: Array<{ key: string; expectedVersion: number }> = [
    { key: STORAGE_KEY, expectedVersion: 4 },
    { key: V3_STORAGE_KEY, expectedVersion: 3 },
    { key: V2_STORAGE_KEY, expectedVersion: 2 },
    { key: LEGACY_STORAGE_KEY, expectedVersion: 1 },
  ];

  for (const { key, expectedVersion } of sources) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;

    const payload = parseStoredPayload(raw);
    if (!payload) continue;

    if (payload.version === 4 && expectedVersion === 4) {
      return normalizeV4Store(payload.data as Partial<FlowSenseStore>);
    }

    if (payload.version === 3 && expectedVersion === 3) {
      return migrateV3ToV4Store(payload.data as Partial<FlowSenseStore>);
    }

    if (payload.version === 2 && expectedVersion === 2) {
      return migrateV2ToV4Store(payload.data as V2RawStore);
    }

    if (payload.version === 1 && expectedVersion === 1) {
      return migrateV1Store(payload.data as Partial<LegacyFlowSenseStoreV1>);
    }
  }

  return null;
}

export function clearStore(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(V3_STORAGE_KEY);
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

  if (obj.version === 4) {
    return normalizeV4Store(obj.data as Partial<FlowSenseStore>);
  }

  if (obj.version === 3) {
    return migrateV3ToV4Store(obj.data as Partial<FlowSenseStore>);
  }

  if (obj.version === 2) {
    return migrateV2ToV4Store(obj.data as V2RawStore);
  }

  if (obj.version === 1) {
    return migrateV1Store(obj.data as Partial<LegacyFlowSenseStoreV1>);
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

// Re-export helpers for consumers that used to import them indirectly.
export { PROPOSAL_CATEGORY_LABELS };
