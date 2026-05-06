import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CellDetailPopover, type CellDetailData } from './CellDetailPopover';

function fixture(overrides: Partial<CellDetailData> = {}): CellDetailData {
  return {
    conceptKey: 'INFLOW.client.acme',
    conceptLabel: 'Cobranza ACME',
    bucketKey: '2026-08',
    bucketLabel: 'Ago 2026',
    scenarioName: 'Escenario Optimista',
    isBaseScenario: false,
    baseValue: 1_000_000,
    manualOverride: null,
    overrideComment: null,
    totalValue: 1_000_000,
    diffVsBase: 0,
    ...overrides,
  };
}

describe('<CellDetailPopover />', () => {
  it('renders concept, scenario and base value', () => {
    render(<CellDetailPopover data={fixture()} onClose={() => {}} />);
    expect(screen.getByText('Cobranza ACME')).toBeTruthy();
    expect(screen.getByText(/Ago 2026/)).toBeTruthy();
    expect(screen.getByText(/Escenario Optimista/)).toBeTruthy();
  });

  it('returns null when data is null', () => {
    const { container } = render(<CellDetailPopover data={null} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows lock badge for Base scenario and hides sensitivity slider', () => {
    const { container } = render(
      <CellDetailPopover
        data={fixture({ isBaseScenario: true, scenarioName: 'Escenario Base' })}
        onClose={() => {}}
        onApplyOverride={() => {}}
      />,
    );
    // Lock badge is a small uppercase span containing "base".
    const badges = Array.from(container.querySelectorAll('span')).filter(
      (el) => el.textContent?.trim().toLowerCase() === 'base',
    );
    expect(badges.length).toBeGreaterThan(0);
    expect(screen.queryByText('Sensibilidad')).toBeNull();
  });

  it('renders sensitivity slider on non-Base scenario when onApplyOverride given', () => {
    render(
      <CellDetailPopover
        data={fixture()}
        onClose={() => {}}
        onApplyOverride={() => {}}
      />,
    );
    expect(screen.getByText('Sensibilidad')).toBeTruthy();
    expect(screen.getByRole('button', { name: /aplicar/i })).toHaveProperty('disabled', true);
  });

  it('enables Aplicar and emits the previewed value when slider moves', () => {
    const onApply = vi.fn();
    render(
      <CellDetailPopover
        data={fixture({ baseValue: 1_000_000 })}
        onClose={() => {}}
        onApplyOverride={onApply}
      />,
    );
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '10' } });
    const applyBtn = screen.getByRole('button', { name: /aplicar/i });
    expect(applyBtn).toHaveProperty('disabled', false);
    fireEvent.click(applyBtn);
    expect(onApply).toHaveBeenCalledWith(1_100_000);
  });

  it('closes when Esc is pressed', () => {
    const onClose = vi.fn();
    render(<CellDetailPopover data={fixture()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
