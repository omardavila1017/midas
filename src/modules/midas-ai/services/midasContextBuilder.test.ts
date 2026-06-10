import { describe, expect, it } from 'vitest';
import { buildMidasContext } from './midasContextBuilder';
import { buildContextBlock } from './midasPromptTemplates';
import type { ForecastRun } from '../../shared-finance/types';

function makeRun(): ForecastRun {
  return {
    id: 'run-1',
    name: 'Run',
    scenarioId: 'draft-1',
    status: 'SIMULATED',
    granularity: 'monthly',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    generatedAt: '2026-06-10T00:00:00Z',
    movements: [
      {
        id: 'cxc:1',
        type: 'INFLOW',
        category: 'AR_COLLECTION',
        concept: 'Factura 123',
        projectedAmount: 1_000_000,
        projectedDate: '2026-06-20',
        counterpartyName: 'CLIENTE UNO',
        counterpartyId: 'c1',
      },
      {
        id: 'cxp:1',
        type: 'OUTFLOW',
        category: 'AP_PAYMENT',
        concept: 'Pago diesel',
        projectedAmount: 400_000,
        projectedDate: '2026-06-25',
        counterpartyName: 'PROVEEDOR DIESEL',
        counterpartyId: 'p1',
      },
    ] as ForecastRun['movements'],
    buckets: [
      {
        date: '2026-05-01', label: 'May 2026', openingCash: 1_000_000, inflows: 5_000_000, outflows: 4_000_000,
        net: 1_000_000, closingCash: 2_000_000, minimumCash: 500_000, deficit: 0, confidenceScore: 0.9,
        movementIds: [], alertIds: [],
      },
      {
        date: '2026-06-01', label: 'Jun 2026', openingCash: 2_000_000, inflows: 3_000_000, outflows: 6_500_000,
        net: -3_500_000, closingCash: -1_500_000, minimumCash: 500_000, deficit: 2_000_000, confidenceScore: 0.8,
        movementIds: [], alertIds: [],
      },
    ],
    summary: {
      currentCash: 1_000_000,
      projectedCash7: 900_000,
      projectedCash30: -1_500_000,
      projectedCash90: 0,
      minimumCashRequired: 500_000,
      deficitDays: 12,
      averageConfidence: 0.85,
      totalInflows: 8_000_000,
      totalOutflows: 10_500_000,
      finalCash: -1_500_000,
      minCash: -1_500_000,
      creditRequired: 2_000_000,
    },
    alerts: [
      { id: 'a1', date: '2026-06-15', severity: 'INFO', title: 'Cobro grande', description: 'Entra CLIENTE UNO.' },
      { id: 'a2', date: '2026-06-25', severity: 'CRITICAL', title: 'Caja negativa', description: 'La caja cruza cero el 25.' },
    ],
  };
}

describe('buildMidasContext', () => {
  const ctx = buildMidasContext({
    cia: '00001',
    asOfDate: '2026-06-10',
    activeRun: makeRun(),
    providers: [],
    adjustments: [],
    activeScenarioId: 'draft-1',
    activeScenarioKind: 'DRAFT',
  });

  it('exposes the per-period series from the run buckets', () => {
    expect(ctx.buckets).toHaveLength(2);
    expect(ctx.buckets[1]).toMatchObject({ label: 'Jun 2026', net: -3_500_000, deficit: 2_000_000 });
  });

  it('exposes engine alerts sorted by severity (CRITICAL first)', () => {
    expect(ctx.alerts.map((a) => a.severity)).toEqual(['CRITICAL', 'INFO']);
  });

  it('buildContextBlock emits seriePorPeriodo and alertasDelMotor sections', () => {
    const block = buildContextBlock(ctx);
    expect(block).toContain('seriePorPeriodo (2 periodos');
    expect(block).toContain('Jun 2026 (2026-06-01)');
    expect(block).toContain('DEFICIT=');
    expect(block).toContain('alertasDelMotor (2');
    expect(block).toContain('[CRITICAL] 2026-06-25 | Caja negativa');
  });
});
