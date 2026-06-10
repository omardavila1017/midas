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

  it('reports the clicked data cell via onClickCell with its exact bucket', () => {
    const onClickCell = vi.fn();
    renderGrid(vi.fn(), [row], onClickCell);

    fireEvent.click(screen.getByText('Clientes'));
    fireEvent.click(dataCell());

    expect(onClickCell).toHaveBeenCalledWith(row.conceptKey, '2026-05-01');
  });

  it('does not fire onClickCell on bucket header clicks', () => {
    const onClickCell = vi.fn();
    renderGrid(vi.fn(), [row], onClickCell);

    fireEvent.click(screen.getByText('Clientes'));

    expect(onClickCell).not.toHaveBeenCalled();
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

  // Los footers sticky (Neto/Caja) deben tapar TODO lo que scrollea por
  // debajo. Las celdas sticky de etiqueta de fila (z 15) y el botón del header
  // de sección (z 18) crean stacking contexts hermanos en el contexto raíz del
  // grid: si el footer queda con z menor, las etiquetas se pintan ENCIMA de
  // Neto/Caja (filas "fantasma" bajo la Caja, parecen inalcanzables) e
  // interceptan sus clicks. Regresión del bug de scroll de Planeación.
  it('stacks the sticky footers above row label cells and section headers', () => {
    renderGrid(vi.fn());

    const footerZ = (label: string): number => {
      const footerRow = screen.getByText(label).closest('[role="row"]') as HTMLElement;
      return Number(footerRow.style.zIndex);
    };

    const labelCell = screen.getByText('Clientes').closest('button')?.parentElement as HTMLElement;
    const labelCellZ = Number(labelCell.style.zIndex);
    const sectionButton = screen.getByRole('button', { name: /^Ingresos/ });
    const sectionZ = Number((sectionButton as HTMLElement).style.zIndex);
    const headerCell = screen.getByText('Concepto').closest('div') as HTMLElement;
    const headerZ = Number(headerCell.style.zIndex);

    for (const label of ['Neto', 'Caja final']) {
      expect(footerZ(label)).toBeGreaterThan(labelCellZ);
      expect(footerZ(label)).toBeGreaterThan(sectionZ);
      // El header de columnas sigue por encima del footer (scroll vertical).
      expect(footerZ(label)).toBeLessThan(headerZ);
    }
  });
});

function renderGrid(
  onInspectCell: (conceptKey: string, bucketKey: string) => void,
  rows: PlanningRow[] = [row],
  onClickCell?: (conceptKey: string, bucketKey: string) => void,
) {
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
      onClickCell={onClickCell}
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
