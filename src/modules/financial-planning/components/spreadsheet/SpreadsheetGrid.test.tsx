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

  it('orders outflow buckets explicitly and uses the unidentified bank fallback label', () => {
    renderGrid(vi.fn(), [
      outflowRow('OUTFLOW:TRANSFER:sin-identificar', 'Sin identificar', 'Egresos bancarios sin identificar', 'TRANSFER'),
      outflowRow('OUTFLOW:AP_PAYMENT:proveedor-sin-categoria', 'Proveedor sin categoría', 'Proveedores sin categoría', 'AP_PAYMENT'),
      outflowRow('OUTFLOW:TAX:iva', 'SAT — IVA', 'Impuestos', 'TAX'),
      outflowRow('OUTFLOW:AP_PAYMENT:flota', 'Proveedor Flota', 'Flota', 'AP_PAYMENT'),
    ]);

    expect(screen.queryByText('Otros')).toBeNull();
    expect(screen.queryByText('Otros egresos')).toBeNull();
    expect(screen.getByText('Egresos bancarios sin identificar')).toBeTruthy();

    expect(appearsBefore('Flota', 'Proveedores sin categoría')).toBe(true);
    expect(appearsBefore('Proveedores sin categoría', 'Impuestos')).toBe(true);
    expect(appearsBefore('Impuestos', 'Egresos bancarios sin identificar')).toBe(true);
  });

  it('separates supplier outflows into category sections and keeps providers hidden until click', () => {
    renderGrid(vi.fn(), [
      outflowRow('OUTFLOW:AP_PAYMENT:taller-a', 'Taller A', 'Flota', 'AP_PAYMENT', 'TALLER ATENCION ACCIDENTES'),
      outflowRow('OUTFLOW:AP_PAYMENT:taller-b', 'Taller B', 'Flota', 'AP_PAYMENT', 'TALLER ATENCION ACCIDENTES'),
      outflowRow('OUTFLOW:AP_PAYMENT:chasis', 'Chasis Norte', 'Flota', 'AP_PAYMENT', 'CHASIS'),
      outflowRow('OUTFLOW:AP_PAYMENT:refacciones', 'Refacciones Norte', 'Flota', 'AP_PAYMENT', 'REFACCIONARIO'),
      outflowRow('OUTFLOW:AP_PAYMENT:ti', 'Soporte TI', 'Proveedor TI', 'AP_PAYMENT', 'TECNOLOGIA Y SOPORTE'),
    ]);

    expect(screen.getByText('Flota · Taller')).toBeTruthy();
    expect(screen.getByText('Flota · Chasis')).toBeTruthy();
    expect(screen.getByText('Flota · Refacciones')).toBeTruthy();
    expect(screen.getByText('Proveedor TI · Tecnologia y Soporte')).toBeTruthy();
    expect(screen.queryByText('Taller A')).toBeNull();
    expect(screen.queryByText('Taller B')).toBeNull();
    expect(screen.queryByText('Chasis Norte')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Flota · Taller/ }));

    expect(screen.getByText('Taller A')).toBeTruthy();
    expect(screen.getByText('Taller B')).toBeTruthy();
    expect(screen.queryByText('Chasis Norte')).toBeNull();
    expect(appearsBefore('Flota · Taller', 'Flota · Refacciones')).toBe(true);
  });
});

function renderGrid(onInspectCell: (conceptKey: string, bucketKey: string) => void, rows: PlanningRow[] = [row]) {
  return render(
    <SpreadsheetGrid
      rows={rows}
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

function outflowRow(
  conceptKey: string,
  label: string,
  bucketLabel: string,
  category: PlanningRow['category'],
  providerCategoryLabel?: string,
): PlanningRow {
  return {
    conceptKey,
    label,
    group: `Egresos · ${bucketLabel}`,
    bucketLabel,
    type: 'OUTFLOW',
    category,
    providerCategoryLabel,
  };
}

function appearsBefore(firstText: string, secondText: string): boolean {
  const first = screen.getByText(firstText);
  const second = screen.getByText(secondText);
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}
