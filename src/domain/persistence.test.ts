import { describe, expect, it, beforeEach } from 'vitest';
import { saveStore, loadStore, importStore, exportStore, getDefaultStore, clearStore } from './persistence';
import type { Proposal, Scenario } from '../types';

const prop: Proposal = {
  id: 'p1',
  name: 'Ahorro operativo',
  kind: 'expense_saving',
  amount: 10_000,
  startYearMonth: '2026-05',
  frequency: 'monthly',
  enabled: true,
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
};

const scen: Scenario = {
  id: 's1',
  name: 'Escenario con ahorro',
  proposalStates: { p1: true },
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
};

describe('persistence v5', () => {
  beforeEach(() => {
    clearStore();
  });

  it('round-trips proposals and scenarios through save/load', () => {
    const store = { ...getDefaultStore(), proposals: [prop], scenarios: [scen], activeScenarioId: 's1' };
    saveStore(store);
    const loaded = loadStore();
    expect(loaded).not.toBeNull();
    expect(loaded!.proposals).toHaveLength(1);
    expect(loaded!.proposals[0].name).toBe('Ahorro operativo');
    expect(loaded!.scenarios[0].proposalStates.p1).toBe(true);
    expect(loaded!.activeScenarioId).toBe('s1');
  });

  it('export/import round-trip', () => {
    const store = { ...getDefaultStore(), proposals: [prop], scenarios: [scen] };
    const json = exportStore(store);
    const imported = importStore(json);
    expect(imported.proposals).toHaveLength(1);
    expect(imported.scenarios).toHaveLength(1);
  });

  it('normalizes invalid proposals out', () => {
    const store = {
      ...getDefaultStore(),
      proposals: [prop, { id: 'bad', kind: 'nonsense' } as unknown as Proposal],
    };
    saveStore(store);
    const loaded = loadStore();
    expect(loaded!.proposals).toHaveLength(1);
    expect(loaded!.proposals[0].id).toBe('p1');
  });

  it('drops activeScenarioId when scenario no longer exists', () => {
    const store = { ...getDefaultStore(), proposals: [prop], scenarios: [], activeScenarioId: 's1' };
    saveStore(store);
    const loaded = loadStore();
    expect(loaded!.activeScenarioId).toBeNull();
  });

  it('migrates legacy v4 store: keeps clients/providers, drops proposals+scenarios', () => {
    clearStore();
    const legacyPayload = {
      version: 4,
      data: {
        plan: null,
        simulations: [{ id: 'legacy-sim' }],
        scenarios: [{ id: 'legacy-scen' }],
        proposals: [{ id: 'legacy-prop', category: 'ahorro' }],
        providers: [{ id: 'prov1', name: 'Prov' }],
        clients: [{ id: 'c1', name: 'Cliente' }],
        assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
        confirmedPayments: [],
        cxpRecords: [],
        lastSaved: '2026-04-01T00:00:00Z',
      },
    };
    localStorage.setItem('flowsense-v4', JSON.stringify(legacyPayload));

    const loaded = loadStore();
    expect(loaded).not.toBeNull();
    expect(loaded!.proposals).toHaveLength(0);
    expect(loaded!.scenarios).toHaveLength(0);
    expect(loaded!.clients).toHaveLength(1);
    expect(loaded!.providers).toHaveLength(1);
    expect(localStorage.getItem('flowsense-v4')).toBeNull();
  });

  it('returns a default store with empty lists', () => {
    const store = getDefaultStore();
    expect(store.proposals).toEqual([]);
    expect(store.scenarios).toEqual([]);
    expect(store.activeScenarioId).toBe(null);
  });
});
