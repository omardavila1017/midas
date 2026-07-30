import { describe, expect, it } from 'vitest';
import {
  applyAdjustmentsToMovements,
  calculateBaseProjection,
  calculateConfidenceBand,
  calculateMovementConfidence,
  calculateScenarioProjection,
  compareProjectionVsScenario,
} from './financialProjectionEngine';
import type { FinancialAdjustment, FinancialMovement, FinancialScenario } from '../types';

describe('financialProjectionEngine', () => {
  it('calculates daily cash balance from inflows and outflows', () => {
    const projection = calculateBaseProjection([
      movement('in-1', 'INFLOW', 'AR_COLLECTION', '2026-05-02', 1_000),
      movement('out-1', 'OUTFLOW', 'AP_PAYMENT', '2026-05-03', 400),
    ], options());

    expect(projection.buckets[0].closingCash).toBe(10_000);
    expect(projection.buckets[1].closingCash).toBe(11_000);
    expect(projection.buckets[2].closingCash).toBe(10_600);
    expect(projection.summary.finalCash).toBe(10_600);
  });

  it('shows signed projected cash while preserving the real liquidity shortfall', () => {
    const projection = calculateBaseProjection([
      movement('out-1', 'OUTFLOW', 'PAYROLL', '2026-05-02', 1_200),
      movement('out-2', 'OUTFLOW', 'TAX', '2026-05-03', 300),
    ], {
      startDate: '2026-05-01',
      endDate: '2026-05-03',
      initialCash: 1_000,
      minimumCash: 100,
      granularity: 'daily',
    });

    expect(projection.buckets[1].closingCash).toBe(-200);
    expect(projection.buckets[2].closingCash).toBe(-500);
    expect(projection.summary.minCash).toBe(-500);
    expect(projection.summary.deficitDays).toBe(2);
    expect(projection.summary.creditRequired).toBe(600);
  });

  describe('días en déficit', () => {
    // Caso real de Planeación (default mensual): la caja se hunde bajo el piso
    // el día 5 y se recupera el 20, así que el CIERRE del mes queda arriba del
    // piso. Contando por bucket el KPI salía 0 aunque hubo 15 días en déficit.
    const intraMonthTrough = () => [
      movement('out-1', 'OUTFLOW', 'AP_PAYMENT', '2026-05-05', 9_000),
      movement('in-1', 'INFLOW', 'AR_COLLECTION', '2026-05-20', 9_500),
    ];
    const monthlyWindow = {
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      initialCash: 10_000,
      minimumCash: 5_000,
      granularity: 'monthly' as const,
    };

    it('cuenta el hoyo intramensual que el cierre de mes esconde', () => {
      const projection = calculateBaseProjection(intraMonthTrough(), monthlyWindow);

      // Un solo bucket mensual, cerrando arriba del piso → sin déficit de cierre.
      expect(projection.buckets).toHaveLength(1);
      expect(projection.buckets[0].closingCash).toBe(10_500);
      expect(projection.buckets[0].deficit).toBe(0);
      // 05-may..19-may bajo el piso (caja 1,000) = 15 días.
      expect(projection.summary.deficitDays).toBe(15);
      expect(projection.summary.minCash).toBe(1_000);
      expect(projection.summary.maxRiskDate).toBe('2026-05-05');
      expect(projection.summary.creditRequired).toBe(4_000);
    });

    it('reporta días de calendario, no el mes completo, cuando el cierre también cae', () => {
      const projection = calculateBaseProjection([
        movement('out-1', 'OUTFLOW', 'AP_PAYMENT', '2026-05-29', 9_000),
      ], monthlyWindow);

      expect(projection.buckets[0].deficit).toBeGreaterThan(0);
      // 29, 30 y 31 de mayo — antes el bucket mensual contaba 1 (último bucket)
      // o el span completo del periodo.
      expect(projection.summary.deficitDays).toBe(3);
    });

    it('a granularidad diaria cuenta los buckets en déficit (respeta overrides)', () => {
      const projection = calculateBaseProjection([
        movement('out-1', 'OUTFLOW', 'PAYROLL', '2026-05-02', 6_000),
      ], options());

      expect(projection.summary.deficitDays).toBe(2);
    });

    it('sin déficit devuelve 0 y no inventa fecha crítica', () => {
      const projection = calculateBaseProjection([
        movement('in-1', 'INFLOW', 'AR_COLLECTION', '2026-05-10', 1_000),
      ], monthlyWindow);

      expect(projection.summary.deficitDays).toBe(0);
      expect(projection.summary.maxRiskDate).toBeUndefined();
      expect(projection.summary.creditRequired).toBe(0);
    });

    it('ignora movimientos fuera de la ventana', () => {
      const projection = calculateBaseProjection([
        movement('out-past', 'OUTFLOW', 'AP_PAYMENT', '2026-04-15', 9_000),
        movement('out-future', 'OUTFLOW', 'AP_PAYMENT', '2026-06-15', 9_000),
      ], monthlyWindow);

      expect(projection.summary.deficitDays).toBe(0);
    });
  });

  it('moves a movement date through a scenario adjustment without mutating the base', () => {
    const baseMovements = [movement('out-1', 'OUTFLOW', 'AP_PAYMENT', '2026-05-02', 1_000)];
    const adjusted = applyAdjustmentsToMovements(baseMovements, [
      adjustment('DATE_SHIFT', { adjustedValue: '2026-05-04' }),
    ], 'liquidity');

    expect(baseMovements[0].projectedDate).toBe('2026-05-02');
    expect(adjusted[0].adjustedDate).toBe('2026-05-04');
  });

  it('replaces movement amount through an amount override', () => {
    const adjusted = applyAdjustmentsToMovements([
      movement('in-1', 'INFLOW', 'AR_COLLECTION', '2026-05-02', 1_000),
    ], [
      adjustment('AMOUNT_OVERRIDE', { adjustedValue: 1_500 }),
    ], 'liquidity');

    expect(adjusted[0].adjustedAmount).toBe(1_500);
  });

  it('compares scenario projection against base projection', () => {
    const baseProjection = calculateBaseProjection([
      movement('in-1', 'INFLOW', 'AR_COLLECTION', '2026-05-02', 1_000),
    ], options());
    const scenario = scenarioModel('liquidity');
    const scenarioProjection = calculateScenarioProjection(baseProjection, scenario, [
      adjustment('AMOUNT_OVERRIDE', { adjustedValue: 2_000 }),
    ]);
    const comparison = compareProjectionVsScenario(baseProjection, scenarioProjection);

    expect(comparison.finalCashDelta).toBe(1_000);
    expect(comparison.totalInflowsDelta).toBe(1_000);
  });

  it('calculates confidence bands from score and inputs', () => {
    expect(calculateConfidenceBand(95)).toBe('CONFIRMED');
    expect(calculateConfidenceBand(80)).toBe('HIGH');
    expect(calculateConfidenceBand(65)).toBe('MEDIUM');
    expect(calculateConfidenceBand(45)).toBe('LOW');
    expect(calculateConfidenceBand(20)).toBe('EXPLORATORY');

    const confidence = calculateMovementConfidence({
      sourceSystem: 'JDE',
      forecastMethod: 'RULE',
      hasManualValidation: true,
      historyScore: 18,
      freshnessScore: 18,
    });
    expect(confidence.band).toBe('CONFIRMED');
  });
});

function options() {
  return {
    startDate: '2026-05-01',
    endDate: '2026-05-03',
    initialCash: 10_000,
    minimumCash: 5_000,
    granularity: 'daily' as const,
  };
}

function movement(
  id: string,
  type: FinancialMovement['type'],
  category: FinancialMovement['category'],
  projectedDate: string,
  amount: number,
): FinancialMovement {
  return {
    id,
    sourceSystem: 'FORECAST',
    type,
    category,
    concept: id,
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate,
    confidenceScore: 80,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  };
}

function adjustment(
  type: FinancialAdjustment['type'],
  overrides: Partial<FinancialAdjustment>,
): FinancialAdjustment {
  return {
    id: `adj-${type}`,
    name: type,
    scenarioIds: ['liquidity'],
    type,
    targetType: 'MOVEMENT',
    targetExpression: overrides.targetExpression ?? (type === 'AMOUNT_OVERRIDE' ? 'in-1' : 'out-1'),
    reasonCode: 'LIQUIDITY',
    justification: 'Test adjustment',
    status: 'DRAFT',
    createdBy: 'test',
    createdAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

function scenarioModel(id: string): FinancialScenario {
  return {
    id,
    name: 'Borrador test',
    kind: 'DRAFT',
    adjustmentIds: [],
    status: 'DRAFT',
    createdBy: 'test',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  };
}
