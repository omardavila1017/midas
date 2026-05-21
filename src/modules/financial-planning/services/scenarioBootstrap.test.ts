import { describe, expect, it } from 'vitest';
import { ensureCoreScenarios, BASE_SCENARIO_ID, APPROVED_SCENARIO_ID } from './scenarioBootstrap';
import type { FinancialScenario } from '../../shared-finance/types';

const sourceBase: FinancialScenario = {
  id: 'source-base',
  name: 'Source Base',
  kind: 'BASE',
  isBase: true,
  status: 'APPROVED',
  adjustmentIds: [],
  createdBy: 'system',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('ensureCoreScenarios', () => {
  it('materializes Base + Approved when storage is empty', () => {
    const result = ensureCoreScenarios({
      storedScenarios: [],
      storedAdjustments: [],
      manualEntries: [],
      customRows: [],
      cellOverrides: [],
      changeLog: [],
      sourceBaseScenario: sourceBase,
    });

    expect(result.changed).toBe(true);
    const ids = result.scenarios.map((s) => s.id);
    expect(ids).toContain(BASE_SCENARIO_ID);
    expect(ids).toContain(APPROVED_SCENARIO_ID);
    const approved = result.scenarios.find((s) => s.kind === 'APPROVED');
    expect(approved?.id).toBe(APPROVED_SCENARIO_ID);
  });

  it('purges legacy CONSERVATIVE/OPTIMISTIC/CRISIS/LIQUIDITY/CUSTOM scenarios and dependents', () => {
    const legacy: FinancialScenario = {
      id: 'legacy-1',
      name: 'Legacy',
      kind: 'CONSERVATIVE' as unknown as FinancialScenario['kind'],
      status: 'DRAFT',
      adjustmentIds: ['adj-x'],
      createdBy: 'x',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const result = ensureCoreScenarios({
      storedScenarios: [legacy],
      storedAdjustments: [{
        id: 'adj-x', name: 'x', scenarioIds: ['legacy-1'], type: 'AMOUNT_OVERRIDE', targetType: 'MOVEMENT',
        targetExpression: 'm-1', reasonCode: 'LIQUIDITY', justification: 'x', status: 'DRAFT',
        createdBy: 'x', createdAt: '2026-01-01T00:00:00Z',
      }],
      manualEntries: [],
      customRows: [],
      cellOverrides: [{
        id: 'co-x', scenarioId: 'legacy-1', conceptKey: 'INFLOW:AR_COLLECTION:cfe',
        granularity: 'monthly', bucketKey: '2026-05-01', type: 'INFLOW', mode: 'REPLACE', value: 100,
        createdBy: 'x', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      }],
      changeLog: [{
        id: 'cl-x', scenarioId: 'legacy-1', kind: 'EDIT_CELL', payload: {},
        autoDescription: 'x', createdBy: 'x', createdAt: '2026-01-01T00:00:00Z',
      }],
      sourceBaseScenario: sourceBase,
    });

    expect(result.scenarios.find((s) => s.id === 'legacy-1')).toBeUndefined();
    expect(result.adjustments.length).toBe(0);
    expect(result.cellOverrides.length).toBe(0);
    expect(result.changeLog.length).toBe(0);
  });

  it('normalizes a leftover non-base, non-approved scenario as DRAFT pointing at Approved', () => {
    const leftover: FinancialScenario = {
      id: 'misc-draft',
      name: 'Misc',
      kind: 'DRAFT',
      status: 'DRAFT',
      adjustmentIds: [],
      createdBy: 'x',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const result = ensureCoreScenarios({
      storedScenarios: [leftover],
      storedAdjustments: [],
      manualEntries: [],
      customRows: [],
      cellOverrides: [],
      changeLog: [],
      sourceBaseScenario: sourceBase,
    });
    const draft = result.scenarios.find((s) => s.id === 'misc-draft');
    expect(draft?.kind).toBe('DRAFT');
    expect(draft?.parentScenarioId).toBe(APPROVED_SCENARIO_ID);
  });
});
