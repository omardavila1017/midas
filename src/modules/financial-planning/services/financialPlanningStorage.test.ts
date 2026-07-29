import { afterEach, describe, expect, it } from 'vitest';
import {
  listHeaderScenarios,
  loadPlanningAdjustments,
  loadPlanningScenarios,
  savePlanningAdjustments,
  savePlanningScenarios,
} from './financialPlanningStorage';
import { PLANNING_ADJUSTMENTS_KEY, PLANNING_SCENARIOS_KEY } from './planningStorageKeys';
import type { FinancialAdjustment, FinancialScenario } from '../../shared-finance/types';

afterEach(() => localStorage.clear());

function scenario(partial: Partial<FinancialScenario> & { id: string }): FinancialScenario {
  return {
    name: partial.id,
    kind: 'DRAFT',
    adjustmentIds: [],
    status: 'DRAFT',
    isBase: false,
    createdBy: 'tester',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...partial,
  } as FinancialScenario;
}

describe('financialPlanningStorage — scenarios/adjustments', () => {
  it('roundtrips scenarios through localStorage', () => {
    savePlanningScenarios([scenario({ id: 'draft-1', name: 'Draft 1' })]);
    const loaded = loadPlanningScenarios([]);
    expect(loaded.length).toBe(1);
    expect(loaded[0]).toMatchObject({ id: 'draft-1', name: 'Draft 1' });
  });

  it('returns the fallback on corrupt JSON, non-array payloads and all-invalid entries', () => {
    const fallback = [scenario({ id: 'fallback' })];

    localStorage.setItem(PLANNING_SCENARIOS_KEY, '{not json');
    expect(loadPlanningScenarios(fallback)).toBe(fallback);

    localStorage.setItem(PLANNING_SCENARIOS_KEY, JSON.stringify({ id: 'obj-not-array' }));
    expect(loadPlanningScenarios(fallback)).toBe(fallback);

    localStorage.setItem(PLANNING_SCENARIOS_KEY, JSON.stringify([null, 42, { noId: true }]));
    expect(loadPlanningScenarios(fallback)).toBe(fallback);
  });

  it('keeps valid entries and drops malformed ones from a mixed payload', () => {
    localStorage.setItem(
      PLANNING_SCENARIOS_KEY,
      JSON.stringify([scenario({ id: 'ok' }), null, { id: 42 }]),
    );
    const loaded = loadPlanningScenarios([]);
    expect(loaded.map((s) => s.id)).toEqual(['ok']);
  });

  it('roundtrips adjustments and filters malformed ones', () => {
    const adj = {
      id: 'adj-1',
      name: 'Recorte',
      kind: 'REDUCE_EXPENSE',
    } as unknown as FinancialAdjustment;
    savePlanningAdjustments([adj]);
    expect(loadPlanningAdjustments([]).map((a) => a.id)).toEqual(['adj-1']);

    localStorage.setItem(PLANNING_ADJUSTMENTS_KEY, JSON.stringify([{ id: 7 }, adj]));
    expect(loadPlanningAdjustments([]).map((a) => a.id)).toEqual(['adj-1']);
  });
});

describe('listHeaderScenarios', () => {
  it('synthesizes Base + Aprobado when nothing is stored', () => {
    const list = listHeaderScenarios();
    expect(list.map((s) => s.id)).toEqual(['base', 'approved']);
    expect(list[0]).toMatchObject({ kind: 'BASE', isBase: true });
    expect(list[1]).toMatchObject({ kind: 'APPROVED', isBase: false });
  });

  it('prefers stored Base/Approved and appends non-archived drafts', () => {
    savePlanningScenarios([
      scenario({ id: 'base', kind: 'BASE', isBase: true, name: 'Mi Base' }),
      scenario({ id: 'approved', kind: 'APPROVED', name: 'Mi Aprobado' }),
      scenario({ id: 'draft-live', kind: 'DRAFT' }),
      scenario({ id: 'draft-gone', kind: 'DRAFT', archivedAt: '2026-02-01T00:00:00Z' }),
    ]);
    const list = listHeaderScenarios();
    expect(list.map((s) => s.id)).toEqual(['base', 'approved', 'draft-live']);
    expect(list[0].name).toBe('Mi Base');
  });

  it('synthesizes a replacement when the stored Base is archived', () => {
    savePlanningScenarios([
      scenario({ id: 'old-base', kind: 'BASE', isBase: true, archivedAt: '2026-02-01T00:00:00Z' }),
    ]);
    const list = listHeaderScenarios();
    expect(list[0]).toMatchObject({ id: 'base', kind: 'BASE' });
  });
});
