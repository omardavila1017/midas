import { afterEach, describe, expect, it } from 'vitest';
import { loadObjectives, saveObjectives } from './objectivesStorage';
import type { Objective } from '../types';

const KEY = 'midas.kpisObjectives.objectives.v1';

afterEach(() => localStorage.clear());

function objective(partial: Partial<Objective> = {}): Objective {
  return {
    id: 'obj-1',
    name: 'Caja mínima',
    kind: 'NUMERIC_MONTHLY',
    numericConcept: 'CASH_CLOSE',
    targetYearMonth: '2026-08',
    targetAmount: 20_000_000,
    comparison: 'GTE',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
    ...partial,
  };
}

describe('objectivesStorage', () => {
  it('roundtrips objectives through localStorage', () => {
    saveObjectives([objective()]);
    const loaded = loadObjectives();
    expect(loaded.length).toBe(1);
    expect(loaded[0]).toMatchObject({ id: 'obj-1', targetAmount: 20_000_000, comparison: 'GTE' });
  });

  it('returns the fallback on corrupt or non-array payloads', () => {
    const fallback = [objective({ id: 'fb' })];
    localStorage.setItem(KEY, '}{');
    expect(loadObjectives(fallback)).toBe(fallback);
    localStorage.setItem(KEY, JSON.stringify({ id: 'not-array' }));
    expect(loadObjectives(fallback)).toBe(fallback);
  });

  it('drops entries without name or with unknown kind', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        objective(),
        { ...objective({ id: 'no-name' }), name: '  ' },
        { ...objective({ id: 'bad-kind' }), kind: 'IMPOSSIBLE' },
        null,
      ]),
    );
    expect(loadObjectives().map((o) => o.id)).toEqual(['obj-1']);
  });

  it('sanitizes malformed optional fields instead of dropping the objective', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        {
          name: 'Cobranza',
          kind: 'KPI_THRESHOLD',
          targetYearMonth: '08-2026',
          targetAmount: 'not-a-number',
          threshold: '95',
          comparison: 'BIGGER',
          numericConcept: 'SIDEWAYS',
          manualStatus: 'MAYBE',
        },
      ]),
    );
    const [loaded] = loadObjectives();
    expect(loaded.targetYearMonth).toBeUndefined();
    expect(loaded.targetAmount).toBeUndefined();
    expect(loaded.threshold).toBe(95);
    expect(loaded.comparison).toBeUndefined();
    expect(loaded.numericConcept).toBeUndefined();
    expect(loaded.manualStatus).toBeUndefined();
    expect(loaded.id).toMatch(/^objective-/);
    expect(typeof loaded.createdAt).toBe('string');
  });

  it('removes the storage key when saving an empty list', () => {
    saveObjectives([objective()]);
    saveObjectives([]);
    expect(localStorage.getItem(KEY)).toBe(null);
  });
});
