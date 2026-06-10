import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Pagos from './Pagos';
import type { PagoProveedorRecord } from '../services/jde';
import type { PaymentMatch } from '../domain/paymentReconciliationEngine';

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

/** Builds a PaymentMatch with UNMATCHED status so the engine input is consistent
 *  with the visible payment list (no CXP/cargo cross). Tests focus on filter +
 *  search + view-mode behavior, not on reconciliation. */
function unmatchedMatch(record: PagoProveedorRecord): PaymentMatch {
  return {
    payment: record,
    status: 'UNMATCHED',
    bankCoverage: 'covered',
    cxpMatches: [],
    reason: 'sin cxp ni cargo (test)',
  };
}

function rows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr'));
}

function switchToFlatList() {
  fireEvent.click(screen.getByRole('button', { name: /Lista plana/ }));
}

describe('<Pagos /> filters and sorting', () => {
  it('hides payments marked as internal from the visible list and totals', () => {
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
    const matches = records.map(unmatchedMatch);

    const { container } = render(
      <Pagos
        pagoProveedorRecords={records}
        pagoProveedorLoadedCias={{ __all__: '2026-06-02T00:00:00Z' }}
        selectedCia="all"
        providers={[]}
        internalPaymentKeys={new Set(['00001::200'])}
        paymentMatches={matches}
        comprasRecords={[]}
        cxpRecords={[]}
      />,
    );

    switchToFlatList();

    expect(rows(container)).toHaveLength(1);
    expect(screen.getByText('Proveedor Visible')).toBeTruthy();
    expect(screen.queryByText('Proveedor Interno')).toBeNull();
    expect(screen.getByText('1 total')).toBeTruthy();
  });

  it('searches and filters by date/amount in flat list view', () => {
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
    const matches = records.map(unmatchedMatch);

    const { container } = render(
      <Pagos
        pagoProveedorRecords={records}
        pagoProveedorLoadedCias={{ __all__: '2026-06-02T00:00:00Z' }}
        selectedCia="all"
        providers={[]}
        paymentMatches={matches}
        comprasRecords={[]}
        cxpRecords={[]}
      />,
    );

    switchToFlatList();

    // Default flat-list sort is fechaPago desc → newest first.
    expect(rows(container)[0].textContent).toContain('Proveedor Dos');

    fireEvent.change(screen.getByPlaceholderText('Buscar proveedor, RFC, no. pago, comentario…'), {
      target: { value: 'Proveedor Dos' },
    });
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0].textContent).toContain('Proveedor Dos');

    fireEvent.click(screen.getByRole('button', { name: /Limpiar/ }));
    fireEvent.change(screen.getByTitle('Fecha pago desde'), { target: { value: '2026-05-15' } });
    fireEvent.change(screen.getByPlaceholderText('Importe mín.'), { target: { value: '2000' } });
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0].textContent).toContain('Proveedor Dos');

    fireEvent.click(screen.getByRole('button', { name: /Limpiar/ }));
    expect(rows(container)).toHaveLength(2);
    expect(rows(container)[0].textContent).toContain('Proveedor Dos');
  });
});
