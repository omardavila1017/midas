import type { FinanceRole, FinancialAdjustment } from '../types';

export type FinancePermission =
  | 'VIEW_PROJECTION'
  | 'CREATE_ADJUSTMENT'
  | 'SUBMIT_ADJUSTMENT'
  | 'APPROVE_ADJUSTMENT'
  | 'CONFIGURE_RULES'
  | 'PUBLISH_PLAN';

const ROLE_PERMISSIONS: Record<FinanceRole, FinancePermission[]> = {
  VIEWER: ['VIEW_PROJECTION'],
  ANALYST: ['VIEW_PROJECTION', 'CREATE_ADJUSTMENT', 'SUBMIT_ADJUSTMENT'],
  MANAGER: ['VIEW_PROJECTION', 'CREATE_ADJUSTMENT', 'SUBMIT_ADJUSTMENT', 'APPROVE_ADJUSTMENT'],
  ADMIN: ['VIEW_PROJECTION', 'CREATE_ADJUSTMENT', 'SUBMIT_ADJUSTMENT', 'APPROVE_ADJUSTMENT', 'CONFIGURE_RULES'],
  CFO: ['VIEW_PROJECTION', 'CREATE_ADJUSTMENT', 'SUBMIT_ADJUSTMENT', 'APPROVE_ADJUSTMENT', 'PUBLISH_PLAN'],
};

export function can(role: FinanceRole, permission: FinancePermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function adjustmentRequiresApproval(adjustment: FinancialAdjustment, materialityThreshold = 1_000_000): boolean {
  const absoluteImpact = Math.max(
    Math.abs(adjustment.deltaAmount ?? 0),
    Math.abs(typeof adjustment.adjustedValue === 'number' ? adjustment.adjustedValue : 0),
  );
  return (
    absoluteImpact >= materialityThreshold
    || adjustment.type === 'SPLIT_PAYMENT'
    || adjustment.type === 'FINANCING_DRAW'
    || adjustment.targetExpression.toUpperCase().includes('TAX')
    || adjustment.targetExpression.toUpperCase().includes('PAYROLL')
  );
}
