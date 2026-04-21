import { describe, expect, it } from 'vitest';
import { evaluateScenario } from './scenarioEngine';
import { buildProposalEffects } from './proposalCompiler';
import {
  createScenarioOverride,
  createTestPlan,
  createTestSimulation,
  createTestScenario,
  createTestProposals,
} from '../test/fixtures';
import { FlowPlan, ROLE_TARGET_INCOME, Proposal, scenarioCellKey } from '../types';

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

function createCitiPlan(): FlowPlan {
  const citiSeries = [205.2, 191.6, 217.1, 228.3, 227.6, 230.1, 294.2, 241.9, 268.8, 323.9, 252.5, 271];
  const otherIncomeSeries = [85.5, 61.9, 86.6, 109.2, 90.4, 67.4, 97.3, 80.1, 68.5, 83.9, 70.1, 87.5];
  const totalIncomeSeries = citiSeries.map((value, index) => value + otherIncomeSeries[index]);

  return {
    name: 'Plan Citi',
    year: 2026,
    cajaInicial: 50,
    weekDates: [],
    concepts: [
      {
        id: 'income-root',
        excelRow: 7,
        name: 'Ingresos',
        parentId: null,
        responsible: null,
        conceptType: 'ingreso',
        sortOrder: 0,
        weeklyData: [],
        monthlyData: totalIncomeSeries,
      },
      {
        id: 'citi',
        excelRow: 8,
        name: 'Citi',
        parentId: 'income-root',
        responsible: null,
        conceptType: 'ingreso',
        sortOrder: 1,
        weeklyData: [],
        monthlyData: citiSeries,
      },
      {
        id: 'other-income',
        excelRow: 9,
        name: 'Otros ingresos',
        parentId: 'income-root',
        responsible: null,
        conceptType: 'ingreso',
        sortOrder: 2,
        weeklyData: [],
        monthlyData: otherIncomeSeries,
      },
      {
        id: 'expense-root',
        excelRow: 14,
        name: 'Egresos',
        parentId: null,
        responsible: null,
        conceptType: 'egreso',
        sortOrder: 3,
        weeklyData: [],
        monthlyData: Array(12).fill(0),
      },
    ],
  };
}

describe('scenarioEngine', () => {
  it('stacks percent and absolute proposals deterministically on the same cell', () => {
    const plan = createTestPlan();
    const simulation = createTestSimulation();
    const scenario = createTestScenario();
    const evaluation = evaluateScenario(plan, simulation, scenario, createTestProposals(), []);

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
    expect(leafCell?.proposalContributions).toHaveLength(2);
  });

  it('keeps overrides isolated per scenario', () => {
    const plan = createTestPlan();
    const simulation = createTestSimulation();
    const scenarioA = createTestScenario({ id: 'scenario-1' });
    const scenarioB = createTestScenario({
      id: 'scenario-2',
      simulationId: 'simulation-1',
      name: 'Escenario Alterno',
      proposalIds: ['proposal-percent', 'proposal-absolute'],
    });

    const evaluationA = evaluateScenario(
      plan,
      simulation,
      scenarioA,
      createTestProposals(),
      [createScenarioOverride(120)],
    );
    const evaluationB = evaluateScenario(
      plan,
      simulation,
      scenarioB,
      createTestProposals(),
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
    const simulation = createTestSimulation();
    const scenario = createTestScenario();

    const withOverride = evaluateScenario(
      plan,
      simulation,
      scenario,
      createTestProposals(),
      [createScenarioOverride(120)],
    );
    const restored = evaluateScenario(
      plan,
      simulation,
      scenario,
      createTestProposals(),
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
    const simulation = createTestSimulation();
    const scenario = createTestScenario({
      proposalIds: ['proposal-role-percent'],
    });

    const evaluation = evaluateScenario(plan, simulation, scenario, [
      {
        id: 'proposal-role-percent',
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

  it('supports weekly and daily forecast views from the same scenario', () => {
    const plan = createGranularPlan(310);
    const simulation = createTestSimulation();
    const scenario = createTestScenario({
      startYearMonth: '2026-01',
      horizonMonths: 1,
      proposalIds: [],
    });

    const weeklyEvaluation = evaluateScenario(plan, simulation, scenario, [], [], { granularity: 'weekly' });
    const dailyEvaluation = evaluateScenario(plan, simulation, scenario, [], [], { granularity: 'daily' });

    const weeklyCell = weeklyEvaluation.cells.get(
      scenarioCellKey('scenario-1', 'income-leaf', 'week:2026-01-01'),
    );
    const dailyCell = dailyEvaluation.cells.get(
      scenarioCellKey('scenario-1', 'income-leaf', '2026-01-01'),
    );

    expect(weeklyEvaluation.months).toHaveLength(5);
    expect(dailyEvaluation.months).toHaveLength(31);
    expect(weeklyCell?.finalValue).toBe(70);
    expect(dailyCell?.finalValue).toBe(10);
  });

  it('prorates percent adjustments from the exact simulation start date', () => {
    const plan = createGranularPlan(310);
    const simulation = createTestSimulation();
    const scenario = createTestScenario({
      startYearMonth: '2026-01',
      horizonMonths: 1,
      proposalIds: ['proposal-mid-month-percent'],
    });

    const proposal = {
      id: 'proposal-mid-month-percent',
      name: 'Ingresos +10% desde mitad de mes',
      description: 'Empieza el 16 de enero',
      category: 'Incremento de Ingresos' as const,
      type: 'percent_adjustment' as const,
      targetIds: ['income-leaf'],
      startYearMonth: '2026-01',
      endYearMonth: '2026-01',
      startDate: '2026-01-16',
      endDate: '2026-01-31',
      frequency: 'once' as const,
      operation: 'increase' as const,
      percent: 0.1,
      effects: [
        {
          id: 'effect-mid-month',
          type: 'concept_delta' as const,
          conceptId: 'income-leaf',
          yearMonths: ['2026-01'],
          startDate: '2026-01-16',
          endDate: '2026-01-31',
          mode: 'percent' as const,
          value: 0.1,
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const monthlyEvaluation = evaluateScenario(plan, simulation, scenario, [proposal], []);
    const dailyEvaluation = evaluateScenario(plan, simulation, scenario, [proposal], [], { granularity: 'daily' });

    const monthlyCell = monthlyEvaluation.cells.get(
      scenarioCellKey('scenario-1', 'income-leaf', '2026-01'),
    );
    const dayBeforeStart = dailyEvaluation.cells.get(
      scenarioCellKey('scenario-1', 'income-leaf', '2026-01-15'),
    );
    const firstActiveDay = dailyEvaluation.cells.get(
      scenarioCellKey('scenario-1', 'income-leaf', '2026-01-16'),
    );

    expect(monthlyCell?.finalValue).toBeCloseTo(326, 5);
    expect(dayBeforeStart?.finalValue).toBe(10);
    expect(firstActiveDay?.finalValue).toBe(11);
  });

  it('keeps a one-time amount in March and applies 10% to Citi only from April 21, 2026', () => {
    const plan = createCitiPlan();
    const simulation = createTestSimulation();
    const scenario = createTestScenario({
      startYearMonth: '2026-01',
      horizonMonths: 12,
      proposalIds: ['proposal-citi-percent', 'proposal-asset-sale'],
    });

    const percentProposal: Proposal = {
      id: 'proposal-citi-percent',
      name: 'Citi +10%',
      description: 'Incrementa Citi desde el 21 de abril',
      category: 'Incremento de Ingresos' as const,
      type: 'percent_adjustment' as const,
      targetIds: ['citi'],
      startYearMonth: '2026-04',
      endYearMonth: '2026-12',
      startDate: '2026-04-21',
      endDate: '2026-12-31',
      frequency: 'monthly' as const,
      operation: 'increase' as const,
      percent: 0.1,
      effects: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const amountProposal: Proposal = {
      id: 'proposal-asset-sale',
      name: 'Venta de activo',
      description: 'Pago único en marzo',
      category: 'Incremento de Ingresos' as const,
      type: 'amount_adjustment' as const,
      targetIds: ['citi'],
      startYearMonth: '2026-03',
      endYearMonth: '2026-03',
      startDate: '2026-03-01',
      endDate: '2026-03-01',
      frequency: 'once' as const,
      operation: 'increase' as const,
      amount: 21,
      effects: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    percentProposal.effects = buildProposalEffects(plan, percentProposal);
    amountProposal.effects = buildProposalEffects(plan, amountProposal);

    const evaluation = evaluateScenario(plan, simulation, scenario, [percentProposal, amountProposal], []);

    const marchCiti = evaluation.cells.get(scenarioCellKey('scenario-1', 'citi', '2026-03'));
    const aprilCiti = evaluation.cells.get(scenarioCellKey('scenario-1', 'citi', '2026-04'));
    const mayCiti = evaluation.cells.get(scenarioCellKey('scenario-1', 'citi', '2026-05'));
    const juneCiti = evaluation.cells.get(scenarioCellKey('scenario-1', 'citi', '2026-06'));
    const marchRoot = evaluation.cells.get(scenarioCellKey('scenario-1', 'income-root', '2026-03'));

    expect(marchCiti?.finalValue).toBeCloseTo(238.1, 5);
    expect(marchCiti?.finalValue! - marchCiti?.baseValue!).toBeCloseTo(21, 5);
    expect(aprilCiti?.finalValue! - aprilCiti?.baseValue!).toBeCloseTo(7.61, 2);
    expect(mayCiti?.finalValue! - mayCiti?.baseValue!).toBeCloseTo(22.76, 2);
    expect(juneCiti?.proposalContributions).toEqual([
      {
        proposalId: 'proposal-citi-percent',
        proposalName: 'Citi +10%',
        delta: 23.01,
      },
    ]);
    expect(marchRoot?.finalValue! - marchRoot?.baseValue!).toBeCloseTo(21, 5);
    expect(evaluation.kpis.ingresos12m).toBeCloseTo(4180.21, 2);
  });
});
