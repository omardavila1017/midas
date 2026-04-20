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

export type KpiUnit = 'currency' | 'percent' | 'count';
export type KpiGoal = 'higher' | 'lower';
export type KpiComparisonKind = 'target' | 'base';
export type KpiStatus = 'met' | 'missed' | 'na';

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
  available: boolean;
  availabilityReason: string | null;
  periodLabel: string | null;
  value: number | null;
  comparisonValue: number | null;
  comparisonLabel: string | null;
  diffValue: number | null;
  status: KpiStatus;
  points: KpiPoint[];
  chartValueLabel: string | null;
  chartComparisonLabel: string | null;
  note: string | null;
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
  build: (context: BuildContext) => Omit<KpiCatalogEntry, 'id' | 'label' | 'description' | 'category' | 'unit' | 'accentColor' | 'comparisonKind' | 'goal'>;
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
    available: false,
    availabilityReason: reason,
    periodLabel: null,
    value: null,
    comparisonValue: null,
    comparisonLabel: null,
    diffValue: null,
    status: 'na',
    points: [],
    chartValueLabel: null,
    chartComparisonLabel: null,
    note: null,
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
): Omit<KpiCatalogEntry, 'id' | 'label' | 'description' | 'category' | 'unit' | 'accentColor' | 'comparisonKind' | 'goal'> {
  const collection = context.collection!;
  const value = config.valueSeries[context.activeMonth] ?? 0;
  const comparisonValue = config.comparisonSeries[context.activeMonth] ?? 0;
  return {
    available: true,
    availabilityReason: null,
    periodLabel: `${MONTHS_FULL[context.activeMonth]} ${collection.year}`,
    value,
    comparisonValue,
    comparisonLabel: config.comparisonLabel,
    diffValue: value - comparisonValue,
    status: statusFor(value, comparisonValue, config.goal),
    points: buildPoints(MONTHS, config.valueSeries, config.comparisonSeries, config.goal),
    chartValueLabel: 'Resultado',
    chartComparisonLabel: config.comparisonLabel,
    note: config.note,
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
): Omit<KpiCatalogEntry, 'id' | 'label' | 'description' | 'category' | 'unit' | 'accentColor' | 'comparisonKind' | 'goal'> {
  const forecast = context.forecast!;
  const value = config.valueSeries[context.activeMonth] ?? 0;
  const comparisonValue = config.comparisonSeries[context.activeMonth] ?? 0;
  return {
    available: true,
    availabilityReason: null,
    periodLabel: `${MONTHS_FULL[context.activeMonth]} ${forecast.year}`,
    value,
    comparisonValue,
    comparisonLabel: 'Base',
    diffValue: value - comparisonValue,
    status: statusFor(value, comparisonValue, config.goal),
    points: buildPoints(forecast.monthlyLabels, config.valueSeries, config.comparisonSeries, config.goal),
    chartValueLabel: forecast.activeScenarioName,
    chartComparisonLabel: 'Base',
    note: config.note,
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
): Omit<KpiCatalogEntry, 'id' | 'label' | 'description' | 'category' | 'unit' | 'accentColor' | 'comparisonKind' | 'goal'> {
  const forecast = context.forecast!;
  return {
    available: true,
    availabilityReason: null,
    periodLabel: `Año ${forecast.year}`,
    value: config.value,
    comparisonValue: config.comparisonValue,
    comparisonLabel: 'Base',
    diffValue: config.value - config.comparisonValue,
    status: statusFor(config.value, config.comparisonValue, config.goal),
    points: buildPoints(forecast.monthlyLabels, config.valueSeries, config.comparisonSeries, config.goal),
    chartValueLabel: forecast.activeScenarioName,
    chartComparisonLabel: 'Base',
    note: config.note,
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

export function buildKpiCatalog(input: KpiCatalogInput): KpiCatalogEntry[] {
  const context: BuildContext = {
    activeMonth: input.activeMonth,
    collection: buildCollectionSnapshot(input.clients, input.assumptions, input.confirmedPayments),
    forecast: buildForecastSnapshot(input),
  };

  return KPI_DEFINITIONS.map((definition) => {
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
      ...definition.build(context),
    };
  });
}
