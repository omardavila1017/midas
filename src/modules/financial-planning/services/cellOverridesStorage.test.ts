import { afterEach, describe, expect, it } from 'vitest';
import { loadCellOverrides, saveCellOverrides } from './cellOverridesStorage';
import type { CellOverride } from '../../shared-finance/types';

afterEach(() => localStorage.clear());

const sample: CellOverride = {
  id: 'co-1',
  scenarioId: 'draft-x',
  conceptKey: 'INFLOW:AR_COLLECTION:cfe',
  granularity: 'monthly',
  bucketKey: '2026-05-01',
  type: 'INFLOW',
  mode: 'REPLACE',
  value: 1_500_000,
  previousAggregatedValue: 1_200_000,
  createdBy: 'tester',
  createdAt: '2026-04-29T00:00:00Z',
  updatedAt: '2026-04-29T00:00:00Z',
};

describe('cellOverridesStorage', () => {
  it('roundtrips overrides through localStorage', () => {
    saveCellOverrides([sample]);
    const loaded = loadCellOverrides();
    expect(loaded.length).toBe(1);
    expect(loaded[0]).toMatchObject({
      id: 'co-1',
      scenarioId: 'draft-x',
      value: 1_500_000,
      granularity: 'monthly',
    });
  });

  it('drops invalid entries during normalization', () => {
    localStorage.setItem(
      'midas.financialPlanning.cellOverrides.v1',
      JSON.stringify([
        sample,
        { id: 'broken', scenarioId: '', value: NaN },
        null,
      ]),
    );
    const loaded = loadCellOverrides();
    expect(loaded.length).toBe(1);
    expect(loaded[0].id).toBe('co-1');
  });

  it('removes the storage key when saving an empty array', () => {
    saveCellOverrides([sample]);
    saveCellOverrides([]);
    expect(localStorage.getItem('midas.financialPlanning.cellOverrides.v1')).toBe(null);
  });
});
