import { fireEvent, render, screen } from '@testing-library/react';
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
    const { container } = render(
      <Compras
        comprasRecords={records}
        comprasLoadedCias={{ __all__: '2026-06-02T00:00:00Z' }}
        selectedCia="all"
        providers={[]}
      />,
    );

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
    fireEvent.change(screen.getByTitle('Importe mínimo'), { target: { value: '2000' } });
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0].textContent).toContain('OC-NEW');

    fireEvent.click(screen.getByRole('button', { name: /Limpiar/ }));
    expect(rows(container)).toHaveLength(2);
    expect(rows(container)[0].textContent).toContain('OC-NEW');
  });
});
