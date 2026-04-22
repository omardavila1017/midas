import {
  FlowPlan,
  Simulation,
  Scenario,
  ScenarioCellOverride,
  Proposal,
} from '../types';

export function createTestPlan(): FlowPlan {
  return {
    name: 'Plan Test',
    year: 2026,
    cajaInicial: 50,
    weekDates: [],
    concepts: [
      {
        id: 'concept-income-root',
        excelRow: 7,
        name: 'Ingresos',
        parentId: null,
        responsible: null,
        conceptType: 'ingreso',
        sortOrder: 0,
        weeklyData: [],
        monthlyData: Array(12).fill(100),
      },
      {
        id: 'concept-income-leaf',
        excelRow: 8,
        name: 'Federal',
        parentId: 'concept-income-root',
        responsible: null,
        conceptType: 'ingreso',
        sortOrder: 1,
        weeklyData: [],
        monthlyData: Array(12).fill(100),
      },
      {
        id: 'concept-expense-root',
        excelRow: 14,
        name: 'Nomina',
        parentId: null,
        responsible: null,
        conceptType: 'egreso',
        sortOrder: 2,
        weeklyData: [],
        monthlyData: Array(12).fill(40),
      },
      {
        id: 'concept-expense-leaf',
        excelRow: 15,
        name: 'Semana',
        parentId: 'concept-expense-root',
        responsible: null,
        conceptType: 'egreso',
        sortOrder: 3,
        weeklyData: [],
        monthlyData: Array(12).fill(40),
      },
    ],
  };
}

export function createTestSimulation(): Simulation {
  return {
    id: 'simulation-1',
    name: 'Propuesta Test',
    description: 'Propuesta para pruebas',
    status: 'Pendiente',
    activeScenarioId: 'scenario-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

export function createTestScenario(overrides?: Partial<Scenario>): Scenario {
  return {
    id: 'scenario-1',
    simulationId: 'simulation-1',
    name: 'Escenario prueba',
    description: 'Escenario para pruebas',
    probability: 1,
    startYearMonth: '2026-01',
    horizonMonths: 12,
    proposalIds: ['proposal-percent', 'proposal-absolute'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function createTestProposals(): Proposal[] {
  return [
    {
      id: 'proposal-percent',
      name: 'Incremento 10%',
      description: 'Aumenta ingresos un 10%',
      category: 'aumento_ingresos',
      amount: 10,
      frequency: 'monthly',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      effects: [
        {
          id: 'effect-1',
          type: 'concept_delta',
          conceptId: 'concept-income-leaf',
          monthOffsets: [0],
          mode: 'percent',
          value: 0.1,
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'proposal-absolute',
      name: 'Incremento $5',
      description: 'Suma 5 al mismo concepto',
      category: 'aumento_ingresos',
      amount: 5,
      frequency: 'once',
      startDate: '2026-01-01',
      effects: [
        {
          id: 'effect-2',
          type: 'concept_delta',
          conceptId: 'concept-income-leaf',
          monthOffsets: [0],
          mode: 'absolute',
          value: 5,
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
}

export function createScenarioOverride(manualValue: number): ScenarioCellOverride {
  return {
    key: 'scenario-1::concept-income-leaf::2026-01',
    scenarioId: 'scenario-1',
    conceptId: 'concept-income-leaf',
    yearMonth: '2026-01',
    baseValue: 100,
    simulatedValue: 115,
    manualValue,
    comment: 'ajuste manual',
    editedAt: '2026-01-05T00:00:00.000Z',
  };
}
