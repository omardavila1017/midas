import { describe, expect, it } from 'vitest';
import { importStore } from './persistence';
import { createTestPlan } from '../test/fixtures';

describe('persistence migration', () => {
  it('migrates the legacy store into proposals, scenarios, simulations and scenario overrides', () => {
    const legacyJson = JSON.stringify({
      version: 1,
      data: {
        plan: createTestPlan(),
        proposals: [
          {
            id: 'legacy-proposal-1',
            category: 'Reducción de Costos',
            name: 'Reducir gasto operativo',
            monthlyAmount: 10,
            probability: 0.8,
            startMonth: 1,
            distribution: 'Mensual',
            status: 'Pendiente',
            annualImpact: 96,
            monthlyImpact: [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8],
            responsible: 'Finanzas',
            notes: 'Ajuste legacy',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        scenarios: [
          {
            id: 'legacy-scenario-1',
            name: 'Escenario Legacy',
            description: 'Escenario guardado antes de la migración',
            selectedProposalIds: ['legacy-proposal-1'],
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        ],
        providers: [],
        clients: [],
        assumptions: {
          year: 2026,
          globalCompliance: 1,
          factorajeDays: 30,
        },
        confirmedPayments: [],
        cxpRecords: [],
        forecastOverrides: [
          {
            key: 'concept-income-leaf::2026-01',
            conceptId: 'concept-income-leaf',
            yearMonth: '2026-01',
            originalValue: 100,
            overrideValue: 120,
            comment: 'Legacy comment',
            editedAt: '2026-01-03T00:00:00.000Z',
          },
        ],
        lastSaved: '2026-01-03T00:00:00.000Z',
      },
    });

    const migrated = importStore(legacyJson);

    expect(migrated.proposals).toHaveLength(1);
    expect(migrated.proposals[0].id).toBe('proposal-migrated');
    expect(migrated.simulations).toHaveLength(1);
    expect(migrated.simulations[0].effects[0].conceptId).toBe('__role__:expense');
    expect(migrated.scenarios).toHaveLength(2);
    expect(migrated.scenarios[0].id).toBe('scenario-base');
    expect(migrated.scenarios[1].simulationIds).toEqual(['simulation-legacy-proposal-1']);
    expect(migrated.scenarioCellOverrides).toHaveLength(1);
    expect(migrated.scenarioCellOverrides[0].scenarioId).toBe('legacy-scenario-1');
    expect(migrated.scenarioCellOverrides[0].manualValue).toBe(120);
    expect(migrated.activeProposalId).toBe(null);
    expect(migrated.activeScenarioId).toBe('scenario-base');
  });
});
