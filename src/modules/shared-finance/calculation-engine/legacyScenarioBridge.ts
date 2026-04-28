// ─────────────────────────────────────────────────────────────────────────
// legacyScenarioBridge — convierte el modelo legacy Proposal/Scenario
// (usado por Simulación) al modelo FinancialScenario/FinancialAdjustment
// que consume Planeación Financiera.
//
// Por qué existe esta capa:
//   El usuario maneja escenarios desde Simulación y desde Planeación. Antes
//   eran universos paralelos: cada quien guardaba su propia lista, sin
//   referencia al otro. Cruzarlos significa que la lista de escenarios es
//   ÚNICA y vive en Simulación (modelo legacy con Proposals). Planeación
//   solo refleja esa lista y la enriquece con el workflow de aprobación.
//
// Mapeo:
//   - Cada `Scenario` legacy → un `FinancialScenario` con kind 'CUSTOM' y
//     prefijo de id `legacy:`.
//   - Cada `Proposal` enabled en el `proposalStates` del scenario activo
//     → uno o varios `FinancialAdjustment` de tipo `ADD_MOVEMENT`. Se
//     emite un movement por cada mes impactado por la propuesta (ya
//     contemplando frecuencia: one_time, monthly, quarterly, semiannual)
//     y la categoría correcta (ingreso vs egreso) según el `kind`.
//
// La cantidad delta sigue la convención del legacy:
//   income_increase, expense_saving → +amount
//   revenue_loss, new_expense       → -amount
// (expense_saving suma porque "ahorrar" en egresos = más caja; el
//  movement es un INFLOW sintético que cancela parte del egreso).
// ─────────────────────────────────────────────────────────────────────────

import type { Proposal, Scenario } from '../../../types';
import type {
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
} from '../types';
import { addMonths, compareYearMonth } from '../../../domain/cashFlowEngine';
import { calculateConfidenceBand } from './financialProjectionEngine';

const LEGACY_SCENARIO_PREFIX = 'legacy:';

export function legacyScenarioId(scenario: Scenario): string {
  return `${LEGACY_SCENARIO_PREFIX}${scenario.id}`;
}

export function isLegacyScenarioId(id: string): boolean {
  return id.startsWith(LEGACY_SCENARIO_PREFIX);
}

export function unwrapLegacyScenarioId(id: string): string {
  return id.startsWith(LEGACY_SCENARIO_PREFIX)
    ? id.slice(LEGACY_SCENARIO_PREFIX.length)
    : id;
}

export function convertLegacyScenariosToFinancial(
  scenarios: Scenario[],
): FinancialScenario[] {
  return scenarios.map((scenario) => ({
    id: legacyScenarioId(scenario),
    name: scenario.name,
    kind: 'CUSTOM',
    description: scenario.description ?? 'Escenario sincronizado desde Simulación.',
    adjustmentIds: [],
    status: 'APPROVED',
    isBase: false,
    createdBy: 'simulacion',
    createdAt: scenario.createdAt,
    updatedAt: scenario.updatedAt,
  }));
}

/**
 * Devuelve los Proposals del escenario activo legacy. Si el id activo no
 * es legacy, devuelve []. Útil para que Planeación solo aplique
 * adjustments cuando esté viendo un escenario de Simulación.
 */
export function legacyProposalsForActiveScenario(
  activeScenarioId: string,
  scenarios: Scenario[],
  proposals: Proposal[],
): Proposal[] {
  if (!isLegacyScenarioId(activeScenarioId)) return [];
  const realId = unwrapLegacyScenarioId(activeScenarioId);
  const scenario = scenarios.find((s) => s.id === realId);
  if (!scenario) return [];
  const enabledIds = new Set(
    Object.entries(scenario.proposalStates)
      .filter(([, enabled]) => enabled)
      .map(([id]) => id),
  );
  return proposals.filter((p) => enabledIds.has(p.id) && p.enabled !== false);
}

/**
 * Convierte una Propuesta legacy en uno o más FinancialAdjustment para
 * ser aplicados en el motor de Planeación.
 */
export function legacyProposalToAdjustments(
  proposal: Proposal,
  financialScenarioId: string,
  asOfDate: string,
  horizonYearMonth: string,
): FinancialAdjustment[] {
  const months = enumerateImpactedMonths(proposal, horizonYearMonth);
  const isInflow = proposal.kind === 'income_increase' || proposal.kind === 'expense_saving';
  return months.map((ym, index) => {
    const movement = synthesizeMovement(proposal, ym, isInflow, asOfDate);
    return {
      id: `legacy-adj:${proposal.id}:${ym}:${index}`,
      name: proposal.name,
      scenarioIds: [financialScenarioId],
      type: 'ADD_MOVEMENT',
      targetType: 'CATEGORY',
      targetExpression: isInflow ? 'AR_COLLECTION' : 'OPEX',
      adjustedValue: movement,
      reasonCode: 'MANAGEMENT_DECISION',
      justification: proposal.description ?? `Propuesta '${proposal.name}' importada desde Simulación.`,
      status: 'APPROVED',
      createdBy: 'simulacion',
      createdAt: proposal.createdAt,
    };
  });
}

function synthesizeMovement(
  proposal: Proposal,
  yearMonth: string,
  isInflow: boolean,
  asOfDate: string,
): Partial<FinancialMovement> {
  const date = `${yearMonth}-15`;
  const score = 70;
  return {
    id: `legacy-mov:${proposal.id}:${yearMonth}`,
    sourceSystem: 'MANUAL',
    sourceObjectId: proposal.id,
    type: isInflow ? 'INFLOW' : 'OUTFLOW',
    category: isInflow ? 'AR_COLLECTION' : 'OPEX',
    concept: proposal.name,
    currency: 'MXN',
    originalAmount: proposal.amount,
    baseAmount: proposal.amount,
    projectedAmount: proposal.amount,
    projectedDate: date,
    confidenceScore: score,
    confidenceBand: calculateConfidenceBand(score),
    forecastMethod: 'MANUAL',
    ruleApplied: `Simulación · ${proposal.frequency}`,
    status: 'ADJUSTED',
    lockState: 'UNLOCKED',
    comments: ['Generado desde Simulación.'],
    createdAt: `${asOfDate}T00:00:00.000Z`,
    updatedAt: `${asOfDate}T00:00:00.000Z`,
  };
}

/**
 * Lista los meses (YYYY-MM) en los que la propuesta aplica, dado su
 * frequency y rango. Limita al horizonte máximo.
 */
function enumerateImpactedMonths(proposal: Proposal, horizonYearMonth: string): string[] {
  const start = proposal.startYearMonth;
  const end = proposal.endYearMonth ?? horizonYearMonth;
  if (compareYearMonth(start, horizonYearMonth) > 0) return [];
  const lastMonth = compareYearMonth(end, horizonYearMonth) < 0 ? end : horizonYearMonth;
  const months: string[] = [];
  const stepByFrequency: Record<typeof proposal.frequency, number | null> = {
    one_time: null,
    monthly: 1,
    quarterly: 3,
    semiannual: 6,
  };
  if (proposal.frequency === 'one_time') {
    months.push(start);
    return months;
  }
  const step = stepByFrequency[proposal.frequency];
  if (!step) {
    months.push(start);
    return months;
  }
  let cursor = start;
  while (compareYearMonth(cursor, lastMonth) <= 0) {
    months.push(cursor);
    cursor = addMonths(cursor, step);
  }
  return months;
}
