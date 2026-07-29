import { describe, expect, it } from 'vitest';
import { calculateBaseProjection } from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialAdjustment, FinancialMovement } from '../../shared-finance/types';
import {
  createFinancialAdjustment,
  previewAdjustmentImpact,
  scenarioUsesMovement,
  type FinancialAdjustmentInput,
} from './financialPlanningService';

function movement(patch: Partial<FinancialMovement> = {}): FinancialMovement {
  return {
    id: 'mov-in-1',
    sourceSystem: 'FORECAST',
    type: 'INFLOW',
    category: 'AR_COLLECTION',
    counterpartyType: 'CUSTOMER',
    concept: 'Cobranza cliente',
    currency: 'MXN',
    originalAmount: 10_000,
    baseAmount: 10_000,
    projectedAmount: 10_000,
    projectedDate: '2026-03-10',
    confidenceScore: 80,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...patch,
  };
}

function adjustmentInput(patch: Partial<FinancialAdjustmentInput> = {}): FinancialAdjustmentInput {
  return {
    name: 'Subir cobranza',
    scenarioIds: ['draft-1'],
    type: 'AMOUNT_DELTA',
    targetType: 'MOVEMENT',
    targetExpression: 'mov-in-1',
    reasonCode: 'FORECAST_CORRECTION',
    justification: 'Cliente confirmó pago adicional de $5,000.',
    deltaAmount: 5_000,
    ...patch,
  };
}

describe('createFinancialAdjustment', () => {
  it('lanza si la justificación viene vacía o en blanco', () => {
    expect(() => createFinancialAdjustment(adjustmentInput({ justification: '' })))
      .toThrow(/justificación es obligatoria/);
    expect(() => createFinancialAdjustment(adjustmentInput({ justification: '   ' })))
      .toThrow(/justificación es obligatoria/);
  });

  it('crea un ajuste DRAFT con los campos del input y metadatos generados', () => {
    const adj = createFinancialAdjustment(adjustmentInput());
    expect(adj.id).toMatch(/^adj-/);
    expect(adj.name).toBe('Subir cobranza');
    expect(adj.scenarioIds).toEqual(['draft-1']);
    expect(adj.type).toBe('AMOUNT_DELTA');
    expect(adj.targetType).toBe('MOVEMENT');
    expect(adj.targetExpression).toBe('mov-in-1');
    expect(adj.deltaAmount).toBe(5_000);
    expect(adj.reasonCode).toBe('FORECAST_CORRECTION');
    expect(adj.status).toBe('DRAFT');
    expect(adj.createdBy).toBe('analyst@senda.local');
    expect(() => new Date(adj.createdAt).toISOString()).not.toThrow();
  });

  it('aplica defaults: nombre en blanco → "Ajuste financiero", scenarioIds vacío → ["custom"]', () => {
    const adj = createFinancialAdjustment(adjustmentInput({ name: '   ', scenarioIds: [] }));
    expect(adj.name).toBe('Ajuste financiero');
    expect(adj.scenarioIds).toEqual(['custom']);
  });

  it('trimmea nombre y justificación; respeta createdBy explícito', () => {
    const adj = createFinancialAdjustment(adjustmentInput({
      name: '  Diferir pago  ',
      justification: '  Se negoció prórroga de 30 días.  ',
      createdBy: 'romo@senda.local',
    }));
    expect(adj.name).toBe('Diferir pago');
    expect(adj.justification).toBe('Se negoció prórroga de 30 días.');
    expect(adj.createdBy).toBe('romo@senda.local');
  });

  it('genera ids distintos por ajuste', () => {
    const a = createFinancialAdjustment(adjustmentInput());
    const b = createFinancialAdjustment(adjustmentInput());
    expect(a.id).not.toBe(b.id);
  });
});

describe('scenarioUsesMovement', () => {
  const movements = [
    movement(),
    movement({ id: 'mov-2', sourceObjectId: 'jde:factura:777' }),
  ];

  it('targetType distinto de MOVEMENT siempre aplica', () => {
    const adj = createFinancialAdjustment(adjustmentInput({ targetType: 'CATEGORY', targetExpression: 'AP_PAYMENT' }));
    expect(scenarioUsesMovement([], adj)).toBe(true);
  });

  it('MOVEMENT cruza por id del movimiento', () => {
    const adj = createFinancialAdjustment(adjustmentInput({ targetExpression: 'mov-in-1' }));
    expect(scenarioUsesMovement(movements, adj)).toBe(true);
  });

  it('MOVEMENT cruza también por sourceObjectId', () => {
    const adj = createFinancialAdjustment(adjustmentInput({ targetExpression: 'jde:factura:777' }));
    expect(scenarioUsesMovement(movements, adj)).toBe(true);
  });

  it('sin cruce regresa false', () => {
    const adj = createFinancialAdjustment(adjustmentInput({ targetExpression: 'mov-inexistente' }));
    expect(scenarioUsesMovement(movements, adj)).toBe(false);
  });
});

describe('previewAdjustmentImpact', () => {
  const baseMovements = [
    movement(),
    movement({ id: 'mov-out-1', type: 'OUTFLOW', category: 'AP_PAYMENT', counterpartyType: 'SUPPLIER', concept: 'Pago proveedor', originalAmount: 4_000, baseAmount: 4_000, projectedAmount: 4_000, projectedDate: '2026-03-15' }),
  ];
  const baseProjection = calculateBaseProjection(baseMovements, {
    startDate: '2026-03-01',
    endDate: '2026-03-31',
    initialCash: 50_000,
    minimumCash: 0,
    granularity: 'monthly',
    scenarioId: 'base',
  });

  function draftAdjustment(patch: Partial<FinancialAdjustment> = {}): FinancialAdjustment {
    return { ...createFinancialAdjustment(adjustmentInput({ scenarioIds: ['draft-1'] })), ...patch };
  }

  it('un AMOUNT_DELTA sobre un ingreso sube inflows y caja final por el delta exacto', () => {
    const comparison = previewAdjustmentImpact(baseProjection, draftAdjustment(), 'draft-1');
    expect(comparison.totalInflowsDelta).toBe(5_000);
    expect(comparison.totalOutflowsDelta).toBe(0);
    expect(comparison.finalCashDelta).toBe(5_000);
    expect(comparison.scenarioId).toBe('draft-1');
  });

  it('un CANCEL_MOVEMENT sobre el egreso elimina su salida de la proyección', () => {
    const cancel = draftAdjustment({ type: 'CANCEL_MOVEMENT', targetExpression: 'mov-out-1', deltaAmount: undefined });
    const comparison = previewAdjustmentImpact(baseProjection, cancel, 'draft-1');
    expect(comparison.totalOutflowsDelta).toBe(-4_000);
    expect(comparison.finalCashDelta).toBe(4_000);
  });

  it('un ajuste cuyo scenarioIds NO incluye el escenario no cambia nada', () => {
    const foreign = draftAdjustment({ scenarioIds: ['otro-escenario'] });
    const comparison = previewAdjustmentImpact(baseProjection, foreign, 'draft-1');
    expect(comparison.totalInflowsDelta).toBe(0);
    expect(comparison.totalOutflowsDelta).toBe(0);
    expect(comparison.finalCashDelta).toBe(0);
  });

  it('preserva la caja inicial del run base (openingCash del primer bucket)', () => {
    const comparison = previewAdjustmentImpact(baseProjection, draftAdjustment(), 'draft-1');
    // Base: 50,000 + 10,000 − 4,000 = 56,000. Ajustado: +5,000 → 61,000.
    expect(comparison.finalCash).toBe(61_000);
  });
});
