import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PasivoDistribuir from './PasivoDistribuir';
import type { ComprasRecord } from '../services/jde';
import { fmtCurrency } from '../formatters';

/** YYYY-MM-DD hace N días (UTC — offsets grandes, sin riesgo de huso). */
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

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
    fechaPedido: isoDaysAgo(150),
    fechaRecepcion: '',
    diasCredito: 30,
    fechaPagoProyectada: '',
    noFactura: '',
    centroCostos: '101',
    categoria: 'CAT',
    descCategoria: 'Refacciones',
    familia: 'FAM',
    descFamilia: 'Flota',
    subFamilia: 'SUB',
    descSubFamilia: 'Llantas',
    estadoSiguiente: '',
    tasaFiscal: 'IVA16',
    cancelada: false,
    facturada: false,
    ...overrides,
  };
}

// Pasivo por distribuir = recibida sin factura (porPagar):
// OC-VIEJA (2 líneas, 1,500, recibida hace 120 d) + OC-NUEVA (2,000, hace 10 d).
// OC-ABIERTA (sin entrada) y OC-FACT (facturada) quedan fuera.
function records(): ComprasRecord[] {
  return [
    compra({ noOrden: 'OC-VIEJA', lineaOrden: 1, importeTotal: 1000, fechaRecepcion: isoDaysAgo(120), nombreProveedor: 'PROVEEDOR VIEJO' }),
    compra({ noOrden: 'OC-VIEJA', lineaOrden: 2, importeTotal: 500, fechaRecepcion: isoDaysAgo(115), nombreProveedor: 'PROVEEDOR VIEJO' }),
    compra({ noOrden: 'OC-NUEVA', lineaOrden: 1, importeTotal: 2000, fechaRecepcion: isoDaysAgo(10), nombreProveedor: 'PROVEEDOR NUEVO' }),
    compra({ noOrden: 'OC-ABIERTA', lineaOrden: 1, importeTotal: 7000 }),
    compra({ noOrden: 'OC-FACT', lineaOrden: 1, importeTotal: 9000, fechaRecepcion: isoDaysAgo(30), facturada: true, noFactura: 'F-9' }),
  ];
}

function rows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr'));
}

function renderPasivo(comprasRecords: ComprasRecord[]) {
  return render(
    <PasivoDistribuir
      comprasRecords={comprasRecords}
      comprasLoadedCias={{ __all__: '2026-07-01T00:00:00Z' }}
      selectedCia="all"
      providers={[]}
    />,
  );
}

describe('<PasivoDistribuir /> KPIs y tabla', () => {
  it('renderiza los KPIs con el total del pasivo y el bucket +90 días', () => {
    renderPasivo(records());

    expect(screen.getByText('Pasivo por Distribuir')).toBeTruthy();
    expect(screen.getByText('Total pasivo por distribuir')).toBeTruthy();
    // Total = 1,500 (OC-VIEJA) + 2,000 (OC-NUEVA); la sin-entrada y la facturada no suman.
    expect(screen.getByText(fmtCurrency(3_500))).toBeTruthy();
    // +90 días = OC-VIEJA (1,500). El label aparece en el KPI y en el strip de aging.
    expect(screen.getAllByText('+90 días').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(fmtCurrency(1_500)).length).toBeGreaterThanOrEqual(1);
  });

  it('la tabla agrega una fila por OC, más antigua primero', () => {
    const { container } = renderPasivo(records());

    const tableRows = rows(container);
    expect(tableRows).toHaveLength(2);
    expect(tableRows[0].textContent).toContain('OC-VIEJA');
    expect(tableRows[1].textContent).toContain('OC-NUEVA');
    expect(container.textContent).not.toContain('OC-ABIERTA');
    expect(container.textContent).not.toContain('OC-FACT');
  });

  it('busca por proveedor/OC y ordena por importe', () => {
    const { container } = renderPasivo(records());

    fireEvent.change(screen.getByPlaceholderText('Buscar proveedor, OC, categoría…'), {
      target: { value: 'OC-NUEVA' },
    });
    expect(rows(container)).toHaveLength(1);
    expect(rows(container)[0].textContent).toContain('OC-NUEVA');

    fireEvent.click(screen.getByRole('button', { name: /Limpiar/ }));
    fireEvent.change(screen.getByTitle('Ordenar'), { target: { value: 'importe' } });
    expect(rows(container)[0].textContent).toContain('OC-NUEVA'); // 2,000 > 1,500
  });

  it('sin OCs cargadas muestra el estado vacío', () => {
    renderPasivo([]);
    expect(screen.getByText('Sin OCs cargadas.')).toBeTruthy();
  });
});
