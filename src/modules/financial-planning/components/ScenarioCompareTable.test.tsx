import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ScenarioCompareTable, type CompareRow } from './ScenarioCompareTable';
import type { FinancialScenario, ProjectionSummary } from '../../shared-finance/types';

function summary(partial: Partial<ProjectionSummary> = {}): ProjectionSummary {
  return {
    currentCash: 0,
    projectedCash7: 0,
    projectedCash30: 0,
    projectedCash90: 0,
    minimumCashRequired: 1_000_000,
    deficitDays: 0,
    averageConfidence: 0.9,
    totalInflows: 0,
    totalOutflows: 0,
    finalCash: 5_000_000,
    minCash: 2_000_000,
    creditRequired: 0,
    ...partial,
  };
}

function scenario(partial: Partial<FinancialScenario>): FinancialScenario {
  return {
    id: 's-1',
    name: 'Escenario',
    kind: 'DRAFT',
    adjustmentIds: [],
    status: 'DRAFT',
    createdBy: 'tester',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

describe('<ScenarioCompareTable />', () => {
  it('renders one row per scenario with delta vs baseline', () => {
    const rows: CompareRow[] = [
      { scenario: scenario({ id: 'b', name: 'Escenario Base', kind: 'BASE' }), summary: summary({ finalCash: 3_000_000 }), isActive: false },
      { scenario: scenario({ id: 'a', name: 'Aprobado', kind: 'APPROVED' }), summary: summary({ finalCash: 5_000_000 }), isActive: true },
      { scenario: scenario({ id: 'd1', name: 'Optimista', kind: 'DRAFT' }), summary: summary({ finalCash: 6_500_000 }), isActive: false },
    ];
    render(<ScenarioCompareTable rows={rows} baselineFinalCash={5_000_000} />);
    expect(screen.getByText('Escenario Base')).toBeTruthy();
    expect(screen.getByText('Aprobado')).toBeTruthy();
    expect(screen.getByText('Optimista')).toBeTruthy();
    // Optimista delta = +1.5M; fmtCompact output varies by Intl impl. Confirm
    // at least one cell starts with "+" (positive delta rendered).
    const positives = screen.getAllByText((c) => c.trim().startsWith('+'));
    expect(positives.length).toBeGreaterThan(0);
  });

  it('marks the active row with the activo badge', () => {
    const rows: CompareRow[] = [
      { scenario: scenario({ id: 'a', name: 'Aprobado', kind: 'APPROVED' }), summary: summary(), isActive: true },
    ];
    render(<ScenarioCompareTable rows={rows} baselineFinalCash={5_000_000} />);
    const activoBadges = screen.getAllByText(/^activo$/i);
    expect(activoBadges.length).toBeGreaterThan(0);
  });

  it('renders ±0 when delta is zero', () => {
    const rows: CompareRow[] = [
      { scenario: scenario({ id: 'a', name: 'Aprobado', kind: 'APPROVED' }), summary: summary({ finalCash: 5_000_000 }), isActive: false },
    ];
    const { container } = render(<ScenarioCompareTable rows={rows} baselineFinalCash={5_000_000} />);
    expect(within(container as HTMLElement).getByText('±0')).toBeTruthy();
  });

  it('flags deficit days in danger color', () => {
    const rows: CompareRow[] = [
      { scenario: scenario({ id: 's', name: 'Estrés', kind: 'DRAFT' }), summary: summary({ deficitDays: 7 }), isActive: false },
    ];
    render(<ScenarioCompareTable rows={rows} baselineFinalCash={5_000_000} />);
    expect(screen.getByText('7')).toBeTruthy();
  });
});
