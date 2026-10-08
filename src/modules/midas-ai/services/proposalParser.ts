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

/**
 * FRONTERA DE UNIDAD del canal de Midas AI: PORCENTAJE → FRACCIÓN.
 *
 * El prompt le pide al modelo el cambio en PUNTOS porcentuales (`-15 = -15%`,
 * `midasPromptTemplates.ts`), que es lo natural para un LLM. El resto del
 * sistema guarda `percentageChange` como FRACCIÓN: la ruta humana divide entre
 * 100 (`AdjustmentEditorPopover`), el motor predictivo emite `0.06`/`-0.08`, y
 * el display multiplica por 100 (`scenarioMerge`). El motor aplica
 * `monto * (1 + percentageChange)`.
 *
 * Sin esta conversión un `-15` llegaba al motor como `monto * (1 - 15)` =
 * `monto * -14` → `Math.max(0, …)` = **$0**: la propuesta BORRABA el pago en vez
 * de reducirlo 15%, y un `+10` lo multiplicaba por 11. En silencio — la tarjeta
 * pintaba "-15%", que es justo lo que el usuario esperaba ver al aceptar.
 *
 * La asimetría favorece convertir: si el modelo desobedeciera y mandara ya una
 * fracción (`-0.15`), dividir de nuevo da `-0.0015` — una reducción del 0.15%,
 * un casi no-op. El modo de falla contrario borra dinero.
 */
function percentToFraction(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value / 100;
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
    percentageChange: percentToFraction(numberOrUndef(args.percentageChange)),
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
