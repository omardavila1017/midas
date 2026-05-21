import type { FinancialAdjustment } from '../../shared-finance/types';
import type { MidasProposalDraft, MidasProposalSuggestion } from '../types';

const VALID_TYPES = new Set<FinancialAdjustment['type']>([
  'DATE_SHIFT',
  'AMOUNT_OVERRIDE',
  'AMOUNT_DELTA',
  'PERCENTAGE_CHANGE',
  'SPLIT_PAYMENT',
  'CANCEL_MOVEMENT',
  'ADD_MOVEMENT',
  'FINANCING_DRAW',
  'RULE_OVERRIDE',
]);
const VALID_TARGET_TYPES = new Set<FinancialAdjustment['targetType']>([
  'MOVEMENT',
  'FILTER_SET',
  'COUNTERPARTY',
  'CATEGORY',
  'DATE_RANGE',
]);
const VALID_REASONS = new Set<FinancialAdjustment['reasonCode']>([
  'LIQUIDITY',
  'NEGOTIATION',
  'CRISIS',
  'UPSIDE',
  'FORECAST_CORRECTION',
  'MANAGEMENT_DECISION',
]);

export interface RawProposalArgs {
  name?: unknown;
  type?: unknown;
  targetType?: unknown;
  targetExpression?: unknown;
  reasonCode?: unknown;
  justification?: unknown;
  deltaAmount?: unknown;
  deltaDays?: unknown;
  percentageChange?: unknown;
  adjustedValueAmount?: unknown;
  estimatedCashImpact?: unknown;
  citedSuppliers?: unknown;
}

export interface ParsedProposal {
  ok: true;
  suggestion: MidasProposalSuggestion;
}
export interface FailedProposal {
  ok: false;
  reason: string;
  raw: RawProposalArgs;
}

export function parseProposal(args: RawProposalArgs): ParsedProposal | FailedProposal {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const type = typeof args.type === 'string' ? (args.type as FinancialAdjustment['type']) : null;
  const targetType =
    typeof args.targetType === 'string' ? (args.targetType as FinancialAdjustment['targetType']) : null;
  const targetExpression = typeof args.targetExpression === 'string' ? args.targetExpression.trim() : '';
  const reasonCode =
    typeof args.reasonCode === 'string' ? (args.reasonCode as FinancialAdjustment['reasonCode']) : null;
  const justification = typeof args.justification === 'string' ? args.justification.trim() : '';

  if (!name) return fail('name vacío', args);
  if (!type || !VALID_TYPES.has(type)) return fail(`type inválido: ${args.type}`, args);
  if (!targetType || !VALID_TARGET_TYPES.has(targetType)) return fail(`targetType inválido: ${args.targetType}`, args);
  if (!targetExpression) return fail('targetExpression vacío', args);
  if (!reasonCode || !VALID_REASONS.has(reasonCode)) return fail(`reasonCode inválido: ${args.reasonCode}`, args);
  if (justification.length < 30) return fail('justification < 30 caracteres', args);
  if (!/\d/.test(justification)) return fail('justification sin cifra cuantificada', args);

  const draft: MidasProposalDraft = {
    name,
    type,
    targetType,
    targetExpression,
    reasonCode,
    justification,
    deltaAmount: numberOrUndef(args.deltaAmount),
    deltaDays: numberOrUndef(args.deltaDays),
    percentageChange: numberOrUndef(args.percentageChange),
    adjustedValue: numberOrUndef(args.adjustedValueAmount),
  };

  const estimatedCashImpact = numberOrUndef(args.estimatedCashImpact) ?? 0;
  const citedSuppliers = Array.isArray(args.citedSuppliers)
    ? args.citedSuppliers.filter((x): x is string => typeof x === 'string')
    : [];

  return {
    ok: true,
    suggestion: {
      id: `midas-prop-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      draft,
      estimatedCashImpact,
      citedSuppliers,
    },
  };
}

function fail(reason: string, raw: RawProposalArgs): FailedProposal {
  return { ok: false, reason, raw };
}

function numberOrUndef(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}
