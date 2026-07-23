import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SalesCalendarDashboard from './SalesCalendarDashboard';
import { todayISO } from '../../../formatters';
import type { CobranzaRecord, RolRecord, ViajeEspecialRecord } from '../../../services/jde';

const today = todayISO();

function cobranza(): CobranzaRecord {
  return {
    cia: '00011',
    noCliente: '1',
    nombreCliente: 'Cliente Demo',
    noFactura: 'RI-1',
    fechaFactura: today, // cae en el mes/año por defecto (hoy)
    fechaVence: '',
    fechaCobro: '',
    diasVencida: 0,
    importeBrutoPesos: 1160,
    importePendientePesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXP',
    condPago: '',
    estatus: '',
    tipoCambio: 1,
    subTotal: 1000,
  } as CobranzaRecord;
}

describe('<SalesCalendarDashboard />', () => {
  it('shows the empty state when there are no sales', () => {
    render(
      <SalesCalendarDashboard cobranzaRecords={[]} rolRecords={[]} viajesEspecialesRecords={[]} companies={[]} />,
    );
    expect(screen.getByText('Sin ventas para mostrar')).toBeTruthy();
  });

  it('renders the calendar, KPIs and export when there are sales', () => {
    render(
      <SalesCalendarDashboard
        cobranzaRecords={[cobranza()]}
        rolRecords={[] as RolRecord[]}
        viajesEspecialesRecords={[] as ViajeEspecialRecord[]}
        companies={[{ cia: '00011', nombre: 'Servicio Industrial' }]}
      />,
    );
    expect(screen.getByText('Venta')).toBeTruthy();
    // "Facturado"/"Por facturar" aparecen como KPI y como leyenda del calendario.
    expect(screen.getAllByText('Facturado').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Por facturar').length).toBeGreaterThan(0);
    expect(screen.getByText('Exportar')).toBeTruthy();
    // La tira de 12 meses siempre se pinta cuando hay datos.
    expect(screen.getByText('Ene')).toBeTruthy();
    expect(screen.getByText('Dic')).toBeTruthy();
    // Sin segmentos clasificados del API, el filtro de segmento NO se pinta.
    expect(screen.queryByLabelText('Filtrar por segmento')).toBeNull();
  });

  it('exposes the segment filter + monthly breakdown when the API sends tipoServicio (C.1)', () => {
    render(
      <SalesCalendarDashboard
        cobranzaRecords={[
          { ...cobranza(), tipoServicio: 'Contrato' },
          { ...cobranza(), noFactura: 'RI-2', tipoServicio: 'Viaje Especial', subTotal: 2000 } as CobranzaRecord,
        ]}
        rolRecords={[] as RolRecord[]}
        viajesEspecialesRecords={[] as ViajeEspecialRecord[]}
        companies={[{ cia: '00011', nombre: 'Servicio Industrial' }]}
      />,
    );

    // Filtro visible con las opciones del API.
    const select = screen.getByLabelText('Filtrar por segmento') as HTMLSelectElement;
    expect(select).toBeTruthy();
    // Desglose del mes por segmento.
    expect(screen.getByText(/Por segmento ·/)).toBeTruthy();
    expect(screen.getAllByText('Contrato').length).toBeGreaterThan(0);

    // Filtrar por un segmento acota y avisa que sólo aplica a lo facturado.
    fireEvent.change(select, { target: { value: 'Contrato' } });
    expect(screen.getByText('Sólo facturado')).toBeTruthy();
    expect(screen.queryByText(/Por segmento ·/)).toBeNull(); // el desglose vuelve al quitar el filtro
  });

  it('resets the segment filter when the company scope no longer offers it', () => {
    render(
      <SalesCalendarDashboard
        cobranzaRecords={[
          { ...cobranza(), tipoServicio: 'Contrato' },
          { ...cobranza(), cia: '00022', noFactura: 'RI-3' } as CobranzaRecord,
        ]}
        rolRecords={[] as RolRecord[]}
        viajesEspecialesRecords={[] as ViajeEspecialRecord[]}
        companies={[
          { cia: '00011', nombre: 'Servicio Industrial' },
          { cia: '00022', nombre: 'Transportes Norte' },
        ]}
      />,
    );

    const segmentSelect = screen.getByLabelText('Filtrar por segmento') as HTMLSelectElement;
    fireEvent.change(segmentSelect, { target: { value: 'Contrato' } });
    expect(screen.getByText('Sólo facturado')).toBeTruthy();

    // La cía 00022 no trae segmentos: el filtro heredado se resetea (nada de
    // calendario en ceros silencioso) y el select de segmento se oculta.
    const companySelect = screen.getByLabelText('Filtrar por compañía') as HTMLSelectElement;
    fireEvent.change(companySelect, { target: { value: '00022' } });
    expect(screen.queryByText('Sólo facturado')).toBeNull();
    expect(screen.queryByLabelText('Filtrar por segmento')).toBeNull();
  });
});
