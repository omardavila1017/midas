export interface FlowPlan {
  name: string;
  year: number;
  cajaInicial: number;
  concepts: FlowConcept[];
  weekDates: string[];
  /**
   * True when the plan came from the mock fallback (no real Cognos/JDE API
   * credentials configured). KPI surfaces gate their numbers on this so we
   * never show "real-looking" KPIs that are actually synthetic.
   */
  isMock?: boolean;
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

export type SimulationStatus =
  | 'Pendiente'
  | 'En proceso'
  | 'Aprobada'
  | 'Descartada';

export type ProposalCategory =
  | 'ahorro'
  | 'aumento_ingresos'
  | 'pausar_gasto'
  | 'timing_shift';

export const PROPOSAL_CATEGORY_LABELS: Record<ProposalCategory, string> = {
  ahorro: 'Ahorro',
  aumento_ingresos: 'Aumento de ingresos',
  pausar_gasto: 'Pausar gasto',
  timing_shift: 'Adelantar o retrasar',
};

export const PROPOSAL_CATEGORY_DESCRIPTIONS: Record<ProposalCategory, string> = {
  ahorro: 'Reduce egresos agregados por el monto indicado.',
  aumento_ingresos: 'Suma ingresos agregados por el monto indicado.',
  pausar_gasto: 'Congela egresos agregados durante el rango de fechas.',
  timing_shift: 'Mueve un monto de un periodo a otro (adelantar o retrasar).',
};

export type ProposalFrequency =
  | 'once'
  | 'monthly'
  | 'bimonthly'
  | 'quarterly'
  | 'semiannual'
  | 'annual';

export const PROPOSAL_FREQUENCY_LABELS: Record<ProposalFrequency, string> = {
  once: 'Una sola vez',
  monthly: 'Mensual',
  bimonthly: 'Bimestral',
  quarterly: 'Trimestral',
  semiannual: 'Semestral',
  annual: 'Anual',
};

export type ProposalEffectMode = 'absolute' | 'percent';
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
  mode: ProposalEffectMode;
  value: number;
}

export type ProposalEffect = ConceptDeltaEffect;

export interface Proposal {
  id: string;
  name: string;
  description?: string;
  category: ProposalCategory;
  amount: number;
  frequency: ProposalFrequency;
  startDate: string;
  endDate?: string;
  shiftMonths?: number;
  effects: ProposalEffect[];
  createdAt: string;
  updatedAt: string;
}

export interface Simulation {
  id: string;
  name: string;
  description: string;
  status: SimulationStatus;
  activeScenarioId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Scenario {
  id: string;
  simulationId: string | null;
  name: string;
  description: string;
  probability: number;
  startYearMonth: string;
  horizonMonths: number;
  proposalIds: string[];
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

export type ForecastConfidenceBasis =
  | 'system_calculation'
  | 'manual_calculation'
  | 'human_criteria'
  | 'mixed';

export interface ForecastConfidenceOverride {
  scenarioId: string;
  score: number;
  basis: ForecastConfidenceBasis;
  comment?: string;
  editedAt: string;
}

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

export interface ProposalContribution {
  proposalId: string;
  proposalName: string;
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
  proposalContributions: ProposalContribution[];
  hasProposalDelta: boolean;
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
  simulationId: string;
  diffByCellKey: Map<string, number>;
  kpiDiff: Partial<Record<keyof ScenarioKpis, number>>;
}

export interface EvaluatedScenario {
  simulationId: string;
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
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
];

export const MONTHS_FULL = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

export const CATEGORY_COLORS: Record<ProposalCategory, string> = {
  ahorro: 'var(--primary)',
  aumento_ingresos: 'var(--success)',
  pausar_gasto: 'var(--warning)',
  timing_shift: 'var(--chart-4)',
};
