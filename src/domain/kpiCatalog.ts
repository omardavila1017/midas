import { projectYear } from './collectionEngine';
import { evaluateScenario } from './scenarioEngine';
import { isBaseScenario } from './simulationCompiler';
import type { CashFlowAssumptions, Client, ConfirmedPayment } from './types';
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

export interface CustomKpiDefinition {
  id: string;
  name: string;
  category: string;
  formula: string;
  targetValue: number;
  period: KpiPeriod;
  unit: KpiUnit;
  customUnitLabel?: string;
  goal: KpiGoal;
  warningThreshold: number;
  notes: string;
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
  targetValue: number | null;
  warningThreshold: number | null;
  customUnitLabel: string | null;
}

export interface KpiCatalogInput {
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  plan: FlowPlan | null;
  proposals: Proposal[];
  scenarios: Scenario[];
  simulations: Simulation[];
  overrides: ScenarioCellOverride[];
  activeProposalId: string | null;
  activeScenarioId: string | null;
  activeMonth: number;
  customKpis?: CustomKpiDefinition[];
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

interface BuildContext {
  activeMonth: number;
  collection: CollectionSnapshot | null;
  forecast: ForecastSnapshot | null;
}

export const DEFAULT_ACTIVE_KPI_IDS = [
  'collection_projected_month',
  'collection_confirmed_month',
  'collection_coverage_month',
  'forecast_ingresos_12m',
  'forecast_flujo_neto_12m',
  'forecast_caja_final',
  'forecast_caja_minima',
  'forecast_cobranza_month',
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
    targetValue: null,
    warningThreshold: null,
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
    targetValue: comparisonValue,
    warningThreshold: null,
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
    targetValue: comparisonValue,
    warningThreshold: null,
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
    targetValue: config.comparisonValue,
    warningThreshold: null,
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
    accentColor: '#af52de',
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
    accentColor: '#ff9500',
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
    accentColor: '#af52de',
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
    accentColor: '#5ac8fa',
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
    accentColor: '#ff9500',
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

    const variables: FormulaVariableMap = {
      ingresos: activeEvaluation.metrics.ingresos,
      egresos: activeEvaluation.metrics.egresos,
      flujo_neto: activeEvaluation.metrics.flujoNeto,
      caja_final: activeEvaluation.metrics.cajaFinal,
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

function customStatusForValue(value: number, definition: CustomKpiDefinition): KpiStatus {
  if (definition.goal === 'higher') {
    if (value >= definition.targetValue) return 'met';
    if (value >= definition.warningThreshold) return 'warning';
    return 'missed';
  }

  if (value <= definition.targetValue) return 'met';
  if (value <= definition.warningThreshold) return 'warning';
  return 'missed';
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

    if (!periodData || periodData.labels.length === 0) {
      return {
        id: definition.id,
        label: definition.name,
        description: definition.notes || `Fórmula: ${definition.formula}`,
        category: definition.category || 'KPIs personalizados',
        unit: definition.unit,
        accentColor: hex.primary,
        comparisonKind: 'target',
        goal: definition.goal,
        source: 'custom',
        isCustom: true,
        available: false,
        availabilityReason: 'No hay datos suficientes para este periodo con el contexto actual.',
        periodLabel: null,
        periodKey: definition.period,
        value: null,
        comparisonValue: definition.targetValue,
        comparisonLabel: 'Meta',
        diffValue: null,
        status: 'na',
        points: [],
        chartValueLabel: 'Resultado',
        chartComparisonLabel: 'Meta',
        note: definition.notes,
        formula: definition.formula,
        targetValue: definition.targetValue,
        warningThreshold: definition.warningThreshold,
        customUnitLabel: definition.customUnitLabel ?? null,
      };
    }

    if (formulaError) {
      return {
        id: definition.id,
        label: definition.name,
        description: definition.notes || `Fórmula: ${definition.formula}`,
        category: definition.category || 'KPIs personalizados',
        unit: definition.unit,
        accentColor: hex.primary,
        comparisonKind: 'target',
        goal: definition.goal,
        source: 'custom',
        isCustom: true,
        available: false,
        availabilityReason: formulaError,
        periodLabel: null,
        periodKey: definition.period,
        value: null,
        comparisonValue: definition.targetValue,
        comparisonLabel: 'Meta',
        diffValue: null,
        status: 'na',
        points: [],
        chartValueLabel: 'Resultado',
        chartComparisonLabel: 'Meta',
        note: definition.notes,
        formula: definition.formula,
        targetValue: definition.targetValue,
        warningThreshold: definition.warningThreshold,
        customUnitLabel: definition.customUnitLabel ?? null,
      };
    }

    const values = periodData.labels.map((_, index) => {
      const scope = Object.fromEntries(
        Object.entries(periodData.variables).map(([key, series]) => [key, series[index] ?? 0]),
      );
      return evaluateFormula(definition.formula, scope);
    });

    const currentIndex = currentIndexForPeriod(definition.period, input.activeMonth, values, definition.targetValue);
    const points = periodData.labels.map((label, index) => ({
      label,
      value: values[index] ?? 0,
      comparison: definition.targetValue,
      status: customStatusForValue(values[index] ?? 0, definition),
    }));
    const currentValue = values[currentIndex] ?? 0;

    return {
      id: definition.id,
      label: definition.name,
      description: definition.notes || `Fórmula: ${definition.formula}`,
      category: definition.category || 'KPIs personalizados',
      unit: definition.unit,
      accentColor: hex.primary,
      comparisonKind: 'target',
      goal: definition.goal,
      source: 'custom',
      isCustom: true,
      available: true,
      availabilityReason: null,
      periodLabel: periodData.labels[currentIndex] ?? null,
      periodKey: definition.period,
      value: currentValue,
      comparisonValue: definition.targetValue,
      comparisonLabel: 'Meta',
      diffValue: currentValue - definition.targetValue,
      status: customStatusForValue(currentValue, definition),
      points,
      chartValueLabel: 'Resultado',
      chartComparisonLabel: 'Meta',
      note: definition.notes,
      formula: definition.formula,
      targetValue: definition.targetValue,
      warningThreshold: definition.warningThreshold,
      customUnitLabel: definition.customUnitLabel ?? null,
    };
  });
}

export function buildKpiCatalog(input: KpiCatalogInput): KpiCatalogEntry[] {
  const context: BuildContext = {
    activeMonth: input.activeMonth,
    collection: buildCollectionSnapshot(input.clients, input.assumptions, input.confirmedPayments),
    forecast: buildForecastSnapshot(input),
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

  return [...builtIns, ...buildCustomKpiEntries(input)];
}
