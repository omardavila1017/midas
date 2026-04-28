import { beforeEach, describe, expect, it } from 'vitest';
import {
  createOperatingProjectionScenario,
  loadOperatingProjectionScenarios,
  saveOperatingProjectionScenarios,
} from './operatingProjectionScenarios';

const STORAGE_KEY = 'midas.operating.scenarios.v1';

describe('operating projection scenarios', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists collection and scheduled outflow overrides', () => {
    const scenario = createOperatingProjectionScenario('Escenario editable', {
      collectionOverrides: [
        {
          id: 'collection-override-1',
          sourceKey: 'collection:c1:2026-05-01:2026-05-01',
          date: '2026-05-04',
          amount: 1500,
          note: 'Cobro movido',
        },
      ],
      scheduledOutflowOverrides: [
        {
          id: 'outflow-override-1',
          sourceKey: 'fixed:rent:2026-05-01',
          date: '2026-05-06',
          amount: 0,
          note: 'Cancelado en escenario',
        },
      ],
    });

    saveOperatingProjectionScenarios([scenario]);
    const loaded = loadOperatingProjectionScenarios();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].collectionOverrides).toEqual([
      expect.objectContaining({
        sourceKey: 'collection:c1:2026-05-01:2026-05-01',
        date: '2026-05-04',
        amount: 1500,
        note: 'Cobro movido',
      }),
    ]);
    expect(loaded[0].scheduledOutflowOverrides).toEqual([
      expect.objectContaining({
        sourceKey: 'fixed:rent:2026-05-01',
        date: '2026-05-06',
        amount: 0,
        note: 'Cancelado en escenario',
      }),
    ]);
  });

  it('drops invalid override rows without breaking scenario load', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([
      {
        id: 'scenario-with-invalid-overrides',
        name: 'Con inválidos',
        createdAt: '2026-04-28T00:00:00Z',
        updatedAt: '2026-04-28T00:00:00Z',
        manualExpenseEvents: [],
        operatingAdjustments: [],
        supplierPaymentOverrides: [],
        taxDebts: [],
        collectionOverrides: [
          { sourceKey: 'collection:c1:2026-05-01:2026-05-01', date: '2026-05-02', amount: '200' },
          { sourceKey: 'collection:bad', date: 'mayo', amount: 100 },
          { sourceKey: '', date: '2026-05-02', amount: 100 },
        ],
        scheduledOutflowOverrides: [
          { sourceKey: 'fixed:rent:2026-05-01', date: '2026-05-02', amount: 0 },
          { sourceKey: 'fixed:bad', date: '2026-05-02', amount: -1 },
          { date: '2026-05-02', amount: 100 },
        ],
      },
    ]));

    const loaded = loadOperatingProjectionScenarios();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].collectionOverrides).toHaveLength(1);
    expect(loaded[0].collectionOverrides[0].amount).toBe(200);
    expect(loaded[0].scheduledOutflowOverrides).toHaveLength(1);
    expect(loaded[0].scheduledOutflowOverrides[0].amount).toBe(0);
  });
});
