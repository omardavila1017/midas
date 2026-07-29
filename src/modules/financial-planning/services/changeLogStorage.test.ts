import { afterEach, describe, expect, it } from 'vitest';
import { appendChangeLogEntry, loadChangeLog, saveChangeLog } from './changeLogStorage';
import { PLANNING_CHANGE_LOG_KEY } from './planningStorageKeys';
import type { ScenarioChangeLogEntry } from '../../shared-finance/types';

afterEach(() => localStorage.clear());

function entry(partial: Partial<ScenarioChangeLogEntry> = {}): ScenarioChangeLogEntry {
  return {
    id: 'log-1',
    scenarioId: 'draft-x',
    kind: 'EDIT_CELL',
    payload: {},
    autoDescription: 'Editó una celda',
    createdBy: 'tester',
    createdAt: '2026-03-01T00:00:00Z',
    ...partial,
  };
}

describe('changeLogStorage', () => {
  it('roundtrips entries through localStorage', () => {
    saveChangeLog([entry()]);
    const loaded = loadChangeLog();
    expect(loaded.length).toBe(1);
    expect(loaded[0]).toMatchObject({ id: 'log-1', kind: 'EDIT_CELL' });
  });

  it('returns the fallback on corrupt or non-array payloads', () => {
    const fallback = [entry({ id: 'fb' })];
    localStorage.setItem(PLANNING_CHANGE_LOG_KEY, '{corrupt');
    expect(loadChangeLog(fallback)).toBe(fallback);
    localStorage.setItem(PLANNING_CHANGE_LOG_KEY, JSON.stringify('a string'));
    expect(loadChangeLog(fallback)).toBe(fallback);
  });

  it('drops entries missing scenarioId, kind or autoDescription and fills defaults', () => {
    localStorage.setItem(
      PLANNING_CHANGE_LOG_KEY,
      JSON.stringify([
        entry(),
        { ...entry({ id: 'no-kind' }), kind: 'NOT_A_KIND' },
        { ...entry({ id: 'no-scenario' }), scenarioId: '  ' },
        { ...entry({ id: 'no-desc' }), autoDescription: '' },
        { id: 'defaults', scenarioId: 's1', kind: 'ADD_ROW', autoDescription: 'Agregó', payload: 'not-an-object' },
        null,
      ]),
    );
    const loaded = loadChangeLog();
    expect(loaded.map((e) => e.id)).toEqual(['log-1', 'defaults']);
    const defaults = loaded[1];
    expect(defaults.payload).toEqual({});
    expect(defaults.createdBy).toBe('tesoreria@senda.local');
    expect(typeof defaults.createdAt).toBe('string');
  });

  it('caps entries per scenario at 500 preserving newest-first order', () => {
    const many: ScenarioChangeLogEntry[] = [];
    for (let i = 0; i < 505; i++) many.push(entry({ id: `a-${i}`, scenarioId: 'sce-a' }));
    many.push(entry({ id: 'b-0', scenarioId: 'sce-b' }));
    saveChangeLog(many);
    const loaded = loadChangeLog();
    expect(loaded.filter((e) => e.scenarioId === 'sce-a').length).toBe(500);
    expect(loaded.filter((e) => e.scenarioId === 'sce-b').length).toBe(1);
    expect(loaded[0].id).toBe('a-0');
  });

  it('appendChangeLogEntry prepends and enforces the per-scenario cap', () => {
    let list: ScenarioChangeLogEntry[] = [];
    for (let i = 0; i < 501; i++) list = appendChangeLogEntry(list, entry({ id: `e-${i}` }));
    expect(list.length).toBe(500);
    expect(list[0].id).toBe('e-500');
    expect(list.some((e) => e.id === 'e-0')).toBe(false);
  });

  it('removes the storage key when saving an empty list', () => {
    saveChangeLog([entry()]);
    saveChangeLog([]);
    expect(localStorage.getItem(PLANNING_CHANGE_LOG_KEY)).toBe(null);
  });
});
