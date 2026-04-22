import {
  FlowPlan,
  Proposal,
  ProposalCategory,
  ProposalEffect,
  ProposalFrequency,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_INCOME,
  Simulation,
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

/**
 * Target role for each Propuesta category. Since we removed `targetIds` from
 * the UI, the category alone determines which aggregated bucket the effect
 * hits — "ahorro" and "pausar_gasto" always affect egresos, "aumento_ingresos"
 * always affects ingresos, and "timing_shift" moves egresos between periods.
 */
function targetRoleForCategory(category: ProposalCategory): string {
  switch (category) {
    case 'aumento_ingresos':
      return ROLE_TARGET_INCOME;
    case 'ahorro':
    case 'pausar_gasto':
    case 'timing_shift':
    default:
      return ROLE_TARGET_EXPENSE;
  }
}

function effectId(proposal: Proposal, suffix: string): string {
  return `${proposal.id}-${suffix}`;
}

/**
 * Compile a Propuesta (simplified model) into low-level concept_delta
 * effects that scenarioEngine can apply. The four supported categories:
 *
 *   - ahorro            → negative absolute amount on ROLE_TARGET_EXPENSE
 *                         at each occurrence derived from frequency
 *   - aumento_ingresos  → positive absolute amount on ROLE_TARGET_INCOME
 *                         at each occurrence derived from frequency
 *   - pausar_gasto      → percent=-1 on ROLE_TARGET_EXPENSE covering the
 *                         [startDate,endDate] window
 *   - timing_shift      → paired effects: -amount at source period,
 *                         +amount at source+shiftMonths period
 */
export function buildProposalEffects(
  plan: FlowPlan,
  proposal: Proposal,
): ProposalEffect[] {
  if (!proposal.startDate) return [];

  const targetId = targetRoleForCategory(proposal.category);
  const startDate = proposal.startDate;
  const endDate = proposal.endDate ?? startDate;
  const startYm = yearMonthFromDate(startDate);
  const endYm = yearMonthFromDate(endDate);
  const frequency = proposal.frequency ?? 'once';
  const amount = Math.max(0, proposal.amount ?? 0);

  if (amount === 0 && proposal.category !== 'pausar_gasto') return [];

  // PAUSAR_GASTO: single percent=-1 effect covering the whole window.
  if (proposal.category === 'pausar_gasto') {
    return [
      {
        id: effectId(proposal, 'pause'),
        type: 'concept_delta',
        conceptId: ROLE_TARGET_EXPENSE,
        startDate,
        endDate,
        mode: 'percent',
        value: -1,
      },
    ];
  }

  // TIMING_SHIFT: each occurrence moves `amount` from source period to
  // source+shiftMonths. Default shift is +1 (retrasar un mes).
  if (proposal.category === 'timing_shift') {
    const shiftMonths = typeof proposal.shiftMonths === 'number' ? proposal.shiftMonths : 1;
    if (shiftMonths === 0) return [];

    const occurrences = enumerateYearMonths(startYm, endYm, frequency);
    const effects: ProposalEffect[] = [];
    occurrences.forEach((yearMonth, index) => {
      const sourceDate = addMonthsToDate(startDate, index * (frequencyStep(frequency) || 1));
      const destDate = addMonthsToDate(sourceDate, shiftMonths);

      effects.push({
        id: effectId(proposal, `shift-out-${yearMonth}`),
        type: 'concept_delta',
        conceptId: targetId,
        yearMonths: [yearMonthFromDate(sourceDate)],
        startDate: sourceDate,
        endDate: sourceDate,
        mode: 'absolute',
        value: -amount,
      });
      effects.push({
        id: effectId(proposal, `shift-in-${yearMonth}`),
        type: 'concept_delta',
        conceptId: targetId,
        yearMonths: [yearMonthFromDate(destDate)],
        startDate: destDate,
        endDate: destDate,
        mode: 'absolute',
        value: amount,
      });
    });
    return effects;
  }

  // AHORRO / AUMENTO_INGRESOS: point-in-time absolute deltas at each
  // occurrence. Sign is determined by category.
  const sign = proposal.category === 'ahorro' ? -1 : 1;
  const signedAmount = sign * amount;

  const occurrences = enumerateYearMonths(startYm, endYm, frequency);
  const step = frequencyStep(frequency) || 1;

  return occurrences.map((yearMonth, index) => {
    const occurrenceDate = frequency === 'once'
      ? startDate
      : addMonthsToDate(startDate, index * step);
    return {
      id: effectId(proposal, `occurrence-${index}`),
      type: 'concept_delta',
      conceptId: targetId,
      yearMonths: [yearMonthFromDate(occurrenceDate)],
      startDate: occurrenceDate,
      endDate: occurrenceDate,
      mode: 'absolute',
      value: signedAmount,
    };
  });
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

// Helper exposed so UI can pre-compute yearmonth ranges etc.
export { startOfMonth, endOfMonth, yearMonthFromDate, addMonthsToDate };
