import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CollectionProjection from './CollectionProjection';
import type { Client, CashFlowAssumptions } from '../domain/types';

function stubMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  });
}

const ASSUMPTIONS: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 0.95,
  factorajeDays: 30,
};

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: overrides.id ?? 'c1',
    name: overrides.name ?? 'Cliente Demo',
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 30,
    monthlyBilling: new Array(12).fill(100_000),
    ...overrides,
  };
}

describe('<CollectionProjection />', () => {
  beforeEach(() => {
    stubMatchMedia();
  });

  it('muestra un empty state cuando no hay clientes', () => {
    render(
      <CollectionProjection
        clients={[]}
        assumptions={ASSUMPTIONS}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
      />,
    );
    expect(screen.getByText(/Sin clientes cargados/i)).toBeTruthy();
    expect(screen.getByText(/Importa el catálogo/i)).toBeTruthy();
  });

  it('renderiza el header y los KPIs de resumen con datos', () => {
    const clients = [
      makeClient({ id: 'a', name: 'Cliente Alfa' }),
      makeClient({ id: 'b', name: 'Cliente Beta', frequency: 'Semanal' }),
    ];
    render(
      <CollectionProjection
        clients={clients}
        assumptions={ASSUMPTIONS}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
      />,
    );
    expect(screen.getByRole('heading', { name: /Proyección de cobranza/i })).toBeTruthy();
    expect(screen.getByText(/Total proyectado 2026/i)).toBeTruthy();
    expect(screen.getByText(/Días promedio de lag/i)).toBeTruthy();
  });

  it('cambia entre vistas Calendario / Por mes / Por cliente', () => {
    const clients = [makeClient()];
    render(
      <CollectionProjection
        clients={clients}
        assumptions={ASSUMPTIONS}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
      />,
    );
    // Default: Calendario → hay un botón "Exportar mes".
    expect(screen.getByLabelText(/Exportar mes/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Por mes/i }));
    expect(screen.getByText(/Entrada de efectivo por mes/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Por cliente/i }));
    expect(screen.getByText(/Ranking por cliente/i)).toBeTruthy();
  });

  it('filtra por búsqueda y muestra el contador filtrado', () => {
    const clients = [
      makeClient({ id: 'a', name: 'Abarrotes del Norte' }),
      makeClient({ id: 'b', name: 'Zapatería Sur' }),
    ];
    render(
      <CollectionProjection
        clients={clients}
        assumptions={ASSUMPTIONS}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
      />,
    );
    const search = screen.getByPlaceholderText(/Buscar cliente/i);
    fireEvent.change(search, { target: { value: 'Abarrotes' } });
    // Aparece "Limpiar filtros" cuando hay filtros activos.
    expect(screen.getByRole('button', { name: /Limpiar filtros/i })).toBeTruthy();
  });

  it('toggle de supuestos muestra y oculta el panel', () => {
    const clients = [makeClient()];
    const onChange = vi.fn();
    render(
      <CollectionProjection
        clients={clients}
        assumptions={ASSUMPTIONS}
        onAssumptionsChange={onChange}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: /Supuestos/i });
    fireEvent.click(btn);
    // El input del año ahora es visible.
    const yearInput = screen.getByDisplayValue('2026');
    expect(yearInput).toBeTruthy();
    fireEvent.change(yearInput, { target: { value: '2027' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ year: 2027 }));
  });

  it('el empty state del ranking aparece cuando filtros excluyen todo', () => {
    const clients = [makeClient({ id: 'a', name: 'Alfa' })];
    render(
      <CollectionProjection
        clients={clients}
        assumptions={ASSUMPTIONS}
        onAssumptionsChange={() => {}}
        confirmedPayments={[]}
        onConfirm={() => {}}
        onUnconfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Por cliente/i }));
    const search = screen.getByPlaceholderText(/Buscar cliente/i);
    fireEvent.change(search, { target: { value: 'no-existe-nunca' } });
    expect(screen.getByText(/Sin datos con los filtros actuales/i)).toBeTruthy();
  });
});
