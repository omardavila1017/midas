import {
  EvaluatedCell,
  EvaluatedScenario,
  FlowConcept,
  FlowPlan,
  MONTHS,
  Proposal,
  ROLE_TARGET_COLLECTIONS,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_INCOME,
  ROLE_TARGET_LABELS,
  ROLE_TARGET_PROVIDER_PAYMENTS,
  Scenario,
  ScenarioCellOverride,
  ScenarioComparisonSnapshot,
  ScenarioKpis,
  ScenarioMonth,
  Simulation,
  scenarioCellKey,
} from '../types';

const ROLE_TARGET_IDS = [
  ROLE_TARGET_INCOME,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_COLLECTIONS,
  ROLE_TARGET_PROVIDER_PAYMENTS,
] as const;

interface ConceptIndexes {
  conceptById: Map<string, FlowConcept>;
  childrenById: Map<string, FlowConcept[]>;
  summaryChildrenByParentId: Map<string, FlowConcept[]>;
  editableConceptIds: Set<string>;
  rootIncomeIds: string[];
  rootExpenseIds: string[];
  collectionsConceptIds: string[];
  providerPaymentConceptIds: string[];
}

interface TargetOption {
  id: string;
  label: string;
  group: 'roles' | 'concepts';
}

function cloneSeriesMap(source: Map<string, number[]>): Map<string, number[]> {
  return new Map(Array.from(source.entries(), ([key, values]) => [key, [...values]]));
}

function addMonths(year: number, monthIndex: number, offset: number): ScenarioMonth {
  const absoluteMonth = monthIndex + offset;
  const targetMonth = ((absoluteMonth % 12) + 12) % 12;
  const targetYear = year + Math.floor(absoluteMonth / 12);
  return {
    monthIndex: targetMonth,
    year: targetYear,
    label: `${MONTHS[targetMonth]} ${String(targetYear).slice(2)}`,
    ym: `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}`,
  };
}

export function buildScenarioMonths(
  plan: FlowPlan,
  scenario?: Pick<Scenario, 'startYearMonth' | 'horizonMonths'>,
): ScenarioMonth[] {
  const defaultStart = `${plan.year}-01`;
  const [yearRaw, monthRaw] = (scenario?.startYearMonth ?? defaultStart).split('-');
  const startYear = Number(yearRaw) || plan.year;
  const startMonthIndex = Math.max(0, Math.min(11, (Number(monthRaw) || 1) - 1));
  const horizonMonths = Math.max(1, Math.min(24, scenario?.horizonMonths ?? 12));

  return Array.from({ length: horizonMonths }, (_, offset) =>
    addMonths(startYear, startMonthIndex, offset),
  );
}

function buildConceptIndexes(plan: FlowPlan): ConceptIndexes {
  const conceptById = new Map<string, FlowConcept>();
  const childrenById = new Map<string, FlowConcept[]>();
  const summaryChildrenByParentId = new Map<string, FlowConcept[]>();

  for (const concept of plan.concepts) {
    conceptById.set(concept.id, concept);
    if (concept.parentId) {
      const siblings = childrenById.get(concept.parentId) ?? [];
      siblings.push(concept);
      childrenById.set(concept.parentId, siblings);
    }
  }

  for (const [parentId, children] of childrenById.entries()) {
    const summaries = children.filter((child) => child.conceptType === 'resumen');
    if (summaries.length > 0) {
      summaryChildrenByParentId.set(parentId, summaries);
    }
  }

  const editableConceptIds = new Set(
    plan.concepts
      .filter((concept) => {
        const children = childrenById.get(concept.id) ?? [];
        return (
          children.length === 0 &&
          concept.conceptType !== 'resumen' &&
          concept.conceptType !== 'reserva'
        );
      })
      .map((concept) => concept.id),
  );

  const rootIncomeIds = plan.concepts
    .filter((concept) => !concept.parentId && concept.conceptType === 'ingreso')
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((concept) => concept.id);

  const rootExpenseIds = plan.concepts
    .filter((concept) => !concept.parentId && concept.conceptType === 'egreso')
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((concept) => concept.id);

  const collectionsConceptIds = plan.concepts
    .filter((concept) =>
      concept.name.toLowerCase().includes('cobranza') ||
      concept.excelRow === 10,
    )
    .map((concept) => concept.id);

  const providerPaymentConceptIds = plan.concepts
    .filter((concept) => {
      const label = concept.name.toLowerCase();
      return (
        concept.excelRow === 35 ||
        concept.excelRow === 36 ||
        concept.excelRow === 73 ||
        label.includes('proveedor') ||
        label.includes('distribuidor') ||
        label.includes('gasoliner')
      );
    })
    .map((concept) => concept.id);

  return {
    conceptById,
    childrenById,
    summaryChildrenByParentId,
    editableConceptIds,
    rootIncomeIds,
    rootExpenseIds,
    collectionsConceptIds,
    providerPaymentConceptIds,
  };
}

function baseValueForMonth(
  concept: FlowConcept,
  month: ScenarioMonth,
  planYear: number,
): number {
  if (month.year !== planYear) return 0;
  return concept.monthlyData[month.monthIndex] ?? 0;
}

function appendContribution(
  map: Map<string, { simulationId: string; simulationName: string; delta: number }[]>,
  cellKey: string,
  simulationId: string,
  simulationName: string,
  delta: number,
) {
  const existing = map.get(cellKey) ?? [];
  const current = existing.find((item) => item.simulationId === simulationId);
  if (current) {
    current.delta += delta;
  } else {
    existing.push({ simulationId, simulationName, delta });
  }
  map.set(cellKey, existing);
}

function addSeries(target: number[], source: number[]): number[] {
  const length = Math.max(target.length, source.length);
  return Array.from({ length }, (_, index) => (target[index] ?? 0) + (source[index] ?? 0));
}

function sumSeries(valuesByConceptId: Map<string, number[]>, conceptIds: string[], months: number): number[] {
  let total = Array(months).fill(0);
  for (const conceptId of conceptIds) {
    total = addSeries(total, valuesByConceptId.get(conceptId) ?? Array(months).fill(0));
  }
  return total;
}

function buildKpis(metrics: EvaluatedScenario['metrics']): ScenarioKpis {
  const ingresos12m = metrics.ingresos.reduce((sum, value) => sum + value, 0);
  const egresos12m = metrics.egresos.reduce((sum, value) => sum + value, 0);
  const flujoNeto12m = metrics.flujoNeto.reduce((sum, value) => sum + value, 0);
  const cajaFinal = metrics.cajaFinal[metrics.cajaFinal.length - 1] ?? 0;
  const cajaMinima = metrics.cajaFinal.length > 0 ? Math.min(...metrics.cajaFinal) : 0;
  const cobranza12m = metrics.cobranza.reduce((sum, value) => sum + value, 0);
  const pagosProveedores12m = metrics.pagosProveedores.reduce((sum, value) => sum + value, 0);

  return {
    ingresos12m,
    egresos12m,
    flujoNeto12m,
    cajaFinal,
    cajaMinima,
    cobranza12m,
    pagosProveedores12m,
  };
}

function getLineage(conceptById: Map<string, FlowConcept>, conceptId: string): FlowConcept[] {
  const lineage: FlowConcept[] = [];
  let cursor = conceptById.get(conceptId) ?? null;
  while (cursor?.parentId) {
    const parent = conceptById.get(cursor.parentId) ?? null;
    if (!parent) break;
    lineage.push(parent);
    cursor = parent;
  }
  return lineage;
}

export function isScenarioEditableConcept(plan: FlowPlan, conceptId: string): boolean {
  return buildConceptIndexes(plan).editableConceptIds.has(conceptId);
}

export function resolveConceptLabel(plan: FlowPlan, conceptId: string): string {
  if (ROLE_TARGET_LABELS[conceptId]) return ROLE_TARGET_LABELS[conceptId];
  return plan.concepts.find((concept) => concept.id === conceptId)?.name ?? conceptId;
}

export function getSimulationTargetOptions(plan: FlowPlan): TargetOption[] {
  const indexes = buildConceptIndexes(plan);
  const conceptOptions = plan.concepts
    .filter((concept) => indexes.editableConceptIds.has(concept.id))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((concept) => ({
      id: concept.id,
      label: concept.name,
      group: 'concepts' as const,
    }));

  const roleOptions = ROLE_TARGET_IDS.map((id) => ({
    id,
    label: ROLE_TARGET_LABELS[id],
    group: 'roles' as const,
  }));

  return [...roleOptions, ...conceptOptions];
}

export function evaluateScenario(
  plan: FlowPlan,
  proposal: Proposal,
  scenario: Scenario,
  simulations: Simulation[],
  overrides: ScenarioCellOverride[],
): EvaluatedScenario {
  const months = buildScenarioMonths(plan, scenario);
  const monthIndexByYm = new Map(months.map((month, index) => [month.ym, index]));
  const indexes = buildConceptIndexes(plan);
  const trackedConceptIds = [
    ...plan.concepts.map((concept) => concept.id),
    ...ROLE_TARGET_IDS,
  ];

  const baseValuesByConceptId = new Map<string, number[]>();
  for (const conceptId of trackedConceptIds) {
    if (ROLE_TARGET_LABELS[conceptId]) {
      baseValuesByConceptId.set(conceptId, Array(months.length).fill(0));
      continue;
    }

    const concept = indexes.conceptById.get(conceptId);
    if (!concept) continue;
    baseValuesByConceptId.set(
      conceptId,
      months.map((month) => baseValueForMonth(concept, month, plan.year)),
    );
  }

  const simulatedValuesByConceptId = cloneSeriesMap(baseValuesByConceptId);
  const finalValuesByConceptId = cloneSeriesMap(baseValuesByConceptId);
  const simulationContributionMap = new Map<
    string,
    { simulationId: string; simulationName: string; delta: number }[]
  >();
  const manualDeltaByConceptId = new Map<string, number[]>(
    trackedConceptIds.map((conceptId) => [conceptId, Array(months.length).fill(0)]),
  );

  const applyDelta = (
    valuesByConceptId: Map<string, number[]>,
    targetId: string,
    monthOffset: number,
    delta: number,
    options?: { simulationId: string; simulationName: string; yearMonth: string },
  ) => {
    if (delta === 0) return;

    const record = (conceptId: string) => {
      const series = valuesByConceptId.get(conceptId);
      if (!series) return;
      series[monthOffset] = (series[monthOffset] ?? 0) + delta;
      if (options) {
        appendContribution(
          simulationContributionMap,
          `${conceptId}::${options.yearMonth}`,
          options.simulationId,
          options.simulationName,
          delta,
        );
      }
    };

    if (ROLE_TARGET_LABELS[targetId]) {
      record(targetId);
      return;
    }

    record(targetId);
    const touchedSummaryIds = new Set<string>();
    for (const ancestor of getLineage(indexes.conceptById, targetId)) {
      record(ancestor.id);
      const summaryChildren = indexes.summaryChildrenByParentId.get(ancestor.id) ?? [];
      for (const summaryChild of summaryChildren) {
        if (touchedSummaryIds.has(summaryChild.id)) continue;
        touchedSummaryIds.add(summaryChild.id);
        record(summaryChild.id);
      }
    }
  };

  const activeSimulationIds = new Set(scenario.simulationIds);
  const activeSimulations = simulations.filter((simulation) => activeSimulationIds.has(simulation.id));

  for (const simulation of activeSimulations) {
    for (const effect of simulation.effects) {
      if (effect.type !== 'concept_delta') continue;
      const monthOffsets = effect.yearMonths && effect.yearMonths.length > 0
        ? effect.yearMonths
            .map((yearMonth) => monthIndexByYm.get(yearMonth))
            .filter((value): value is number => value !== undefined)
        : (effect.monthOffsets && effect.monthOffsets.length > 0
            ? effect.monthOffsets
            : months.map((_, index) => index));

      for (const monthOffset of monthOffsets) {
        if (monthOffset < 0 || monthOffset >= months.length) continue;
        const yearMonth = months[monthOffset].ym;
        const baseSeries = baseValuesByConceptId.get(effect.conceptId) ?? Array(months.length).fill(0);
        const baseValue = baseSeries[monthOffset] ?? 0;
        const delta =
          effect.mode === 'percent'
            ? baseValue * effect.value
            : effect.value;

        applyDelta(simulatedValuesByConceptId, effect.conceptId, monthOffset, delta, {
          simulationId: simulation.id,
          simulationName: simulation.name,
          yearMonth,
        });
        applyDelta(finalValuesByConceptId, effect.conceptId, monthOffset, delta, {
          simulationId: simulation.id,
          simulationName: simulation.name,
          yearMonth,
        });
      }
    }
  }

  const overrideMap = new Map<string, ScenarioCellOverride>();
  for (const override of overrides) {
    if (override.scenarioId !== scenario.id) continue;
    const monthOffset = monthIndexByYm.get(override.yearMonth);
    if (monthOffset === undefined) continue;
    if (!finalValuesByConceptId.has(override.conceptId)) continue;

    const simulatedSeries = simulatedValuesByConceptId.get(override.conceptId) ?? Array(months.length).fill(0);
    const simulatedValue = simulatedSeries[monthOffset] ?? 0;
    const baseValue = (baseValuesByConceptId.get(override.conceptId) ?? Array(months.length).fill(0))[monthOffset] ?? 0;
    const manualDelta = override.manualValue - simulatedValue;

    applyDelta(finalValuesByConceptId, override.conceptId, monthOffset, manualDelta);

    const directSeries = manualDeltaByConceptId.get(override.conceptId);
    if (directSeries) {
      directSeries[monthOffset] = (directSeries[monthOffset] ?? 0) + manualDelta;
    }

    for (const ancestor of getLineage(indexes.conceptById, override.conceptId)) {
      const series = manualDeltaByConceptId.get(ancestor.id);
      if (series) {
        series[monthOffset] = (series[monthOffset] ?? 0) + manualDelta;
      }
      const summaryChildren = indexes.summaryChildrenByParentId.get(ancestor.id) ?? [];
      for (const summaryChild of summaryChildren) {
        const summarySeries = manualDeltaByConceptId.get(summaryChild.id);
        if (summarySeries) {
          summarySeries[monthOffset] = (summarySeries[monthOffset] ?? 0) + manualDelta;
        }
      }
    }

    overrideMap.set(
      scenarioCellKey(scenario.id, override.conceptId, override.yearMonth),
      {
        ...override,
        baseValue,
        simulatedValue,
      },
    );
  }

  const cells = new Map<string, EvaluatedCell>();
  const diffVsBase = new Map<string, number>();
  const changedKeys = new Set<string>();

  for (const conceptId of trackedConceptIds) {
    const baseSeries = baseValuesByConceptId.get(conceptId) ?? Array(months.length).fill(0);
    const simulatedSeries = simulatedValuesByConceptId.get(conceptId) ?? Array(months.length).fill(0);
    const finalSeries = finalValuesByConceptId.get(conceptId) ?? Array(months.length).fill(0);
    const manualSeries = manualDeltaByConceptId.get(conceptId) ?? Array(months.length).fill(0);

    for (const [monthOffset, month] of months.entries()) {
      const key = scenarioCellKey(scenario.id, conceptId, month.ym);
      const diff = (finalSeries[monthOffset] ?? 0) - (baseSeries[monthOffset] ?? 0);
      const contributions = simulationContributionMap.get(`${conceptId}::${month.ym}`) ?? [];
      const override = overrideMap.get(key);
      const cell: EvaluatedCell = {
        key,
        conceptId,
        yearMonth: month.ym,
        monthIndex: month.monthIndex,
        baseValue: baseSeries[monthOffset] ?? 0,
        simulatedValue: simulatedSeries[monthOffset] ?? 0,
        finalValue: finalSeries[monthOffset] ?? 0,
        manualDelta: manualSeries[monthOffset] ?? 0,
        override,
        comment: override?.comment,
        simulationContributions: contributions,
        hasSimulationDelta: contributions.some((item) => item.delta !== 0),
        hasManualDelta: (manualSeries[monthOffset] ?? 0) !== 0 || Boolean(override?.comment),
        isOverridden: Boolean(override),
        isEditable: indexes.editableConceptIds.has(conceptId),
      };
      cells.set(key, cell);
      diffVsBase.set(key, diff);
      if (diff !== 0 || override?.comment) {
        changedKeys.add(key);
      }
    }
  }

  const ingresos = addSeries(
    sumSeries(finalValuesByConceptId, indexes.rootIncomeIds, months.length),
    finalValuesByConceptId.get(ROLE_TARGET_INCOME) ?? Array(months.length).fill(0),
  );
  const egresos = addSeries(
    sumSeries(finalValuesByConceptId, indexes.rootExpenseIds, months.length),
    finalValuesByConceptId.get(ROLE_TARGET_EXPENSE) ?? Array(months.length).fill(0),
  );
  const flujoNeto = ingresos.map((ingreso, index) => ingreso - (egresos[index] ?? 0));

  const cajaFinal: number[] = [];
  let saldo = plan.cajaInicial;
  for (const flujo of flujoNeto) {
    saldo += flujo;
    cajaFinal.push(saldo);
  }

  const cobranzaBaseIds =
    indexes.collectionsConceptIds.length > 0
      ? indexes.collectionsConceptIds
      : indexes.rootIncomeIds;
  const pagosBaseIds =
    indexes.providerPaymentConceptIds.length > 0
      ? indexes.providerPaymentConceptIds
      : indexes.rootExpenseIds;

  const cobranza = addSeries(
    sumSeries(finalValuesByConceptId, cobranzaBaseIds, months.length),
    finalValuesByConceptId.get(ROLE_TARGET_COLLECTIONS) ?? Array(months.length).fill(0),
  );
  const pagosProveedores = addSeries(
    sumSeries(finalValuesByConceptId, pagosBaseIds, months.length),
    finalValuesByConceptId.get(ROLE_TARGET_PROVIDER_PAYMENTS) ?? Array(months.length).fill(0),
  );

  const metrics = {
    ingresos,
    egresos,
    flujoNeto,
    cajaFinal,
    cobranza,
    pagosProveedores,
    saldosFinales: [...cajaFinal],
  };

  return {
    proposalId: proposal.id,
    scenarioId: scenario.id,
    months,
    valuesByConceptId: finalValuesByConceptId,
    baseValuesByConceptId,
    cells,
    diffVsBase,
    changedKeys,
    metrics,
    kpis: buildKpis(metrics),
  };
}

export function compareScenarioEvaluations(
  left: EvaluatedScenario,
  right: EvaluatedScenario,
): ScenarioComparisonSnapshot {
  const diffByCellKey = new Map<string, number>();
  const kpiDiff: Partial<Record<keyof ScenarioKpis, number>> = {};

  const rightCellIndex = new Map<string, EvaluatedCell>();
  for (const cell of right.cells.values()) {
    rightCellIndex.set(`${cell.conceptId}::${cell.yearMonth}`, cell);
  }

  for (const cell of left.cells.values()) {
    const pairKey = `${cell.conceptId}::${cell.yearMonth}`;
    const rightCell = rightCellIndex.get(pairKey);
    diffByCellKey.set(pairKey, cell.finalValue - (rightCell?.finalValue ?? 0));
  }

  for (const key of Object.keys(left.kpis) as (keyof ScenarioKpis)[]) {
    kpiDiff[key] = (left.kpis[key] ?? 0) - (right.kpis[key] ?? 0);
  }

  return {
    scenarioId: left.scenarioId,
    proposalId: left.proposalId,
    diffByCellKey,
    kpiDiff,
  };
}
