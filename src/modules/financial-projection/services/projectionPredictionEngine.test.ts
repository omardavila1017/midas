import { describe, expect, it } from 'vitest';
import type { CXPRecord } from '../../../domain/persistence';
import type { Client, Provider, CashFlowAssumptions } from '../../../domain/types';
import type { FinancialMovement, FinancialScenario } from '../../shared-finance/types';
import {
  buildPredictionScenarioDraft,
  createQuickMovementAdjustment,
} from './projectionPredictionEngine';

describe('projectionPredictionEngine', () => {
  it('generates optimistic detailed adjustments by client instead of generic monthly totals', () => {
    const draft = buildPredictionScenarioDraft({
      template: 'OPTIMISTIC',
      movements: [
        movement({
          id: 'ar-1',
          type: 'INFLOW',
          category: 'AR_COLLECTION',
          counterpartyName: 'Cliente Norte',
          projectedDate: '2026-06-20',
          projectedAmount: 1000,
        }),
        movement({
          id: 'ar-2',
          type: 'INFLOW',
          category: 'AR_COLLECTION',
          counterpartyName: 'Cliente Sur',
          projectedDate: '2026-06-22',
          projectedAmount: 2000,
        }),
      ],
      providers: [],
      clients: [client('Cliente Norte'), client('Cliente Sur')],
      cxpRecords: [],
      assumptions,
      approvedScenario: approvedScenario(),
      asOfDate: '2026-06-01',
    });

    expect(draft.scenario.kind).toBe('DRAFT');
    expect(draft.adjustments.length).toBeGreaterThanOrEqual(4);
    expect(draft.adjustments.every((adjustment) => adjustment.targetType === 'MOVEMENT')).toBe(true);
    expect(draft.entityImpacts.map((impact) => impact.entityName)).toContain('Cliente Norte');
    expect(draft.entityImpacts.map((impact) => impact.entityName)).toContain('Cliente Sur');
    expect(draft.entityImpacts.every((impact) => impact.entityType === 'CLIENT')).toBe(true);
  });

  it('generates supplier-level conservative and optimized scenarios', () => {
    const flexiblePayment = movement({
      id: 'ap-flex',
      type: 'OUTFLOW',
      category: 'AP_PAYMENT',
      counterpartyName: 'Proveedor Flexible',
      projectedDate: '2026-06-10',
      projectedAmount: 1_500_000,
      lockState: 'UNLOCKED',
    });
    const conservative = buildPredictionScenarioDraft({
      template: 'CONSERVATIVE',
      movements: [flexiblePayment],
      providers: [provider('Proveedor Flexible', 'flexible')],
      clients: [],
      cxpRecords: [cxp('Proveedor Flexible')],
      assumptions,
      approvedScenario: approvedScenario(),
      asOfDate: '2026-06-01',
    });
    const liquidity = buildPredictionScenarioDraft({
      template: 'LIQUIDITY_OPTIMIZED',
      movements: [flexiblePayment],
      providers: [provider('Proveedor Flexible', 'flexible')],
      clients: [],
      cxpRecords: [cxp('Proveedor Flexible')],
      assumptions,
      approvedScenario: approvedScenario(),
      asOfDate: '2026-06-01',
    });

    expect(conservative.adjustments.some((adjustment) => adjustment.type === 'PERCENTAGE_CHANGE')).toBe(true);
    expect(liquidity.adjustments.some((adjustment) => adjustment.type === 'SPLIT_PAYMENT')).toBe(true);
    expect(liquidity.entityImpacts[0]).toMatchObject({
      entityType: 'SUPPLIER',
      entityName: 'Proveedor Flexible',
    });
  });

  it('does not move critical suppliers in the critical-supplier scenario', () => {
    const critical = movement({
      id: 'ap-critical',
      type: 'OUTFLOW',
      category: 'AP_PAYMENT',
      counterpartyName: 'Proveedor Critico',
      projectedDate: '2026-06-10',
      projectedAmount: 1_000_000,
      lockState: 'LOCKED',
    });
    const flexible = movement({
      id: 'ap-flex',
      type: 'OUTFLOW',
      category: 'AP_PAYMENT',
      counterpartyName: 'Proveedor Flexible',
      projectedDate: '2026-06-10',
      projectedAmount: 900_000,
      lockState: 'UNLOCKED',
    });

    const draft = buildPredictionScenarioDraft({
      template: 'CRITICAL_SUPPLIERS',
      movements: [critical, flexible],
      providers: [
        provider('Proveedor Critico', 'inamovible'),
        provider('Proveedor Flexible', 'flexible'),
      ],
      clients: [],
      cxpRecords: [cxp('Proveedor Critico'), cxp('Proveedor Flexible')],
      assumptions,
      approvedScenario: approvedScenario(),
      asOfDate: '2026-06-01',
    });

    expect(draft.adjustments.some((adjustment) => adjustment.targetExpression === 'ap-critical')).toBe(false);
    expect(draft.adjustments.some((adjustment) => adjustment.targetExpression === 'ap-flex')).toBe(true);
  });

  it('only protects supplier numbers that belong to critical providers', () => {
    const criticalByNumber = movement({
      id: 'ap-critical-number',
      type: 'OUTFLOW',
      category: 'AP_PAYMENT',
      counterpartyName: 'Pago proveedor 900',
      sourceObjectId: '900',
      projectedDate: '2026-06-10',
      projectedAmount: 1_000_000,
      lockState: 'UNLOCKED',
    });
    const flexibleByNumber = movement({
      id: 'ap-flex-number',
      type: 'OUTFLOW',
      category: 'AP_PAYMENT',
      counterpartyName: 'Pago proveedor 901',
      sourceObjectId: '901',
      projectedDate: '2026-06-10',
      projectedAmount: 900_000,
      lockState: 'UNLOCKED',
    });

    const draft = buildPredictionScenarioDraft({
      template: 'CRITICAL_SUPPLIERS',
      movements: [criticalByNumber, flexibleByNumber],
      providers: [
        provider('Proveedor Critico', 'inamovible', '900'),
        provider('Proveedor Flexible', 'flexible', '901'),
      ],
      clients: [],
      cxpRecords: [
        cxp('Proveedor Critico', '900'),
        cxp('Proveedor Flexible', '901'),
      ],
      assumptions,
      approvedScenario: approvedScenario(),
      asOfDate: '2026-06-01',
    });

    expect(draft.adjustments.some((adjustment) => adjustment.targetExpression === 'ap-critical-number')).toBe(false);
    expect(draft.adjustments.some((adjustment) => adjustment.targetExpression === 'ap-flex-number')).toBe(true);
  });

  it('creates quick movement adjustments for projection edits', () => {
    const target = movement({
      id: 'ar-quick',
      type: 'INFLOW',
      category: 'AR_COLLECTION',
      counterpartyName: 'Cliente Quick',
      projectedDate: '2026-06-20',
      projectedAmount: 1000,
    });

    const shift = createQuickMovementAdjustment({
      movement: target,
      scenarioId: 'draft-1',
      action: 'SHIFT_DATE',
      targetDate: '2026-06-12',
      asOfDate: '2026-06-01',
    });
    const amount = createQuickMovementAdjustment({
      movement: target,
      scenarioId: 'draft-1',
      action: 'AMOUNT_OVERRIDE',
      targetAmount: 1200,
      asOfDate: '2026-06-01',
    });

    expect(shift).toMatchObject({
      type: 'DATE_SHIFT',
      targetExpression: 'ar-quick',
      adjustedValue: '2026-06-12',
    });
    expect(amount).toMatchObject({
      type: 'AMOUNT_OVERRIDE',
      targetExpression: 'ar-quick',
      adjustedValue: 1200,
    });
  });
});

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

function client(name: string): Client {
  return {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 30,
    monthlyBilling: Array.from({ length: 12 }, () => 1000),
    complianceRate: 0.85,
  };
}

function provider(name: string, flexibility: Provider['flexibility'], numProveedorJDE?: string): Provider {
  return {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    name,
    type: 'Operación',
    risk: flexibility === 'inamovible' ? 'Alto' : 'Bajo',
    paymentPeriod: '30 días',
    flexibility,
    clasificacionAlberto: flexibility === 'inamovible' ? 'CRITICO' : 'FLEX_BAJO',
    numProveedorJDE,
  };
}

function cxp(name: string, noProveedor = name.toLowerCase().replace(/\s+/g, '-')): CXPRecord {
  return {
    cia: '00011',
    noProveedor,
    nombre: name,
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
  };
}

function movement(input: Partial<FinancialMovement> & Pick<FinancialMovement, 'id' | 'type' | 'category' | 'counterpartyName' | 'projectedDate' | 'projectedAmount'>): FinancialMovement {
  const {
    id,
    type,
    category,
    counterpartyName,
    projectedDate,
    projectedAmount,
    ...patch
  } = input;
  return {
    id,
    sourceSystem: patch.sourceSystem ?? 'FORECAST',
    type,
    category,
    counterpartyName,
    concept: patch.concept ?? counterpartyName ?? id,
    currency: 'MXN',
    originalAmount: patch.originalAmount ?? projectedAmount,
    baseAmount: patch.baseAmount ?? projectedAmount,
    projectedAmount,
    projectedDate,
    confidenceScore: patch.confidenceScore ?? 75,
    confidenceBand: patch.confidenceBand ?? 'HIGH',
    forecastMethod: patch.forecastMethod ?? 'RULE',
    status: patch.status ?? 'PROJECTED_BASE',
    lockState: patch.lockState ?? 'UNLOCKED',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...patch,
  };
}
