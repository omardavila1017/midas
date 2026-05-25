import { beforeEach, describe, expect, it } from 'vitest';
import type { FinancialProjectionSourceData, FinancialProjectionSourceInput } from './financialProjectionService';
import {
  __clearFinancialProjectionPersistentCacheForTests,
  loadProjectionSourceFromPersistentCache,
  saveProjectionSourceToPersistentCache,
} from './financialProjectionPersistentCache';

describe('financialProjectionPersistentCache', () => {
  beforeEach(() => {
    localStorage.clear();
    __clearFinancialProjectionPersistentCacheForTests();
  });

  it('roundtrips projection source data without storing the payload in localStorage', async () => {
    const input = projectionInput({ startingBalance: 10_000 });
    const source = projectionSource('heavy-source-marker');

    saveProjectionSourceToPersistentCache(input, source);

    await expect(loadProjectionSourceFromPersistentCache(input)).resolves.toEqual(source);
    expect(allLocalStorageText()).not.toContain('heavy-source-marker');
  });

  it('misses when a source fingerprint changes', async () => {
    const input = projectionInput({ startingBalance: 10_000 });
    saveProjectionSourceToPersistentCache(input, projectionSource('cached'));

    await expect(loadProjectionSourceFromPersistentCache(projectionInput({ startingBalance: 20_000 }))).resolves.toBeNull();
  });

  it('returns null when IndexedDB has no saved metadata', async () => {
    await expect(loadProjectionSourceFromPersistentCache(projectionInput({ startingBalance: 10_000 }))).resolves.toBeNull();
  });
});

function projectionInput(patch: Partial<FinancialProjectionSourceInput>): FinancialProjectionSourceInput {
  return {
    companyCode: 'all',
    bankStatements: [],
    clients: [],
    providers: [],
    cxpRecords: [],
    assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
    budget: null,
    startingBalance: patch.startingBalance ?? 0,
    asOfDate: '2026-05-18',
  };
}

function projectionSource(marker: string): FinancialProjectionSourceData {
  return {
    movements: [{
      id: 'm-1',
      sourceSystem: 'FORECAST',
      type: 'INFLOW',
      category: 'AR_COLLECTION',
      counterpartyType: 'CUSTOMER',
      concept: marker,
      currency: 'MXN',
      originalAmount: 1,
      baseAmount: 1,
      projectedAmount: 1,
      projectedDate: '2026-05-18',
      confidenceScore: 80,
      confidenceBand: 'HIGH',
      forecastMethod: 'RULE',
      status: 'PROJECTED_BASE',
      lockState: 'UNLOCKED',
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
    }],
    scenarios: [],
    adjustments: [],
    suppliers: [],
    customers: [],
    canonical: {
      monthly: [],
      movements: [],
      initialCash: 0,
      fromYearMonth: '2026-05',
      toYearMonth: '2026-05',
      predictive: null,
    },
    paidPurchaseOrderKeys: new Set(),
    hasData: true,
  };
}

function allLocalStorageText(): string {
  const parts: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    parts.push(key, localStorage.getItem(key) ?? '');
  }
  return parts.join('\n');
}
