export interface FlowPlan {
  name: string;
  year: number;
  cajaInicial: number;
  concepts: FlowConcept[];
  weekDates: string[];
}

export interface FlowConcept {
  id: string;
  excelRow: number;
  name: string;
  parentId: string | null;
  responsible: string | null;
  conceptType: 'ingreso' | 'egreso' | 'resumen' | 'reserva';
  sortOrder: number;
  weeklyData: number[];
  monthlyData: number[];
  children?: FlowConcept[];
}

export type ProposalStatus =
  | 'Pendiente'
  | 'En proceso'
  | 'Aprobada'
  | 'Descartada';

export const BASE_SCENARIO_ID = 'scenario-base';
export const BASE_SCENARIO_NAME = 'Escenario Base';

export type ScenarioKind = 'base' | 'proposal';

export type SimulationCategory =
  | 'Reducción de Costos'
  | 'Incremento de Ingresos'
  | 'Diferimiento'
  | 'Renegociación';

export type SimulationType =
  | 'percent_adjustment'
  | 'amount_adjustment'
  | 'recurring_series'
  | 'installment_plan'
  | 'timing_shift'
  | 'pause_expense';

export type SimulationFrequency =
  | 'once'
  | 'monthly'
  | 'bimonthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual';

export type SimulationOperation = 'increase' | 'decrease';

export type SimulationEffectMode = 'absolute' | 'percent';
export type ForecastGranularity = 'monthly' | 'weekly' | 'daily';

export const ROLE_TARGET_INCOME = '__role__:income';
export const ROLE_TARGET_EXPENSE = '__role__:expense';
export const ROLE_TARGET_COLLECTIONS = '__role__:collections';
export const ROLE_TARGET_PROVIDER_PAYMENTS = '__role__:provider-payments';

export const ROLE_TARGET_LABELS: Record<string, string> = {
  [ROLE_TARGET_INCOME]: 'Ajuste general ingresos',
  [ROLE_TARGET_EXPENSE]: 'Ajuste general egresos',
  [ROLE_TARGET_COLLECTIONS]: 'Ajuste general cobranza',
  [ROLE_TARGET_PROVIDER_PAYMENTS]: 'Ajuste general pagos proveedores',
};

export interface ConceptDeltaEffect {
  id: string;
  type: 'concept_delta';
  conceptId: string;
  monthOffsets?: number[];
  yearMonths?: string[];
  startDate?: string;
  endDate?: string;
  mode: SimulationEffectMode;
  value: number;
}

export type SimulationEffect = ConceptDeltaEffect;

export interface Simulation {
  id: string;
  name: string;
  description: string;
  category: SimulationCategory;
  type: SimulationType;
  targetIds: string[];
  startYearMonth: string;
  endYearMonth?: string;
  startDate?: string;
  endDate?: string;
  frequency?: SimulationFrequency;
  operation?: SimulationOperation;
  amount?: number;
  percent?: number;
  installments?: number;
  customAllocation?: number[];
  shiftMonths?: number;
  shiftRatio?: number;
  paymentLabel?: string;
  comments?: string;
  effects: SimulationEffect[];
  createdAt: string;
  updatedAt: string;
}

export interface Proposal {
  id: string;
  name: string;
  description: string;
  status: ProposalStatus;
  activeScenarioId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Scenario {
  id: string;
  proposalId: string | null;
  kind: ScenarioKind;
  name: string;
  description: string;
  probability: number;
  startYearMonth: string;
  horizonMonths: number;
  simulationIds: string[];
  locked?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DrillDownLevel {
  label: string;
  conceptId: string | null;
  month: number | null;
}

export type TabId =
  | 'dashboard'
  | 'kpis'
  | 'scenarios'
  | 'forecast'
  | 'providers'
  | 'collections'
  | 'clients'
  | 'cxp'
  | 'bancos'
  | 'netflow';

export type ForecastView = 'pnl' | 'cashflow' | 'drivers';

export interface ScenarioCellOverride {
  key: string;
  scenarioId: string;
  conceptId: string;
  yearMonth: string;
  baseValue: number;
  simulatedValue: number;
  manualValue: number;
  comment?: string;
  editedAt: string;
}

export function scenarioCellKey(
  scenarioId: string,
  conceptId: string,
  yearMonth: string,
): string {
  return `${scenarioId}::${conceptId}::${yearMonth}`;
}

export interface ScenarioMonth {
  monthIndex: number;
  year: number;
  label: string;
  ym: string;
  granularity: ForecastGranularity;
  startDate: string;
  endDate: string;
}

export interface SimulationContribution {
  simulationId: string;
  simulationName: string;
  delta: number;
}

export interface EvaluatedCell {
  key: string;
  conceptId: string;
  yearMonth: string;
  monthIndex: number;
  granularity: ForecastGranularity;
  periodLabel: string;
  periodStartDate: string;
  periodEndDate: string;
  baseValue: number;
  simulatedValue: number;
  finalValue: number;
  manualDelta: number;
  override?: ScenarioCellOverride;
  comment?: string;
  simulationContributions: SimulationContribution[];
  hasSimulationDelta: boolean;
  hasManualDelta: boolean;
  isOverridden: boolean;
  isEditable: boolean;
}

export interface ScenarioMetrics {
  ingresos: number[];
  egresos: number[];
  flujoNeto: number[];
  cajaFinal: number[];
  cobranza: number[];
  pagosProveedores: number[];
  saldosFinales: number[];
}

export interface ScenarioKpis {
  ingresos12m: number;
  egresos12m: number;
  flujoNeto12m: number;
  cajaFinal: number;
  cajaMinima: number;
  cobranza12m: number;
  pagosProveedores12m: number;
}

export interface ScenarioComparisonSnapshot {
  scenarioId: string;
  proposalId: string;
  diffByCellKey: Map<string, number>;
  kpiDiff: Partial<Record<keyof ScenarioKpis, number>>;
}

export interface EvaluatedScenario {
  proposalId: string;
  scenarioId: string;
  granularity: ForecastGranularity;
  months: ScenarioMonth[];
  valuesByConceptId: Map<string, number[]>;
  baseValuesByConceptId: Map<string, number[]>;
  cells: Map<string, EvaluatedCell>;
  diffVsBase: Map<string, number>;
  changedKeys: Set<string>;
  metrics: ScenarioMetrics;
  kpis: ScenarioKpis;
}

export type ForecastLayerMode = 'base' | 'simulated' | 'manual' | 'diff';

export const MONTHS = [
  'Ene',
  'Feb',
  'Mar',
  'Abr',
  'May',
  'Jun',
  'Jul',
  'Ago',
  'Sep',
  'Oct',
  'Nov',
  'Dic',
];

export const MONTHS_FULL = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

export const CATEGORY_COLORS: Record<SimulationCategory, string> = {
  'Reducción de Costos': '#0071e3',
  'Incremento de Ingresos': '#34c759',
  'Diferimiento': '#ff9f0a',
  'Renegociación': '#af52de',
};
