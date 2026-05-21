import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Pagos from './Pagos';
import type { PagoProveedorRecord } from '../services/jde';

function pago(overrides: Partial<PagoProveedorRecord>): PagoProveedorRecord {
  return {
    tipoPago: 'PT',
    noPago: '100',
    cia: '00001',
    nombreCia: 'SIR',
    cuentaBancaria: '38.1020.0010405 - BANAMEX - 7013 8708851',
    cuentaBanco: '70138708851',
    fechaPago: '2026-05-01',
    importePesos: 1000,
    importeDolares: 0,
    moneda: 'MXP',
    batchPago: 'B-1',
    claveProveedor: '900',
    rfcProveedor: 'RFC900',
    nombreProveedor: 'Proveedor Demo',
    tipoBusqueda: 'Suppliers',
    clasificacionProveedor: 'Servicios',
    clasificacionProveedorFinanciera: '220 - Por Clasificar',
    comentarioPago: 'FL CXP-1',
    ...overrides,
  };
}

function rows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr'));
}

describe('<Pagos /> filters and sorting', () => {
  it('hides payments marked as internal from the visible table and totals', () => {
    const records = [
      pago({
        noPago: '100',
        nombreProveedor: 'Proveedor Visible',
        importePesos: 1000,
      }),
      pago({
        noPago: '200',
        nombreProveedor: 'Proveedor Interno',
        importePesos: 9000,
      }),
    ];

    const { container } = render(
      <Pagos
        pagoProveedorRecords={records}
        pagoProveedorLoadedCias={{ __all__: '2026-06-02T00:00:00Z' }}
        selectedCia="all"
        providers={[]}
        internalPaymentKeys={new Set(['00001::200'])}
      />,
    );

    expect(rows(container)).toHaveLength(1);
    expect(screen.getByText('Proveedor Visible')).toBeTruthy();
    expect(screen.queryByText('Proveedor Interno')).toBeNull();
    expect(screen.getByText('1 total')).toBeTruthy();
  });

  it('searches, filters by ranges, sorts, and clears back to the default order', () => {
    const records = [
      pago({
        noPago: '100',
        nombreProveedor: 'Proveedor Uno',
        fechaPago: '2026-05-01',
        importePesos: 1000,
        cuentaBancaria: '38.1020.0010405 - BANAMEX - 7013 8708851',
        moneda: 'MXP',
      }),
      pago({
        noPago: '200',
        nombreProveedor: 'Proveedor Dos',
        fechaPago: '2026-06-01',
        importePesos: 3000,
        cuentaBancaria: '38.1020.0010405 - BBVA - 7013 8708851',
        moneda: 'USD',
        clasificacionProveedorFinanciera: '100 - Critico',
      }),
    ];
    const { container } = render(
      <Pagos
        pagoProveedorRecords={records}
        pagoProveedorLoadedCias={{ __all__: '2026-06-02T00:00:00Z' }}
        selectedCia="all"
        providers={[]}
      />,
    );

    expect(rows(container)[0].textContent).toContain('Proveedor Dos');

    fireEvent.change(screen.getByTitle('Ordenar registros'), { target: { value: 'importePesos:asc' } });
    expect(rows(container)[0].textContent).toContain('Proveedor Uno');

    fireEvent.change(screen.getByPlaceholderText('Buscar proveedor, RFC, no. pago, comentario…'), {
      target: { value: 'Proveedor Dos' },
    });
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0].textContent).toContain('Proveedor Dos');

    fireEvent.click(screen.getByRole('button', { name: /Limpiar/ }));
    fireEvent.change(screen.getByTitle('Fecha pago desde'), { target: { value: '2026-05-15' } });
    fireEvent.change(screen.getByTitle('Importe mínimo'), { target: { value: '2000' } });
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0].textContent).toContain('Proveedor Dos');

    fireEvent.click(screen.getByRole('button', { name: /Limpiar/ }));
    expect(rows(container)).toHaveLength(2);
    expect(rows(container)[0].textContent).toContain('Proveedor Dos');
  });
});
