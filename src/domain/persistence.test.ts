import { describe, expect, it } from 'vitest';
import { importStore, getDefaultStore } from './persistence';
import { createTestPlan } from '../test/fixtures';

describe('persistence (v4)', () => {
  it('loads a v4 payload and normalizes it', () => {
    const plan = createTestPlan();
    const v4Json = JSON.stringify({
      version: 4,
      data: {
        plan,
        simulations: [],
        scenarios: [],
        proposals: [
          {
            id: 'proposal-v4',
            name: 'Ahorro operativo',
            description: 'Reduce 50 al mes',
            category: 'ahorro',
            amount: 50,
            frequency: 'monthly',
            startDate: '2026-01-01',
            endDate: '2026-12-31',
            effects: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        scenarioCellOverrides: [],
        activeSimulationId: null,
        activeScenarioId: null,
        providers: [],
        clients: [],
        assumptions: {
          year: 2026,
          globalCompliance: 1,
          factorajeDays: 30,
        },
        confirmedPayments: [],
        cxpRecords: [],
        lastSaved: '2026-01-03T00:00:00.000Z',
      },
    });

    const store = importStore(v4Json);

    expect(store.proposals).toHaveLength(1);
    expect(store.proposals[0].category).toBe('ahorro');
    expect(store.proposals[0].amount).toBe(50);
    expect(store.activeScenarioId).toBe(null);
  });

  it('returns a default store with empty lists', () => {
    const store = getDefaultStore();
    expect(store.proposals).toEqual([]);
    expect(store.scenarios).toEqual([]);
    expect(store.simulations).toEqual([]);
    expect(store.activeScenarioId).toBe(null);
  });
});
