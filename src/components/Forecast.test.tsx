import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Forecast from './Forecast';
import { FlowPlan, Proposal, Scenario } from '../types';

function createLeafOnlyPlan(): FlowPlan {
  return {
    name: 'Plan Smoke',
    year: 2026,
    cajaInicial: 25,
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
        monthlyData: Array(12).fill(100),
      },
      {
        id: 'expense-root',
        excelRow: 14,
        name: 'Egresos',
        parentId: null,
        responsible: null,
        conceptType: 'egreso',
        sortOrder: 1,
        weeklyData: [],
        monthlyData: Array(12).fill(40),
      },
    ],
  };
}

function createProposal(): Proposal {
  return {
    id: 'proposal-smoke',
    name: 'Propuesta Smoke',
    description: '',
    status: 'Pendiente',
    activeScenarioId: 'scenario-smoke',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function createScenario(): Scenario {
  return {
    id: 'scenario-smoke',
    proposalId: 'proposal-smoke',
    kind: 'proposal',
    name: 'Escenario Smoke',
    description: '',
    probability: 1,
    startYearMonth: '2026-01',
    horizonMonths: 12,
    simulationIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('Forecast', () => {
  it('emits a scenario-scoped override when an editable cell is changed', async () => {
    const onOverridesChange = vi.fn();
    const proposal = createProposal();
    const scenario = createScenario();
    const { container } = render(
      <Forecast
        plan={createLeafOnlyPlan()}
        view="drivers"
        proposals={[proposal]}
        scenarios={[scenario]}
        simulations={[]}
        activeProposalId={proposal.id}
        activeScenarioId={scenario.id}
        overrides={[]}
        onSelectProposal={() => undefined}
        onSelectScenario={() => undefined}
        onOverridesChange={onOverridesChange}
      />,
    );

    expect(screen.getByText('Drivers')).toBeTruthy();

    const firstValueCell = container.querySelector('tbody tr td:nth-child(2)') as HTMLElement;
    fireEvent.doubleClick(firstValueCell);

    const input = await screen.findByDisplayValue('100');
    fireEvent.change(input, { target: { value: '120' } });
    fireEvent.blur(input);

    expect(onOverridesChange).toHaveBeenCalledTimes(1);
    const nextOverrides = onOverridesChange.mock.calls[0][0];
    expect(nextOverrides).toHaveLength(1);
    expect(nextOverrides[0].scenarioId).toBe('scenario-smoke');
    expect(nextOverrides[0].conceptId).toBe('income-root');
    expect(nextOverrides[0].yearMonth).toBe('2026-01');
    expect(nextOverrides[0].manualValue).toBe(120);
  });
});
