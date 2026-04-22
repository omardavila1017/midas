import { describe, expect, it } from 'vitest';
import { evaluateScenario } from './scenarioEngine';
import {
  createScenarioOverride,
  createTestPlan,
  createTestSimulation,
  createTestScenario,
  createTestProposals,
} from '../test/fixtures';
import { FlowPlan, scenarioCellKey } from '../types';

function createGranularPlan(monthlyIncome = 310): FlowPlan {
  return {
    name: 'Plan Granular',
    year: 2026,
    cajaInicial: 50,
    weekDates: ['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22', '2026-01-29'],
    concepts: [
      {
        id: 'income-root',
        excelRow: 7,
        name: 'Ingresos',
        parentId: null,
        responsible: null,
        conceptType: 'ingreso',
        sortOrder: 0,
        weeklyData: [70, 70, 70, 70, 30],
        monthlyData: [monthlyIncome, ...Array(11).fill(0)],
      },
      {
        id: 'income-leaf',
        excelRow: 8,
        name: 'Federal',
        parentId: 'income-root',
        responsible: null,
        conceptType: 'ingreso',
        sortOrder: 1,
        weeklyData: [70, 70, 70, 70, 30],
        monthlyData: [monthlyIncome, ...Array(11).fill(0)],
      },
      {
        id: 'expense-root',
        excelRow: 14,
        name: 'Egresos',
        parentId: null,
        responsible: null,
        conceptType: 'egreso',
        sortOrder: 2,
        weeklyData: [0, 0, 0, 0, 0],
        monthlyData: Array(12).fill(0),
      },
    ],
  };
}

describe('evaluateScenario', () => {
  it('returns the base plan when there are no proposals and no overrides', () => {
    const plan = createTestPlan();
    const simulation = createTestSimulation();
    const scenario = createTestScenario({ proposalIds: [] });

    const evaluation = evaluateScenario(plan, simulation, scenario, [], []);

    expect(evaluation.months).toHaveLength(12);
    expect(evaluation.metrics.ingresos[0]).toBe(100);
    expect(evaluation.metrics.egresos[0]).toBe(40);
    const cell = evaluation.cells.get(
      scenarioCellKey('scenario-1', 'concept-income-leaf', '2026-01'),
    );
    expect(cell?.baseValue).toBe(100);
    expect(cell?.finalValue).toBe(100);
  });

  it('applies a manual override scoped to the active scenario', () => {
    const plan = createTestPlan();
    const simulation = createTestSimulation();
    const scenario = createTestScenario({ proposalIds: [] });
    const override = createScenarioOverride(120);

    const evaluation = evaluateScenario(plan, simulation, scenario, [], [override]);

    const cell = evaluation.cells.get(
      scenarioCellKey('scenario-1', 'concept-income-leaf', '2026-01'),
    );
    expect(cell?.manualDelta).toBe(20);
    expect(cell?.finalValue).toBe(120);
    expect(cell?.isOverridden).toBe(true);
  });

  it('combines proposals declared as absolute and percent effects', () => {
    const plan = createTestPlan();
    const simulation = createTestSimulation();
    const scenario = createTestScenario();
    const proposals = createTestProposals();

    const evaluation = evaluateScenario(plan, simulation, scenario, proposals, []);

    const cell = evaluation.cells.get(
      scenarioCellKey('scenario-1', 'concept-income-leaf', '2026-01'),
    );
    // percent +10% on 100 = 110, plus absolute +5 = 115
    expect(cell?.finalValue).toBeCloseTo(115, 5);
  });

  it('supports weekly and daily granularity views from the same scenario', () => {
    const plan = createGranularPlan(310);
    const simulation = createTestSimulation();
    const scenario = createTestScenario({
      startYearMonth: '2026-01',
      horizonMonths: 1,
      proposalIds: [],
    });

    const weeklyEvaluation = evaluateScenario(plan, simulation, scenario, [], [], { granularity: 'weekly' });
    const dailyEvaluation = evaluateScenario(plan, simulation, scenario, [], [], { granularity: 'daily' });

    expect(weeklyEvaluation.months.length).toBeGreaterThanOrEqual(4);
    expect(dailyEvaluation.months.length).toBeGreaterThan(25);
  });
});
