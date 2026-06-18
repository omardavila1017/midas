import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Compras from './Compras';
import type { ComprasRecord } from '../services/jde';

function compra(overrides: Partial<ComprasRecord>): ComprasRecord {
  return {
    cia: '00001',
    noProveedor: '100',
    nombreProveedor: 'Proveedor Demo',
    noOrden: 'OC-1',
    tipoOrden: 'OS',
    descTipoOrden: 'Orden de servicio',
    lineaOrden: 1,
    noProducto: 'SKU',
    descProducto: 'Producto',
    concepto: 'Concepto',
    cantidad: 1,
    precioUnitario: 1000,
    importeTotal: 1000,
    moneda: 'MXP',
    tipoCambio: 1,
    fechaPedido: '2026-05-01',
    fechaRecepcion: '',
    diasCredito: 30,
    fechaPagoProyectada: '',
    noFactura: '',
    centroCostos: '101',
    categoria: 'CAT',
    descCategoria: 'Indirectos',
    familia: 'FAM',
    descFamilia: 'Servicios',
    subFamilia: 'SUB',
    descSubFamilia: 'Servicios',
    estadoSiguiente: '',
    tasaFiscal: 'IVA16',
    cancelada: false,
    facturada: false,
    ...overrides,
  };
}

function rows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr'));
}

/** YYYY-MM-DD hace N días (UTC — los offsets de los tests son >1 día, sin riesgo de huso). */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function renderCompras(records: ComprasRecord[]) {
  return render(
    <Compras
      comprasRecords={records}
      comprasLoadedCias={{ __all__: '2026-06-02T00:00:00Z' }}
      selectedCia="all"
      providers={[]}
    />,
  );
}

/** La vista por defecto es el resumen por OC; el detalle por línea es opt-in. */
function enterDetalle() {
  fireEvent.click(screen.getByRole('button', { name: /Detalle por línea/ }));
}

describe('<Compras /> filters and sorting', () => {
  it('searches, filters by ranges, sorts, and clears back to the default order', () => {
    const records = [
      compra({
        noOrden: 'OC-OLD',
        nombreProveedor: 'Proveedor Uno',
        fechaPedido: '2026-04-01',
        fechaRecepcion: '2026-04-05',
        fechaPagoProyectada: '2026-05-05',
        importeTotal: 1000,
        descCategoria: 'Diesel',
      }),
      compra({
        noOrden: 'OC-NEW',
        nombreProveedor: 'Proveedor Dos',
        fechaPedido: '2026-06-01',
        fechaRecepcion: '',
        fechaPagoProyectada: '',
        importeTotal: 3000,
        descCategoria: 'Llantas',
      }),
    ];
    const { container } = renderCompras(records);
    enterDetalle();

    expect(rows(container)[0].textContent).toContain('OC-NEW');

    fireEvent.change(screen.getByTitle('Ordenar registros'), { target: { value: 'importeTotal:asc' } });
    expect(rows(container)[0].textContent).toContain('OC-OLD');

    fireEvent.change(screen.getByPlaceholderText('Buscar proveedor, OC, producto, factura…'), {
      target: { value: 'Proveedor Dos' },
    });
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0].textContent).toContain('OC-NEW');

    fireEvent.click(screen.getByRole('button', { name: /Limpiar/ }));
    fireEvent.change(screen.getByTitle('Fecha desde'), { target: { value: '2026-05-01' } });
    fireEvent.change(screen.getByTitle('Importe mínimo (MXN)'), { target: { value: '2000' } });
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0].textContent).toContain('OC-NEW');

    fireEvent.click(screen.getByRole('button', { name: /Limpiar/ }));
    expect(rows(container)).toHaveLength(2);
    expect(rows(container)[0].textContent).toContain('OC-NEW');
  });
});

describe('<Compras /> strip de OCs abiertas sin entrada', () => {
  it('shows only open-never-received OCs grouped by order month and focuses the table on click', () => {
    const freshDate = isoDaysAgo(5);
    const staleDate = isoDaysAgo(200);
    const records = [
      compra({ noOrden: 'OC-FRESH', fechaPedido: freshDate, importeTotal: 3000 }),
      compra({ noOrden: 'OC-STALE', fechaPedido: staleDate, importeTotal: 5000 }),
      // recibida → fuera del strip aunque no esté facturada
      compra({
        noOrden: 'OC-REC',
        fechaPedido: isoDaysAgo(10),
        fechaRecepcion: isoDaysAgo(8),
        fechaPagoProyectada: isoDaysAgo(-22),
      }),
    ];
    const { container } = renderCompras(records);

    expect(
      screen.getByText('OCs abiertas sin entrada por mes (fecha de pedido)'),
    ).toBeTruthy();

    const staleYm = staleDate.slice(0, 7);
    const staleChip = screen.getByText(staleYm);
    expect(staleChip).toBeTruthy();

    // enfocar el mes stale → la tabla muestra solo esa OC
    fireEvent.click(staleChip);
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0].textContent).toContain('OC-STALE');

    // clic de nuevo en el mismo mes → quita el foco
    fireEvent.click(screen.getByText(staleYm));
    expect(rows(container)).toHaveLength(3);
  });
});

describe('<Compras /> depuración JDE', () => {
  it('detects stale open OCs and filters the table when the insight card is clicked', () => {
    const records = [
      compra({ noOrden: 'OC-FRESH', fechaPedido: isoDaysAgo(5), importeTotal: 3000 }),
      compra({ noOrden: 'OC-STALE', fechaPedido: isoDaysAgo(200), importeTotal: 5000 }),
    ];
    const { container } = renderCompras(records);

    expect(screen.getByText('Depuración JDE')).toBeTruthy();
    const card = screen.getByText(/Sin entrada hace \+90 días/);
    fireEvent.click(card);
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0].textContent).toContain('OC-STALE');

    // el chip de foco en el toolbar lo quita
    fireEvent.click(screen.getByTitle('Quitar el foco'));
    expect(rows(container)).toHaveLength(2);
  });
});

describe('<Compras /> moneda extranjera y estado', () => {
  it('shows amounts converted to MXN with the original currency as detail', () => {
    const records = [
      compra({
        noOrden: 'OC-USD',
        fechaPedido: isoDaysAgo(3),
        moneda: 'USD',
        tipoCambio: 17,
        importeTotal: 100,
      }),
    ];
    const { container } = renderCompras(records);
    enterDetalle();

    const row = rows(container)[0];
    expect(row.textContent).toContain('1,700.00'); // 100 USD × 17
    expect(row.textContent).toContain('USD');
    expect(within(row).getByText('Sin entrada')).toBeTruthy();
  });

  it('labels workflow-closed OCs distinctly from open ones', () => {
    const records = [
      compra({ noOrden: 'OC-WF', fechaPedido: isoDaysAgo(3), estadoSiguiente: '999' }),
    ];
    const { container } = renderCompras(records);
    enterDetalle();
    expect(within(rows(container)[0]).getByText('Cerrada en JDE')).toBeTruthy();
  });
});

describe('<Compras /> resumen por OC (vista financiera por defecto)', () => {
  it('agrega líneas a una fila por OC con el split recibido / pendiente', () => {
    const records = [
      compra({ noOrden: 'OC-MIX', lineaOrden: 1, importeTotal: 1000 }), // sin entrada
      compra({ noOrden: 'OC-MIX', lineaOrden: 2, importeTotal: 2000, fechaRecepcion: isoDaysAgo(5) }), // pendiente factura
    ];
    const { container } = renderCompras(records);

    // Una sola fila para la OC (no una por línea).
    expect(rows(container)).toHaveLength(1);
    const row = rows(container)[0];
    expect(row.textContent).toContain('OC-MIX');
    expect(row.textContent).toContain('2 líneas');
    expect(row.textContent).toContain('3,000.00'); // importe total = recibido + pendiente recibir
    // Chip de estado: tiene línea sin entrada → "Pendiente de recibir".
    expect(within(row).getByText('Pendiente de recibir')).toBeTruthy();
  });

  it('el filtro backlog deja fuera las OCs ya facturadas', () => {
    const records = [
      compra({ noOrden: 'OC-OPEN', importeTotal: 1000 }), // sin entrada → backlog
      compra({ noOrden: 'OC-FACT', importeTotal: 5000, fechaRecepcion: isoDaysAgo(20), facturada: true, noFactura: 'F-9' }),
    ];
    const { container } = renderCompras(records);

    // Default = backlog: solo la OC abierta.
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0].textContent).toContain('OC-OPEN');

    // Cambiar a "Todas" trae también la facturada.
    fireEvent.change(screen.getByTitle('Filtrar por estado de la OC'), { target: { value: 'todas' } });
    expect(rows(container)).toHaveLength(2);
  });
});
