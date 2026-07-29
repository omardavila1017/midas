import { afterEach, describe, expect, it } from 'vitest';
import { loadCustomKpis, saveCustomKpis } from './customKpisStorage';
import type { CustomKpi } from '../types';

const KEY = 'midas.kpisObjectives.customKpis.v1';

afterEach(() => localStorage.clear());

function kpi(partial: Partial<CustomKpi> = {}): CustomKpi {
  return {
    id: 'kpi-1',
    name: 'DSO',
    unit: 'days',
    manualValue: 42,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...partial,
  };
}

describe('customKpisStorage', () => {
  it('roundtrips KPIs through localStorage', () => {
    saveCustomKpis([kpi()]);
    const loaded = loadCustomKpis();
    expect(loaded.length).toBe(1);
    expect(loaded[0]).toMatchObject({ id: 'kpi-1', unit: 'days', manualValue: 42 });
  });

  it('returns the fallback on corrupt or non-array payloads', () => {
    const fallback = [kpi({ id: 'fb' })];
    localStorage.setItem(KEY, 'oops');
    expect(loadCustomKpis(fallback)).toBe(fallback);
    localStorage.setItem(KEY, JSON.stringify(null));
    expect(loadCustomKpis(fallback)).toBe(fallback);
  });

  it('drops nameless entries, defaults unknown units to MXN and coerces numeric strings', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        kpi(),
        { name: 'Margen', unit: 'lightyears', manualValue: '12.5' },
        { name: '   ' },
        null,
      ]),
    );
    const loaded = loadCustomKpis();
    expect(loaded.length).toBe(2);
    expect(loaded[1]).toMatchObject({ name: 'Margen', unit: 'MXN', manualValue: 12.5 });
    expect(loaded[1].id).toMatch(/^custom-kpi-/);
  });

  it('removes the storage key when saving an empty list', () => {
    saveCustomKpis([kpi()]);
    saveCustomKpis([]);
    expect(localStorage.getItem(KEY)).toBe(null);
  });
});
