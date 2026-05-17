import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CashTroughAlertBanner } from './CashTroughAlertBanner';

afterEach(() => {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('midas.troughBannerDismissed.v1'))
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
});

const baseProps = {
  scenarioId: 's-1',
  scenarioName: 'Pesimista',
  deficitDays: 0,
  minCash: 5_000_000,
  creditRequired: 0,
  minimumCashRequired: 1_000_000,
};

describe('<CashTroughAlertBanner />', () => {
  it('renders nothing when scenario is healthy', () => {
    const { container } = render(<CashTroughAlertBanner {...baseProps} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows critical headline when deficit days > 0', () => {
    render(
      <CashTroughAlertBanner
        {...baseProps}
        deficitDays={3}
        minCash={-200_000}
        maxRiskDate="2026-09-01"
        creditRequired={250_000}
      />,
    );
    expect(screen.getByText(/3 días/)).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('shows warning when minCash dips below minimum but not yet deficit', () => {
    render(
      <CashTroughAlertBanner
        {...baseProps}
        minCash={500_000}
      />,
    );
    expect(screen.getByText(/cerca del umbral/i)).toBeTruthy();
  });

  it('hides after dismiss and persists per-scenario', () => {
    const props = { ...baseProps, deficitDays: 2, minCash: -1, maxRiskDate: '2026-09-01' };
    const { container, rerender } = render(<CashTroughAlertBanner {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /descartar alerta/i }));
    expect(container.firstChild).toBeNull();
    rerender(<CashTroughAlertBanner {...props} />);
    expect(container.firstChild).toBeNull();
  });
});
