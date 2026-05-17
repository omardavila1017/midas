import type { CXPRecord } from '../../../domain/persistence';
import type { Client, Provider, CashFlowAssumptions } from '../../../domain/types';
import type {
  AdjustmentReasonCode,
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
  ScenarioChangeLogEntry,
} from '../../shared-finance/types';
import { effectiveAmount, effectiveMovementDate } from '../../shared-finance/calculation-engine/financialProjectionEngine';
import { newChangeLogEntry } from '../../financial-planning/services/changeLogTemplates';

export type PredictionScenarioTemplate =
  | 'OPTIMISTIC'
  | 'CONSERVATIVE'
  | 'LIQUIDITY_OPTIMIZED'
  | 'CRITICAL_SUPPLIERS';

export interface ProjectionPredictionInput {
  template: PredictionScenarioTemplate;
  movements: FinancialMovement[];
  providers: Provider[];
  clients: Client[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  approvedScenario: FinancialScenario;
  asOfDate: string;
  user?: string;
}

export interface PredictionEntityImpact {
  entityType: 'CLIENT' | 'SUPPLIER' | 'CATEGORY';
  entityName: string;
  movementId: string;
  baseDate: string;
  predictedDate: string;
  baseAmount: number;
  predictedAmount: number;
  confidenceScore: number;
  reason: string;
}

export interface ProjectionPredictionDraft {
  scenario: FinancialScenario;
  adjustments: FinancialAdjustment[];
  changeLogEntry: ScenarioChangeLogEntry;
  template: PredictionScenarioTemplate;
  title: string;
  summary: string;
  entityImpacts: PredictionEntityImpact[];
}

export interface QuickMovementAdjustmentInput {
  movement: FinancialMovement;
  scenarioId: string;
  action: 'SHIFT_DATE' | 'AMOUNT_OVERRIDE' | 'SPLIT_PAYMENT';
  asOfDate: string;
  targetDate?: string;
  targetAmount?: number;
  splitCount?: number;
  user?: string;
}

const MAX_AUTOMATIC_ADJUSTMENTS = 90;

export function buildPredictionScenarioDraft(input: ProjectionPredictionInput): ProjectionPredictionDraft {
  const user = input.user ?? 'tesoreria@senda.local';
  const now = new Date().toISOString();
  const def = templateDefinition(input.template);
  const scenarioId = `draft-predictive-${input.template.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const scenario: FinancialScenario = {
    id: scenarioId,
    name: def.name,
    kind: 'DRAFT',
    description: def.description,
    adjustmentIds: [],
    status: 'DRAFT',
    parentScenarioId: input.approvedScenario.id,
    createdBy: user,
    createdAt: now,
    updatedAt: now,
  };

  const context = buildPredictionContext(input.providers, input.clients, input.cxpRecords);
  const selected = selectScenarioAdjustments(input, scenarioId, context, now)
    .slice(0, MAX_AUTOMATIC_ADJUSTMENTS);
  const adjustments = selected.map(({ adjustment }) => adjustment);
  scenario.adjustmentIds = adjustments.map((adjustment) => adjustment.id);

  const entityImpacts = selected.map(({ impact }) => impact);
  const changeLogEntry = newChangeLogEntry({
    scenarioId,
    kind: 'CREATE_DRAFT',
    autoDescription: `Motor predictivo generó ${def.shortLabel} con ${adjustments.length} ajuste${adjustments.length === 1 ? '' : 's'} detallados.`,
    payload: {
      template: input.template,
      adjustmentCount: adjustments.length,
      entityCount: new Set(entityImpacts.map((impact) => `${impact.entityType}:${impact.entityName}`)).size,
    },
    createdBy: user,
  });

  return {
    scenario,
    adjustments,
    changeLogEntry,
    template: input.template,
    title: def.shortLabel,
    summary: def.summary,
    entityImpacts,
  };
}

export function buildPredictionScenarioDrafts(
  input: Omit<ProjectionPredictionInput, 'template'>,
): ProjectionPredictionDraft[] {
  return (['OPTIMISTIC', 'CONSERVATIVE', 'LIQUIDITY_OPTIMIZED', 'CRITICAL_SUPPLIERS'] as PredictionScenarioTemplate[])
    .map((template) => buildPredictionScenarioDraft({ ...input, template }));
}

export function createQuickMovementAdjustment(input: QuickMovementAdjustmentInput): FinancialAdjustment {
  const movement = input.movement;
  const user = input.user ?? 'tesoreria@senda.local';
  const now = new Date().toISOString();
  const entity = movement.counterpartyName ?? movement.concept;
  const baseDate = effectiveMovementDate(movement);
  const baseAmount = effectiveAmount(movement);
  const common = {
    id: `adj-proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    scenarioIds: [input.scenarioId],
    targetType: 'MOVEMENT' as const,
    targetExpression: movement.id,
    originalValue: {
      date: baseDate,
      amount: baseAmount,
      movementId: movement.id,
      entity,
    },
    reasonCode: 'FORECAST_CORRECTION' as AdjustmentReasonCode,
    status: 'DRAFT' as const,
    createdBy: user,
    createdAt: now,
  };

  if (input.action === 'SHIFT_DATE') {
    const targetDate = input.targetDate ?? addDays(baseDate, movement.type === 'INFLOW' ? -7 : 7);
    return {
      ...common,
      name: `Mover ${movement.type === 'INFLOW' ? 'cobro' : 'pago'} · ${entity}`,
      type: 'DATE_SHIFT',
      adjustedValue: targetDate,
      deltaDays: daysBetween(baseDate, targetDate),
      justification: `Ajuste rápido desde Proyección: ${entity} se mueve de ${baseDate} a ${targetDate}.`,
    };
  }

  if (input.action === 'AMOUNT_OVERRIDE') {
    const targetAmount = Math.max(0, input.targetAmount ?? baseAmount);
    return {
      ...common,
      name: `Cambiar monto · ${entity}`,
      type: 'AMOUNT_OVERRIDE',
      adjustedValue: targetAmount,
      deltaAmount: targetAmount - baseAmount,
      justification: `Ajuste rápido desde Proyección: ${entity} cambia de ${round(baseAmount)} a ${round(targetAmount)}.`,
    };
  }

  return {
    ...common,
    name: `Dividir pago · ${entity}`,
    type: 'SPLIT_PAYMENT',
    splitConfig: {
      numberOfPayments: Math.max(2, input.splitCount ?? 2),
      frequency: 'BIWEEKLY',
    },
    justification: `Ajuste rápido desde Proyección: ${entity} se divide para suavizar caja.`,
  };
}

function selectScenarioAdjustments(
  input: ProjectionPredictionInput,
  scenarioId: string,
  context: PredictionContext,
  createdAt: string,
): Array<{ adjustment: FinancialAdjustment; impact: PredictionEntityImpact }> {
  const future = input.movements
    .filter((movement) => movement.status !== 'REAL' && movement.status !== 'EXECUTED' && effectiveMovementDate(movement) >= input.asOfDate)
    .sort((a, b) => {
      const dateDelta = effectiveMovementDate(a).localeCompare(effectiveMovementDate(b));
      if (dateDelta !== 0) return dateDelta;
      return effectiveAmount(b) - effectiveAmount(a);
    });

  if (input.template === 'OPTIMISTIC') return optimisticAdjustments(future, scenarioId, createdAt);
  if (input.template === 'CONSERVATIVE') return conservativeAdjustments(future, scenarioId, createdAt);
  if (input.template === 'LIQUIDITY_OPTIMIZED') return liquidityAdjustments(future, scenarioId, context, createdAt);
  return criticalSupplierAdjustments(future, scenarioId, context, createdAt);
}

function optimisticAdjustments(
  movements: FinancialMovement[],
  scenarioId: string,
  createdAt: string,
): Array<{ adjustment: FinancialAdjustment; impact: PredictionEntityImpact }> {
  const out: Array<{ adjustment: FinancialAdjustment; impact: PredictionEntityImpact }> = [];
  for (const movement of movements) {
    if (movement.type !== 'INFLOW' || movement.category !== 'AR_COLLECTION') continue;
    if (movement.lockState === 'LOCKED') continue;
    const baseDate = effectiveMovementDate(movement);
    const nextDate = addDays(baseDate, -Math.min(10, Math.max(3, Math.round((100 - movement.confidenceScore) / 8))));
    out.push(buildDateAdjustment({
      movement,
      scenarioId,
      createdAt,
      nextDate,
      namePrefix: 'Acelerar cobranza',
      reasonCode: 'UPSIDE',
      justification: `Patrón optimista: mejora de cobranza para ${movement.counterpartyName ?? movement.concept}.`,
    }));
    out.push(buildPercentAdjustment({
      movement,
      scenarioId,
      createdAt,
      percentageChange: 0.06,
      namePrefix: 'Incrementar cobranza',
      reasonCode: 'UPSIDE',
      justification: `Patrón optimista: mayor cumplimiento/venta esperada para ${movement.counterpartyName ?? movement.concept}.`,
    }));
  }
  return out;
}

function conservativeAdjustments(
  movements: FinancialMovement[],
  scenarioId: string,
  createdAt: string,
): Array<{ adjustment: FinancialAdjustment; impact: PredictionEntityImpact }> {
  const out: Array<{ adjustment: FinancialAdjustment; impact: PredictionEntityImpact }> = [];
  for (const movement of movements) {
    if (movement.type === 'INFLOW' && movement.category === 'AR_COLLECTION' && movement.lockState !== 'LOCKED') {
      out.push(buildDateAdjustment({
        movement,
        scenarioId,
        createdAt,
        nextDate: addDays(effectiveMovementDate(movement), 12),
        namePrefix: 'Retrasar cobranza',
        reasonCode: 'CRISIS',
        justification: `Patrón conservador: posible retraso de cliente ${movement.counterpartyName ?? movement.concept}.`,
      }));
      out.push(buildPercentAdjustment({
        movement,
        scenarioId,
        createdAt,
        percentageChange: -0.08,
        namePrefix: 'Reducir cobranza',
        reasonCode: 'CRISIS',
        justification: `Patrón conservador: menor cobranza esperada para ${movement.counterpartyName ?? movement.concept}.`,
      }));
      continue;
    }
    if (movement.type === 'OUTFLOW' && movement.category !== 'TRANSFER' && movement.lockState !== 'LOCKED') {
      out.push(buildPercentAdjustment({
        movement,
        scenarioId,
        createdAt,
        percentageChange: 0.05,
        namePrefix: 'Presionar egreso',
        reasonCode: 'CRISIS',
        justification: `Patrón conservador: mayor presión de gasto en ${movement.counterpartyName ?? movement.concept}.`,
      }));
    }
  }
  return out;
}

function liquidityAdjustments(
  movements: FinancialMovement[],
  scenarioId: string,
  context: PredictionContext,
  createdAt: string,
): Array<{ adjustment: FinancialAdjustment; impact: PredictionEntityImpact }> {
  const out: Array<{ adjustment: FinancialAdjustment; impact: PredictionEntityImpact }> = [];
  for (const movement of movements) {
    if (movement.type === 'INFLOW' && movement.category === 'AR_COLLECTION' && movement.lockState !== 'LOCKED') {
      out.push(buildDateAdjustment({
        movement,
        scenarioId,
        createdAt,
        nextDate: addDays(effectiveMovementDate(movement), -5),
        namePrefix: 'Adelantar cobranza',
        reasonCode: 'LIQUIDITY',
        justification: `Optimización de liquidez: adelantar cobro de ${movement.counterpartyName ?? movement.concept}.`,
      }));
      continue;
    }
    if (!isFlexibleOutflow(movement, context)) continue;
    if (effectiveAmount(movement) >= 1_000_000 && movement.category === 'AP_PAYMENT') {
      out.push(buildSplitAdjustment({
        movement,
        scenarioId,
        createdAt,
        reasonCode: 'LIQUIDITY',
        justification: `Optimización de liquidez: dividir pago flexible de ${movement.counterpartyName ?? movement.concept}.`,
      }));
    } else {
      out.push(buildDateAdjustment({
        movement,
        scenarioId,
        createdAt,
        nextDate: addDays(effectiveMovementDate(movement), 14),
        namePrefix: 'Diferir egreso flexible',
        reasonCode: 'LIQUIDITY',
        justification: `Optimización de liquidez: diferir egreso no crítico de ${movement.counterpartyName ?? movement.concept}.`,
      }));
    }
  }
  return out;
}

function criticalSupplierAdjustments(
  movements: FinancialMovement[],
  scenarioId: string,
  context: PredictionContext,
  createdAt: string,
): Array<{ adjustment: FinancialAdjustment; impact: PredictionEntityImpact }> {
  const out: Array<{ adjustment: FinancialAdjustment; impact: PredictionEntityImpact }> = [];
  for (const movement of movements) {
    if (movement.type !== 'OUTFLOW') continue;
    if (movement.category !== 'AP_PAYMENT' && movement.category !== 'OPEX' && movement.category !== 'CAPEX') continue;
    if (isCriticalSupplierMovement(movement, context)) continue;
    if (movement.lockState === 'LOCKED') continue;
    out.push(buildDateAdjustment({
      movement,
      scenarioId,
      createdAt,
      nextDate: addDays(effectiveMovementDate(movement), 10),
      namePrefix: 'Liberar caja para críticos',
      reasonCode: 'LIQUIDITY',
      justification: `Priorización de proveedores críticos: diferir ${movement.counterpartyName ?? movement.concept}.`,
    }));
  }
  return out;
}

function buildDateAdjustment(args: {
  movement: FinancialMovement;
  scenarioId: string;
  createdAt: string;
  nextDate: string;
  namePrefix: string;
  reasonCode: AdjustmentReasonCode;
  justification: string;
}): { adjustment: FinancialAdjustment; impact: PredictionEntityImpact } {
  const baseDate = effectiveMovementDate(args.movement);
  const baseAmount = effectiveAmount(args.movement);
  const adjustment: FinancialAdjustment = {
    id: automaticAdjustmentId(args.scenarioId, args.movement.id, 'date'),
    name: `${args.namePrefix} · ${args.movement.counterpartyName ?? args.movement.concept}`,
    scenarioIds: [args.scenarioId],
    type: 'DATE_SHIFT',
    targetType: 'MOVEMENT',
    targetExpression: args.movement.id,
    originalValue: baseDate,
    adjustedValue: args.nextDate,
    deltaDays: daysBetween(baseDate, args.nextDate),
    reasonCode: args.reasonCode,
    justification: args.justification,
    status: 'DRAFT',
    createdBy: 'projection-engine@senda.local',
    createdAt: args.createdAt,
  };
  return {
    adjustment,
    impact: impactFor(args.movement, args.nextDate, baseAmount, args.justification),
  };
}

function buildPercentAdjustment(args: {
  movement: FinancialMovement;
  scenarioId: string;
  createdAt: string;
  percentageChange: number;
  namePrefix: string;
  reasonCode: AdjustmentReasonCode;
  justification: string;
}): { adjustment: FinancialAdjustment; impact: PredictionEntityImpact } {
  const baseAmount = effectiveAmount(args.movement);
  const nextAmount = Math.max(0, baseAmount * (1 + args.percentageChange));
  const adjustment: FinancialAdjustment = {
    id: automaticAdjustmentId(args.scenarioId, args.movement.id, `pct-${args.percentageChange}`),
    name: `${args.namePrefix} · ${args.movement.counterpartyName ?? args.movement.concept}`,
    scenarioIds: [args.scenarioId],
    type: 'PERCENTAGE_CHANGE',
    targetType: 'MOVEMENT',
    targetExpression: args.movement.id,
    originalValue: baseAmount,
    percentageChange: args.percentageChange,
    reasonCode: args.reasonCode,
    justification: args.justification,
    status: 'DRAFT',
    createdBy: 'projection-engine@senda.local',
    createdAt: args.createdAt,
  };
  return {
    adjustment,
    impact: impactFor(args.movement, effectiveMovementDate(args.movement), nextAmount, args.justification),
  };
}

function buildSplitAdjustment(args: {
  movement: FinancialMovement;
  scenarioId: string;
  createdAt: string;
  reasonCode: AdjustmentReasonCode;
  justification: string;
}): { adjustment: FinancialAdjustment; impact: PredictionEntityImpact } {
  const baseDate = effectiveMovementDate(args.movement);
  const adjustment: FinancialAdjustment = {
    id: automaticAdjustmentId(args.scenarioId, args.movement.id, 'split'),
    name: `Dividir pago · ${args.movement.counterpartyName ?? args.movement.concept}`,
    scenarioIds: [args.scenarioId],
    type: 'SPLIT_PAYMENT',
    targetType: 'MOVEMENT',
    targetExpression: args.movement.id,
    originalValue: effectiveAmount(args.movement),
    splitConfig: {
      numberOfPayments: 2,
      frequency: 'BIWEEKLY',
    },
    reasonCode: args.reasonCode,
    justification: args.justification,
    status: 'DRAFT',
    createdBy: 'projection-engine@senda.local',
    createdAt: args.createdAt,
  };
  return {
    adjustment,
    impact: impactFor(args.movement, addDays(baseDate, 14), effectiveAmount(args.movement), args.justification),
  };
}

function impactFor(
  movement: FinancialMovement,
  predictedDate: string,
  predictedAmount: number,
  reason: string,
): PredictionEntityImpact {
  const entityType = movement.type === 'INFLOW'
    ? 'CLIENT'
    : movement.category === 'AP_PAYMENT'
      ? 'SUPPLIER'
      : 'CATEGORY';
  return {
    entityType,
    entityName: movement.counterpartyName ?? movement.concept,
    movementId: movement.id,
    baseDate: effectiveMovementDate(movement),
    predictedDate,
    baseAmount: effectiveAmount(movement),
    predictedAmount,
    confidenceScore: movement.confidenceScore,
    reason,
  };
}

interface PredictionContext {
  criticalProviderNames: Set<string>;
  criticalSupplierNumbers: Set<string>;
  flexibleProviderNames: Set<string>;
  supplierNumbersByName: Map<string, string>;
}

function buildPredictionContext(
  providers: Provider[],
  clients: Client[],
  cxpRecords: CXPRecord[],
): PredictionContext {
  void clients;
  const criticalProviderNames = new Set<string>();
  const criticalSupplierNumbers = new Set<string>();
  const flexibleProviderNames = new Set<string>();
  const supplierNumbersByName = new Map<string, string>();
  for (const provider of providers) {
    const key = normalize(provider.name);
    if (!key) continue;
    const supplierNumber = normalize(provider.numProveedorJDE);
    const isCritical = (
      provider.clasificacionAlberto === 'CRITICO'
      || provider.clasificacionAutomatica === 'CRITICO'
      || provider.flexibility === 'inamovible'
      || provider.risk === 'Alto'
    );
    if (isCritical) {
      criticalProviderNames.add(key);
      if (supplierNumber) criticalSupplierNumbers.add(supplierNumber);
    }
    if (provider.flexibility === 'flexible' || provider.clasificacionAlberto === 'FLEX_BAJO' || provider.clasificacionAlberto === 'PAUSAR') {
      flexibleProviderNames.add(key);
    }
    if (supplierNumber) supplierNumbersByName.set(key, supplierNumber);
  }
  for (const record of cxpRecords) {
    const key = normalize(record.nombre);
    const supplierNumber = normalize(record.noProveedor);
    if (!key || !supplierNumber) continue;
    if (!supplierNumbersByName.has(key)) supplierNumbersByName.set(key, supplierNumber);
    if (criticalProviderNames.has(key)) criticalSupplierNumbers.add(supplierNumber);
  }
  return { criticalProviderNames, criticalSupplierNumbers, flexibleProviderNames, supplierNumbersByName };
}

function isFlexibleOutflow(movement: FinancialMovement, context: PredictionContext): boolean {
  if (movement.type !== 'OUTFLOW') return false;
  if (movement.lockState === 'LOCKED') return false;
  if (movement.category === 'TAX' || movement.category === 'PAYROLL' || movement.category === 'TRANSFER') return false;
  if (isCriticalSupplierMovement(movement, context)) return false;
  const name = normalize(movement.counterpartyName);
  if (!name) return true;
  return context.flexibleProviderNames.has(name) || movement.lockState === 'UNLOCKED' || movement.category !== 'AP_PAYMENT';
}

function isCriticalSupplierMovement(movement: FinancialMovement, context: PredictionContext): boolean {
  if (movement.lockState === 'LOCKED') return true;
  const name = normalize(movement.counterpartyName);
  if (name && context.criticalProviderNames.has(name)) return true;
  const source = normalize(movement.counterpartyId ?? movement.sourceObjectId);
  return Boolean(source && context.criticalSupplierNumbers.has(source));
}

function templateDefinition(template: PredictionScenarioTemplate): {
  name: string;
  shortLabel: string;
  description: string;
  summary: string;
} {
  switch (template) {
    case 'OPTIMISTIC':
      return {
        name: 'Predictivo · Optimista',
        shortLabel: 'Optimista',
        description: 'Escenario generado por el motor: adelanta cobranza y eleva cumplimiento por cliente.',
        summary: 'Mayor cobranza y menor lag de clientes.',
      };
    case 'CONSERVATIVE':
      return {
        name: 'Predictivo · Conservador',
        shortLabel: 'Conservador',
        description: 'Escenario generado por el motor: retrasa cobranza y aumenta presión de egresos.',
        summary: 'Menor cobranza, más retraso y egresos presionados.',
      };
    case 'LIQUIDITY_OPTIMIZED':
      return {
        name: 'Predictivo · Liquidez optimizada',
        shortLabel: 'Liquidez',
        description: 'Escenario generado por el motor: adelanta cobros y difiere o divide pagos flexibles.',
        summary: 'Mejora caja moviendo sólo partidas flexibles.',
      };
    case 'CRITICAL_SUPPLIERS':
      return {
        name: 'Predictivo · Proveedores críticos',
        shortLabel: 'Críticos',
        description: 'Escenario generado por el motor: protege proveedores críticos y difiere pagos no críticos.',
        summary: 'Prioriza operación crítica sin tocar proveedores inamovibles.',
      };
  }
}

function automaticAdjustmentId(scenarioId: string, movementId: string, suffix: string): string {
  return `adj:${scenarioId}:${movementId}:${suffix}`.replace(/[^A-Za-z0-9:_-]/g, '-');
}

function normalize(value: string | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T12:00:00.000Z`).getTime();
  const b = new Date(`${to}T12:00:00.000Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
