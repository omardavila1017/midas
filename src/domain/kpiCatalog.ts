import { projectYear } from './collectionEngine';
import { evaluateScenario } from './scenarioEngine';
import { isBaseScenario } from './simulationCompiler';
import type { CashFlowAssumptions, Client, ConfirmedPayment } from './types';
import type { BankAccountStatement } from '../services/jdeTypes';
import {
  BASE_SCENARIO_NAME,
  FlowPlan,
  MONTHS,
  MONTHS_FULL,
  Proposal,
  Scenario,
  ScenarioCellOverride,
  Simulation,
} from '../types';
import { hex } from '../theme';

export type KpiUnit = 'currency' | 'percent' | 'count' | 'days' | 'times' | 'custom';
export type KpiGoal = 'higher' | 'lower';
export type KpiComparisonKind = 'target' | 'base';
export type KpiStatus = 'met' | 'warning' | 'missed' | 'na';
export type KpiPeriod = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual';

export type KpiTargetSource = 'manual' | 'auto';
export type KpiTargetOwner = 'user' | 'system' | 'historical';

export interface KpiTargetHistoryEntry {
  value: number;
  warningThreshold: number;
  goal: KpiGoal;
  targetSource: KpiTargetSource;
  targetSourceVariable?: string;
  targetOwner: KpiTargetOwner;
  note?: string;
  changedAt: string;
}

export interface KpiConfigOverride {
  kpiId: string;
  targetValue: number;
  targetSource: KpiTargetSource;
  targetSourceVariable?: string;
  targetOwner: KpiTargetOwner;
  goal: KpiGoal;
  warningThreshold: number;
  notes: string;
  updatedAt: string;
  history: KpiTargetHistoryEntry[];
}

export interface CustomKpiDefinition {
  id: string;
  name: string;
  category: string;
  formula: string;
  targetValue: number;
  targetSource: KpiTargetSource;
  targetSourceVariable?: string;
  period: KpiPeriod;
  unit: KpiUnit;
  customUnitLabel?: string;
  goal: KpiGoal;
  warningThreshold: number;
  targetOwner: KpiTargetOwner;
  notes: string;
  targetHistory: KpiTargetHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface KpiVariableDoc {
  key: string;
  label: string;
  description: string;
  group: string;
}

export interface KpiFormulaHelperDoc {
  signature: string;
  description: string;
}

export interface KpiPoint {
  label: string;
  value: number;
  comparison: number | null;
  status: KpiStatus;
}

export interface KpiCatalogEntry {
  id: string;
  label: string;
  description: string;
  category: string;
  unit: KpiUnit;
  accentColor: string;
  comparisonKind: KpiComparisonKind;
  goal: KpiGoal;
  source: 'template' | 'custom';
  isCustom: boolean;
  available: boolean;
  availabilityReason: string | null;
  periodLabel: string | null;
  periodKey: KpiPeriod | null;
  value: number | null;
  comparisonValue: number | null;
  comparisonLabel: string | null;
  diffValue: number | null;
  status: KpiStatus;
  points: KpiPoint[];
  chartValueLabel: string | null;
  chartComparisonLabel: string | null;
  note: string | null;
  formula: string | null;
  sourceDataLabel: string | null;
  targetValue: number | null;
  targetSource: KpiTargetSource | null;
  targetSourceVariable: string | null;
  targetOwner: KpiTargetOwner | null;
  targetUpdatedAt: string | null;
  warningThreshold: number | null;
  manualNotes: string | null;
  targetHistory: KpiTargetHistoryEntry[];
  customUnitLabel: string | null;
}

export interface KpiCatalogInput {
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  cxpRecords: Array<{
    fechaFactura: string;
    fechaProgramacionPago: string;
    fechaVence: string;
    importePendientePesos: number;
    diasVencida: number;
  }>;
  bankStatements: BankAccountStatement[];
  plan: FlowPlan | null;
  proposals: Proposal[];
  scenarios: Scenario[];
  simulations: Simulation[];
  overrides: ScenarioCellOverride[];
  activeProposalId: string | null;
  activeScenarioId: string | null;
  activeMonth: number;
  customKpis?: CustomKpiDefinition[];
  kpiConfigs?: KpiConfigOverride[];
}

interface KpiDefinition {
  id: string;
  label: string;
  description: string;
  category: string;
  unit: KpiUnit;
  accentColor: string;
  comparisonKind: KpiComparisonKind;
  goal: KpiGoal;
  build: (
    context: BuildContext,
  ) => Omit<
    KpiCatalogEntry,
    'id'
    | 'label'
    | 'description'
    | 'category'
    | 'unit'
    | 'accentColor'
    | 'comparisonKind'
    | 'goal'
    | 'source'
    | 'isCustom'
  >;
}

interface CollectionSnapshot {
  year: number;
  projectedMonthly: number[];
  targetMonthly: number[];
  confirmedMonthly: number[];
  expectedClientCounts: number[];
  confirmedClientCounts: number[];
  coverageMonthly: number[];
}

interface ForecastSnapshot {
  year: number;
  activeScenarioName: string;
  baseScenarioName: string;
  monthlyLabels: string[];
  activeMetrics: {
    ingresos: number[];
    egresos: number[];
    flujoNeto: number[];
    cajaFinal: number[];
    cobranza: number[];
    pagosProveedores: number[];
  };
  baseMetrics: {
    ingresos: number[];
    egresos: number[];
    flujoNeto: number[];
    cajaFinal: number[];
    cobranza: number[];
    pagosProveedores: number[];
  };
  activeKpis: {
    ingresos12m: number;
    egresos12m: number;
    flujoNeto12m: number;
    cajaFinal: number;
    cajaMinima: number;
    cobranza12m: number;
    pagosProveedores12m: number;
  };
  baseKpis: {
    ingresos12m: number;
    egresos12m: number;
    flujoNeto12m: number;
    cajaFinal: number;
    cajaMinima: number;
    cobranza12m: number;
    pagosProveedores12m: number;
  };
}

interface OperationsSnapshot {
  year: number;
  actualInflowsMonthly: number[];
  actualOutflowsMonthly: number[];
  actualNetFlowMonthly: number[];
  scheduledOutflowsMonthly: number[];
  paymentDaysMonthly: number[];
  paymentDaysAverage: number;
  pendingLiabilities: number;
  latestLiquidity: number | null;
  latestLiquidityDate: string | null;
}

interface BuildContext {
  activeMonth: number;
  collection: CollectionSnapshot | null;
  forecast: ForecastSnapshot | null;
  operations: OperationsSnapshot | null;
}

export const DEFAULT_ACTIVE_KPI_IDS = [
  'cash_collection_target',
  'cash_expense_target',
  'cash_minimum_safety',
  'cash_net_flow_projected',
  'cash_projected_ending_balance',
  'cash_deficit_risk',
  'cash_collection_compliance',
  'cash_coverage_months',
] as const;

export const KPI_PERIOD_OPTIONS: Array<{ value: KpiPeriod; label: string }> = [
  { value: 'daily', label: 'Diario' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'monthly', label: 'Mensual' },
  { value: 'quarterly', label: 'Trimestral' },
  { value: 'annual', label: 'Anual' },
];

export const KPI_UNIT_OPTIONS: Array<{ value: KpiUnit; label: string }> = [
  { value: 'currency', label: 'Pesos' },
  { value: 'percent', label: 'Porcentaje' },
  { value: 'days', label: 'Días' },
  { value: 'times', label: 'Veces' },
  { value: 'count', label: 'Conteo' },
  { value: 'custom', label: 'Personalizada' },
];

export const KPI_GOAL_OPTIONS: Array<{ value: KpiGoal; label: string }> = [
  { value: 'higher', label: 'Más alto es mejor' },
  { value: 'lower', label: 'Más bajo es mejor' },
];

export const KPI_VARIABLE_GROUP_ORIGIN: Record<string, string> = {
  'Pronóstico': 'Pronóstico del escenario activo',
  'Base / presupuesto': 'Plan de flujo base (pronóstico original)',
  'Desviaciones': 'Diferencia entre escenario activo y base',
  'Cobranza': 'Módulo Cobranza (clientes + pagos confirmados)',
  'Flujo de efectivo': 'KPIs de flujo de efectivo, bancos, CXP y escenario activo',
  'Conceptos del plan': 'Concepto del plan de flujo cargado',
};

export const KPI_FORMULA_HELPERS: KpiFormulaHelperDoc[] = [
  { signature: 'safe_div(a, b)', description: 'Divide y regresa 0 si el denominador es 0.' },
  { signature: 'pct(a, b)', description: 'Atajo de porcentaje: a / b.' },
  { signature: 'ifelse(cond, a, b)', description: 'Evalúa una condición y devuelve un valor u otro.' },
  { signature: 'abs(x)', description: 'Valor absoluto.' },
  { signature: 'min(a, b)', description: 'Menor entre dos valores.' },
  { signature: 'max(a, b)', description: 'Mayor entre dos valores.' },
  { signature: 'round(x)', description: 'Redondea al entero más cercano.' },
];

function monthIndexFromIso(isoDate: string): number {
  return Number(isoDate.slice(5, 7)) - 1;
}

function createMonthlyBuckets(): Set<string>[] {
  return Array.from({ length: 12 }, () => new Set<string>());
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function statusFor(value: number, comparison: number | null, goal: KpiGoal): KpiStatus {
  if (comparison === null) return 'na';
  if (goal === 'higher') return value + 0.0001 >= comparison ? 'met' : 'missed';
  return value <= comparison + 0.0001 ? 'met' : 'missed';
}

function buildPoints(
  labels: string[],
  valueSeries: number[],
  comparisonSeries: Array<number | null>,
  goal: KpiGoal,
): KpiPoint[] {
  return labels.map((label, index) => {
    const value = valueSeries[index] ?? 0;
    const comparison = comparisonSeries[index] ?? null;
    return {
      label,
      value,
      comparison,
      status: statusFor(value, comparison, goal),
    };
  });
}

function unavailable(definition: KpiDefinition, reason: string): KpiCatalogEntry {
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    category: definition.category,
    unit: definition.unit,
    accentColor: definition.accentColor,
    comparisonKind: definition.comparisonKind,
    goal: definition.goal,
    source: 'template',
    isCustom: false,
    available: false,
    availabilityReason: reason,
    periodLabel: null,
    periodKey: null,
    value: null,
    comparisonValue: null,
    comparisonLabel: null,
    diffValue: null,
    status: 'na',
    points: [],
    chartValueLabel: null,
    chartComparisonLabel: null,
    note: null,
    formula: null,
    sourceDataLabel: null,
    targetValue: null,
    targetSource: null,
    targetSourceVariable: null,
    targetOwner: null,
    targetUpdatedAt: null,
    warningThreshold: null,
    manualNotes: null,
    targetHistory: [],
    customUnitLabel: null,
  };
}

function buildCollectionSnapshot(
  clients: Client[],
  assumptions: CashFlowAssumptions,
  confirmedPayments: ConfirmedPayment[],
): CollectionSnapshot | null {
  if (clients.length === 0) return null;

  const projectedEvents = projectYear(clients, assumptions);
  const targetEvents = projectYear(
    clients.map((client) => ({ ...client, complianceRate: 1 })),
    { ...assumptions, globalCompliance: 1 },
  );
  const projectedMonthly = new Array(12).fill(0);
  const targetMonthly = new Array(12).fill(0);
  const confirmedMonthly = new Array(12).fill(0);
  const expectedClientBuckets = createMonthlyBuckets();
  const confirmedClientBuckets = createMonthlyBuckets();

  for (const event of projectedEvents) {
    projectedMonthly[monthIndexFromIso(event.realDate)] += event.amount;
  }

  for (const event of targetEvents) {
    const monthIndex = monthIndexFromIso(event.realDate);
    targetMonthly[monthIndex] += event.amount;
    expectedClientBuckets[monthIndex].add(event.clientId);
  }

  for (const payment of confirmedPayments) {
    if (!payment.realDate.startsWith(String(assumptions.year))) continue;
    const monthIndex = monthIndexFromIso(payment.realDate);
    confirmedMonthly[monthIndex] += payment.amount;
    confirmedClientBuckets[monthIndex].add(payment.clientId);
  }

  return {
    year: assumptions.year,
    projectedMonthly,
    targetMonthly,
    confirmedMonthly,
    expectedClientCounts: expectedClientBuckets.map((bucket) => bucket.size),
    confirmedClientCounts: confirmedClientBuckets.map((bucket) => bucket.size),
    coverageMonthly: targetMonthly.map((value, index) => (value > 0 ? confirmedMonthly[index] / value : 1)),
  };
}

function buildForecastSnapshot(input: KpiCatalogInput): ForecastSnapshot | null {
  const { plan, proposals, scenarios, simulations, overrides, activeProposalId, activeScenarioId } = input;
  if (!plan || scenarios.length === 0) return null;

  const baseScenario = scenarios.find((scenario) => isBaseScenario(scenario)) ?? null;
  const activeProposal = proposals.find((proposal) => proposal.id === activeProposalId) ?? proposals[0] ?? null;
  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId)
    ?? scenarios.find((scenario) => scenario.proposalId === activeProposal?.id)
    ?? baseScenario
    ?? null;

  if (!activeScenario) return null;

  const effectiveProposal = activeProposal ?? {
    id: 'proposal-base',
    name: BASE_SCENARIO_NAME,
    description: 'Pronóstico original',
    status: 'Pendiente' as const,
    createdAt: '',
    updatedAt: '',
  };

  const activeEvaluation = evaluateScenario(
    plan,
    effectiveProposal,
    activeScenario,
    isBaseScenario(activeScenario) ? [] : simulations,
    isBaseScenario(activeScenario) ? [] : overrides,
    { granularity: 'monthly' },
  );
  const baseEvaluation = evaluateScenario(
    plan,
    effectiveProposal,
    activeScenario,
    [],
    [],
    { granularity: 'monthly' },
  );

  return {
    year: plan.year,
    activeScenarioName: activeScenario.name,
    baseScenarioName: BASE_SCENARIO_NAME,
    monthlyLabels: activeEvaluation.months.map((month) => month.label),
    activeMetrics: activeEvaluation.metrics,
    baseMetrics: baseEvaluation.metrics,
    activeKpis: activeEvaluation.kpis,
    baseKpis: baseEvaluation.kpis,
  };
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime());
}

function safeMonthIndexFromIso(isoDate: string): number | null {
  if (!isValidIsoDate(isoDate)) return null;
  const monthIndex = monthIndexFromIso(isoDate);
  return monthIndex >= 0 && monthIndex < 12 ? monthIndex : null;
}

function diffDaysBetween(startDate: string, endDate: string): number | null {
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) return null;
  const start = new Date(`${startDate}T12:00:00Z`).getTime();
  const end = new Date(`${endDate}T12:00:00Z`).getTime();
  return Math.round((end - start) / 86_400_000);
}

function latestIsoDate(values: string[]): string | null {
  const sorted = values.filter(isValidIsoDate).sort();
  return sorted.length > 0 ? sorted[sorted.length - 1] : null;
}

function buildOperationsSnapshot(input: KpiCatalogInput): OperationsSnapshot | null {
  const year = input.plan?.year ?? input.assumptions.year;
  const actualInflowsMonthly = new Array(12).fill(0);
  const actualOutflowsMonthly = new Array(12).fill(0);
  const scheduledOutflowsMonthly = new Array(12).fill(0);
  const paymentDaySumsMonthly = new Array(12).fill(0);
  const paymentDayCountsMonthly = new Array(12).fill(0);
  let pendingLiabilities = 0;

  for (const statement of input.bankStatements) {
    for (const movement of statement.movimientos) {
      if (!movement.fechaOperacion.startsWith(String(year))) continue;
      const monthIndex = safeMonthIndexFromIso(movement.fechaOperacion);
      if (monthIndex === null) continue;
      const isOutflow = String(movement.tipoMovimiento).toUpperCase().includes('CARGO') || String(movement.tipoMovimiento).toUpperCase().includes('DEBIT');
      if (isOutflow) actualOutflowsMonthly[monthIndex] += movement.importe;
      else actualInflowsMonthly[monthIndex] += movement.importe;
    }
  }

  for (const record of input.cxpRecords) {
    pendingLiabilities += Math.max(0, record.importePendientePesos ?? 0);
    const paymentMonth = safeMonthIndexFromIso(record.fechaProgramacionPago);
    if (paymentMonth !== null && record.fechaProgramacionPago.startsWith(String(year))) {
      scheduledOutflowsMonthly[paymentMonth] += Math.max(0, record.importePendientePesos ?? 0);
      const days = diffDaysBetween(record.fechaFactura, record.fechaProgramacionPago);
      if (days !== null) {
        paymentDaySumsMonthly[paymentMonth] += days;
        paymentDayCountsMonthly[paymentMonth] += 1;
      }
    }
  }

  const paymentDaysMonthly = paymentDaySumsMonthly.map((sumValue, index) => (
    paymentDayCountsMonthly[index] > 0 ? sumValue / paymentDayCountsMonthly[index] : 0
  ));
  const paymentDayCountTotal = paymentDayCountsMonthly.reduce((total, value) => total + value, 0);
  const paymentDaysAverage = paymentDayCountTotal > 0
    ? paymentDaySumsMonthly.reduce((total, value) => total + value, 0) / paymentDayCountTotal
    : 0;
  const actualNetFlowMonthly = actualInflowsMonthly.map((value, index) => value - (actualOutflowsMonthly[index] ?? 0));
  const latestDate = latestIsoDate(input.bankStatements.map((statement) => statement.fechaEstadoCuenta));
  const latestLiquidity = latestDate
    ? input.bankStatements
      .filter((statement) => statement.fechaEstadoCuenta === latestDate)
      .reduce((total, statement) => total + (statement.saldoFinal ?? 0), 0)
    : null;

  const hasData = input.bankStatements.length > 0 || input.cxpRecords.length > 0;
  if (!hasData) return null;

  return {
    year,
    actualInflowsMonthly,
    actualOutflowsMonthly,
    actualNetFlowMonthly,
    scheduledOutflowsMonthly,
    paymentDaysMonthly,
    paymentDaysAverage,
    pendingLiabilities,
    latestLiquidity,
    latestLiquidityDate: latestDate,
  };
}

function buildCollectionMonthlyEntry(
  context: BuildContext,
  config: {
    valueSeries: number[];
    comparisonSeries: number[];
    comparisonLabel: string;
    unit: KpiUnit;
    goal: KpiGoal;
    note: string;
  },
): Omit<
  KpiCatalogEntry,
  'id'
  | 'label'
  | 'description'
  | 'category'
  | 'unit'
  | 'accentColor'
  | 'comparisonKind'
  | 'goal'
  | 'source'
  | 'isCustom'
> {
  const collection = context.collection!;
  const value = config.valueSeries[context.activeMonth] ?? 0;
  const comparisonValue = config.comparisonSeries[context.activeMonth] ?? 0;
  return {
    available: true,
    availabilityReason: null,
    periodLabel: `${MONTHS_FULL[context.activeMonth]} ${collection.year}`,
    periodKey: 'monthly',
    value,
    comparisonValue,
    comparisonLabel: config.comparisonLabel,
    diffValue: value - comparisonValue,
    status: statusFor(value, comparisonValue, config.goal),
    points: buildPoints(MONTHS, config.valueSeries, config.comparisonSeries, config.goal),
    chartValueLabel: 'Resultado',
    chartComparisonLabel: config.comparisonLabel,
    note: config.note,
    formula: null,
    sourceDataLabel: null,
    targetValue: comparisonValue,
    targetSource: null,
    targetSourceVariable: null,
    targetOwner: null,
    targetUpdatedAt: null,
    warningThreshold: null,
    manualNotes: null,
    targetHistory: [],
    customUnitLabel: null,
  };
}

function buildForecastMonthlyEntry(
  context: BuildContext,
  config: {
    valueSeries: number[];
    comparisonSeries: number[];
    goal: KpiGoal;
    note: string;
  },
): Omit<
  KpiCatalogEntry,
  'id'
  | 'label'
  | 'description'
  | 'category'
  | 'unit'
  | 'accentColor'
  | 'comparisonKind'
  | 'goal'
  | 'source'
  | 'isCustom'
> {
  const forecast = context.forecast!;
  const value = config.valueSeries[context.activeMonth] ?? 0;
  const comparisonValue = config.comparisonSeries[context.activeMonth] ?? 0;
  return {
    available: true,
    availabilityReason: null,
    periodLabel: `${MONTHS_FULL[context.activeMonth]} ${forecast.year}`,
    periodKey: 'monthly',
    value,
    comparisonValue,
    comparisonLabel: 'Base',
    diffValue: value - comparisonValue,
    status: statusFor(value, comparisonValue, config.goal),
    points: buildPoints(forecast.monthlyLabels, config.valueSeries, config.comparisonSeries, config.goal),
    chartValueLabel: forecast.activeScenarioName,
    chartComparisonLabel: 'Base',
    note: config.note,
    formula: null,
    sourceDataLabel: null,
    targetValue: comparisonValue,
    targetSource: null,
    targetSourceVariable: null,
    targetOwner: null,
    targetUpdatedAt: null,
    warningThreshold: null,
    manualNotes: null,
    targetHistory: [],
    customUnitLabel: null,
  };
}

function buildForecastSummaryEntry(
  context: BuildContext,
  config: {
    value: number;
    comparisonValue: number;
    valueSeries: number[];
    comparisonSeries: number[];
    goal: KpiGoal;
    note: string;
  },
): Omit<
  KpiCatalogEntry,
  'id'
  | 'label'
  | 'description'
  | 'category'
  | 'unit'
  | 'accentColor'
  | 'comparisonKind'
  | 'goal'
  | 'source'
  | 'isCustom'
> {
  const forecast = context.forecast!;
  return {
    available: true,
    availabilityReason: null,
    periodLabel: `Año ${forecast.year}`,
    periodKey: 'annual',
    value: config.value,
    comparisonValue: config.comparisonValue,
    comparisonLabel: 'Base',
    diffValue: config.value - config.comparisonValue,
    status: statusFor(config.value, config.comparisonValue, config.goal),
    points: buildPoints(forecast.monthlyLabels, config.valueSeries, config.comparisonSeries, config.goal),
    chartValueLabel: forecast.activeScenarioName,
    chartComparisonLabel: 'Base',
    note: config.note,
    formula: null,
    sourceDataLabel: null,
    targetValue: config.comparisonValue,
    targetSource: null,
    targetSourceVariable: null,
    targetOwner: null,
    targetUpdatedAt: null,
    warningThreshold: null,
    manualNotes: null,
    targetHistory: [],
    customUnitLabel: null,
  };
}

const KPI_DEFINITIONS: KpiDefinition[] = [
  {
    id: 'collection_projected_month',
    label: 'Cobranza proyectada',
    description: 'Cobranza esperada del mes bajo el escenario actual contra la meta teórica al 100% de cumplimiento.',
    category: 'Cobranza',
    unit: 'currency',
    accentColor: hex.primary,
    comparisonKind: 'target',
    goal: 'higher',
    build: (context) => buildCollectionMonthlyEntry(context, {
      valueSeries: context.collection!.projectedMonthly,
      comparisonSeries: context.collection!.targetMonthly,
      comparisonLabel: 'Meta',
      unit: 'currency',
      goal: 'higher',
      note: 'La meta usa la misma agenda de cobro, pero asumiendo cumplimiento total.',
    }),
  },
  {
    id: 'collection_confirmed_month',
    label: 'Cobrado confirmado',
    description: 'Cobros ya confirmados por el equipo contra la meta teórica del mes.',
    category: 'Cobranza',
    unit: 'currency',
    accentColor: hex.success,
    comparisonKind: 'target',
    goal: 'higher',
    build: (context) => buildCollectionMonthlyEntry(context, {
      valueSeries: context.collection!.confirmedMonthly,
      comparisonSeries: context.collection!.targetMonthly,
      comparisonLabel: 'Meta',
      unit: 'currency',
      goal: 'higher',
      note: 'Ayuda a medir cuánto de la meta ya se convirtió en cobranza real confirmada.',
    }),
  },
  {
    id: 'collection_coverage_month',
    label: 'Cumplimiento real',
    description: 'Porcentaje de cumplimiento del mes: cobrado confirmado dividido entre la meta.',
    category: 'Cobranza',
    unit: 'percent',
    accentColor: hex.warning,
    comparisonKind: 'target',
    goal: 'higher',
    build: (context) => buildCollectionMonthlyEntry(context, {
      valueSeries: context.collection!.coverageMonthly,
      comparisonSeries: new Array(12).fill(1),
      comparisonLabel: 'Meta 100%',
      unit: 'percent',
      goal: 'higher',
      note: 'Un valor de 100% o más implica que el KPI sí alcanzó su objetivo mensual.',
    }),
  },
  {
    id: 'collection_clients_month',
    label: 'Clientes cobrados',
    description: 'Clientes con cobro confirmado frente a los clientes que debían caer en el mes.',
    category: 'Cobranza',
    unit: 'count',
    accentColor: hex.info,
    comparisonKind: 'target',
    goal: 'higher',
    build: (context) => buildCollectionMonthlyEntry(context, {
      valueSeries: context.collection!.confirmedClientCounts,
      comparisonSeries: context.collection!.expectedClientCounts,
      comparisonLabel: 'Esperados',
      unit: 'count',
      goal: 'higher',
      note: 'Permite seguir cobertura de clientes, no solo montos.',
    }),
  },
  {
    id: 'forecast_ingresos_month',
    label: 'Ingresos del mes',
    description: 'Ingresos del mes en el escenario activo comparados contra el escenario base.',
    category: 'Pronóstico mensual',
    unit: 'currency',
    accentColor: hex.primary,
    comparisonKind: 'base',
    goal: 'higher',
    build: (context) => buildForecastMonthlyEntry(context, {
      valueSeries: context.forecast!.activeMetrics.ingresos,
      comparisonSeries: context.forecast!.baseMetrics.ingresos,
      goal: 'higher',
      note: 'Un valor arriba de base implica mejora de ingresos en el periodo.',
    }),
  },
  {
    id: 'forecast_egresos_month',
    label: 'Egresos del mes',
    description: 'Egresos del mes en el escenario activo comparados contra el base.',
    category: 'Pronóstico mensual',
    unit: 'currency',
    accentColor: hex.danger,
    comparisonKind: 'base',
    goal: 'lower',
    build: (context) => buildForecastMonthlyEntry(context, {
      valueSeries: context.forecast!.activeMetrics.egresos,
      comparisonSeries: context.forecast!.baseMetrics.egresos,
      goal: 'lower',
      note: 'Menor que base es mejor porque representa menor salida de efectivo.',
    }),
  },
  {
    id: 'forecast_flujo_month',
    label: 'Flujo neto del mes',
    description: 'Flujo neto mensual del escenario activo contra el base.',
    category: 'Pronóstico mensual',
    unit: 'currency',
    accentColor: hex.success,
    comparisonKind: 'base',
    goal: 'higher',
    build: (context) => buildForecastMonthlyEntry(context, {
      valueSeries: context.forecast!.activeMetrics.flujoNeto,
      comparisonSeries: context.forecast!.baseMetrics.flujoNeto,
      goal: 'higher',
      note: 'Sirve para detectar mejora o deterioro del flujo operativo por mes.',
    }),
  },
  {
    id: 'forecast_caja_month',
    label: 'Caja del mes',
    description: 'Caja final del mes en el escenario activo vs el escenario base.',
    category: 'Pronóstico mensual',
    unit: 'currency',
    accentColor: 'var(--chart-4)',
    comparisonKind: 'base',
    goal: 'higher',
    build: (context) => buildForecastMonthlyEntry(context, {
      valueSeries: context.forecast!.activeMetrics.cajaFinal,
      comparisonSeries: context.forecast!.baseMetrics.cajaFinal,
      goal: 'higher',
      note: 'Compara la posición de liquidez al cierre de cada mes.',
    }),
  },
  {
    id: 'forecast_cobranza_month',
    label: 'Cobranza del mes',
    description: 'Cobranza mensual del escenario activo contra el base.',
    category: 'Pronóstico mensual',
    unit: 'currency',
    accentColor: hex.info,
    comparisonKind: 'base',
    goal: 'higher',
    build: (context) => buildForecastMonthlyEntry(context, {
      valueSeries: context.forecast!.activeMetrics.cobranza,
      comparisonSeries: context.forecast!.baseMetrics.cobranza,
      goal: 'higher',
      note: 'Mide el efecto mensual de cambios en cobranza sobre el pronóstico.',
    }),
  },
  {
    id: 'forecast_pagos_month',
    label: 'Pagos a proveedores del mes',
    description: 'Pagos a proveedores del mes comparados contra base.',
    category: 'Pronóstico mensual',
    unit: 'currency',
    accentColor: 'var(--warning)',
    comparisonKind: 'base',
    goal: 'lower',
    build: (context) => buildForecastMonthlyEntry(context, {
      valueSeries: context.forecast!.activeMetrics.pagosProveedores,
      comparisonSeries: context.forecast!.baseMetrics.pagosProveedores,
      goal: 'lower',
      note: 'Útil para medir alivios o presiones mensuales en pagos a proveedores.',
    }),
  },
  {
    id: 'forecast_ingresos_12m',
    label: 'Ingresos 12m',
    description: 'Ingresos acumulados del año del escenario activo comparados contra base.',
    category: 'KPIs financieros',
    unit: 'currency',
    accentColor: hex.primary,
    comparisonKind: 'base',
    goal: 'higher',
    build: (context) => buildForecastSummaryEntry(context, {
      value: context.forecast!.activeKpis.ingresos12m,
      comparisonValue: context.forecast!.baseKpis.ingresos12m,
      valueSeries: context.forecast!.activeMetrics.ingresos,
      comparisonSeries: context.forecast!.baseMetrics.ingresos,
      goal: 'higher',
      note: 'Resume el desempeño anual de ingresos mientras la gráfica conserva el detalle mensual.',
    }),
  },
  {
    id: 'forecast_egresos_12m',
    label: 'Egresos 12m',
    description: 'Egresos acumulados del año comparados contra base.',
    category: 'KPIs financieros',
    unit: 'currency',
    accentColor: hex.danger,
    comparisonKind: 'base',
    goal: 'lower',
    build: (context) => buildForecastSummaryEntry(context, {
      value: context.forecast!.activeKpis.egresos12m,
      comparisonValue: context.forecast!.baseKpis.egresos12m,
      valueSeries: context.forecast!.activeMetrics.egresos,
      comparisonSeries: context.forecast!.baseMetrics.egresos,
      goal: 'lower',
      note: 'Menor que base implica ahorro o menor presión de salida.',
    }),
  },
  {
    id: 'forecast_flujo_neto_12m',
    label: 'Flujo neto 12m',
    description: 'Flujo neto acumulado del año comparado contra base.',
    category: 'KPIs financieros',
    unit: 'currency',
    accentColor: hex.success,
    comparisonKind: 'base',
    goal: 'higher',
    build: (context) => buildForecastSummaryEntry(context, {
      value: context.forecast!.activeKpis.flujoNeto12m,
      comparisonValue: context.forecast!.baseKpis.flujoNeto12m,
      valueSeries: context.forecast!.activeMetrics.flujoNeto,
      comparisonSeries: context.forecast!.baseMetrics.flujoNeto,
      goal: 'higher',
      note: 'Integra efecto total del escenario sobre generación de caja.',
    }),
  },
  {
    id: 'forecast_caja_final',
    label: 'Caja final',
    description: 'Caja al cierre del año comparada contra base.',
    category: 'KPIs financieros',
    unit: 'currency',
    accentColor: 'var(--chart-4)',
    comparisonKind: 'base',
    goal: 'higher',
    build: (context) => buildForecastSummaryEntry(context, {
      value: context.forecast!.activeKpis.cajaFinal,
      comparisonValue: context.forecast!.baseKpis.cajaFinal,
      valueSeries: context.forecast!.activeMetrics.cajaFinal,
      comparisonSeries: context.forecast!.baseMetrics.cajaFinal,
      goal: 'higher',
      note: 'La serie muestra el saldo de caja de cada mes hasta el cierre anual.',
    }),
  },
  {
    id: 'forecast_caja_minima',
    label: 'Caja mínima',
    description: 'Mínimo nivel de caja del año comparado contra base.',
    category: 'KPIs financieros',
    unit: 'currency',
    accentColor: 'var(--info)',
    comparisonKind: 'base',
    goal: 'higher',
    build: (context) => buildForecastSummaryEntry(context, {
      value: context.forecast!.activeKpis.cajaMinima,
      comparisonValue: context.forecast!.baseKpis.cajaMinima,
      valueSeries: context.forecast!.activeMetrics.cajaFinal,
      comparisonSeries: context.forecast!.baseMetrics.cajaFinal,
      goal: 'higher',
      note: 'Aunque el KPI resume el mínimo anual, la gráfica muestra toda la curva de caja para ubicar el valle.',
    }),
  },
  {
    id: 'forecast_cobranza_12m',
    label: 'Cobranza 12m',
    description: 'Cobranza acumulada del año comparada contra base.',
    category: 'KPIs financieros',
    unit: 'currency',
    accentColor: hex.info,
    comparisonKind: 'base',
    goal: 'higher',
    build: (context) => buildForecastSummaryEntry(context, {
      value: context.forecast!.activeKpis.cobranza12m,
      comparisonValue: context.forecast!.baseKpis.cobranza12m,
      valueSeries: context.forecast!.activeMetrics.cobranza,
      comparisonSeries: context.forecast!.baseMetrics.cobranza,
      goal: 'higher',
      note: 'Permite monitorear el impacto anual de iniciativas de cobranza dentro del plan.',
    }),
  },
  {
    id: 'forecast_pagos_12m',
    label: 'Pagos proveedores 12m',
    description: 'Pagos a proveedores acumulados del año contra base.',
    category: 'KPIs financieros',
    unit: 'currency',
    accentColor: 'var(--warning)',
    comparisonKind: 'base',
    goal: 'lower',
    build: (context) => buildForecastSummaryEntry(context, {
      value: context.forecast!.activeKpis.pagosProveedores12m,
      comparisonValue: context.forecast!.baseKpis.pagosProveedores12m,
      valueSeries: context.forecast!.activeMetrics.pagosProveedores,
      comparisonSeries: context.forecast!.baseMetrics.pagosProveedores,
      goal: 'lower',
      note: 'Menor que base implica una mejor salida acumulada por pagos a proveedores.',
    }),
  },
];

type FormulaVariableMap = Record<string, number[]>;
interface FormulaPeriodData {
  labels: string[];
  variables: FormulaVariableMap;
}

interface ConceptVariableDef {
  conceptId: string;
  slug: string;
  label: string;
}

const FORMULA_HELPER_IMPL = {
  safe_div: (a: number, b: number) => (Math.abs(b) > 0.000001 ? a / b : 0),
  pct: (a: number, b: number) => (Math.abs(b) > 0.000001 ? a / b : 0),
  ifelse: (condition: number | boolean, whenTrue: number, whenFalse: number) => (condition ? whenTrue : whenFalse),
  abs: (value: number) => Math.abs(value),
  min: (left: number, right: number) => Math.min(left, right),
  max: (left: number, right: number) => Math.max(left, right),
  round: (value: number) => Math.round(value),
  floor: (value: number) => Math.floor(value),
  ceil: (value: number) => Math.ceil(value),
} as const;

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
}

function clampMonthIndex(monthIndex: number): number {
  return Math.max(0, Math.min(11, monthIndex));
}

function isoDateRange(year: number): string[] {
  const dates: string[] = [];
  const cursor = new Date(Date.UTC(year, 0, 1));
  while (cursor.getUTCFullYear() === year) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function formatShortDateLabel(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return `${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]}`;
}

function weekStartIso(isoDate: string): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const weekday = date.getUTCDay();
  const offset = weekday === 0 ? -6 : 1 - weekday;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function weekLabelFromIso(isoDate: string, index: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  return `Sem ${String(index + 1).padStart(2, '0')} · ${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]}`;
}

function quarterIndexFromMonth(monthIndex: number): number {
  return Math.floor(monthIndex / 3);
}

function buildConceptVariableDefs(plan: FlowPlan | null): ConceptVariableDef[] {
  if (!plan) return [];
  const used = new Map<string, number>();
  return [...plan.concepts]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((concept) => {
      const baseSlug = slugify(concept.name || concept.id) || `concepto_${concept.excelRow}`;
      const seen = used.get(baseSlug) ?? 0;
      used.set(baseSlug, seen + 1);
      return {
        conceptId: concept.id,
        slug: seen === 0 ? baseSlug : `${baseSlug}_${seen + 1}`,
        label: concept.name,
      };
    });
}

export function getKpiVariableDocs(plan: FlowPlan | null): KpiVariableDoc[] {
  const baseDocs: KpiVariableDoc[] = [
    { key: 'ingresos', label: 'Ingresos', description: 'Ingresos del periodo en el escenario activo.', group: 'Pronóstico' },
    { key: 'egresos', label: 'Egresos', description: 'Egresos del periodo en el escenario activo.', group: 'Pronóstico' },
    { key: 'flujo_neto', label: 'Flujo neto', description: 'Ingresos menos egresos del periodo.', group: 'Pronóstico' },
    { key: 'caja_final', label: 'Caja final', description: 'Saldo de caja al cierre del periodo.', group: 'Pronóstico' },
    { key: 'egresos_proyectados', label: 'Egresos proyectados', description: 'Egresos proyectados del escenario activo usados como presupuesto de salida.', group: 'Flujo de efectivo' },
    { key: 'flujo_neto_proyectado', label: 'Flujo neto proyectado', description: 'Flujo neto esperado del escenario activo.', group: 'Flujo de efectivo' },
    { key: 'caja_proyectada_final', label: 'Caja proyectada final', description: 'Saldo de caja proyectado al cierre del periodo.', group: 'Flujo de efectivo' },
    { key: 'caja_seguridad_minima', label: 'Caja de seguridad mínima', description: 'Meta mínima de caja disponible para operar sin riesgo.', group: 'Flujo de efectivo' },
    { key: 'cobranza', label: 'Cobranza', description: 'Cobranza del periodo en el escenario activo.', group: 'Pronóstico' },
    { key: 'pagos_proveedores', label: 'Pagos proveedores', description: 'Pagos a proveedores del periodo.', group: 'Pronóstico' },
    { key: 'presupuesto_ingresos', label: 'Presupuesto ingresos', description: 'Serie base para comparar ingresos.', group: 'Base / presupuesto' },
    { key: 'presupuesto_egresos', label: 'Presupuesto egresos', description: 'Serie base para comparar egresos.', group: 'Base / presupuesto' },
    { key: 'desviacion_ingresos', label: 'Desviación ingresos', description: 'Ingresos activos menos ingresos base.', group: 'Desviaciones' },
    { key: 'desviacion_egresos', label: 'Desviación egresos', description: 'Egresos activos menos egresos base.', group: 'Desviaciones' },
    { key: 'desviacion_flujo_neto', label: 'Desviación flujo neto', description: 'Flujo neto activo menos base.', group: 'Desviaciones' },
    { key: 'cobranza_proyectada', label: 'Cobranza proyectada', description: 'Cobranza esperada por proyección de clientes.', group: 'Cobranza' },
    { key: 'cobranza_confirmada', label: 'Cobranza confirmada', description: 'Cobros marcados como realizados.', group: 'Cobranza' },
    { key: 'meta_cobranza', label: 'Meta cobranza', description: 'Meta teórica con 100% de cumplimiento.', group: 'Cobranza' },
    { key: 'porcentaje_cobranza', label: 'Porcentaje de cobranza', description: 'Cobranza confirmada dividida entre meta de cobranza.', group: 'Cobranza' },
    { key: 'clientes_esperados_cobro', label: 'Clientes esperados', description: 'Clientes que debían cobrar en el periodo.', group: 'Cobranza' },
    { key: 'clientes_cobrados', label: 'Clientes cobrados', description: 'Clientes con cobros confirmados en el periodo.', group: 'Cobranza' },
    { key: 'lag_promedio_dias', label: 'Lag promedio', description: 'Días promedio entre fecha teórica y fecha real de cobro.', group: 'Cobranza' },
    { key: 'dias_cobro', label: 'Días de cobro', description: 'Alias de lag_promedio_dias.', group: 'Cobranza' },
  ];

  const conceptDocs = buildConceptVariableDefs(plan).map((concept) => ({
    key: `concepto_${concept.slug}`,
    label: concept.label,
    description: `Valor del concepto "${concept.label}" en el escenario activo. También puedes usar presupuesto_concepto_${concept.slug} y desviacion_concepto_${concept.slug}.`,
    group: 'Conceptos del plan',
  }));

  return [...baseDocs, ...conceptDocs];
}

function collectionBucketKeys(period: KpiPeriod, year: number): string[] {
  if (period === 'daily') return isoDateRange(year);
  if (period === 'weekly') {
    const keys: string[] = [];
    let lastKey = '';
    for (const isoDate of isoDateRange(year)) {
      const key = weekStartIso(isoDate);
      if (key !== lastKey) {
        keys.push(key);
        lastKey = key;
      }
    }
    return keys;
  }
  if (period === 'monthly') return Array.from({ length: 12 }, (_, index) => String(index + 1));
  if (period === 'quarterly') return ['1', '2', '3', '4'];
  return [String(year)];
}

function collectionBucketKey(isoDate: string, year: number, period: KpiPeriod): string {
  if (period === 'daily') return isoDate;
  if (period === 'weekly') return weekStartIso(isoDate);
  if (period === 'monthly') return String(monthIndexFromIso(isoDate) + 1);
  if (period === 'quarterly') return String(quarterIndexFromMonth(monthIndexFromIso(isoDate)) + 1);
  return String(year);
}

function collectionBucketLabel(period: KpiPeriod, key: string, index: number, year: number): string {
  if (period === 'daily') return formatShortDateLabel(key);
  if (period === 'weekly') return weekLabelFromIso(key, index);
  if (period === 'monthly') return MONTHS[Number(key) - 1] ?? key;
  if (period === 'quarterly') return `T${key} ${year}`;
  return `Año ${year}`;
}

function buildCollectionFormulaData(
  clients: Client[],
  assumptions: CashFlowAssumptions,
  confirmedPayments: ConfirmedPayment[],
): Record<KpiPeriod, FormulaPeriodData> | null {
  if (clients.length === 0) return null;

  const projectedEvents = projectYear(clients, assumptions);
  const targetEvents = projectYear(
    clients.map((client) => ({ ...client, complianceRate: 1 })),
    { ...assumptions, globalCompliance: 1 },
  );
  const filteredConfirmed = confirmedPayments.filter((payment) => payment.realDate.startsWith(String(assumptions.year)));
  const periods: KpiPeriod[] = ['daily', 'weekly', 'monthly', 'quarterly', 'annual'];
  const result = {} as Record<KpiPeriod, FormulaPeriodData>;

  for (const period of periods) {
    const keys = collectionBucketKeys(period, assumptions.year);
    const labels = keys.map((key, index) => collectionBucketLabel(period, key, index, assumptions.year));
    const projectedByKey = new Map<string, number>();
    const targetByKey = new Map<string, number>();
    const confirmedByKey = new Map<string, number>();
    const expectedClientsByKey = new Map<string, Set<string>>();
    const confirmedClientsByKey = new Map<string, Set<string>>();
    const lagSumsByKey = new Map<string, number>();
    const lagCountsByKey = new Map<string, number>();

    for (const event of projectedEvents) {
      const key = collectionBucketKey(event.realDate, assumptions.year, period);
      projectedByKey.set(key, (projectedByKey.get(key) ?? 0) + event.amount);
      lagSumsByKey.set(key, (lagSumsByKey.get(key) ?? 0) + event.lagDays);
      lagCountsByKey.set(key, (lagCountsByKey.get(key) ?? 0) + 1);
    }

    for (const event of targetEvents) {
      const key = collectionBucketKey(event.realDate, assumptions.year, period);
      targetByKey.set(key, (targetByKey.get(key) ?? 0) + event.amount);
      const clientBucket = expectedClientsByKey.get(key) ?? new Set<string>();
      clientBucket.add(event.clientId);
      expectedClientsByKey.set(key, clientBucket);
    }

    for (const payment of filteredConfirmed) {
      const key = collectionBucketKey(payment.realDate, assumptions.year, period);
      confirmedByKey.set(key, (confirmedByKey.get(key) ?? 0) + payment.amount);
      const clientBucket = confirmedClientsByKey.get(key) ?? new Set<string>();
      clientBucket.add(payment.clientId);
      confirmedClientsByKey.set(key, clientBucket);
    }

    const cobranzaProyectada = keys.map((key) => projectedByKey.get(key) ?? 0);
    const metaCobranza = keys.map((key) => targetByKey.get(key) ?? 0);
    const cobranzaConfirmada = keys.map((key) => confirmedByKey.get(key) ?? 0);
    const clientesEsperados = keys.map((key) => (expectedClientsByKey.get(key)?.size ?? 0));
    const clientesCobrados = keys.map((key) => (confirmedClientsByKey.get(key)?.size ?? 0));
    const lagPromedioDias = keys.map((key) => {
      const count = lagCountsByKey.get(key) ?? 0;
      return count > 0 ? (lagSumsByKey.get(key) ?? 0) / count : 0;
    });
    const porcentajeCobranza = keys.map((key, index) => {
      const meta = metaCobranza[index] ?? 0;
      return meta > 0 ? (cobranzaConfirmada[index] ?? 0) / meta : 0;
    });

    result[period] = {
      labels,
      variables: {
        cobranza_proyectada: cobranzaProyectada,
        cobranza_confirmada: cobranzaConfirmada,
        meta_cobranza: metaCobranza,
        porcentaje_cobranza: porcentajeCobranza,
        clientes_esperados_cobro: clientesEsperados,
        clientes_cobrados: clientesCobrados,
        lag_promedio_dias: lagPromedioDias,
        dias_cobro: lagPromedioDias,
      },
    };
  }

  return result;
}

function aggregateSeries(values: number[], period: 'quarterly' | 'annual', mode: 'sum' | 'last'): number[] {
  if (period === 'annual') {
    if (mode === 'last') return [values[values.length - 1] ?? 0];
    return [sum(values)];
  }

  const result: number[] = [];
  for (let quarter = 0; quarter < 4; quarter++) {
    const start = quarter * 3;
    const slice = values.slice(start, start + 3);
    result.push(mode === 'last' ? (slice[slice.length - 1] ?? 0) : sum(slice));
  }
  return result;
}

function labelFromPeriodMonthSlice(period: 'quarterly' | 'annual', year: number): string[] {
  if (period === 'annual') return [`Año ${year}`];
  return ['T1', 'T2', 'T3', 'T4'].map((quarter) => `${quarter} ${year}`);
}

function buildForecastFormulaData(input: KpiCatalogInput): Record<KpiPeriod, FormulaPeriodData> | null {
  const { plan, proposals, scenarios, simulations, overrides, activeProposalId, activeScenarioId } = input;
  if (!plan || scenarios.length === 0) return null;

  const baseScenario = scenarios.find((scenario) => isBaseScenario(scenario)) ?? null;
  const activeProposal = proposals.find((proposal) => proposal.id === activeProposalId) ?? proposals[0] ?? null;
  const activeScenario = scenarios.find((scenario) => scenario.id === activeScenarioId)
    ?? scenarios.find((scenario) => scenario.proposalId === activeProposal?.id)
    ?? baseScenario
    ?? null;

  if (!activeScenario) return null;

  const effectiveProposal = activeProposal ?? {
    id: 'proposal-base',
    name: BASE_SCENARIO_NAME,
    description: 'Pronóstico original',
    status: 'Pendiente' as const,
    createdAt: '',
    updatedAt: '',
  };

  const conceptDefs = buildConceptVariableDefs(plan);
  const periodData = {} as Record<KpiPeriod, FormulaPeriodData>;

  const populateFromEvaluation = (period: Extract<KpiPeriod, 'daily' | 'weekly' | 'monthly'>, granularity: 'daily' | 'weekly' | 'monthly') => {
    const activeEvaluation = evaluateScenario(
      plan,
      effectiveProposal,
      activeScenario,
      isBaseScenario(activeScenario) ? [] : simulations,
      isBaseScenario(activeScenario) ? [] : overrides,
      { granularity },
    );
    const baseEvaluation = evaluateScenario(
      plan,
      effectiveProposal,
      activeScenario,
      [],
      [],
      { granularity },
    );
    const safetyCashReference = averageMonthly(activeEvaluation.metrics.egresos);

    const variables: FormulaVariableMap = {
      ingresos: activeEvaluation.metrics.ingresos,
      egresos: activeEvaluation.metrics.egresos,
      flujo_neto: activeEvaluation.metrics.flujoNeto,
      caja_final: activeEvaluation.metrics.cajaFinal,
      egresos_proyectados: activeEvaluation.metrics.egresos,
      flujo_neto_proyectado: activeEvaluation.metrics.flujoNeto,
      caja_proyectada_final: activeEvaluation.metrics.cajaFinal,
      caja_seguridad_minima: buildConstantSeries(activeEvaluation.months.length, safetyCashReference),
      cobranza: activeEvaluation.metrics.cobranza,
      pagos_proveedores: activeEvaluation.metrics.pagosProveedores,
      base_ingresos: baseEvaluation.metrics.ingresos,
      presupuesto_ingresos: baseEvaluation.metrics.ingresos,
      base_egresos: baseEvaluation.metrics.egresos,
      presupuesto_egresos: baseEvaluation.metrics.egresos,
      base_flujo_neto: baseEvaluation.metrics.flujoNeto,
      presupuesto_flujo_neto: baseEvaluation.metrics.flujoNeto,
      base_caja_final: baseEvaluation.metrics.cajaFinal,
      presupuesto_caja_final: baseEvaluation.metrics.cajaFinal,
      base_cobranza: baseEvaluation.metrics.cobranza,
      presupuesto_cobranza: baseEvaluation.metrics.cobranza,
      base_pagos_proveedores: baseEvaluation.metrics.pagosProveedores,
      presupuesto_pagos_proveedores: baseEvaluation.metrics.pagosProveedores,
      desviacion_ingresos: activeEvaluation.metrics.ingresos.map((value, index) => value - (baseEvaluation.metrics.ingresos[index] ?? 0)),
      desviacion_egresos: activeEvaluation.metrics.egresos.map((value, index) => value - (baseEvaluation.metrics.egresos[index] ?? 0)),
      desviacion_flujo_neto: activeEvaluation.metrics.flujoNeto.map((value, index) => value - (baseEvaluation.metrics.flujoNeto[index] ?? 0)),
      desviacion_caja_final: activeEvaluation.metrics.cajaFinal.map((value, index) => value - (baseEvaluation.metrics.cajaFinal[index] ?? 0)),
      desviacion_cobranza: activeEvaluation.metrics.cobranza.map((value, index) => value - (baseEvaluation.metrics.cobranza[index] ?? 0)),
      desviacion_pagos_proveedores: activeEvaluation.metrics.pagosProveedores.map((value, index) => value - (baseEvaluation.metrics.pagosProveedores[index] ?? 0)),
    };

    for (const concept of conceptDefs) {
      const activeValues = activeEvaluation.valuesByConceptId.get(concept.conceptId) ?? Array(activeEvaluation.months.length).fill(0);
      const baseValues = baseEvaluation.baseValuesByConceptId.get(concept.conceptId) ?? Array(baseEvaluation.months.length).fill(0);
      variables[`concepto_${concept.slug}`] = activeValues;
      variables[`base_concepto_${concept.slug}`] = baseValues;
      variables[`presupuesto_concepto_${concept.slug}`] = baseValues;
      variables[`desviacion_concepto_${concept.slug}`] = activeValues.map((value, index) => value - (baseValues[index] ?? 0));
    }

    periodData[period] = {
      labels: activeEvaluation.months.map((month) => month.label),
      variables,
    };
  };

  populateFromEvaluation('daily', 'daily');
  populateFromEvaluation('weekly', 'weekly');
  populateFromEvaluation('monthly', 'monthly');

  const monthly = periodData.monthly;
  const buildAggregateVariables = (period: 'quarterly' | 'annual') => {
    const variables: FormulaVariableMap = {};
    for (const [key, values] of Object.entries(monthly.variables)) {
      const mode = key.includes('caja_final') ? 'last' : 'sum';
      variables[key] = aggregateSeries(values, period, mode);
    }
    return variables;
  };

  periodData.quarterly = {
    labels: labelFromPeriodMonthSlice('quarterly', plan.year),
    variables: buildAggregateVariables('quarterly'),
  };
  periodData.annual = {
    labels: labelFromPeriodMonthSlice('annual', plan.year),
    variables: buildAggregateVariables('annual'),
  };

  return periodData;
}

export function extractFormulaIdentifiers(expression: string): string[] {
  const identifiers = expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return Array.from(new Set(identifiers));
}

function validateFormula(expression: string, allowedVariables: string[]): string | null {
  const trimmed = expression.trim();
  if (!trimmed) return 'Escribe una fórmula para el KPI.';
  if (/[^A-Za-z0-9_+\-*/%().,<>=!&|?:\s]/.test(trimmed)) {
    return 'La fórmula contiene caracteres no permitidos.';
  }

  const identifiers = trimmed.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  const allowed = new Set<string>([
    ...allowedVariables,
    ...Object.keys(FORMULA_HELPER_IMPL),
    'true',
    'false',
    'null',
  ]);

  for (const identifier of identifiers) {
    if (!allowed.has(identifier)) {
      return `Variable o función desconocida: ${identifier}`;
    }
  }

  return null;
}

function evaluateFormula(expression: string, scope: Record<string, number>): number {
  const helperKeys = Object.keys(FORMULA_HELPER_IMPL);
  const variableKeys = Object.keys(scope);
  const fn = new Function(
    ...helperKeys,
    ...variableKeys,
    `"use strict"; return (${expression});`,
  );
  const result = fn(
    ...helperKeys.map((key) => FORMULA_HELPER_IMPL[key as keyof typeof FORMULA_HELPER_IMPL]),
    ...variableKeys.map((key) => scope[key]),
  );

  return typeof result === 'number' && Number.isFinite(result) ? result : 0;
}

function latestMeaningfulIndex(values: number[], comparisonValue?: number | null): number {
  for (let index = values.length - 1; index >= 0; index--) {
    const value = values[index] ?? 0;
    if (Math.abs(value) > 0.0001) return index;
    if (comparisonValue !== null && comparisonValue !== undefined && Math.abs(comparisonValue) > 0.0001) return index;
  }
  return Math.max(0, values.length - 1);
}

function currentIndexForPeriod(period: KpiPeriod, activeMonth: number, values: number[], comparisonValue: number | null): number {
  if (period === 'annual') return 0;
  if (period === 'quarterly') return Math.min(3, quarterIndexFromMonth(clampMonthIndex(activeMonth)));
  if (period === 'monthly') return Math.min(values.length - 1, clampMonthIndex(activeMonth));
  return latestMeaningfulIndex(values, comparisonValue);
}

function customStatusForValue(value: number, target: number, warningThreshold: number, goal: KpiGoal): KpiStatus {
  if (goal === 'higher') {
    if (value >= target) return 'met';
    if (value >= warningThreshold) return 'warning';
    return 'missed';
  }

  if (value <= target) return 'met';
  if (value <= warningThreshold) return 'warning';
  return 'missed';
}

function defaultWarningThreshold(targetValue: number, goal: KpiGoal): number {
  if (goal === 'higher') {
    return targetValue > 0 ? targetValue * 0.9 : targetValue;
  }
  return targetValue > 0 ? targetValue * 1.1 : targetValue;
}

interface ManagedTargetConfig {
  targetValue: number;
  targetSource: KpiTargetSource;
  targetSourceVariable?: string;
  targetOwner: KpiTargetOwner;
  goal: KpiGoal;
  warningThreshold: number;
  notes: string;
  updatedAt: string | null;
  history: KpiTargetHistoryEntry[];
}

function resolveManagedTargetConfig(
  kpiId: string,
  defaults: Omit<ManagedTargetConfig, 'updatedAt' | 'history'>,
  overrides: KpiConfigOverride[],
): ManagedTargetConfig {
  const override = overrides.find((item) => item.kpiId === kpiId) ?? null;
  return {
    targetValue: override?.targetValue ?? defaults.targetValue,
    targetSource: override?.targetSource ?? defaults.targetSource,
    targetSourceVariable: override?.targetSourceVariable ?? defaults.targetSourceVariable,
    targetOwner: override?.targetOwner ?? defaults.targetOwner,
    goal: override?.goal ?? defaults.goal,
    warningThreshold: override?.warningThreshold ?? defaults.warningThreshold,
    notes: override?.notes ?? defaults.notes,
    updatedAt: override?.updatedAt ?? null,
    history: override?.history ?? [],
  };
}

function buildConstantSeries(length: number, value: number): number[] {
  return Array.from({ length }, () => value);
}

function resolveConfiguredTargetSeries(
  labels: string[],
  variables: FormulaVariableMap | null,
  config: ManagedTargetConfig,
): number[] {
  if (config.targetSource === 'auto' && config.targetSourceVariable && variables?.[config.targetSourceVariable]) {
    const series = variables[config.targetSourceVariable];
    return labels.map((_, index) => series[index] ?? config.targetValue);
  }
  return buildConstantSeries(labels.length, config.targetValue);
}

function buildManagedTargetEntry(config: {
  id: string;
  label: string;
  description: string;
  category: string;
  unit: KpiUnit;
  accentColor: string;
  goal: KpiGoal;
  periodKey: KpiPeriod;
  activeMonth: number;
  labels: string[];
  valueSeries: number[];
  variables: FormulaVariableMap | null;
  targetConfig: ManagedTargetConfig;
  dataSourceLabel: string;
  note: string;
  formula: string | null;
  customUnitLabel?: string | null;
}): KpiCatalogEntry {
  const targetSeries = resolveConfiguredTargetSeries(config.labels, config.variables, config.targetConfig);
  const currentIndex = currentIndexForPeriod(
    config.periodKey,
    config.activeMonth,
    config.valueSeries,
    targetSeries[0] ?? config.targetConfig.targetValue,
  );
  const safeIndex = Math.max(0, Math.min(config.labels.length - 1, currentIndex));
  const currentValue = config.valueSeries[safeIndex] ?? 0;
  const currentTarget = targetSeries[safeIndex] ?? config.targetConfig.targetValue;
  const points = config.labels.map((label, index) => ({
    label,
    value: config.valueSeries[index] ?? 0,
    comparison: targetSeries[index] ?? config.targetConfig.targetValue,
    status: customStatusForValue(
      config.valueSeries[index] ?? 0,
      targetSeries[index] ?? config.targetConfig.targetValue,
      config.targetConfig.warningThreshold,
      config.targetConfig.goal,
    ),
  }));

  return {
    id: config.id,
    label: config.label,
    description: config.description,
    category: config.category,
    unit: config.unit,
    accentColor: config.accentColor,
    comparisonKind: 'target',
    goal: config.targetConfig.goal,
    source: 'template',
    isCustom: false,
    available: true,
    availabilityReason: null,
    periodLabel: config.labels[safeIndex] ?? null,
    periodKey: config.periodKey,
    value: currentValue,
    comparisonValue: currentTarget,
    comparisonLabel: 'Meta',
    diffValue: currentValue - currentTarget,
    status: customStatusForValue(currentValue, currentTarget, config.targetConfig.warningThreshold, config.targetConfig.goal),
    points,
    chartValueLabel: 'Resultado',
    chartComparisonLabel: 'Meta',
    note: config.note,
    formula: config.formula,
    sourceDataLabel: config.dataSourceLabel,
    targetValue: config.targetConfig.targetValue,
    targetSource: config.targetConfig.targetSource,
    targetSourceVariable: config.targetConfig.targetSourceVariable ?? null,
    targetOwner: config.targetConfig.targetOwner,
    targetUpdatedAt: config.targetConfig.updatedAt,
    warningThreshold: config.targetConfig.warningThreshold,
    manualNotes: config.targetConfig.notes,
    targetHistory: config.targetConfig.history,
    customUnitLabel: config.customUnitLabel ?? null,
  };
}

function cumulativePositiveGap(left: number[], right: number[]): number[] {
  let runningGap = 0;
  return left.map((value, index) => {
    runningGap += Math.max((value ?? 0) - (right[index] ?? 0), 0);
    return runningGap;
  });
}

function averageMonthly(values: number[]): number {
  return values.length > 0 ? sum(values) / values.length : 0;
}

function buildCashFlowKpiEntries(input: KpiCatalogInput, context: BuildContext): KpiCatalogEntry[] {
  const { collection, forecast, operations } = context;
  if (!forecast) return [];

  const kpiConfigs = input.kpiConfigs ?? [];
  const labels = forecast.monthlyLabels;
  const activeMonth = input.activeMonth;
  const zeroSeries = buildConstantSeries(labels.length, 0);
  const monthlyCollectionFormulaData = buildCollectionFormulaData(input.clients, input.assumptions, input.confirmedPayments)?.monthly;
  const monthlyForecastFormulaData = buildForecastFormulaData(input)?.monthly;
  const collectionTargetMonthly = collection?.targetMonthly ?? zeroSeries;
  const collectionConfirmedMonthly = collection?.confirmedMonthly ?? zeroSeries;
  const collectionProjectedMonthly = collection?.projectedMonthly ?? forecast.activeMetrics.cobranza;
  const collectionCoverageMonthly = collection?.coverageMonthly ?? zeroSeries;
  const avgMonthlyExpenses = averageMonthly(forecast.activeMetrics.egresos);
  const minimumSafetyDefault = avgMonthlyExpenses;
  const baseTargetContextVariables: FormulaVariableMap = {
    ...(monthlyForecastFormulaData?.variables ?? {}),
    ...(monthlyCollectionFormulaData?.variables ?? {}),
    meta_cobranza: collectionTargetMonthly,
    cobranza_confirmada: collectionConfirmedMonthly,
    cobranza_proyectada: collectionProjectedMonthly,
    porcentaje_cobranza: collectionCoverageMonthly,
    egresos_proyectados: forecast.activeMetrics.egresos,
    flujo_neto_proyectado: forecast.activeMetrics.flujoNeto,
    caja_proyectada_final: forecast.activeMetrics.cajaFinal,
  };
  const minimumSafetyConfig = resolveManagedTargetConfig(
    'cash_minimum_safety',
    {
      targetValue: minimumSafetyDefault,
      targetSource: 'manual',
      targetOwner: 'system',
      goal: 'higher',
      warningThreshold: defaultWarningThreshold(minimumSafetyDefault, 'higher'),
      notes: 'Meta sugerida automáticamente como un mes promedio de egresos proyectados.',
    },
    kpiConfigs,
  );
  const minimumSafetySeries = resolveConfiguredTargetSeries(labels, baseTargetContextVariables, minimumSafetyConfig);
  const actualOutflows = operations?.actualOutflowsMonthly ?? Array(12).fill(0);
  const actualInflows = operations?.actualInflowsMonthly ?? Array(12).fill(0);
  const actualNetFlow = operations?.actualNetFlowMonthly ?? Array(12).fill(0);
  const scheduledOutflows = operations?.scheduledOutflowsMonthly ?? Array(12).fill(0);
  const paymentDays = operations?.paymentDaysMonthly ?? Array(12).fill(0);
  const overdueCollection = cumulativePositiveGap(collectionTargetMonthly, collectionConfirmedMonthly);
  const expenseCompliance = forecast.activeMetrics.egresos.map((targetValue, index) => {
    const actual = actualOutflows[index] ?? 0;
    return targetValue > 0 ? actual / targetValue : 0;
  });
  const flowVariance = forecast.activeMetrics.flujoNeto.map((projected, index) => Math.abs((actualNetFlow[index] ?? 0) - projected));
  const workingCapital = forecast.activeMetrics.cajaFinal.map((cashValue, index) => cashValue + (collectionProjectedMonthly[index] ?? 0) - (scheduledOutflows[index] ?? 0));
  const coverageMonths = forecast.activeMetrics.cajaFinal.map((cashValue) => avgMonthlyExpenses > 0 ? cashValue / avgMonthlyExpenses : 0);
  const burnRate = actualOutflows.some((value) => value > 0)
    ? actualOutflows.map((outflow, index) => Math.max(outflow - (actualInflows[index] ?? 0), 0))
    : forecast.activeMetrics.flujoNeto.map((value) => Math.max(-value, 0));
  const liquiditySeries = operations?.latestLiquidity !== null && operations?.latestLiquidity !== undefined
    ? buildConstantSeries(labels.length, operations.latestLiquidity)
    : [...forecast.activeMetrics.cajaFinal];
  const deficitRisk = forecast.activeMetrics.cajaFinal.map((_, index) => (
    forecast.activeMetrics.cajaFinal.slice(index).filter((cashValue, futureIndex) => {
      const threshold = minimumSafetySeries[Math.min(index + futureIndex, minimumSafetySeries.length - 1)] ?? 0;
      return cashValue < threshold;
    }).length
  ));
  const collectionLagSeries = buildConstantSeries(labels.length, 0).map((_, index) => (
    monthlyCollectionFormulaData?.variables.lag_promedio_dias?.[index] ?? 0
  ));
  const cycleConversionSeries = collectionLagSeries.map((lagValue, index) => lagValue - (paymentDays[index] ?? 0));

  const targetContextVariables: FormulaVariableMap = {
    ...baseTargetContextVariables,
    caja_seguridad_minima: minimumSafetySeries,
  };

  const makeEntry = (config: {
    id: string;
    label: string;
    description: string;
    category: string;
    unit: KpiUnit;
    accentColor: string;
    goal: KpiGoal;
    valueSeries: number[];
    dataSourceLabel: string;
    note: string;
    formula: string | null;
    defaults: Omit<ManagedTargetConfig, 'updatedAt' | 'history' | 'goal'>;
    available?: boolean;
    availabilityReason?: string | null;
  }): KpiCatalogEntry => {
    const targetConfig = resolveManagedTargetConfig(config.id, { ...config.defaults, goal: config.goal }, kpiConfigs);
    if (config.available === false) {
      return {
        id: config.id,
        label: config.label,
        description: config.description,
        category: config.category,
        unit: config.unit,
        accentColor: config.accentColor,
        comparisonKind: 'target',
        goal: targetConfig.goal,
        source: 'template',
        isCustom: false,
        available: false,
        availabilityReason: config.availabilityReason ?? 'No hay datos suficientes para calcular este KPI.',
        periodLabel: null,
        periodKey: 'monthly',
        value: null,
        comparisonValue: targetConfig.targetValue,
        comparisonLabel: 'Meta',
        diffValue: null,
        status: 'na',
        points: [],
        chartValueLabel: 'Resultado',
        chartComparisonLabel: 'Meta',
        note: config.note,
        formula: config.formula,
        sourceDataLabel: config.dataSourceLabel,
        targetValue: targetConfig.targetValue,
        targetSource: targetConfig.targetSource,
        targetSourceVariable: targetConfig.targetSourceVariable ?? null,
        targetOwner: targetConfig.targetOwner,
        targetUpdatedAt: targetConfig.updatedAt,
        warningThreshold: targetConfig.warningThreshold,
        manualNotes: targetConfig.notes,
        targetHistory: targetConfig.history,
        customUnitLabel: null,
      };
    }

    return buildManagedTargetEntry({
      id: config.id,
      label: config.label,
      description: config.description,
      category: config.category,
      unit: config.unit,
      accentColor: config.accentColor,
      goal: config.goal,
      periodKey: 'monthly',
      activeMonth,
      labels,
      valueSeries: config.valueSeries,
      variables: targetContextVariables,
      targetConfig,
      dataSourceLabel: config.dataSourceLabel,
      note: config.note,
      formula: config.formula,
    });
  };

  return [
    makeEntry({
      id: 'cash_collection_target',
      label: 'Meta de cobranza',
      description: 'Cobranza real del periodo contra la meta de cobranza.',
      category: 'Flujo de efectivo',
      unit: 'currency',
      accentColor: hex.success,
      goal: 'higher',
      valueSeries: collectionConfirmedMonthly,
      dataSourceLabel: 'Cobranza confirmada del módulo de clientes y meta teórica al 100% de cumplimiento.',
      note: 'Mide cuánto se cobró realmente contra la meta esperada del periodo.',
      formula: 'cobranza_confirmada',
      defaults: {
        targetValue: collectionTargetMonthly[activeMonth] ?? 0,
        targetSource: 'auto',
        targetSourceVariable: 'meta_cobranza',
        targetOwner: 'historical',
        warningThreshold: defaultWarningThreshold(collectionTargetMonthly[activeMonth] ?? 0, 'higher'),
        notes: 'Meta automática basada en la agenda de cobranza con cumplimiento total.',
      },
      available: Boolean(collection),
      availabilityReason: 'Carga clientes y cobranza confirmada para medir la meta de cobranza.',
    }),
    makeEntry({
      id: 'cash_expense_target',
      label: 'Meta de egresos',
      description: 'Egresos reales contra el gasto esperado del periodo.',
      category: 'Flujo de efectivo',
      unit: 'currency',
      accentColor: hex.danger,
      goal: 'lower',
      valueSeries: actualOutflows,
      dataSourceLabel: 'Cargos reales bancarios comparados contra egresos proyectados del escenario.',
      note: 'Sirve para controlar la salida real de efectivo frente al presupuesto del periodo.',
      formula: 'egresos_reales',
      defaults: {
        targetValue: forecast.activeMetrics.egresos[activeMonth] ?? 0,
        targetSource: 'auto',
        targetSourceVariable: 'egresos_proyectados',
        targetOwner: 'system',
        warningThreshold: defaultWarningThreshold(forecast.activeMetrics.egresos[activeMonth] ?? 0, 'lower'),
        notes: 'La meta inicial toma el egreso proyectado del escenario activo.',
      },
      available: Boolean(operations && actualOutflows.some((value) => value !== 0)),
      availabilityReason: 'Carga estados de cuenta bancarios para comparar egresos reales contra la meta.',
    }),
    makeEntry({
      id: 'cash_minimum_safety',
      label: 'Caja de seguridad mínima',
      description: 'Saldo de caja disponible frente al mínimo requerido para operar.',
      category: 'Liquidez',
      unit: 'currency',
      accentColor: 'var(--info)',
      goal: 'higher',
      valueSeries: forecast.activeMetrics.cajaFinal,
      dataSourceLabel: 'Saldo final de caja proyectado del escenario activo.',
      note: 'Detecta rápidamente si la empresa cae por debajo del colchón mínimo deseado.',
      formula: 'caja_final',
      defaults: {
        targetValue: minimumSafetyConfig.targetValue,
        targetSource: minimumSafetyConfig.targetSource,
        targetSourceVariable: minimumSafetyConfig.targetSourceVariable,
        targetOwner: minimumSafetyConfig.targetOwner,
        warningThreshold: minimumSafetyConfig.warningThreshold,
        notes: minimumSafetyConfig.notes,
      },
    }),
    makeEntry({
      id: 'cash_cycle_conversion',
      label: 'Conversión del ciclo de flujo',
      description: 'Días de cobranza promedio menos días de pago promedio.',
      category: 'Eficiencia de caja',
      unit: 'days',
      accentColor: 'var(--chart-4)',
      goal: 'lower',
      valueSeries: cycleConversionSeries,
      dataSourceLabel: 'Lag promedio de cobranza más calendario de pago capturado en CXP.',
      note: 'Menor número de días implica un retorno más rápido del efectivo.',
      formula: 'dias_cobro - dias_pago_promedio',
      defaults: {
        targetValue: 30,
        targetSource: 'manual',
        targetOwner: 'system',
        warningThreshold: 45,
        notes: 'Meta sugerida como máximo aceptable del ciclo de conversión.',
      },
      available: Boolean(collection && operations && operations.paymentDaysAverage > 0),
      availabilityReason: 'Carga clientes y CXP con fechas de factura/programación para medir el ciclo.',
    }),
    makeEntry({
      id: 'cash_working_capital',
      label: 'Capital de trabajo',
      description: 'Caja proyectada más cobranza proyectada menos egresos programados.',
      category: 'Liquidez',
      unit: 'currency',
      accentColor: hex.primary,
      goal: 'higher',
      valueSeries: workingCapital,
      dataSourceLabel: 'Caja proyectada, cobranza del escenario y CXP programada.',
      note: 'Aproxima la capacidad operativa de corto plazo con los datos disponibles en la plataforma.',
      formula: 'caja_final + cobranza - egresos_programados',
      defaults: {
        targetValue: 0,
        targetSource: 'manual',
        targetOwner: 'system',
        warningThreshold: 0,
        notes: 'Un capital de trabajo positivo indica mayor holgura operativa.',
      },
    }),
    makeEntry({
      id: 'cash_avg_collection_days',
      label: 'Días de cobranza promedio',
      description: 'Tiempo promedio entre la fecha teórica de cobro y la fecha real de pago.',
      category: 'Cobranza',
      unit: 'days',
      accentColor: hex.info,
      goal: 'lower',
      valueSeries: collectionLagSeries,
      dataSourceLabel: 'Motor de proyección de cobranza con clientes, crédito y cumplimiento.',
      note: 'Ayuda a medir qué tan rápido se convierte la facturación en efectivo.',
      formula: 'dias_cobro',
      defaults: {
        targetValue: 30,
        targetSource: 'manual',
        targetOwner: 'historical',
        warningThreshold: 45,
        notes: 'Meta histórica sugerida para días promedio de cobranza.',
      },
      available: Boolean(collection),
      availabilityReason: 'Carga clientes para calcular los días promedio de cobranza.',
    }),
    makeEntry({
      id: 'cash_avg_payment_days',
      label: 'Días de pago promedio',
      description: 'Tiempo promedio entre fecha de factura y fecha de programación de pago.',
      category: 'Pagos',
      unit: 'days',
      accentColor: 'var(--warning)',
      goal: 'higher',
      valueSeries: paymentDays,
      dataSourceLabel: 'Registros de CXP y calendario de programación de pagos.',
      note: 'Más días de pago extienden la caja, aunque deben monitorearse sin deteriorar la operación.',
      formula: 'dias_pago_promedio',
      defaults: {
        targetValue: operations?.paymentDaysAverage || 30,
        targetSource: 'manual',
        targetOwner: 'historical',
        warningThreshold: Math.max(1, (operations?.paymentDaysAverage || 30) * 0.8),
        notes: 'Referencia histórica estimada con las fechas de pago programadas.',
      },
      available: Boolean(operations && operations.paymentDaysAverage > 0),
      availabilityReason: 'Carga CXP para medir los días promedio de pago.',
    }),
    makeEntry({
      id: 'cash_net_flow_projected',
      label: 'Flujo neto proyectado',
      description: 'Ingresos proyectados menos egresos proyectados en el periodo.',
      category: 'Flujo de efectivo',
      unit: 'currency',
      accentColor: hex.success,
      goal: 'higher',
      valueSeries: forecast.activeMetrics.flujoNeto,
      dataSourceLabel: 'Pronóstico del escenario activo.',
      note: 'Resume la generación esperada de caja del periodo.',
      formula: 'flujo_neto',
      defaults: {
        targetValue: 0,
        targetSource: 'manual',
        targetOwner: 'system',
        warningThreshold: 0,
        notes: 'La meta por defecto exige no cerrar el periodo con flujo neto negativo.',
      },
    }),
    makeEntry({
      id: 'cash_net_flow_real',
      label: 'Flujo neto real',
      description: 'Ingresos reales menos egresos reales del periodo.',
      category: 'Flujo de efectivo',
      unit: 'currency',
      accentColor: 'var(--success)',
      goal: 'higher',
      valueSeries: actualNetFlow,
      dataSourceLabel: 'Movimientos bancarios reales (abonos menos cargos).',
      note: 'Contrasta el comportamiento real de caja frente a lo planeado.',
      formula: 'flujo_neto_real',
      defaults: {
        targetValue: forecast.activeMetrics.flujoNeto[activeMonth] ?? 0,
        targetSource: 'auto',
        targetSourceVariable: 'flujo_neto_proyectado',
        targetOwner: 'system',
        warningThreshold: defaultWarningThreshold(forecast.activeMetrics.flujoNeto[activeMonth] ?? 0, 'higher'),
        notes: 'La referencia inicial usa el flujo neto proyectado del escenario activo.',
      },
      available: Boolean(operations && (actualInflows.some((value) => value !== 0) || actualOutflows.some((value) => value !== 0))),
      availabilityReason: 'Carga movimientos bancarios para medir el flujo neto real.',
    }),
    makeEntry({
      id: 'cash_flow_variance',
      label: 'Desviación flujo proyectado vs real',
      description: 'Diferencia absoluta entre flujo neto proyectado y flujo neto real.',
      category: 'Control',
      unit: 'currency',
      accentColor: hex.warning,
      goal: 'lower',
      valueSeries: flowVariance,
      dataSourceLabel: 'Pronóstico del escenario activo y movimientos bancarios reales.',
      note: 'Mientras más cerca de cero, mejor alineado está lo real contra el plan.',
      formula: 'abs(flujo_neto_real - flujo_neto)',
      defaults: {
        targetValue: 0,
        targetSource: 'manual',
        targetOwner: 'system',
        warningThreshold: avgMonthlyExpenses * 0.15,
        notes: 'La meta ideal es cero desviación; la alerta inicial usa 15% del egreso mensual promedio.',
      },
      available: Boolean(operations && (actualInflows.some((value) => value !== 0) || actualOutflows.some((value) => value !== 0))),
      availabilityReason: 'Carga movimientos bancarios para comparar flujo real contra proyectado.',
    }),
    makeEntry({
      id: 'cash_overdue_collection',
      label: 'Cobranza vencida',
      description: 'Monto acumulado pendiente de cobro respecto a la meta esperada.',
      category: 'Cobranza',
      unit: 'currency',
      accentColor: hex.danger,
      goal: 'lower',
      valueSeries: overdueCollection,
      dataSourceLabel: 'Meta de cobranza teórica y cobros confirmados.',
      note: 'Cuantifica el rezago acumulado de cobranza en el año.',
      formula: 'max(meta_cobranza - cobranza_confirmada, 0)',
      defaults: {
        targetValue: 0,
        targetSource: 'manual',
        targetOwner: 'historical',
        warningThreshold: collectionTargetMonthly[activeMonth] ?? 0,
        notes: 'La meta deseable es cero vencido acumulado.',
      },
      available: Boolean(collection),
      availabilityReason: 'Carga clientes y cobros confirmados para calcular cobranza vencida.',
    }),
    makeEntry({
      id: 'cash_collection_compliance',
      label: '% cumplimiento de cobranza',
      description: 'Cobranza real dividida entre la meta de cobranza.',
      category: 'Cobranza',
      unit: 'percent',
      accentColor: hex.info,
      goal: 'higher',
      valueSeries: collectionCoverageMonthly,
      dataSourceLabel: 'Cobros confirmados y meta de cobranza.',
      note: 'Un valor de 100% o más indica cumplimiento de la meta.',
      formula: 'porcentaje_cobranza',
      defaults: {
        targetValue: 1,
        targetSource: 'manual',
        targetOwner: 'historical',
        warningThreshold: 0.85,
        notes: 'La meta recomendada es al menos 100% de cumplimiento.',
      },
      available: Boolean(collection),
      availabilityReason: 'Carga clientes y cobros confirmados para medir cumplimiento de cobranza.',
    }),
    makeEntry({
      id: 'cash_expense_compliance',
      label: '% cumplimiento de egresos',
      description: 'Egresos reales comparados contra el egreso objetivo del periodo.',
      category: 'Control',
      unit: 'percent',
      accentColor: 'var(--warning)',
      goal: 'lower',
      valueSeries: expenseCompliance,
      dataSourceLabel: 'Cargos bancarios reales contra egresos proyectados.',
      note: 'Un valor por debajo de 100% indica que el gasto real se mantuvo por debajo de la meta.',
      formula: 'safe_div(egresos_reales, egresos_proyectados)',
      defaults: {
        targetValue: 1,
        targetSource: 'manual',
        targetOwner: 'system',
        warningThreshold: 1.1,
        notes: 'La meta recomendada es no exceder 100% del egreso objetivo.',
      },
      available: Boolean(operations && actualOutflows.some((value) => value !== 0)),
      availabilityReason: 'Carga movimientos bancarios para medir cumplimiento real de egresos.',
    }),
    makeEntry({
      id: 'cash_coverage_months',
      label: 'Meses de cobertura de caja',
      description: 'Cuántos meses podría operar la empresa con la caja proyectada actual.',
      category: 'Liquidez',
      unit: 'times',
      accentColor: 'var(--info)',
      goal: 'higher',
      valueSeries: coverageMonths,
      dataSourceLabel: 'Caja final proyectada y egreso mensual promedio del escenario.',
      note: 'Una mayor cobertura indica más resiliencia de caja.',
      formula: 'safe_div(caja_final, egresos_promedio_mensual)',
      defaults: {
        targetValue: 3,
        targetSource: 'manual',
        targetOwner: 'system',
        warningThreshold: 2,
        notes: 'Meta sugerida de tres meses de cobertura.',
      },
    }),
    makeEntry({
      id: 'cash_burn_rate',
      label: 'Burn rate operativo',
      description: 'Cuánto efectivo se consume en el periodo.',
      category: 'Flujo de efectivo',
      unit: 'currency',
      accentColor: hex.warning,
      goal: 'lower',
      valueSeries: burnRate,
      dataSourceLabel: actualOutflows.some((value) => value > 0)
        ? 'Movimientos bancarios reales.'
        : 'Pronóstico del escenario activo.',
      note: 'Mide la velocidad a la que el negocio consume efectivo cuando las salidas superan a las entradas.',
      formula: actualOutflows.some((value) => value > 0)
        ? 'max(egresos_reales - ingresos_reales, 0)'
        : 'max(egresos - ingresos, 0)',
      defaults: {
        targetValue: 0,
        targetSource: 'manual',
        targetOwner: 'system',
        warningThreshold: avgMonthlyExpenses * 0.2,
        notes: 'La meta recomendada es cero consumo neto o un nivel marginal de quema.',
      },
    }),
    makeEntry({
      id: 'cash_liquidity_available',
      label: 'Liquidez disponible',
      description: 'Caja disponible y recursos líquidos de corto plazo.',
      category: 'Liquidez',
      unit: 'currency',
      accentColor: hex.primary,
      goal: 'higher',
      valueSeries: liquiditySeries,
      dataSourceLabel: operations?.latestLiquidity !== null && operations?.latestLiquidity !== undefined
        ? 'Saldos finales bancarios más recientes.'
        : 'Caja final proyectada del escenario activo.',
      note: 'Cuando existen estados de cuenta, usa el último saldo bancario consolidado; si no, cae al saldo proyectado.',
      formula: operations?.latestLiquidity !== null && operations?.latestLiquidity !== undefined
        ? 'liquidez_disponible'
        : 'caja_final',
      defaults: {
        targetValue: minimumSafetySeries[activeMonth] ?? minimumSafetyDefault,
        targetSource: 'auto',
        targetSourceVariable: 'caja_seguridad_minima',
        targetOwner: 'system',
        warningThreshold: defaultWarningThreshold(minimumSafetySeries[activeMonth] ?? minimumSafetyDefault, 'higher'),
        notes: 'La liquidez debería mantenerse por encima de la caja de seguridad mínima.',
      },
    }),
    makeEntry({
      id: 'cash_projected_ending_balance',
      label: 'Saldo final de caja proyectado',
      description: 'Saldo de caja esperado al final de cada periodo.',
      category: 'Liquidez',
      unit: 'currency',
      accentColor: 'var(--chart-4)',
      goal: 'higher',
      valueSeries: forecast.activeMetrics.cajaFinal,
      dataSourceLabel: 'Saldo final del escenario proyectado.',
      note: 'Resume cuánto efectivo quedará al cierre del periodo proyectado.',
      formula: 'caja_final',
      defaults: {
        targetValue: minimumSafetySeries[activeMonth] ?? minimumSafetyDefault,
        targetSource: 'auto',
        targetSourceVariable: 'caja_seguridad_minima',
        targetOwner: 'system',
        warningThreshold: defaultWarningThreshold(minimumSafetySeries[activeMonth] ?? minimumSafetyDefault, 'higher'),
        notes: 'La proyección debería terminar por encima del mínimo de caja.',
      },
    }),
    makeEntry({
      id: 'cash_deficit_risk',
      label: 'Riesgo de déficit de caja',
      description: 'Número de meses futuros donde la caja proyectada cae por debajo del mínimo requerido.',
      category: 'Riesgo',
      unit: 'count',
      accentColor: hex.danger,
      goal: 'lower',
      valueSeries: deficitRisk,
      dataSourceLabel: 'Saldo de caja proyectado contra la caja de seguridad mínima.',
      note: 'Un valor mayor que cero anticipa meses con riesgo de déficit de caja.',
      formula: 'riesgo_deficit_caja',
      defaults: {
        targetValue: 0,
        targetSource: 'manual',
        targetOwner: 'system',
        warningThreshold: 1,
        notes: 'La meta recomendada es no tener meses futuros por debajo del mínimo de caja.',
      },
    }),
  ];
}

function buildCustomKpiEntries(input: KpiCatalogInput): KpiCatalogEntry[] {
  const customKpis = input.customKpis ?? [];
  if (customKpis.length === 0) return [];

  const collectionData = buildCollectionFormulaData(input.clients, input.assumptions, input.confirmedPayments);
  const forecastData = buildForecastFormulaData(input);
  const allowedVariables = Array.from(new Set([
    ...Object.values(collectionData ?? {}).flatMap((period) => Object.keys(period.variables)),
    ...Object.values(forecastData ?? {}).flatMap((period) => Object.keys(period.variables)),
  ]));

  return customKpis.map((definition) => {
    const targetOwner = definition.targetOwner ?? 'user';
    const targetConfig = resolveManagedTargetConfig(
      definition.id,
      {
        targetValue: definition.targetValue,
        targetSource: definition.targetSource,
        targetSourceVariable: definition.targetSourceVariable,
        targetOwner,
        goal: definition.goal,
        warningThreshold: definition.warningThreshold,
        notes: definition.notes,
      },
      input.kpiConfigs ?? [],
    );
    const targetHistory = [
      ...(definition.targetHistory ?? []),
      ...targetConfig.history,
    ];
    const description = targetConfig.notes || definition.notes || `Fórmula: ${definition.formula}`;
    const forecastPeriod = forecastData?.[definition.period];
    const collectionPeriod = collectionData?.[definition.period];
    const periodData = forecastPeriod || collectionPeriod
      ? {
          labels: forecastPeriod?.labels ?? collectionPeriod?.labels ?? [],
          variables: {
            ...(forecastPeriod?.variables ?? {}),
            ...(collectionPeriod?.variables ?? {}),
          },
        }
      : null;

    const formulaError = validateFormula(definition.formula, allowedVariables);

    const autoVariable = targetConfig.targetSource === 'auto' ? targetConfig.targetSourceVariable : undefined;

    if (!periodData || periodData.labels.length === 0) {
      return {
        id: definition.id,
        label: definition.name,
        description,
        category: definition.category || 'KPIs personalizados',
        unit: definition.unit,
        accentColor: hex.primary,
        comparisonKind: 'target',
        goal: targetConfig.goal,
        source: 'custom',
        isCustom: true,
        available: false,
        availabilityReason: 'No hay datos suficientes para este periodo con el contexto actual.',
        periodLabel: null,
        periodKey: definition.period,
        value: null,
        comparisonValue: targetConfig.targetValue,
        comparisonLabel: 'Meta',
        diffValue: null,
        status: 'na',
        points: [],
        chartValueLabel: 'Resultado',
        chartComparisonLabel: 'Meta',
        note: targetConfig.notes || definition.notes,
        formula: definition.formula,
        sourceDataLabel: 'Fórmula personalizada con variables de cobranza, pronóstico y escenario.',
        targetValue: targetConfig.targetValue,
        targetSource: targetConfig.targetSource,
        targetSourceVariable: autoVariable ?? null,
        targetOwner: targetConfig.targetOwner,
        targetUpdatedAt: targetConfig.updatedAt ?? definition.updatedAt,
        warningThreshold: targetConfig.warningThreshold,
        manualNotes: targetConfig.notes || definition.notes,
        targetHistory,
        customUnitLabel: definition.customUnitLabel ?? null,
      };
    }

    if (formulaError) {
      return {
        id: definition.id,
        label: definition.name,
        description,
        category: definition.category || 'KPIs personalizados',
        unit: definition.unit,
        accentColor: hex.primary,
        comparisonKind: 'target',
        goal: targetConfig.goal,
        source: 'custom',
        isCustom: true,
        available: false,
        availabilityReason: formulaError,
        periodLabel: null,
        periodKey: definition.period,
        value: null,
        comparisonValue: targetConfig.targetValue,
        comparisonLabel: 'Meta',
        diffValue: null,
        status: 'na',
        points: [],
        chartValueLabel: 'Resultado',
        chartComparisonLabel: 'Meta',
        note: targetConfig.notes || definition.notes,
        formula: definition.formula,
        sourceDataLabel: 'Fórmula personalizada con variables de cobranza, pronóstico y escenario.',
        targetValue: targetConfig.targetValue,
        targetSource: targetConfig.targetSource,
        targetSourceVariable: autoVariable ?? null,
        targetOwner: targetConfig.targetOwner,
        targetUpdatedAt: targetConfig.updatedAt ?? definition.updatedAt,
        warningThreshold: targetConfig.warningThreshold,
        manualNotes: targetConfig.notes || definition.notes,
        targetHistory,
        customUnitLabel: definition.customUnitLabel ?? null,
      };
    }

    const values = periodData.labels.map((_, index) => {
      const scope = Object.fromEntries(
        Object.entries(periodData.variables).map(([key, series]) => [key, series[index] ?? 0]),
      );
      return evaluateFormula(definition.formula, scope);
    });

    const autoSeries = autoVariable ? periodData.variables[autoVariable] : undefined;
    const autoIsValid = autoVariable ? Array.isArray(autoSeries) : false;
    const targetSeries = autoIsValid
      ? periodData.labels.map((_, index) => autoSeries?.[index] ?? targetConfig.targetValue)
      : periodData.labels.map(() => targetConfig.targetValue);

    const currentIndex = currentIndexForPeriod(definition.period, input.activeMonth, values, targetSeries[0] ?? targetConfig.targetValue);
    const points = periodData.labels.map((label, index) => {
      const targetValueForPoint = targetSeries[index] ?? targetConfig.targetValue;
      return {
        label,
        value: values[index] ?? 0,
        comparison: targetValueForPoint,
        status: customStatusForValue(values[index] ?? 0, targetValueForPoint, targetConfig.warningThreshold, targetConfig.goal),
      };
    });
    const currentValue = values[currentIndex] ?? 0;
    const currentTarget = targetSeries[currentIndex] ?? targetConfig.targetValue;

    const availabilityReason = autoVariable && !autoIsValid
      ? `La meta automática referencia "${autoVariable}" pero no está disponible en este contexto.`
      : null;

    return {
      id: definition.id,
      label: definition.name,
      description,
      category: definition.category || 'KPIs personalizados',
      unit: definition.unit,
      accentColor: hex.primary,
      comparisonKind: 'target',
      goal: targetConfig.goal,
      source: 'custom',
      isCustom: true,
      available: true,
      availabilityReason,
      periodLabel: periodData.labels[currentIndex] ?? null,
      periodKey: definition.period,
      value: currentValue,
      comparisonValue: currentTarget,
      comparisonLabel: 'Meta',
      diffValue: currentValue - currentTarget,
      status: customStatusForValue(currentValue, currentTarget, targetConfig.warningThreshold, targetConfig.goal),
      points,
      chartValueLabel: 'Resultado',
      chartComparisonLabel: 'Meta',
      note: targetConfig.notes || definition.notes,
      formula: definition.formula,
      sourceDataLabel: 'Fórmula personalizada con variables de cobranza, pronóstico y escenario.',
      targetValue: targetConfig.targetValue,
      targetSource: targetConfig.targetSource,
      targetSourceVariable: autoVariable ?? null,
      targetOwner: targetConfig.targetOwner,
      targetUpdatedAt: targetConfig.updatedAt ?? definition.updatedAt,
      warningThreshold: targetConfig.warningThreshold,
      manualNotes: targetConfig.notes || definition.notes,
      targetHistory,
      customUnitLabel: definition.customUnitLabel ?? null,
    };
  });
}

export function buildKpiCatalog(input: KpiCatalogInput): KpiCatalogEntry[] {
  const context: BuildContext = {
    activeMonth: input.activeMonth,
    collection: buildCollectionSnapshot(input.clients, input.assumptions, input.confirmedPayments),
    forecast: buildForecastSnapshot(input),
    operations: buildOperationsSnapshot(input),
  };
  const builtIns: KpiCatalogEntry[] = KPI_DEFINITIONS.map((definition): KpiCatalogEntry => {
    const needsCollection = definition.category === 'Cobranza';
    if (needsCollection && !context.collection) {
      return unavailable(definition, 'Carga clientes para habilitar KPIs de cobranza.');
    }

    if (!needsCollection && !context.forecast) {
      return unavailable(definition, 'Carga un plan y un escenario para habilitar KPIs financieros y de pronóstico.');
    }

    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      category: definition.category,
      unit: definition.unit,
      accentColor: definition.accentColor,
      comparisonKind: definition.comparisonKind,
      goal: definition.goal,
      source: 'template',
      isCustom: false,
      ...definition.build(context),
    };
  });

  return [
    ...buildCashFlowKpiEntries(input, context),
    ...builtIns,
    ...buildCustomKpiEntries(input),
  ];
}
