import { describe, expect, it } from 'vitest';
import { importStore } from './persistence';
import { createTestPlan } from '../test/fixtures';

describe('persistence migration', () => {
  it('migrates the legacy store into simulations, scenarios, proposals and scenario overrides', () => {
    const legacyJson = JSON.stringify({
      version: 1,
      data: {
        plan: createTestPlan(),
        simulations: [
          {
            id: 'legacy-simulation-1',
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
            selectedSimulationIds: ['legacy-simulation-1'],
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

    expect(migrated.simulations).toHaveLength(1);
    expect(migrated.simulations[0].id).toBe('simulation-migrated');
    expect(migrated.proposals).toHaveLength(1);
    expect(migrated.proposals[0].effects[0].conceptId).toBe('__role__:expense');
    expect(migrated.scenarios).toHaveLength(2);
    expect(migrated.scenarios[0].id).toBe('scenario-base');
    expect(migrated.scenarios[1].proposalIds).toEqual(['proposal-legacy-simulation-1']);
    expect(migrated.scenarioCellOverrides).toHaveLength(1);
    expect(migrated.scenarioCellOverrides[0].scenarioId).toBe('legacy-scenario-1');
    expect(migrated.scenarioCellOverrides[0].manualValue).toBe(120);
    expect(migrated.activeSimulationId).toBe(null);
    expect(migrated.activeScenarioId).toBe('scenario-base');
  });

  it('normalizes v3 proposals that were saved without the new fields', () => {
    const v3Json = JSON.stringify({
      version: 3,
      data: {
        plan: createTestPlan(),
        simulations: [],
        scenarios: [],
        proposals: [
          {
            id: 'proposal-legacy-v3',
            name: 'Propuesta vieja',
            description: 'Guardada antes de targetIds',
            category: 'Reducción de Costos',
            effects: [
              {
                id: 'effect-1',
                type: 'concept_delta',
                conceptId: '__role__:expense',
                monthOffsets: [0],
                mode: 'absolute',
                value: -50,
              },
            ],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        scenarioCellOverrides: [],
        activeSimulationId: null,
        activeScenarioId: 'scenario-base',
        providers: [],
        clients: [],
        assumptions: {
          year: 2026,
          globalCompliance: 1,
          factorajeDays: 30,
        },
        confirmedPayments: [],
        cxpRecords: [],
        lastSaved: '2026-01-03T00:00:00.000Z',
      },
    });

    const normalized = importStore(v3Json);

    expect(normalized.proposals).toHaveLength(1);
    expect(normalized.proposals[0].type).toBe('amount_adjustment');
    expect(normalized.proposals[0].targetIds).toEqual(['__role__:expense']);
    expect(normalized.proposals[0].startYearMonth).toBe('2026-01');
  });

  it('migrates v2 store (pre-swap field names) into v3 shape', () => {
    const v2Json = JSON.stringify({
      version: 2,
      data: {
        plan: createTestPlan(),
        proposals: [
          {
            id: 'container-v2',
            name: 'Simulación guardada en v2',
            description: 'Era un Proposal en el código v2 (contenedor).',
            status: 'Pendiente',
            activeScenarioId: 'scenario-v2-a',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        simulations: [
          {
            id: 'adjustment-v2',
            name: 'Propuesta guardada en v2',
            description: 'Era una Simulation en el código v2 (ajuste).',
            category: 'Reducción de Costos',
            type: 'amount_adjustment',
            targetIds: ['__role__:expense'],
            startYearMonth: '2026-01',
            effects: [
              {
                id: 'effect-v2',
                type: 'concept_delta',
                conceptId: '__role__:expense',
                monthOffsets: [0],
                mode: 'absolute',
                value: -100,
              },
            ],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        scenarios: [
          {
            id: 'scenario-v2-a',
            proposalId: 'container-v2',
            kind: 'proposal',
            name: 'Escenario v2',
            description: 'Escenario guardado con la terminología vieja.',
            probability: 1,
            startYearMonth: '2026-01',
            horizonMonths: 12,
            simulationIds: ['adjustment-v2'],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        scenarioCellOverrides: [],
        activeProposalId: 'container-v2',
        activeScenarioId: 'scenario-v2-a',
        providers: [],
        clients: [],
        assumptions: {
          year: 2026,
          globalCompliance: 1,
          factorajeDays: 30,
        },
        confirmedPayments: [],
        cxpRecords: [],
        lastSaved: '2026-01-03T00:00:00.000Z',
      },
    });

    const migrated = importStore(v2Json);

    expect(migrated.simulations).toHaveLength(1);
    expect(migrated.simulations[0].id).toBe('container-v2');
    expect(migrated.simulations[0].name).toBe('Simulación guardada en v2');

    expect(migrated.proposals).toHaveLength(1);
    expect(migrated.proposals[0].id).toBe('adjustment-v2');
    expect(migrated.proposals[0].category).toBe('Reducción de Costos');
    expect(migrated.proposals[0].effects[0].value).toBe(-100);

    expect(migrated.scenarios).toHaveLength(2);
    expect(migrated.scenarios[0].id).toBe('scenario-base');

    const migratedScenario = migrated.scenarios.find((s) => s.id === 'scenario-v2-a');
    expect(migratedScenario).toBeTruthy();
    expect(migratedScenario?.simulationId).toBe('container-v2');
    expect(migratedScenario?.proposalIds).toEqual(['adjustment-v2']);
    expect(migratedScenario?.kind).toBe('simulation');

    expect(migrated.activeSimulationId).toBe('container-v2');
    expect(migrated.activeScenarioId).toBe('scenario-v2-a');
  });
});
