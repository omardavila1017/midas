import { describe, expect, it } from 'vitest';
import { evaluateScenario } from './scenarioEngine';
import {
  createScenarioOverride,
  createTestPlan,
  createTestProposal,
  createTestScenario,
  createTestSimulations,
} from '../test/fixtures';
import { ROLE_TARGET_INCOME, scenarioCellKey } from '../types';

describe('scenarioEngine', () => {
  it('stacks percent and absolute simulations deterministically on the same cell', () => {
    const plan = createTestPlan();
    const proposal = createTestProposal();
    const scenario = createTestScenario();
    const evaluation = evaluateScenario(plan, proposal, scenario, createTestSimulations(), []);

    const leafCell = evaluation.cells.get(
      scenarioCellKey('scenario-1', 'concept-income-leaf', '2026-01'),
    );
    const rootCell = evaluation.cells.get(
      scenarioCellKey('scenario-1', 'concept-income-root', '2026-01'),
    );

    expect(leafCell?.baseValue).toBe(100);
    expect(leafCell?.simulatedValue).toBe(115);
    expect(leafCell?.finalValue).toBe(115);
    expect(rootCell?.finalValue).toBe(115);
    expect(leafCell?.simulationContributions).toHaveLength(2);
  });

  it('keeps overrides isolated per scenario', () => {
    const plan = createTestPlan();
    const proposal = createTestProposal();
    const scenarioA = createTestScenario({ id: 'scenario-1' });
    const scenarioB = createTestScenario({
      id: 'scenario-2',
      proposalId: 'proposal-1',
      name: 'Escenario Alterno',
      simulationIds: ['simulation-percent', 'simulation-absolute'],
    });

    const evaluationA = evaluateScenario(
      plan,
      proposal,
      scenarioA,
      createTestSimulations(),
      [createScenarioOverride(120)],
    );
    const evaluationB = evaluateScenario(
      plan,
      proposal,
      scenarioB,
      createTestSimulations(),
      [createScenarioOverride(120)],
    );

    const cellA = evaluationA.cells.get(
      scenarioCellKey('scenario-1', 'concept-income-leaf', '2026-01'),
    );
    const cellB = evaluationB.cells.get(
      scenarioCellKey('scenario-2', 'concept-income-leaf', '2026-01'),
    );

    expect(cellA?.finalValue).toBe(120);
    expect(cellA?.hasManualDelta).toBe(true);
    expect(cellB?.finalValue).toBe(115);
    expect(cellB?.hasManualDelta).toBe(false);
  });

  it('returns to the simulated value when the manual override disappears', () => {
    const plan = createTestPlan();
    const proposal = createTestProposal();
    const scenario = createTestScenario();

    const withOverride = evaluateScenario(
      plan,
      proposal,
      scenario,
      createTestSimulations(),
      [createScenarioOverride(120)],
    );
    const restored = evaluateScenario(
      plan,
      proposal,
      scenario,
      createTestSimulations(),
      [],
    );

    const overriddenCell = withOverride.cells.get(
      scenarioCellKey('scenario-1', 'concept-income-leaf', '2026-01'),
    );
    const restoredCell = restored.cells.get(
      scenarioCellKey('scenario-1', 'concept-income-leaf', '2026-01'),
    );

    expect(overriddenCell?.finalValue).toBe(120);
    expect(restoredCell?.finalValue).toBe(115);
    expect(restoredCell?.simulatedValue).toBe(115);
  });

  it('applies percent adjustments correctly on aggregate role targets', () => {
    const plan = createTestPlan();
    const proposal = createTestProposal();
    const scenario = createTestScenario({
      simulationIds: ['simulation-role-percent'],
    });

    const evaluation = evaluateScenario(plan, proposal, scenario, [
      {
        id: 'simulation-role-percent',
        name: 'Ingresos +10%',
        description: 'Aumenta ingresos generales 10%',
        category: 'Incremento de Ingresos',
        type: 'percent_adjustment',
        targetIds: [ROLE_TARGET_INCOME],
        startYearMonth: '2026-01',
        endYearMonth: '2026-01',
        frequency: 'once',
        operation: 'increase',
        percent: 0.1,
        effects: [
          {
            id: 'effect-role-percent',
            type: 'concept_delta',
            conceptId: ROLE_TARGET_INCOME,
            monthOffsets: [0],
            mode: 'percent',
            value: 0.1,
          },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ], []);

    const roleCell = evaluation.cells.get(
      scenarioCellKey('scenario-1', ROLE_TARGET_INCOME, '2026-01'),
    );

    expect(roleCell?.baseValue).toBe(0);
    expect(roleCell?.finalValue).toBe(10);
    expect(evaluation.metrics.ingresos[0]).toBe(110);
    expect(evaluation.metrics.cajaFinal[0]).toBe(120);
  });
});
