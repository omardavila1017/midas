import {
  BASE_SCENARIO_ID,
  BASE_SCENARIO_NAME,
  FlowPlan,
  Simulation,
  ROLE_TARGET_COLLECTIONS,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_INCOME,
  ROLE_TARGET_PROVIDER_PAYMENTS,
  Scenario,
  Proposal,
  ProposalEffect,
  ProposalFrequency,
} from '../types';

function now(): string {
  return new Date().toISOString();
}

function parseIsoDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatIsoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function startOfMonth(yearMonth: string): string {
  return `${yearMonth}-01`;
}

function endOfMonth(yearMonth: string): string {
  const { year, monthIndex } = parseYearMonth(yearMonth);
  return formatIsoDate(new Date(Date.UTC(year, monthIndex + 1, 0)));
}

function yearMonthFromDate(date: string): string {
  return date.slice(0, 7);
}

function addMonthsToDate(date: string, offset: number): string {
  const parsed = parseIsoDate(date);
  const year = parsed.getUTCFullYear();
  const monthIndex = parsed.getUTCMonth();
  const day = parsed.getUTCDate();
  const absolute = monthIndex + offset;
  const nextMonthIndex = ((absolute % 12) + 12) % 12;
  const nextYear = year + Math.floor(absolute / 12);
  const daysInTargetMonth = new Date(Date.UTC(nextYear, nextMonthIndex + 1, 0)).getUTCDate();
  return formatIsoDate(new Date(Date.UTC(nextYear, nextMonthIndex, Math.min(day, daysInTargetMonth))));
}

function maxIsoDate(left: string, right: string): string {
  return left > right ? left : right;
}

function minIsoDate(left: string, right: string): string {
  return left < right ? left : right;
}

function normalizeProposalStartDate(proposal: Proposal): string {
  if (typeof proposal.startDate === 'string' && proposal.startDate.length === 10) {
    return proposal.startDate;
  }
  return startOfMonth(proposal.startYearMonth);
}

function normalizeProposalEndDate(proposal: Proposal, startDate: string): string {
  if (typeof proposal.endDate === 'string' && proposal.endDate.length === 10) {
    return proposal.endDate;
  }

  if (typeof proposal.endYearMonth === 'string' && proposal.endYearMonth.includes('-')) {
    return endOfMonth(proposal.endYearMonth);
  }

  if ((proposal.frequency ?? 'once') === 'once') {
    return startDate;
  }

  return endOfMonth(proposal.startYearMonth);
}

function effectWindowForMonth(
  yearMonth: string,
  proposalStartDate: string,
  proposalEndDate: string,
): { startDate: string; endDate: string } | null {
  const windowStart = maxIsoDate(startOfMonth(yearMonth), proposalStartDate);
  const windowEnd = minIsoDate(endOfMonth(yearMonth), proposalEndDate);
  if (windowEnd < windowStart) return null;
  return {
    startDate: windowStart,
    endDate: windowEnd,
  };
}

export function createBaseScenario(plan: FlowPlan | null): Scenario {
  return {
    id: BASE_SCENARIO_ID,
    simulationId: null,
    kind: 'base',
    name: BASE_SCENARIO_NAME,
    description: 'Pronóstico original sin cambios. Siempre visible y no editable.',
    probability: 1,
    startYearMonth: `${plan?.year ?? new Date().getFullYear()}-01`,
    horizonMonths: 12,
    proposalIds: [],
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
        simulationId: null,
        kind: 'base' as const,
        name: BASE_SCENARIO_NAME,
        description: existing.description || 'Pronóstico original sin cambios.',
        proposalIds: [],
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

export function frequencyStep(frequency: ProposalFrequency): number {
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
  frequency: ProposalFrequency = 'once',
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

function signedAmount(proposal: Proposal): number {
  const amount = Math.abs(proposal.amount ?? 0);
  return proposal.operation === 'decrease' ? -amount : amount;
}

function signedPercent(proposal: Proposal): number {
  const percent = Math.abs(proposal.percent ?? 0);
  return proposal.operation === 'decrease' ? -percent : percent;
}

function buildInstallmentAllocation(proposal: Proposal): number[] {
  const installments = Math.max(1, proposal.installments ?? 1);
  const custom = proposal.customAllocation?.filter((value) => value > 0) ?? [];
  if (custom.length === installments) {
    const total = custom.reduce((sum, value) => sum + value, 0);
    if (total > 0) return custom.map((value) => value / total);
  }
  return Array.from({ length: installments }, () => 1 / installments);
}

function effectId(proposal: Proposal, targetId: string, suffix: string): string {
  return `${proposal.id}-${targetId}-${suffix}`;
}

export function buildProposalEffects(
  plan: FlowPlan,
  proposal: Proposal,
): ProposalEffect[] {
  const targetIds = proposal.targetIds.length > 0 ? proposal.targetIds : [ROLE_TARGET_INCOME];
  const effects: ProposalEffect[] = [];
  const proposalStartDate = normalizeProposalStartDate(proposal);
  const proposalEndDate = normalizeProposalEndDate(proposal, proposalStartDate);

  if (proposal.type === 'pause_expense') {
    const months = enumerateYearMonths(
      proposal.startYearMonth,
      proposal.endYearMonth,
      'monthly',
    );
    for (const targetId of targetIds) {
      months.forEach((yearMonth, index) => {
        const window = effectWindowForMonth(yearMonth, proposalStartDate, proposalEndDate);
        if (!window) return;
        effects.push({
          id: effectId(proposal, targetId, `pause-${index}`),
          type: 'concept_delta',
          conceptId: targetId,
          yearMonths: [yearMonth],
          startDate: window.startDate,
          endDate: window.endDate,
          mode: 'percent',
          value: -1,
        });
      });
    }
    return effects;
  }

  if (proposal.type === 'percent_adjustment') {
    const months = enumerateYearMonths(
      proposal.startYearMonth,
      proposal.endYearMonth,
      proposal.frequency ?? 'monthly',
    );
    for (const targetId of targetIds) {
      months.forEach((yearMonth, index) => {
        const window = effectWindowForMonth(yearMonth, proposalStartDate, proposalEndDate);
        if (!window) return;
        effects.push({
          id: effectId(proposal, targetId, `percent-${index}`),
          type: 'concept_delta',
          conceptId: targetId,
          yearMonths: [yearMonth],
          startDate: window.startDate,
          endDate: window.endDate,
          mode: 'percent',
          value: signedPercent(proposal),
        });
      });
    }
    return effects;
  }

  if (proposal.type === 'amount_adjustment' || proposal.type === 'recurring_series') {
    const months = enumerateYearMonths(
      proposal.startYearMonth,
      proposal.endYearMonth,
      proposal.frequency ?? (proposal.type === 'recurring_series' ? 'monthly' : 'once'),
    );
    for (const targetId of targetIds) {
      months.forEach((yearMonth, index) => {
        const occurrenceDate = addMonthsToDate(
          proposalStartDate,
          index * (frequencyStep(proposal.frequency ?? (proposal.type === 'recurring_series' ? 'monthly' : 'once')) || 1),
        );
        effects.push({
          id: effectId(proposal, targetId, `amount-${index}`),
          type: 'concept_delta',
          conceptId: targetId,
          yearMonths: [yearMonthFromDate(occurrenceDate)],
          startDate: occurrenceDate,
          endDate: occurrenceDate,
          mode: 'absolute',
          value: signedAmount(proposal),
        });
      });
    }
    return effects;
  }

  if (proposal.type === 'installment_plan') {
    const allocations = buildInstallmentAllocation(proposal);
    const step = frequencyStep(proposal.frequency ?? 'monthly') || 1;
    for (const targetId of targetIds) {
      allocations.forEach((ratio, index) => {
        const occurrenceDate = addMonthsToDate(proposalStartDate, index * step);
        effects.push({
          id: effectId(proposal, targetId, `installment-${index}`),
          type: 'concept_delta',
          conceptId: targetId,
          yearMonths: [yearMonthFromDate(occurrenceDate)],
          startDate: occurrenceDate,
          endDate: occurrenceDate,
          mode: 'absolute',
          value: signedAmount(proposal) * ratio,
        });
      });
    }
    return effects;
  }

  if (proposal.type === 'timing_shift') {
    const months = enumerateYearMonths(
      proposal.startYearMonth,
      proposal.endYearMonth,
      proposal.frequency ?? 'monthly',
    );
    const shiftMonths = proposal.shiftMonths ?? 0;
    const shiftRatio = Math.max(0, Math.min(1, proposal.shiftRatio ?? 1));

    for (const targetId of targetIds) {
      const baseSeries = resolveTargetBaseSeries(plan, targetId);
      for (const [index, month] of months.entries()) {
        const { year, monthIndex } = parseYearMonth(month);
        if (year !== plan.year) continue;
        const baseAmount = baseSeries[monthIndex] ?? 0;
        const movedAmount = baseAmount * shiftRatio;
        if (movedAmount === 0) continue;
        const sourceDate = addMonthsToDate(
          proposalStartDate,
          index * (frequencyStep(proposal.frequency ?? 'monthly') || 1),
        );
        const targetDate = addMonthsToDate(sourceDate, shiftMonths);

        effects.push({
          id: effectId(proposal, targetId, `shift-out-${month}`),
          type: 'concept_delta',
          conceptId: targetId,
          yearMonths: [month],
          startDate: sourceDate,
          endDate: sourceDate,
          mode: 'absolute',
          value: -movedAmount,
        });
        effects.push({
          id: effectId(proposal, targetId, `shift-in-${month}`),
          type: 'concept_delta',
          conceptId: targetId,
          yearMonths: [yearMonthFromDate(targetDate)],
          startDate: targetDate,
          endDate: targetDate,
          mode: 'absolute',
          value: movedAmount,
        });
      }
    }
    return effects;
  }

  return proposal.effects ?? [];
}

export function cloneSimulationWithActiveScenario(
  simulation: Simulation,
  scenarioId: string | undefined,
): Simulation {
  return {
    ...simulation,
    activeScenarioId: scenarioId,
    updatedAt: now(),
  };
}
