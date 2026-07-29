import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Clients from './Clients';
import type { CashFlowAssumptions, Client } from '../domain/types';
import type { MatcherOutput } from '../domain/clientCobranzaMatcher';

const assumptions: CashFlowAssumptions = {
  year: new Date().getFullYear(),
  globalCompliance: 1,
  factorajeDays: 30,
};

const emptyMatcherReview: MatcherOutput = {
  autoAccepted: [],
  needsReview: [],
  orphanNoClientes: [],
};

function client(overrides: Partial<Client> & Pick<Client, 'id' | 'name'>): Client {
  return {
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 30,
    monthlyBilling: new Array(12).fill(100_000),
    ...overrides,
  };
}

function renderClients(clients: Client[]) {
  return render(
    <Clients
      clients={clients}
      assumptions={assumptions}
      confirmedPayments={[]}
      cobranzaRecords={[]}
      matcherReview={emptyMatcherReview}
      onReplace={vi.fn()}
      onAdd={vi.fn()}
      onUpdate={vi.fn()}
      onDelete={vi.fn()}
      onConfirmMatch={vi.fn()}
      onIgnoreOrphan={vi.fn()}
      onCreateClientFromOrphan={vi.fn()}
    />,
  );
}

describe('<Clients /> catálogo', () => {
  it('renderiza la lista con los grupos/clientes del catálogo', () => {
    renderClients([
      client({ id: 'c1', name: 'ACME ALFA', rfc: 'AAA010101AAA' }),
      client({ id: 'c2', name: 'ZETA BETA', rfc: 'BBB020202BBB' }),
    ]);

    expect(screen.getByText('Clientes')).toBeTruthy();
    // El nombre del grupo puede venir normalizado (title case) — matcher laxo.
    expect(screen.getAllByText(/acme alfa/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/zeta beta/i).length).toBeGreaterThanOrEqual(1);
  });

  it('expande el grupo y abre el detalle de la cuenta', () => {
    renderClients([client({ id: 'c1', name: 'ACME ALFA', rfc: 'AAA010101AAA' })]);

    // Clic en la fila del grupo → aparecen las cuentas del grupo.
    fireEvent.click(screen.getAllByText(/acme alfa/i)[0]);
    const accountButton = screen.getByRole('button', { name: /acme alfa/i });
    expect(accountButton).toBeTruthy();

    // Clic en la cuenta → abre el detalle (métricas + editor).
    fireEvent.click(accountButton);
    expect(screen.getByText('Lag estimado')).toBeTruthy();
    expect(screen.getByText('Cobranza confirmada')).toBeTruthy();
  });

  it('filtra por búsqueda de nombre', () => {
    renderClients([
      client({ id: 'c1', name: 'ACME ALFA', rfc: 'AAA010101AAA' }),
      client({ id: 'c2', name: 'ZETA BETA', rfc: 'BBB020202BBB' }),
    ]);

    fireEvent.change(screen.getByPlaceholderText('Buscar grupo, cuenta, RFC o dominio'), {
      target: { value: 'ZETA' },
    });

    expect(screen.queryByText(/acme alfa/i)).toBeNull();
    expect(screen.getAllByText(/zeta beta/i).length).toBeGreaterThanOrEqual(1);
  });

  it('sin clientes muestra el estado vacío', () => {
    renderClients([]);
    expect(
      screen.getByText('Sin clientes. Sincroniza el catálogo o agrega uno manual.'),
    ).toBeTruthy();
  });
});
