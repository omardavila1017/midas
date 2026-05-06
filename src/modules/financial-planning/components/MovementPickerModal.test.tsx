import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MovementPickerModal } from './MovementPickerModal';
import type { FinancialMovement } from '../../shared-finance/types';

function movement(overrides: Partial<FinancialMovement> = {}): FinancialMovement {
  return {
    id: overrides.id ?? 'm-1',
    sourceSystem: 'JDE',
    type: 'OUTFLOW',
    category: 'AP_PAYMENT',
    concept: 'Pago proveedor X',
    counterpartyName: 'Acme S.A.',
    currency: 'MXN',
    originalAmount: 500_000,
    baseAmount: 500_000,
    projectedAmount: 500_000,
    projectedDate: '2026-08-15',
    confidenceScore: 0.9,
    confidenceBand: 'HIGH',
    forecastMethod: 'BASE',
    ...overrides,
  } as FinancialMovement;
}

const ASOF = '2026-08-01';

describe('<MovementPickerModal />', () => {
  it('lists movements within the 90-day horizon', () => {
    render(
      <MovementPickerModal
        movements={[movement({ id: 'm-1', concept: 'Pago renta' })]}
        asOfDate={ASOF}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('Pago renta')).toBeTruthy();
  });

  it('filters out movements outside the 90-day horizon', () => {
    render(
      <MovementPickerModal
        movements={[
          movement({ id: 'm-1', concept: 'Pago cercano', projectedDate: '2026-08-10' }),
          movement({ id: 'm-2', concept: 'Pago lejano', projectedDate: '2027-02-01' }),
        ]}
        asOfDate={ASOF}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText('Pago lejano')).toBeNull();
    expect(screen.getByText('Pago cercano')).toBeTruthy();
  });

  it('search filters by concept', () => {
    render(
      <MovementPickerModal
        movements={[
          movement({ id: 'a', concept: 'Nómina quincenal' }),
          movement({ id: 'b', concept: 'Pago renta oficina' }),
        ]}
        asOfDate={ASOF}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    const input = screen.getByPlaceholderText(/buscar concepto/i);
    fireEvent.change(input, { target: { value: 'renta' } });
    expect(screen.queryByText('Nómina quincenal')).toBeNull();
    expect(screen.getByText('Pago renta oficina')).toBeTruthy();
  });

  it('emits the selected movement on row click', () => {
    const m = movement({ id: 'pick', concept: 'Cobro acme' });
    const onPick = vi.fn();
    render(
      <MovementPickerModal
        movements={[m]}
        asOfDate={ASOF}
        onPick={onPick}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('Cobro acme'));
    expect(onPick).toHaveBeenCalledWith(m);
  });

  it('shows empty state when no candidates match', () => {
    render(
      <MovementPickerModal
        movements={[]}
        asOfDate={ASOF}
        onPick={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/no hay movimientos/i)).toBeTruthy();
  });
});
