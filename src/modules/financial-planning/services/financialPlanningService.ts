import {
  applyAdjustmentsToMovements,
  calculateBaseProjection,
  calculateScenarioImpact,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  AuditEvent,
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
  ForecastRun,
  ScenarioComparison,
} from '../../shared-finance/types';
import { createAuditEvent } from '../../shared-finance/audit/audit';

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

export function approveAdjustment(
  adjustment: FinancialAdjustment,
  approver = 'manager@senda.local',
): { adjustment: FinancialAdjustment; auditEvent: AuditEvent } {
  const approved: FinancialAdjustment = {
    ...adjustment,
    status: 'APPROVED',
    approvedBy: approver,
    approvedAt: new Date().toISOString(),
  };
  return {
    adjustment: approved,
    auditEvent: createAuditEvent({
      entityType: 'ADJUSTMENT',
      entityId: adjustment.id,
      action: 'APPROVE',
      previousValue: adjustment.status,
      newValue: approved.status,
      comment: approved.justification,
      userId: approver,
    }),
  };
}

export function rejectAdjustment(
  adjustment: FinancialAdjustment,
  userId = 'manager@senda.local',
): { adjustment: FinancialAdjustment; auditEvent: AuditEvent } {
  const rejected: FinancialAdjustment = { ...adjustment, status: 'REJECTED' };
  return {
    adjustment: rejected,
    auditEvent: createAuditEvent({
      entityType: 'ADJUSTMENT',
      entityId: adjustment.id,
      action: 'REJECT',
      previousValue: adjustment.status,
      newValue: rejected.status,
      comment: adjustment.justification,
      userId,
    }),
  };
}

export function approveScenario(
  scenario: FinancialScenario,
  approver = 'cfo@senda.local',
): { scenario: FinancialScenario; auditEvent: AuditEvent } {
  const approved: FinancialScenario = {
    ...scenario,
    status: 'APPROVED',
    approvedBy: approver,
    approvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    scenario: approved,
    auditEvent: createAuditEvent({
      entityType: 'SCENARIO',
      entityId: scenario.id,
      action: 'APPROVE',
      previousValue: scenario.status,
      newValue: approved.status,
      comment: 'Escenario aprobado para publicar plan financiero.',
      userId: approver,
    }),
  };
}

export function publishPlan(
  scenario: FinancialScenario,
  userId = 'cfo@senda.local',
): { scenario: FinancialScenario; auditEvent: AuditEvent } {
  const published: FinancialScenario = {
    ...scenario,
    status: 'PUBLISHED',
    publishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return {
    scenario: published,
    auditEvent: createAuditEvent({
      entityType: 'PLAN',
      entityId: scenario.id,
      action: 'PUBLISH',
      previousValue: scenario.status,
      newValue: published.status,
      comment: 'Plan financiero oficial publicado.',
      userId,
    }),
  };
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
