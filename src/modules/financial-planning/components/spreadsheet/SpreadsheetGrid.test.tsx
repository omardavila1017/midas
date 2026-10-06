import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CellOverride, PlanningRow } from '../../../shared-finance/types';
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
  // El motor (`applyCellOverridesToBuckets`) salta los overrides de una columna
  // cerrada. El grid no lo hacía: un override capturado sobre un mes futuro
  // seguía PINTÁNDOSE (celda + total del bucket) cuando ese mes cerraba, pero ya
  // no entraba en Neto ni en Caja final. La pantalla contradecía al motor sobre
  // el mismo dinero, y el usuario no podía corregirlo (la columna cerrada no es
  // editable).
  it('una columna CERRADA ignora el override y muestra el agregado real', () => {
    const stale: CellOverride = {
      id: 'co-1',
      scenarioId: 'approved',
      conceptKey: row.conceptKey,
      granularity: 'monthly',
      bucketKey: '2026-04-01',
      type: 'INFLOW',
      mode: 'REPLACE',
      value: 999,
      createdBy: 'tester',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    };
    renderPastGrid(stale);

    // `baseValueFor` devuelve 100 en toda celda; el override valdría 999.
    expect(screen.queryAllByText(/999/).length).toBe(0);
  });

  // La selección vive por ÍNDICE, pero una ola de rebuild en segundo plano
  // reordena las filas mientras el usuario teclea (INVARIANTE DE ESTABILIDAD).
  // Resolver la fila por índice AL CONFIRMAR escribía el monto en otra fila.
  it('confirma sobre la fila que se empezó a editar aunque las filas se reordenen', () => {
    const onCommitCell = vi.fn();
    const filaA = { ...row, conceptKey: 'INFLOW:AR_COLLECTION:a', label: 'Cliente A' };
    const filaB = { ...row, conceptKey: 'INFLOW:AR_COLLECTION:b', label: 'Cliente B' };
    const { rerender } = render(editableGrid([filaA, filaB], onCommitCell));

    fireEvent.click(screen.getByText('Clientes'));
    fireEvent.doubleClick(cellOfRow('Cliente A')); // abre el editor sobre Cliente A

    // Llega el rebuild con una fila que ORDENA ANTES (el grid ordena por label),
    // así que el índice que tenía Cliente A pasa a ser de otra fila.
    const filaNueva = { ...row, conceptKey: 'INFLOW:AR_COLLECTION:nueva', label: 'Abarrotes del Norte' };
    rerender(editableGrid([filaNueva, filaA, filaB], onCommitCell));

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '500' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onCommitCell).toHaveBeenCalledWith('INFLOW:AR_COLLECTION:a', '2026-05-01', 500, 'INFLOW');
  });

  // Hermano del caso de arriba: si la columna CIERRA entre que se abre el
  // editor y se confirma, el override iría a un bucket que el motor ignora y
  // que la UI ya no deja editar ni limpiar.
  it('descarta la edición si la columna cerró mientras se editaba', () => {
    const onCommitCell = vi.fn();
    const { rerender } = render(editableGrid([row], onCommitCell));

    fireEvent.click(screen.getByText('Clientes'));
    fireEvent.doubleClick(cellOfRow('Cliente A'));

    rerender(editableGrid([row], onCommitCell, true));

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '500' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(onCommitCell).not.toHaveBeenCalled();
  });

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

  it('orders outflow buckets alphabetically and pushes the residual ones to the end', () => {
    renderGrid(vi.fn(), [
      outflowRow('OUTFLOW:TRANSFER:sin-identificar', 'Sin identificar', 'Egresos bancarios sin identificar', 'TRANSFER'),
      outflowRow('OUTFLOW:AP_PAYMENT:sin-clase', 'Proveedor sin clase', 'Sin clasificación de pago', 'AP_PAYMENT'),
      outflowRow('OUTFLOW:TAX:iva', 'SAT — IVA', 'Impuestos', 'TAX'),
      outflowRow('OUTFLOW:AP_PAYMENT:autopistas', 'PASE', 'Servicios · 160 - Autopistas', 'AP_PAYMENT'),
    ]);

    expect(screen.queryByText('Otros')).toBeNull();
    expect(screen.queryByText('Otros egresos')).toBeNull();
    expect(screen.getByText('Egresos bancarios sin identificar')).toBeTruthy();

    // Clasificación real primero (alfabético), residuos al final.
    expect(appearsBefore('Impuestos', 'Servicios · 160 - Autopistas')).toBe(true);
    expect(appearsBefore('Servicios · 160 - Autopistas', 'Sin clasificación de pago')).toBe(true);
    expect(appearsBefore('Sin clasificación de pago', 'Egresos bancarios sin identificar')).toBe(true);
  });

  it('agrupa por la clasificación de pago cruda, sin colgar el sufijo de categoría', () => {
    renderGrid(vi.fn(), [
      outflowRow('OUTFLOW:AP_PAYMENT:taller-a', 'Taller A', 'Servicios · 010 - Refacciones y Llantas', 'AP_PAYMENT', 'TALLER ATENCION ACCIDENTES'),
      outflowRow('OUTFLOW:AP_PAYMENT:taller-b', 'Taller B', 'Servicios · 010 - Refacciones y Llantas', 'AP_PAYMENT', 'TALLER ATENCION ACCIDENTES'),
      outflowRow('OUTFLOW:AP_PAYMENT:chasis', 'Chasis Norte', 'Directos · 020 - Chasis', 'AP_PAYMENT', 'CHASIS'),
      outflowRow('OUTFLOW:AP_PAYMENT:ti', 'Soporte TI', 'Servicios · 180 - Proveedores TI', 'AP_PAYMENT', 'TECNOLOGIA Y SOPORTE'),
    ]);

    // El grupo es EXACTAMENTE el par crudo. Antes se le colgaba
    // `· <categoría generalizada>` (`Flota · Taller`), lo que partía el mismo
    // valor de JDE en varios grupos y duplicaba la información.
    expect(screen.getByText('Servicios · 010 - Refacciones y Llantas')).toBeTruthy();
    expect(screen.getByText('Directos · 020 - Chasis')).toBeTruthy();
    expect(screen.getByText('Servicios · 180 - Proveedores TI')).toBeTruthy();
    expect(screen.queryByText('Flota · Taller')).toBeNull();
    expect(screen.queryByText('Taller A')).toBeNull();
    expect(screen.queryByText('Chasis Norte')).toBeNull();

    // Los dos talleres comparten clasificación → viven en el MISMO grupo.
    fireEvent.click(screen.getByRole('button', { name: /Servicios · 010 - Refacciones y Llantas/ }));

    expect(screen.getByText('Taller A')).toBeTruthy();
    expect(screen.getByText('Taller B')).toBeTruthy();
    expect(screen.queryByText('Chasis Norte')).toBeNull();
    expect(appearsBefore('Directos · 020 - Chasis', 'Servicios · 010 - Refacciones y Llantas')).toBe(true);
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

function editableGrid(
  rows: PlanningRow[],
  onCommitCell: (conceptKey: string, bucketKey: string, value: number, type: PlanningRow['type']) => void,
  columnClosed = false,
) {
  return (
    <SpreadsheetGrid
      rows={rows}
      columns={[{ key: '2026-05-01', label: 'May', isPast: columnClosed, isCurrent: !columnClosed }]}
      granularity="monthly"
      isReadOnly={false}
      asOfDate="2026-05-01"
      baseValueFor={() => 100}
      overrideFor={() => undefined}
      totalsFor={() => 100}
      onCommitCell={onCommitCell}
      onClearCell={() => {}}
      onAddRow={() => {}}
      onInspectCell={() => {}}
    />
  );
}

function renderPastGrid(override: CellOverride | undefined) {
  return render(
    <SpreadsheetGrid
      rows={[row]}
      columns={[
        { key: '2026-04-01', label: 'Abr', isPast: true, isCurrent: false },
        { key: '2026-05-01', label: 'May', isPast: false, isCurrent: true },
      ]}
      granularity="monthly"
      isReadOnly={false}
      asOfDate="2026-05-01"
      baseValueFor={() => 100}
      overrideFor={(_c, bucketKey) => (bucketKey === '2026-04-01' ? override : undefined)}
      totalsFor={() => 100}
      onCommitCell={() => {}}
      onClearCell={() => {}}
      onAddRow={() => {}}
      onInspectCell={() => {}}
    />,
  );
}

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

function cellOfRow(label: string): HTMLElement {
  const rowElement = screen.getByRole('button', { name: label }).closest('[role="row"]');
  const cell = rowElement?.querySelector('[role="gridcell"]');
  if (!cell) throw new Error(`Celda no encontrada para ${label}`);
  return cell as HTMLElement;
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
