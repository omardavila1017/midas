import { describe, expect, it } from 'vitest';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { FinancialMovement, FinancialScenario } from '../../shared-finance/types';
import {
  buildPredictionScenarioDraft,
  buildPredictionScenarioDrafts,
  createQuickMovementAdjustment,
} from './projectionPredictionEngine';

// Unreachable branch left uncovered on purpose: the `lockState === 'LOCKED'` guard in
// `criticalSupplierAdjustments` (projectionPredictionEngine.ts:332) is dead code — the line
// above it already `continue`s on `isCriticalSupplierMovement`, which returns true for every
// LOCKED movement.

const AS_OF = '2026-06-01';

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 0.85,
  factorajeDays: 30,
};

function approvedScenario(): FinancialScenario {
  return {
    id: 'approved',
    name: 'Escenario Aprobado',
    kind: 'APPROVED',
    adjustmentIds: [],
    status: 'APPROVED',
    createdBy: 'system',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

function movement(patch: Partial<FinancialMovement> & Pick<FinancialMovement, 'id' | 'type' | 'category'>): FinancialMovement {
  const amount = patch.projectedAmount ?? 1000;
  return {
    sourceSystem: 'FORECAST',
    concept: `Concepto ${patch.id}`,
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate: '2026-06-20',
    confidenceScore: 75,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...patch,
  };
}

function draftFor(template: Parameters<typeof buildPredictionScenarioDraft>[0]['template'], patch: {
  movements: FinancialMovement[];
  providers?: Provider[];
  cxpRecords?: CXPRecord[];
  clients?: Client[];
}) {
  return buildPredictionScenarioDraft({
    template,
    movements: patch.movements,
    providers: patch.providers ?? [],
    clients: patch.clients ?? [],
    cxpRecords: patch.cxpRecords ?? [],
    assumptions,
    approvedScenario: approvedScenario(),
    asOfDate: AS_OF,
  });
}

function provider(patch: Partial<Provider> & Pick<Provider, 'id' | 'name'>): Provider {
  return {
    type: 'Operación',
    risk: 'Bajo',
    paymentPeriod: '30 días',
    ...patch,
  };
}

function cxp(patch: Partial<CXPRecord> & Pick<CXPRecord, 'nombre' | 'noProveedor'>): CXPRecord {
  return {
    cia: '00011',
    noFactura: 'F-1',
    fechaFactura: '2026-05-01',
    fechaVence: '2026-06-10',
    fechaProgramacionPago: '2026-06-10',
    diasVencida: 0,
    importeBrutoPesos: 1000,
    importePendientePesos: 1000,
    importeSubtotalPesos: 862,
    importeImpuestosPesos: 138,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '',
    clasifica: '',
    clasificacionProveedor: '',
    edoPago: '',
    tipoCambio: 1,
    porVencer: 0,
    v1_30: 0,
    v31_60: 0,
    v61_90: 0,
    v91_120: 0,
    v121_150: 0,
    v151_180: 0,
    mas180: 0,
    ...patch,
  };
}

describe('createQuickMovementAdjustment — action and default branches', () => {
  it('defaults the shift direction per movement type and falls back to the concept as entity', () => {
    const inflow = createQuickMovementAdjustment({
      movement: movement({ id: 'ar-1', type: 'INFLOW', category: 'AR_COLLECTION', projectedDate: '2026-06-20' }),
      scenarioId: 'draft-1',
      action: 'SHIFT_DATE',
      asOfDate: AS_OF,
    });
    const outflow = createQuickMovementAdjustment({
      movement: movement({ id: 'ap-1', type: 'OUTFLOW', category: 'AP_PAYMENT', projectedDate: '2026-06-20' }),
      scenarioId: 'draft-1',
      action: 'SHIFT_DATE',
      asOfDate: AS_OF,
    });

    expect(inflow).toMatchObject({ adjustedValue: '2026-06-13', deltaDays: -7 });
    expect(inflow.name).toBe('Mover cobro · Concepto ar-1');
    expect(outflow).toMatchObject({ adjustedValue: '2026-06-27', deltaDays: 7 });
    expect(outflow.name).toBe('Mover pago · Concepto ap-1');
    expect(inflow.createdBy).toBe('tesoreria@senda.local');
  });

  it('returns a zero delta when the target date cannot be parsed', () => {
    const shift = createQuickMovementAdjustment({
      movement: movement({ id: 'ar-2', type: 'INFLOW', category: 'AR_COLLECTION', counterpartyName: 'Cliente' }),
      scenarioId: 'draft-1',
      action: 'SHIFT_DATE',
      targetDate: 'sin-fecha',
      asOfDate: AS_OF,
      user: 'tester@senda.local',
    });
    expect(shift.deltaDays).toBe(0);
    expect(shift.createdBy).toBe('tester@senda.local');
  });

  it('defaults the override amount to the current effective amount and clamps negatives to zero', () => {
    const target = movement({ id: 'ap-2', type: 'OUTFLOW', category: 'AP_PAYMENT', projectedAmount: 900, counterpartyName: 'Proveedor' });
    const identity = createQuickMovementAdjustment({ movement: target, scenarioId: 'd', action: 'AMOUNT_OVERRIDE', asOfDate: AS_OF });
    const clamped = createQuickMovementAdjustment({ movement: target, scenarioId: 'd', action: 'AMOUNT_OVERRIDE', targetAmount: -500, asOfDate: AS_OF });

    expect(identity).toMatchObject({ adjustedValue: 900, deltaAmount: 0 });
    expect(clamped).toMatchObject({ adjustedValue: 0, deltaAmount: -900 });
  });

  it('builds split payments with a floor of two instalments', () => {
    const target = movement({ id: 'ap-3', type: 'OUTFLOW', category: 'AP_PAYMENT', counterpartyName: 'Proveedor' });
    const byDefault = createQuickMovementAdjustment({ movement: target, scenarioId: 'd', action: 'SPLIT_PAYMENT', asOfDate: AS_OF });
    const clamped = createQuickMovementAdjustment({ movement: target, scenarioId: 'd', action: 'SPLIT_PAYMENT', splitCount: 1, asOfDate: AS_OF });
    const explicit = createQuickMovementAdjustment({ movement: target, scenarioId: 'd', action: 'SPLIT_PAYMENT', splitCount: 4, asOfDate: AS_OF });

    expect(byDefault.type).toBe('SPLIT_PAYMENT');
    expect(byDefault.splitConfig).toEqual({ numberOfPayments: 2, frequency: 'BIWEEKLY' });
    expect(clamped.splitConfig?.numberOfPayments).toBe(2);
    expect(explicit.splitConfig?.numberOfPayments).toBe(4);
  });
});

describe('OPTIMISTIC template', () => {
  it('skips non-collection and locked movements and falls back to the concept', () => {
    const draft = draftFor('OPTIMISTIC', {
      movements: [
        movement({ id: 'opex', type: 'OUTFLOW', category: 'OPEX' }),
        movement({ id: 'inflow-otro', type: 'INFLOW', category: 'MANUAL' }),
        movement({ id: 'ar-locked', type: 'INFLOW', category: 'AR_COLLECTION', lockState: 'LOCKED' }),
        movement({ id: 'ar-real', type: 'INFLOW', category: 'AR_COLLECTION', status: 'REAL' }),
        movement({ id: 'ar-past', type: 'INFLOW', category: 'AR_COLLECTION', projectedDate: '2026-01-05' }),
        movement({ id: 'ar-ok', type: 'INFLOW', category: 'AR_COLLECTION', confidenceScore: 20 }),
      ],
    });

    expect(draft.adjustments.map((adjustment) => adjustment.targetExpression)).toEqual(['ar-ok', 'ar-ok']);
    expect(draft.entityImpacts.every((impact) => impact.entityName === 'Concepto ar-ok')).toBe(true);
    // (100 - 20) / 8 = 10 → capped at 10 days earlier.
    expect(draft.adjustments[0].adjustedValue).toBe('2026-06-10');
  });

  it('uses the singular wording when a template produces exactly one adjustment', () => {
    const draft = draftFor('CRITICAL_SUPPLIERS', {
      movements: [movement({ id: 'ap-only', type: 'OUTFLOW', category: 'AP_PAYMENT', counterpartyName: 'Proveedor Suelto' })],
    });
    expect(draft.adjustments).toHaveLength(1);
    expect(draft.changeLogEntry.autoDescription).toContain('1 ajuste ');
  });
});

describe('CONSERVATIVE template', () => {
  it('delays collections, pressures outflows and leaves transfers and locked rows alone', () => {
    const draft = draftFor('CONSERVATIVE', {
      movements: [
        movement({ id: 'ar-1', type: 'INFLOW', category: 'AR_COLLECTION', counterpartyName: 'Cliente Norte' }),
        // No counterparty → justifications fall back to the concept.
        movement({ id: 'ar-anonimo', type: 'INFLOW', category: 'AR_COLLECTION', projectedAmount: 1 }),
        movement({ id: 'ar-locked', type: 'INFLOW', category: 'AR_COLLECTION', lockState: 'LOCKED' }),
        movement({ id: 'transfer', type: 'OUTFLOW', category: 'TRANSFER' }),
        movement({ id: 'ap-locked', type: 'OUTFLOW', category: 'AP_PAYMENT', lockState: 'LOCKED' }),
        movement({ id: 'ap-1', type: 'OUTFLOW', category: 'AP_PAYMENT' }),
      ],
    });

    const byTarget = draft.adjustments.map((adjustment) => `${adjustment.targetExpression}:${adjustment.type}`);
    expect(byTarget).toEqual([
      'ar-1:DATE_SHIFT',
      'ar-1:PERCENTAGE_CHANGE',
      'ap-1:PERCENTAGE_CHANGE',
      'ar-anonimo:DATE_SHIFT',
      'ar-anonimo:PERCENTAGE_CHANGE',
    ]);
    expect(draft.adjustments[0].adjustedValue).toBe('2026-07-02');
    expect(draft.adjustments[2].justification).toContain('Concepto ap-1');
    expect(draft.adjustments[3].justification).toContain('Concepto ar-anonimo');
    expect(draft.adjustments[4].justification).toContain('Concepto ar-anonimo');
  });
});

describe('LIQUIDITY_OPTIMIZED template', () => {
  it('advances collections, splits large flexible payables and defers the rest', () => {
    const draft = draftFor('LIQUIDITY_OPTIMIZED', {
      movements: [
        movement({ id: 'ar-1', type: 'INFLOW', category: 'AR_COLLECTION', counterpartyName: 'Cliente Norte' }),
        // Non-collection inflow → isFlexibleOutflow rejects it outright.
        movement({ id: 'inflow-otro', type: 'INFLOW', category: 'MANUAL' }),
        movement({ id: 'ap-locked', type: 'OUTFLOW', category: 'AP_PAYMENT', lockState: 'LOCKED' }),
        movement({ id: 'tax', type: 'OUTFLOW', category: 'TAX' }),
        movement({ id: 'payroll', type: 'OUTFLOW', category: 'PAYROLL' }),
        movement({ id: 'transfer', type: 'OUTFLOW', category: 'TRANSFER' }),
        movement({ id: 'ap-critico', type: 'OUTFLOW', category: 'AP_PAYMENT', counterpartyName: 'Proveedor Critico' }),
        // No counterparty at all → treated as flexible.
        movement({ id: 'ap-sin-nombre', type: 'OUTFLOW', category: 'AP_PAYMENT', projectedAmount: 500 }),
        movement({ id: 'ap-grande', type: 'OUTFLOW', category: 'AP_PAYMENT', counterpartyName: 'Proveedor Flexible', projectedAmount: 1_500_000 }),
        // Large flexible payable with no counterparty → split, named from the concept.
        movement({ id: 'ap-grande-anonimo', type: 'OUTFLOW', category: 'AP_PAYMENT', projectedAmount: 1_200_000 }),
        // Collection with no counterparty → advance, justified with the concept.
        movement({ id: 'ar-anonimo', type: 'INFLOW', category: 'AR_COLLECTION', projectedAmount: 1 }),
      ],
      providers: [
        provider({ id: 'p-critico', name: 'Proveedor Critico', flexibility: 'inamovible' }),
        provider({ id: 'p-flex', name: 'Proveedor Flexible', flexibility: 'flexible' }),
      ],
    });

    const byTarget = draft.adjustments.map((adjustment) => `${adjustment.targetExpression}:${adjustment.type}`);
    // Same-day movements are ranked by descending amount, so the 1.5M payable leads.
    expect(byTarget).toEqual([
      'ap-grande:SPLIT_PAYMENT',
      'ap-grande-anonimo:SPLIT_PAYMENT',
      'ar-1:DATE_SHIFT',
      'ap-sin-nombre:DATE_SHIFT',
      'ar-anonimo:DATE_SHIFT',
    ]);
    expect(draft.adjustments[1].name).toBe('Dividir pago · Concepto ap-grande-anonimo');
    expect(draft.adjustments[2].adjustedValue).toBe('2026-06-15');
    expect(draft.adjustments[3].adjustedValue).toBe('2026-07-04');
    expect(draft.adjustments[4].justification).toContain('Concepto ar-anonimo');
    expect(draft.entityImpacts[0]).toMatchObject({ entityType: 'SUPPLIER', predictedDate: '2026-07-04' });
  });

  it('treats a restricted non-payable as flexible but a restricted payable as untouchable', () => {
    const draft = draftFor('LIQUIDITY_OPTIMIZED', {
      movements: [
        // Known non-flexible provider, RESTRICTED, AP_PAYMENT → every OR operand is false.
        movement({ id: 'ap-restringido', type: 'OUTFLOW', category: 'AP_PAYMENT', counterpartyName: 'Proveedor Normal', lockState: 'RESTRICTED' }),
        // Same provider/lock but an OPEX row → the category operand rescues it.
        movement({ id: 'opex-restringido', type: 'OUTFLOW', category: 'OPEX', counterpartyName: 'Proveedor Normal', lockState: 'RESTRICTED' }),
        // Known non-flexible provider but UNLOCKED → the lock operand rescues it.
        movement({ id: 'ap-abierto', type: 'OUTFLOW', category: 'AP_PAYMENT', counterpartyName: 'Proveedor Normal' }),
      ],
      providers: [provider({ id: 'p-normal', name: 'Proveedor Normal', clasificacionAlberto: 'FLEX_MEDIO' })],
    });

    expect(draft.adjustments.map((adjustment) => adjustment.targetExpression))
      .toEqual(['opex-restringido', 'ap-abierto']);
    expect(draft.entityImpacts[0].entityType).toBe('CATEGORY');
  });
});

describe('CRITICAL_SUPPLIERS template', () => {
  it('only defers non-critical outflows in the payable-like categories', () => {
    const draft = draftFor('CRITICAL_SUPPLIERS', {
      movements: [
        movement({ id: 'ar-1', type: 'INFLOW', category: 'AR_COLLECTION' }),
        movement({ id: 'tax', type: 'OUTFLOW', category: 'TAX' }),
        movement({ id: 'ap-critico-por-numero', type: 'OUTFLOW', category: 'AP_PAYMENT', counterpartyName: 'Nombre distinto', counterpartyId: '900' }),
        movement({ id: 'opex', type: 'OUTFLOW', category: 'OPEX' }),
        movement({ id: 'capex', type: 'OUTFLOW', category: 'CAPEX', counterpartyName: 'Proveedor Obra' }),
        movement({ id: 'ap-sin-nombre', type: 'OUTFLOW', category: 'AP_PAYMENT' }),
      ],
      providers: [provider({ id: 'p-critico', name: 'Proveedor Critico', risk: 'Alto', numProveedorJDE: '900' })],
      cxpRecords: [cxp({ nombre: 'Proveedor Critico', noProveedor: '900' })],
    });

    expect(draft.adjustments.map((adjustment) => adjustment.targetExpression))
      .toEqual(['opex', 'capex', 'ap-sin-nombre']);
    // OPEX/CAPEX land in the CATEGORY bucket; AP_PAYMENT in SUPPLIER.
    expect(draft.entityImpacts.map((impact) => impact.entityType)).toEqual(['CATEGORY', 'CATEGORY', 'SUPPLIER']);
    expect(draft.entityImpacts[2].entityName).toBe('Concepto ap-sin-nombre');
  });
});

describe('buildPredictionContext branches', () => {
  it('ignores unnamed providers and CXP rows missing a name or a supplier number', () => {
    const draft = draftFor('CRITICAL_SUPPLIERS', {
      movements: [
        movement({ id: 'ap-por-cxp', type: 'OUTFLOW', category: 'AP_PAYMENT', counterpartyName: 'Otro nombre', counterpartyId: '777' }),
        movement({ id: 'ap-libre', type: 'OUTFLOW', category: 'AP_PAYMENT', counterpartyName: 'Proveedor Libre' }),
      ],
      providers: [
        provider({ id: 'p-vacio', name: '   ' }),
        // Critical but without a JDE number of its own — the number comes from the CXP roster.
        provider({ id: 'p-critico', name: 'Proveedor Critico', clasificacionAutomatica: 'CRITICO' }),
        provider({ id: 'p-libre', name: 'Proveedor Libre', flexibility: 'flexible' }),
      ],
      cxpRecords: [
        cxp({ nombre: '   ', noProveedor: '111' }),
        cxp({ nombre: 'Sin numero', noProveedor: '  ' }),
        cxp({ nombre: 'Proveedor Critico', noProveedor: '777' }),
        // A second row for the same provider must not overwrite the first supplier number.
        cxp({ nombre: 'Proveedor Critico', noProveedor: '778' }),
      ],
    });

    expect(draft.adjustments.map((adjustment) => adjustment.targetExpression)).toEqual(['ap-libre']);
  });
});

describe('buildPredictionScenarioDrafts', () => {
  it('produces one draft per template', () => {
    const drafts = buildPredictionScenarioDrafts({
      movements: [movement({ id: 'ar-1', type: 'INFLOW', category: 'AR_COLLECTION', counterpartyName: 'Cliente' })],
      providers: [],
      clients: [],
      cxpRecords: [],
      assumptions,
      approvedScenario: approvedScenario(),
      asOfDate: AS_OF,
    });

    expect(drafts.map((draft) => draft.template)).toEqual([
      'OPTIMISTIC',
      'CONSERVATIVE',
      'LIQUIDITY_OPTIMIZED',
      'CRITICAL_SUPPLIERS',
    ]);
    expect(drafts.map((draft) => draft.title)).toEqual(['Optimista', 'Conservador', 'Liquidez', 'Críticos']);
    expect(drafts.every((draft) => draft.scenario.parentScenarioId === 'approved')).toBe(true);
  });
});
