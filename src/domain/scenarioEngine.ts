import {
  EvaluatedCell,
  EvaluatedScenario,
  FlowConcept,
  FlowPlan,
  ForecastGranularity,
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

interface ScenarioEvaluationOptions {
  granularity?: ForecastGranularity;
}

function cloneSeriesMap(source: Map<string, number[]>): Map<string, number[]> {
  return new Map(Array.from(source.entries(), ([key, values]) => [key, [...values]]));
}

function parseYearMonth(yearMonth: string): { year: number; monthIndex: number } {
  const [yearRaw, monthRaw] = yearMonth.split('-');
  return {
    year: Number(yearRaw),
    monthIndex: Math.max(0, Math.min(11, (Number(monthRaw) || 1) - 1)),
  };
}

function formatYearMonth(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function addYearMonths(yearMonth: string, offset: number): string {
  const { year, monthIndex } = parseYearMonth(yearMonth);
  const absoluteMonth = monthIndex + offset;
  const targetMonth = ((absoluteMonth % 12) + 12) % 12;
  const targetYear = year + Math.floor(absoluteMonth / 12);
  return formatYearMonth(targetYear, targetMonth);
}

function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDays(dateIso: string, offset: number): string {
  const date = parseIsoDate(dateIso);
  date.setUTCDate(date.getUTCDate() + offset);
  return formatIsoDate(date);
}

function addMonthsToDate(dateIso: string, offset: number): string {
  const parsed = parseIsoDate(dateIso);
  const year = parsed.getUTCFullYear();
  const monthIndex = parsed.getUTCMonth();
  const day = parsed.getUTCDate();
  const absolute = monthIndex + offset;
  const nextMonthIndex = ((absolute % 12) + 12) % 12;
  const nextYear = year + Math.floor(absolute / 12);
  const daysInMonth = new Date(Date.UTC(nextYear, nextMonthIndex + 1, 0)).getUTCDate();
  return formatIsoDate(new Date(Date.UTC(nextYear, nextMonthIndex, Math.min(day, daysInMonth))));
}

function startOfMonth(yearMonth: string): string {
  return `${yearMonth}-01`;
}

function endOfMonth(yearMonth: string): string {
  const { year, monthIndex } = parseYearMonth(yearMonth);
  return formatIsoDate(new Date(Date.UTC(year, monthIndex + 1, 0)));
}

function firstScenarioDate(plan: FlowPlan, scenario?: Pick<Scenario, 'startYearMonth'>): string {
  return startOfMonth(scenario?.startYearMonth ?? `${plan.year}-01`);
}

function lastScenarioDate(plan: FlowPlan, scenario?: Pick<Scenario, 'startYearMonth' | 'horizonMonths'>): string {
  const startYearMonth = scenario?.startYearMonth ?? `${plan.year}-01`;
  const horizonMonths = Math.max(1, Math.min(24, scenario?.horizonMonths ?? 12));
  return endOfMonth(addYearMonths(startYearMonth, horizonMonths - 1));
}

function shortDateLabel(dateIso: string): string {
  const date = parseIsoDate(dateIso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

function addMonthlyPeriod(year: number, monthIndex: number, offset: number): ScenarioMonth {
  const absoluteMonth = monthIndex + offset;
  const targetMonth = ((absoluteMonth % 12) + 12) % 12;
  const targetYear = year + Math.floor(absoluteMonth / 12);
  const ym = formatYearMonth(targetYear, targetMonth);
  return {
    monthIndex: targetMonth,
    year: targetYear,
    label: `${MONTHS[targetMonth]} ${String(targetYear).slice(2)}`,
    ym,
    granularity: 'monthly',
    startDate: startOfMonth(ym),
    endDate: endOfMonth(ym),
  };
}

function scenarioRange(plan: FlowPlan, scenario?: Pick<Scenario, 'startYearMonth' | 'horizonMonths'>) {
  return {
    startDate: firstScenarioDate(plan, scenario),
    endDate: lastScenarioDate(plan, scenario),
  };
}

export function buildScenarioMonths(
  plan: FlowPlan,
  scenario?: Pick<Scenario, 'startYearMonth' | 'horizonMonths'>,
  granularity: ForecastGranularity = 'monthly',
): ScenarioMonth[] {
  const defaultStart = `${plan.year}-01`;
  const [yearRaw, monthRaw] = (scenario?.startYearMonth ?? defaultStart).split('-');
  const startYear = Number(yearRaw) || plan.year;
  const startMonthIndex = Math.max(0, Math.min(11, (Number(monthRaw) || 1) - 1));
  const horizonMonths = Math.max(1, Math.min(24, scenario?.horizonMonths ?? 12));

  if (granularity === 'monthly') {
    return Array.from({ length: horizonMonths }, (_, offset) =>
      addMonthlyPeriod(startYear, startMonthIndex, offset),
    );
  }

  const { startDate, endDate } = scenarioRange(plan, scenario);

  if (granularity === 'weekly') {
    const periods: ScenarioMonth[] = [];
    plan.weekDates.forEach((weekStartDate) => {
      const weekEndDate = addDays(weekStartDate, 6);
      if (weekEndDate < startDate || weekStartDate > endDate) return;
      const weekStart = parseIsoDate(weekStartDate);
      periods.push({
        monthIndex: weekStart.getUTCMonth(),
        year: weekStart.getUTCFullYear(),
        label: `Sem ${shortDateLabel(weekStartDate)}`,
        ym: `week:${weekStartDate}`,
        granularity: 'weekly',
        startDate: weekStartDate,
        endDate: weekEndDate,
      });
    });
    return periods;
  }

  const periods: ScenarioMonth[] = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const date = parseIsoDate(cursor);
    periods.push({
      monthIndex: date.getUTCMonth(),
      year: date.getUTCFullYear(),
      label: shortDateLabel(cursor),
      ym: cursor,
      granularity: 'daily',
      startDate: cursor,
      endDate: cursor,
    });
    cursor = addDays(cursor, 1);
  }
  return periods;
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

function sumSeries(valuesByConceptId: Map<string, number[]>, conceptIds: string[], periods: number): number[] {
  let total = Array(periods).fill(0);
  for (const conceptId of conceptIds) {
    total = addSeries(total, valuesByConceptId.get(conceptId) ?? Array(periods).fill(0));
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

function buildWeekIndexByStartDate(plan: FlowPlan): Map<string, number> {
  return new Map(plan.weekDates.map((weekDate, index) => [weekDate, index]));
}

function buildDayToWeekIndex(plan: FlowPlan): Map<string, number> {
  const index = new Map<string, number>();
  plan.weekDates.forEach((weekDate, weekIndex) => {
    for (let offset = 0; offset < 7; offset += 1) {
      index.set(addDays(weekDate, offset), weekIndex);
    }
  });
  return index;
}

function baseValueForPeriod(
  concept: FlowConcept,
  period: ScenarioMonth,
  planYear: number,
  weekIndexByStartDate: Map<string, number>,
  dayToWeekIndex: Map<string, number>,
): number {
  if (period.granularity === 'monthly') {
    if (period.year !== planYear) return 0;
    return concept.monthlyData[period.monthIndex] ?? 0;
  }

  if (period.granularity === 'weekly') {
    const weekIndex = weekIndexByStartDate.get(period.startDate);
    return weekIndex === undefined ? 0 : (concept.weeklyData[weekIndex] ?? 0);
  }

  const weekIndex = dayToWeekIndex.get(period.startDate);
  return weekIndex === undefined ? 0 : ((concept.weeklyData[weekIndex] ?? 0) / 7);
}

function periodContainsDate(period: ScenarioMonth, dateIso: string): boolean {
  return dateIso >= period.startDate && dateIso <= period.endDate;
}

function inclusiveDaySpan(startDate: string, endDate: string): number {
  const start = parseIsoDate(startDate).getTime();
  const end = parseIsoDate(endDate).getTime();
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function overlapRatio(period: ScenarioMonth, startDate: string, endDate: string): number {
  const overlapStart = period.startDate > startDate ? period.startDate : startDate;
  const overlapEnd = period.endDate < endDate ? period.endDate : endDate;
  if (overlapEnd < overlapStart) return 0;
  return inclusiveDaySpan(overlapStart, overlapEnd) / inclusiveDaySpan(period.startDate, period.endDate);
}

function resolveLegacyYearMonthForOffset(
  scenario: Scenario,
  monthOffset: number,
): string {
  return addYearMonths(scenario.startYearMonth, monthOffset);
}

function normalizeEffectDateWindow(
  effect: Simulation['effects'][number],
  scenario: Scenario,
): { startDate: string; endDate: string } | null {
  if (effect.startDate && effect.endDate) {
    return {
      startDate: effect.startDate,
      endDate: effect.endDate,
    };
  }

  if (effect.startDate) {
    return {
      startDate: effect.startDate,
      endDate: effect.endDate ?? effect.startDate,
    };
  }

  const yearMonth = effect.yearMonths?.[0]
    ?? (typeof effect.monthOffsets?.[0] === 'number'
      ? resolveLegacyYearMonthForOffset(scenario, effect.monthOffsets[0])
      : null);

  if (!yearMonth) return null;

  return effect.mode === 'percent'
    ? { startDate: startOfMonth(yearMonth), endDate: endOfMonth(yearMonth) }
    : { startDate: startOfMonth(yearMonth), endDate: startOfMonth(yearMonth) };
}

function resolvePeriodIndexesForEffect(
  periods: ScenarioMonth[],
  effect: Simulation['effects'][number],
  scenario: Scenario,
): Array<{ periodIndex: number; weight: number }> {
  const explicitWindow = normalizeEffectDateWindow(effect, scenario);

  if (explicitWindow) {
    const isPointEffect = explicitWindow.startDate === explicitWindow.endDate && effect.mode === 'absolute';
    const indexes: Array<{ periodIndex: number; weight: number }> = [];

    periods.forEach((period, periodIndex) => {
      const weight = isPointEffect
        ? (periodContainsDate(period, explicitWindow.startDate) ? 1 : 0)
        : overlapRatio(period, explicitWindow.startDate, explicitWindow.endDate);
      if (weight > 0) {
        indexes.push({ periodIndex, weight });
      }
    });

    return indexes;
  }

  if (effect.yearMonths && effect.yearMonths.length > 0) {
    const yearMonthSet = new Set(effect.yearMonths);
    return periods
      .map((period, periodIndex) => ({
        periodIndex,
        weight: period.granularity === 'monthly'
          ? (yearMonthSet.has(period.ym) ? 1 : 0)
          : (yearMonthSet.has(period.startDate.slice(0, 7))
            ? (effect.mode === 'percent'
              ? overlapRatio(period, `${period.startDate.slice(0, 7)}-01`, endOfMonth(period.startDate.slice(0, 7)))
              : (period.startDate.endsWith('-01') ? 1 : 0))
            : 0),
      }))
      .filter((item) => item.weight > 0);
  }

  if (effect.monthOffsets && effect.monthOffsets.length > 0) {
    const yearMonths = effect.monthOffsets.map((offset) => resolveLegacyYearMonthForOffset(scenario, offset));
    return resolvePeriodIndexesForEffect(periods, { ...effect, yearMonths }, scenario);
  }

  return periods.map((_, periodIndex) => ({ periodIndex, weight: 1 }));
}

export function evaluateScenario(
  plan: FlowPlan,
  proposal: Proposal,
  scenario: Scenario,
  simulations: Simulation[],
  overrides: ScenarioCellOverride[],
  options?: ScenarioEvaluationOptions,
): EvaluatedScenario {
  const granularity = options?.granularity ?? 'monthly';
  const months = buildScenarioMonths(plan, scenario, granularity);
  const monthIndexByYm = new Map(months.map((month, index) => [month.ym, index]));
  const weekIndexByStartDate = buildWeekIndexByStartDate(plan);
  const dayToWeekIndex = buildDayToWeekIndex(plan);
  const indexes = buildConceptIndexes(plan);
  const trackedConceptIds = [
    ...plan.concepts.map((concept) => concept.id),
    ...ROLE_TARGET_IDS,
  ];
  const cobranzaBaseIds =
    indexes.collectionsConceptIds.length > 0
      ? indexes.collectionsConceptIds
      : indexes.rootIncomeIds;
  const pagosBaseIds =
    indexes.providerPaymentConceptIds.length > 0
      ? indexes.providerPaymentConceptIds
      : indexes.rootExpenseIds;

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
      months.map((month) => baseValueForPeriod(concept, month, plan.year, weekIndexByStartDate, dayToWeekIndex)),
    );
  }

  const effectBaseValuesByConceptId = cloneSeriesMap(baseValuesByConceptId);
  effectBaseValuesByConceptId.set(
    ROLE_TARGET_INCOME,
    sumSeries(baseValuesByConceptId, indexes.rootIncomeIds, months.length),
  );
  effectBaseValuesByConceptId.set(
    ROLE_TARGET_EXPENSE,
    sumSeries(baseValuesByConceptId, indexes.rootExpenseIds, months.length),
  );
  effectBaseValuesByConceptId.set(
    ROLE_TARGET_COLLECTIONS,
    sumSeries(baseValuesByConceptId, cobranzaBaseIds, months.length),
  );
  effectBaseValuesByConceptId.set(
    ROLE_TARGET_PROVIDER_PAYMENTS,
    sumSeries(baseValuesByConceptId, pagosBaseIds, months.length),
  );

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
    optionsWithSimulation?: { simulationId: string; simulationName: string; yearMonth: string },
  ) => {
    if (delta === 0) return;

    const record = (conceptId: string) => {
      const series = valuesByConceptId.get(conceptId);
      if (!series) return;
      series[monthOffset] = (series[monthOffset] ?? 0) + delta;
      if (optionsWithSimulation) {
        appendContribution(
          simulationContributionMap,
          `${conceptId}::${optionsWithSimulation.yearMonth}`,
          optionsWithSimulation.simulationId,
          optionsWithSimulation.simulationName,
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

      const targetPeriods = resolvePeriodIndexesForEffect(months, effect, scenario);
      for (const { periodIndex, weight } of targetPeriods) {
        if (periodIndex < 0 || periodIndex >= months.length) continue;
        const periodKey = months[periodIndex].ym;
        const baseSeries = effectBaseValuesByConceptId.get(effect.conceptId) ?? Array(months.length).fill(0);
        const baseValue = baseSeries[periodIndex] ?? 0;
        const delta =
          effect.mode === 'percent'
            ? baseValue * effect.value * weight
            : effect.value * weight;

        applyDelta(simulatedValuesByConceptId, effect.conceptId, periodIndex, delta, {
          simulationId: simulation.id,
          simulationName: simulation.name,
          yearMonth: periodKey,
        });
        applyDelta(finalValuesByConceptId, effect.conceptId, periodIndex, delta, {
          simulationId: simulation.id,
          simulationName: simulation.name,
          yearMonth: periodKey,
        });
      }
    }
  }

  const overrideMap = new Map<string, ScenarioCellOverride>();
  const overrideEditingEnabled = granularity === 'monthly';
  for (const override of overrides) {
    if (!overrideEditingEnabled) continue;
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
        granularity,
        periodLabel: month.label,
        periodStartDate: month.startDate,
        periodEndDate: month.endDate,
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
        isEditable: granularity === 'monthly' && indexes.editableConceptIds.has(conceptId),
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
    granularity,
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
