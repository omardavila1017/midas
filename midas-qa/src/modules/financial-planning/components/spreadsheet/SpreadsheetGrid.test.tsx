import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanningRow } from '../../../shared-finance/types';
import { SpreadsheetGrid } from './SpreadsheetGrid';

const row: PlanningRow = {
  conceptKey: 'INFLOW:AR_COLLECTION:test',
  label: 'Cliente A',
  group: 'Ingresos',
  bucketLabel: 'Clientes',
  type: 'INFLOW',
  category: 'AR_COLLECTION',
};

describe('<SpreadsheetGrid />', () => {
  it('selects cells on click without opening the advanced inspector', () => {
    const onInspectCell = vi.fn();
    renderGrid(onInspectCell);

    fireEvent.click(screen.getByText('Clientes'));
    fireEvent.click(dataCell());

    expect(onInspectCell).not.toHaveBeenCalled();
  });

  it('opens the advanced inspector with the i shortcut', () => {
    const onInspectCell = vi.fn();
    renderGrid(onInspectCell);

    fireEvent.click(screen.getByText('Clientes'));
    fireEvent.click(dataCell());
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'i' });

    expect(onInspectCell).toHaveBeenCalledWith(row.conceptKey, '2026-05-01');
  });
});

function renderGrid(onInspectCell: (conceptKey: string, bucketKey: string) => void) {
  return render(
    <SpreadsheetGrid
      rows={[row]}
      columns={[{ key: '2026-05-01', label: 'May', isPast: false, isCurrent: true }]}
      granularity="monthly"
      isReadOnly={false}
      asOfDate="2026-05-01"
      baseValueFor={() => 100}
      overrideFor={() => undefined}
      totalsFor={() => 100}
      onCommitCell={() => {}}
      onClearCell={() => {}}
      onAddRow={() => {}}
      onInspectCell={onInspectCell}
    />,
  );
}

function dataCell(): HTMLElement {
  const rowButton = screen.getByRole('button', { name: 'Cliente A' });
  const rowElement = rowButton.closest('[role="row"]');
  const cell = rowElement?.querySelector('[role="gridcell"]');
  if (!cell) throw new Error('Data cell not found');
  return cell as HTMLElement;
}
