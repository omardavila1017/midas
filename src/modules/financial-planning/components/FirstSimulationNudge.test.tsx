import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FirstSimulationNudge } from './FirstSimulationNudge';

const STORAGE_KEY = 'midas.firstSimulationNudge.dismissed.v1';

afterEach(() => {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
});

describe('<FirstSimulationNudge />', () => {
  it('renders the wow-moment headline', () => {
    render(<FirstSimulationNudge onCreateDraft={() => {}} />);
    expect(screen.getByText('Tu pronóstico está listo')).toBeTruthy();
  });

  it('calls onCreateDraft and dismisses on primary CTA', () => {
    const onCreateDraft = vi.fn();
    render(<FirstSimulationNudge onCreateDraft={onCreateDraft} />);
    fireEvent.click(screen.getByRole('button', { name: /crear primera propuesta/i }));
    expect(onCreateDraft).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Tu pronóstico está listo')).toBeNull();
  });

  it('respects persisted dismissal', () => {
    localStorage.setItem(STORAGE_KEY, '1');
    render(<FirstSimulationNudge onCreateDraft={() => {}} />);
    expect(screen.queryByText('Tu pronóstico está listo')).toBeNull();
  });

  it('dismisses via "Más tarde" without creating a draft', () => {
    const onCreateDraft = vi.fn();
    render(<FirstSimulationNudge onCreateDraft={onCreateDraft} />);
    fireEvent.click(screen.getByRole('button', { name: /más tarde/i }));
    expect(onCreateDraft).not.toHaveBeenCalled();
    expect(screen.queryByText('Tu pronóstico está listo')).toBeNull();
  });
});
