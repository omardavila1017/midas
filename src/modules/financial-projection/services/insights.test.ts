import { describe, expect, it } from 'vitest';
import { deriveInsights } from './insights';
import type { ProjectionSummary } from '../../shared-finance/types';

function summary(partial: Partial<ProjectionSummary>): ProjectionSummary {
  return {
    currentCash: 0,
    projectedCash7: 0,
    projectedCash30: 0,
    projectedCash90: 0,
    minimumCashRequired: 1_000_000,
    deficitDays: 0,
    averageConfidence: 0.9,
    totalInflows: 0,
    totalOutflows: 0,
    finalCash: 5_000_000,
    minCash: 2_000_000,
    creditRequired: 0,
    ...partial,
  };
}

describe('deriveInsights', () => {
  it('returns no observations for a healthy base scenario', () => {
    const insights = deriveInsights({
      active: summary({ minCash: 5_000_000, finalCash: 5_000_000 }),
      scenarioName: 'Escenario Base',
      isBaseScenario: true,
    });
    expect(insights.find((i) => i.id === 'cash-buffer')).toBeDefined();
    expect(insights.find((i) => i.id === 'variance-vs-approved')).toBeUndefined();
  });

  it('flags a critical cash trough when deficitDays > 0', () => {
    const insights = deriveInsights({
      active: summary({ deficitDays: 5, minCash: -200_000, maxRiskDate: '2026-08-15' }),
      scenarioName: 'Pesimista',
      isBaseScenario: false,
    });
    const trough = insights.find((i) => i.id === 'cash-trough');
    expect(trough).toBeDefined();
    expect(trough?.tone).toBe('critical');
  });

  it('reports positive variance vs approved', () => {
    const insights = deriveInsights({
      active: summary({ finalCash: 6_000_000, minCash: 3_000_000 }),
      approved: summary({ finalCash: 5_000_000 }),
      scenarioName: 'Optimista',
      isBaseScenario: false,
    });
    const variance = insights.find((i) => i.id === 'variance-vs-approved');
    expect(variance).toBeDefined();
    expect(variance?.tone).toBe('positive');
  });

  it('caps at 3 observations', () => {
    const insights = deriveInsights({
      active: summary({
        deficitDays: 2,
        minCash: -100,
        maxRiskDate: '2026-09-01',
        largestUpcomingOutflow: {
          id: 'm1', sourceSystem: 'JDE', type: 'OUTFLOW', category: 'AP_PAYMENT',
          concept: 'Pago grande', currency: 'MXN', originalAmount: 1_000_000, baseAmount: 1_000_000,
          projectedAmount: 1_000_000, projectedDate: '2026-08-20', confidenceScore: 0.9,
          confidenceBand: 'HIGH', forecastMethod: 'BASE',
        } as never,
      }),
      approved: summary({ finalCash: 2_000_000 }),
      scenarioName: 'Estrés',
      isBaseScenario: false,
    });
    expect(insights.length).toBeLessThanOrEqual(3);
  });
});
