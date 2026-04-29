import { describe, expect, it } from 'vitest';
import { calculateBaseProjection } from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialMovement } from '../../shared-finance/types';
import {
  buildTaxPeriodRows,
  createTaxAdjustmentEntry,
} from './taxPlanningService';

describe('taxPlanningService', () => {
  it('calculates hybrid IVA from classified movements and manual adjustments', () => {
    const projection = calculateBaseProjection([
      movement('in-1', 'INFLOW', 'AR_COLLECTION', '2026-05-05', 1160),
      movement('out-1', 'OUTFLOW', 'AP_PAYMENT', '2026-05-06', 580),
      movement('tax-paid', 'OUTFLOW', 'TAX', '2026-05-17', 50),
    ], {
      startDate: '2026-05-01',
      endDate: '2026-06-30',
      initialCash: 10_000,
      minimumCash: 1_000,
      granularity: 'daily',
    });
    const rows = buildTaxPeriodRows(projection, [
      createTaxAdjustmentEntry({
        period: '2026-05',
        kind: 'IVA_PAYABLE',
        amount: 10,
      }),
    ]);

    const may = rows.find((row) => row.period === '2026-05');
    expect(may?.ivaCaused).toBeCloseTo(185.6);
    expect(may?.ivaCreditable).toBeCloseTo(92.8);
    expect(may?.ivaPaid).toBe(50);
    expect(may?.payable).toBeCloseTo(52.8);
    expect(may?.suggestedDate).toBe('2026-06-17');
  });

  it('keeps unclassified manual movements out of IVA estimate', () => {
    const projection = calculateBaseProjection([
      movement('manual-in', 'INFLOW', 'MANUAL', '2026-05-05', 1000, 'UNCLASSIFIED'),
    ], {
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      initialCash: 10_000,
      minimumCash: 1_000,
      granularity: 'daily',
    });
    const [row] = buildTaxPeriodRows(projection, []);

    expect(row.taxableInflows).toBe(0);
    expect(row.unclassifiedInflows).toBe(1000);
    expect(row.payable).toBe(0);
  });
});

function movement(
  id: string,
  type: FinancialMovement['type'],
  category: FinancialMovement['category'],
  projectedDate: string,
  amount: number,
  taxTreatment?: FinancialMovement['taxTreatment'],
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
    taxTreatment,
    confidenceScore: 80,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  };
}
