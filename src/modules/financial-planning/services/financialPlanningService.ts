import {
  applyAdjustmentsToMovements,
  calculateBaseProjection,
  calculateScenarioImpact,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  FinancialAdjustment,
  FinancialMovement,
  ForecastRun,
  ScenarioComparison,
} from '../../shared-finance/types';

export interface FinancialAdjustmentInput {
  name: string;
  scenarioIds: string[];
  type: FinancialAdjustment['type'];
  targetType: FinancialAdjustment['targetType'];
  targetExpression: string;
  reasonCode: FinancialAdjustment['reasonCode'];
  justification: string;
  adjustedValue?: unknown;
  deltaAmount?: number;
  deltaDays?: number;
  percentageChange?: number;
  splitConfig?: FinancialAdjustment['splitConfig'];
  createdBy?: string;
}

export function createFinancialAdjustment(input: FinancialAdjustmentInput): FinancialAdjustment {
  if (!input.justification.trim()) {
    throw new Error('La justificación es obligatoria para crear un ajuste financiero.');
  }
  const now = new Date().toISOString();
  const adjustment: FinancialAdjustment = {
    id: `adj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: input.name.trim() || 'Ajuste financiero',
    scenarioIds: input.scenarioIds.length > 0 ? input.scenarioIds : ['custom'],
    type: input.type,
    targetType: input.targetType,
    targetExpression: input.targetExpression,
    adjustedValue: input.adjustedValue,
    deltaAmount: input.deltaAmount,
    deltaDays: input.deltaDays,
    percentageChange: input.percentageChange,
    splitConfig: input.splitConfig,
    reasonCode: input.reasonCode,
    justification: input.justification.trim(),
    status: 'DRAFT',
    createdBy: input.createdBy ?? 'analyst@senda.local',
    createdAt: now,
  };
  return adjustment;
}

export function previewAdjustmentImpact(
  baseProjection: ForecastRun,
  adjustment: FinancialAdjustment,
  scenarioId: string,
): ScenarioComparison {
  const movements = applyAdjustmentsToMovements(baseProjection.movements, [adjustment], scenarioId);
  const adjustedProjection = calculateBaseProjection(movements, {
    startDate: baseProjection.startDate,
    endDate: baseProjection.endDate,
    initialCash: baseProjection.buckets[0]?.openingCash ?? baseProjection.summary.currentCash,
    minimumCash: baseProjection.summary.minimumCashRequired,
    granularity: baseProjection.granularity,
    scenarioId,
    name: `Vista previa · ${adjustment.name}`,
  });
  return calculateScenarioImpact(baseProjection, adjustedProjection);
}

export function scenarioUsesMovement(
  movements: FinancialMovement[],
  adjustment: FinancialAdjustment,
): boolean {
  if (adjustment.targetType !== 'MOVEMENT') return true;
  return movements.some((movement) => movement.id === adjustment.targetExpression || movement.sourceObjectId === adjustment.targetExpression);
}
