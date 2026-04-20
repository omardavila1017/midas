import {
  BASE_SCENARIO_ID,
  BASE_SCENARIO_NAME,
  FlowPlan,
  Proposal,
  ROLE_TARGET_COLLECTIONS,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_INCOME,
  ROLE_TARGET_PROVIDER_PAYMENTS,
  Scenario,
  Simulation,
  SimulationEffect,
  SimulationFrequency,
} from '../types';

function now(): string {
  return new Date().toISOString();
}

export function createBaseScenario(plan: FlowPlan | null): Scenario {
  return {
    id: BASE_SCENARIO_ID,
    proposalId: null,
    kind: 'base',
    name: BASE_SCENARIO_NAME,
    description: 'Pronóstico original sin cambios. Siempre visible y no editable.',
    probability: 1,
    startYearMonth: `${plan?.year ?? new Date().getFullYear()}-01`,
    horizonMonths: 12,
    simulationIds: [],
    locked: true,
    createdAt: now(),
    updatedAt: now(),
  };
}

export function ensureBaseScenario(
  plan: FlowPlan | null,
  scenarios: Scenario[],
): Scenario[] {
  const existing = scenarios.find((scenario) => scenario.id === BASE_SCENARIO_ID || scenario.kind === 'base');
  const base = existing
    ? {
        ...existing,
        id: BASE_SCENARIO_ID,
        proposalId: null,
        kind: 'base' as const,
        name: BASE_SCENARIO_NAME,
        description: existing.description || 'Pronóstico original sin cambios.',
        simulationIds: [],
        locked: true,
        startYearMonth: existing.startYearMonth || `${plan?.year ?? new Date().getFullYear()}-01`,
        horizonMonths: existing.horizonMonths || 12,
      }
    : createBaseScenario(plan);

  return [base, ...scenarios.filter((scenario) => scenario.id !== existing?.id && scenario.kind !== 'base')];
}

export function isBaseScenario(scenario: Scenario | null | undefined): boolean {
  return Boolean(scenario && (scenario.kind === 'base' || scenario.id === BASE_SCENARIO_ID));
}

function parseYearMonth(yearMonth: string): { year: number; monthIndex: number } {
  const [yearRaw, monthRaw] = yearMonth.split('-');
  return {
    year: Number(yearRaw),
    monthIndex: Math.max(0, Math.min(11, Number(monthRaw) - 1)),
  };
}

function formatYearMonth(year: number, monthIndex: number): string {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

export function addYearMonths(yearMonth: string, offset: number): string {
  const { year, monthIndex } = parseYearMonth(yearMonth);
  const absolute = monthIndex + offset;
  const nextMonthIndex = ((absolute % 12) + 12) % 12;
  const nextYear = year + Math.floor(absolute / 12);
  return formatYearMonth(nextYear, nextMonthIndex);
}

export function compareYearMonths(left: string, right: string): number {
  return left.localeCompare(right);
}

export function frequencyStep(frequency: SimulationFrequency): number {
  switch (frequency) {
    case 'once':
      return 0;
    case 'monthly':
      return 1;
    case 'bimonthly':
      return 2;
    case 'quarterly':
      return 3;
    case 'semiannual':
      return 6;
    case 'annual':
      return 12;
  }
}

export function enumerateYearMonths(
  startYearMonth: string,
  endYearMonth?: string,
  frequency: SimulationFrequency = 'once',
): string[] {
  const finalEnd = endYearMonth ?? startYearMonth;
  if (compareYearMonths(finalEnd, startYearMonth) < 0) return [startYearMonth];

  const step = frequencyStep(frequency);
  if (step === 0) return [startYearMonth];

  const months: string[] = [];
  let cursor = startYearMonth;
  while (compareYearMonths(cursor, finalEnd) <= 0 && months.length < 60) {
    months.push(cursor);
    cursor = addYearMonths(cursor, step);
  }
  return months;
}

function collectChildren(plan: FlowPlan, parentId: string): string[] {
  return plan.concepts
    .filter((concept) => concept.parentId === parentId)
    .flatMap((concept) => {
      const nested = collectChildren(plan, concept.id);
      return nested.length > 0 ? nested : [concept.id];
    });
}

function resolveTargetBaseSeries(plan: FlowPlan, targetId: string): number[] {
  if (targetId === ROLE_TARGET_INCOME) {
    return plan.concepts
      .filter((concept) => !concept.parentId && concept.conceptType === 'ingreso')
      .reduce((series, concept) => series.map((value, index) => value + (concept.monthlyData[index] ?? 0)), Array(12).fill(0));
  }

  if (targetId === ROLE_TARGET_EXPENSE) {
    return plan.concepts
      .filter((concept) => !concept.parentId && concept.conceptType === 'egreso')
      .reduce((series, concept) => series.map((value, index) => value + (concept.monthlyData[index] ?? 0)), Array(12).fill(0));
  }

  if (targetId === ROLE_TARGET_COLLECTIONS) {
    return plan.concepts
      .filter((concept) => concept.name.toLowerCase().includes('cobranza') || concept.excelRow === 10)
      .reduce((series, concept) => series.map((value, index) => value + (concept.monthlyData[index] ?? 0)), Array(12).fill(0));
  }

  if (targetId === ROLE_TARGET_PROVIDER_PAYMENTS) {
    return plan.concepts
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
      .reduce((series, concept) => series.map((value, index) => value + (concept.monthlyData[index] ?? 0)), Array(12).fill(0));
  }

  const concept = plan.concepts.find((item) => item.id === targetId);
  if (!concept) return Array(12).fill(0);

  const descendantLeafIds = collectChildren(plan, concept.id);
  if (descendantLeafIds.length === 0) return [...concept.monthlyData];

  return descendantLeafIds
    .map((conceptId) => plan.concepts.find((item) => item.id === conceptId))
    .filter(Boolean)
    .reduce((series, node) => series.map((value, index) => value + ((node?.monthlyData[index] ?? 0))), Array(12).fill(0));
}

function signedAmount(simulation: Simulation): number {
  const amount = Math.abs(simulation.amount ?? 0);
  return simulation.operation === 'decrease' ? -amount : amount;
}

function signedPercent(simulation: Simulation): number {
  const percent = Math.abs(simulation.percent ?? 0);
  return simulation.operation === 'decrease' ? -percent : percent;
}

function buildInstallmentAllocation(simulation: Simulation): number[] {
  const installments = Math.max(1, simulation.installments ?? 1);
  const custom = simulation.customAllocation?.filter((value) => value > 0) ?? [];
  if (custom.length === installments) {
    const total = custom.reduce((sum, value) => sum + value, 0);
    if (total > 0) return custom.map((value) => value / total);
  }
  return Array.from({ length: installments }, () => 1 / installments);
}

function effectId(simulation: Simulation, targetId: string, suffix: string): string {
  return `${simulation.id}-${targetId}-${suffix}`;
}

export function buildSimulationEffects(
  plan: FlowPlan,
  simulation: Simulation,
): SimulationEffect[] {
  const targetIds = simulation.targetIds.length > 0 ? simulation.targetIds : [ROLE_TARGET_INCOME];
  const effects: SimulationEffect[] = [];

  if (simulation.type === 'pause_expense') {
    const months = enumerateYearMonths(
      simulation.startYearMonth,
      simulation.endYearMonth,
      'monthly',
    );
    for (const targetId of targetIds) {
      effects.push({
        id: effectId(simulation, targetId, 'pause'),
        type: 'concept_delta',
        conceptId: targetId,
        yearMonths: months,
        mode: 'percent',
        value: -1,
      });
    }
    return effects;
  }

  if (simulation.type === 'percent_adjustment') {
    const months = enumerateYearMonths(
      simulation.startYearMonth,
      simulation.endYearMonth,
      simulation.frequency ?? 'monthly',
    );
    for (const targetId of targetIds) {
      effects.push({
        id: effectId(simulation, targetId, 'percent'),
        type: 'concept_delta',
        conceptId: targetId,
        yearMonths: months,
        mode: 'percent',
        value: signedPercent(simulation),
      });
    }
    return effects;
  }

  if (simulation.type === 'amount_adjustment' || simulation.type === 'recurring_series') {
    const months = enumerateYearMonths(
      simulation.startYearMonth,
      simulation.endYearMonth,
      simulation.frequency ?? (simulation.type === 'recurring_series' ? 'monthly' : 'once'),
    );
    for (const targetId of targetIds) {
      effects.push({
        id: effectId(simulation, targetId, 'amount'),
        type: 'concept_delta',
        conceptId: targetId,
        yearMonths: months,
        mode: 'absolute',
        value: signedAmount(simulation),
      });
    }
    return effects;
  }

  if (simulation.type === 'installment_plan') {
    const start = simulation.startYearMonth;
    const allocations = buildInstallmentAllocation(simulation);
    const step = frequencyStep(simulation.frequency ?? 'monthly') || 1;
    for (const targetId of targetIds) {
      allocations.forEach((ratio, index) => {
        effects.push({
          id: effectId(simulation, targetId, `installment-${index}`),
          type: 'concept_delta',
          conceptId: targetId,
          yearMonths: [addYearMonths(start, index * step)],
          mode: 'absolute',
          value: signedAmount(simulation) * ratio,
        });
      });
    }
    return effects;
  }

  if (simulation.type === 'timing_shift') {
    const months = enumerateYearMonths(
      simulation.startYearMonth,
      simulation.endYearMonth,
      simulation.frequency ?? 'monthly',
    );
    const shiftMonths = simulation.shiftMonths ?? 0;
    const shiftRatio = Math.max(0, Math.min(1, simulation.shiftRatio ?? 1));

    for (const targetId of targetIds) {
      const baseSeries = resolveTargetBaseSeries(plan, targetId);
      for (const month of months) {
        const { year, monthIndex } = parseYearMonth(month);
        if (year !== plan.year) continue;
        const baseAmount = baseSeries[monthIndex] ?? 0;
        const movedAmount = baseAmount * shiftRatio;
        if (movedAmount === 0) continue;

        effects.push({
          id: effectId(simulation, targetId, `shift-out-${month}`),
          type: 'concept_delta',
          conceptId: targetId,
          yearMonths: [month],
          mode: 'absolute',
          value: -movedAmount,
        });
        effects.push({
          id: effectId(simulation, targetId, `shift-in-${month}`),
          type: 'concept_delta',
          conceptId: targetId,
          yearMonths: [addYearMonths(month, shiftMonths)],
          mode: 'absolute',
          value: movedAmount,
        });
      }
    }
    return effects;
  }

  return simulation.effects ?? [];
}

export function cloneProposalWithActiveScenario(
  proposal: Proposal,
  scenarioId: string | undefined,
): Proposal {
  return {
    ...proposal,
    activeScenarioId: scenarioId,
    updatedAt: now(),
  };
}
