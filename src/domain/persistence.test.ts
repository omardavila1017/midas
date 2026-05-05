import { describe, expect, it, beforeEach } from 'vitest';
import { saveStore, loadStore, importStore, exportStore, getDefaultStore, clearStore } from './persistence';

describe('persistence v8', () => {
  beforeEach(() => {
    clearStore();
  });

  it('round-trips catalogs and assumptions through save/load', () => {
    const store = {
      ...getDefaultStore(),
      providers: [{ id: 'prov1', name: 'Prov' } as never],
      clients: [{ id: 'c1', name: 'Cliente' } as never],
    };
    saveStore(store);
    const loaded = loadStore();
    expect(loaded).not.toBeNull();
    expect(loaded!.providers).toHaveLength(1);
    expect(loaded!.clients).toHaveLength(1);
  });

  it('export/import round-trip', () => {
    const store = getDefaultStore();
    const json = exportStore(store);
    const imported = importStore(json);
    expect(imported.assumptions.year).toBe(store.assumptions.year);
  });

  it('migrates midas-v5 store: drops proposals/scenarios/activeScenarioId, keeps the rest', () => {
    const v5Payload = {
      version: 5,
      data: {
        proposals: [{ id: 'p1', name: 'Old', kind: 'expense_saving', amount: 1, startYearMonth: '2026-01', frequency: 'monthly', enabled: true, createdAt: 'x', updatedAt: 'x' }],
        scenarios: [{ id: 's1', name: 'Old', proposalStates: { p1: true }, createdAt: 'x', updatedAt: 'x' }],
        activeScenarioId: 's1',
        providers: [{ id: 'prov1', name: 'Prov' }],
        clients: [{ id: 'c1', name: 'Cliente' }],
        assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
        confirmedPayments: [],
        cxpRecords: [],
        cxpLoadedCias: {},
        cashFlowOverrides: { '2026-05': { income: 1000 } },
        lastSaved: '2026-04-01T00:00:00Z',
      },
    };
    localStorage.setItem('midas-v5', JSON.stringify(v5Payload));

    const loaded = loadStore();
    expect(loaded).not.toBeNull();
    expect((loaded as unknown as Record<string, unknown>).proposals).toBeUndefined();
    expect((loaded as unknown as Record<string, unknown>).scenarios).toBeUndefined();
    expect(loaded!.providers).toHaveLength(1);
    expect(loaded!.clients).toHaveLength(1);
    expect(loaded!.cashFlowOverrides['2026-05']).toEqual({ income: 1000 });
    expect(localStorage.getItem('midas-v5')).toBeNull();
    expect(localStorage.getItem('midas-v8')).not.toBeNull();
  });

  it('migrates legacy v4 store: keeps clients/providers, drops everything simulation-y', () => {
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
    expect(loaded!.clients).toHaveLength(1);
    expect(loaded!.providers).toHaveLength(1);
    expect(localStorage.getItem('flowsense-v4')).toBeNull();
  });

  it('clamps invalid assumptions back to sane defaults', () => {
    const payload = {
      version: 6,
      data: {
        ...getDefaultStore(),
        assumptions: {
          year: -7,
          globalCompliance: 42,
          factorajeDays: 'no number',
        },
      },
    };
    localStorage.setItem('midas-v6', JSON.stringify(payload));
    const loaded = loadStore();
    expect(loaded).not.toBeNull();
    expect(loaded!.assumptions.year).toBeGreaterThan(1900);
    expect(loaded!.assumptions.globalCompliance).toBe(1);
    expect(loaded!.assumptions.factorajeDays).toBe(30);
  });

  it('drops providers/clients without a string id', () => {
    const payload = {
      version: 6,
      data: {
        ...getDefaultStore(),
        providers: [
          { id: 'ok', name: 'OK' },
          { name: 'no id' },
          null,
        ],
        clients: [
          { id: 'c1', name: 'Cliente' },
          { id: 123 },
        ],
      },
    };
    localStorage.setItem('midas-v6', JSON.stringify(payload));
    const loaded = loadStore();
    expect(loaded!.providers).toHaveLength(1);
    expect(loaded!.clients).toHaveLength(1);
  });

  it('drops malformed confirmedPayments but keeps the valid ones', () => {
    const valid = {
      key: 'c1::2026-05-01::2026-04-01',
      clientId: 'c1',
      realDate: '2026-05-01',
      invoiceDate: '2026-04-01',
      amount: 1000,
      confirmedAt: '2026-04-21T00:00:00Z',
    };
    const payload = {
      version: 6,
      data: {
        ...getDefaultStore(),
        confirmedPayments: [
          valid,
          { key: 'x' },
          null,
        ],
      },
    };
    localStorage.setItem('midas-v6', JSON.stringify(payload));
    const loaded = loadStore();
    expect(loaded!.confirmedPayments).toHaveLength(1);
    expect(loaded!.confirmedPayments[0].key).toBe(valid.key);
  });

  it('does not let unknown fields leak into the store', () => {
    const payload = {
      version: 6,
      data: {
        ...getDefaultStore(),
        maliciousField: { drop: 'me' },
        __proto__: { polluted: true },
      },
    };
    localStorage.setItem('midas-v6', JSON.stringify(payload));
    const loaded = loadStore();
    expect(loaded).not.toBeNull();
    expect((loaded as unknown as Record<string, unknown>).maliciousField).toBeUndefined();
  });
});
