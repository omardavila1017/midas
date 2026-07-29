import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCustomConceptKey,
  loadCustomRows,
  normalizeCustomRow,
  saveCustomRows,
  slug,
} from './customRowsStorage';
import { PLANNING_CUSTOM_ROWS_KEY } from './planningStorageKeys';
import type { PlanningCustomRow } from '../../shared-finance/types';

afterEach(() => localStorage.clear());

function row(partial: Partial<PlanningCustomRow> = {}): PlanningCustomRow {
  return {
    id: 'row-1',
    scenarioId: 'draft-x',
    conceptKey: 'custom:OUTFLOW:renta:row-1',
    label: 'Renta bodega',
    type: 'OUTFLOW',
    category: 'OPEX',
    createdBy: 'tester',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...partial,
  };
}

describe('customRowsStorage', () => {
  it('roundtrips rows through localStorage', () => {
    saveCustomRows([row()]);
    const loaded = loadCustomRows();
    expect(loaded.length).toBe(1);
    expect(loaded[0]).toMatchObject({ id: 'row-1', category: 'OPEX', type: 'OUTFLOW' });
  });

  it('returns the fallback on corrupt or non-array payloads', () => {
    const fallback = [row({ id: 'fb' })];
    localStorage.setItem(PLANNING_CUSTOM_ROWS_KEY, 'not-json{');
    expect(loadCustomRows(fallback)).toBe(fallback);
    localStorage.setItem(PLANNING_CUSTOM_ROWS_KEY, JSON.stringify(123));
    expect(loadCustomRows(fallback)).toBe(fallback);
  });

  it('drops rows with invalid type/category or missing label/scenarioId', () => {
    localStorage.setItem(
      PLANNING_CUSTOM_ROWS_KEY,
      JSON.stringify([
        row(),
        { ...row({ id: 'bad-type' }), type: 'SIDEWAYS' },
        { ...row({ id: 'bad-cat' }), category: 'NOT_A_CATEGORY' },
        { ...row({ id: 'no-label' }), label: '   ' },
        { ...row({ id: 'no-scenario' }), scenarioId: '' },
        null,
        'garbage',
      ]),
    );
    expect(loadCustomRows().map((r) => r.id)).toEqual(['row-1']);
  });

  it('normalizeCustomRow fills id, conceptKey and timestamps when missing', () => {
    const normalized = normalizeCustomRow(
      { scenarioId: 's1', label: 'Nueva fila', type: 'INFLOW', category: 'MANUAL' },
      3,
    );
    expect(normalized).not.toBeNull();
    expect(normalized!.id).toMatch(/^custom-row-/);
    expect(normalized!.conceptKey.startsWith('custom:INFLOW:nueva-fila:')).toBe(true);
    expect(normalized!.createdBy).toBe('tesoreria@senda.local');
  });

  it('removes the storage key when saving an empty list', () => {
    saveCustomRows([row()]);
    saveCustomRows([]);
    expect(localStorage.getItem(PLANNING_CUSTOM_ROWS_KEY)).toBe(null);
  });
});

describe('slug / buildCustomConceptKey', () => {
  it('slugifies accents, symbols and length', () => {
    expect(slug('Renta de Bodega — Ñoño #3')).toBe('renta-de-bodega-nono-3');
    expect(slug('   ')).toBe('general');
    expect(slug('x'.repeat(80)).length).toBeLessThanOrEqual(48);
  });

  it('builds the concept key from type, label and id tail', () => {
    expect(buildCustomConceptKey('OUTFLOW', 'Renta', 'abcdef123456')).toBe(
      'custom:OUTFLOW:renta:123456',
    );
  });
});
