import { describe, expect, it } from 'vitest';
import { calculateBaseProjection } from './financialProjectionEngine';
import type { FinancialMovement } from '../types';

// Operational proof under production load: the bucket engine that used to OOM
// ("Aw Snap code 5") on the month→week→day flip must process production-scale
// movement volumes without crashing, and the F1.8 bounded daily window must
// keep that work cheap. Deterministic, CI-permanent — no JDE / no real data.

function makeMovements(n: number, baseIso: string, spanDays: number): FinancialMovement[] {
  const base = Date.parse(`${baseIso}T00:00:00Z`);
  const out: FinancialMovement[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const d = new Date(base + (i % spanDays) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const inflow = i % 2 === 0;
    out[i] = {
      id: `vol:${i}`,
      sourceSystem: 'JDE',
      type: inflow ? 'INFLOW' : 'OUTFLOW',
      category: inflow ? 'AR_COLLECTION' : 'AP_PAYMENT',
      concept: 'volume-test',
      currency: 'MXN',
      originalAmount: 1000 + (i % 7000),
      baseAmount: 1000 + (i % 7000),
      projectedAmount: 1000 + (i % 7000),
      projectedDate: d,
      confidenceScore: 60,
      confidenceBand: 'MEDIUM',
      forecastMethod: 'STATISTICAL',
      status: 'PROJECTED_BASE',
      lockState: 'UNLOCKED',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }
  return out;
}

describe('calculateBaseProjection — production volume', () => {
  // ~100k movements ≈ a real 2-year canonical source for several companies.
  const movements = makeMovements(100_000, '2026-01-01', 730);

  it('daily granularity, bounded window (F1.8) — no crash, fast', () => {
    const t0 = performance.now();
    const run = calculateBaseProjection(movements, {
      startDate: '2026-05-04',
      endDate: '2026-08-02', // ≈ 90 days — the bounded daily window
      initialCash: 5_000_000,
      minimumCash: 1_000_000,
      granularity: 'daily',
      scenarioId: 'base',
    });
    const ms = performance.now() - t0;
    expect(run.buckets.length).toBeGreaterThan(0);
    expect(run.buckets.length).toBeLessThanOrEqual(100);
    expect(Number.isFinite(run.buckets[run.buckets.length - 1].closingCash)).toBe(true);
    // Generous CI-safe ceiling; locally this is tens of ms.
    expect(ms).toBeLessThan(4000);
  });

  it('daily granularity, OLD unbounded full-year window — still completes (no OOM/throw)', () => {
    // The pre-F1.8 worst case. Must not throw or hang even at 100k × 365.
    const run = calculateBaseProjection(movements, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      initialCash: 5_000_000,
      minimumCash: 1_000_000,
      granularity: 'daily',
      scenarioId: 'base',
    });
    expect(run.buckets.length).toBeGreaterThan(360);
    expect(run.buckets.every((b) => Number.isFinite(b.closingCash))).toBe(true);
  });

  it('monthly granularity over 2 years — bounded buckets', () => {
    const run = calculateBaseProjection(movements, {
      startDate: '2026-01-01',
      endDate: '2027-12-31',
      initialCash: 5_000_000,
      minimumCash: 1_000_000,
      granularity: 'monthly',
      scenarioId: 'base',
    });
    expect(run.buckets.length).toBeLessThanOrEqual(24);
  });
});
