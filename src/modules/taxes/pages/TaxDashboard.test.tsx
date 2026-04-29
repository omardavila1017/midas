import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import TaxDashboard from './TaxDashboard';
import type { Budget } from '../../../domain/budget';
import type { CashFlowAssumptions, Client } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';

const TODAY = '2026-05-01';

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`));
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('<TaxDashboard />', () => {
  it('renders the independent tax module and stores a manual IMSS obligation', () => {
    render(
      <TaxDashboard
        companyCode="all"
        bankStatements={[bank()]}
        clients={[client()]}
        providers={[]}
        cxpRecords={[]}
        assumptions={assumptions}
        budget={budget()}
        startingBalance={20_000}
        legacyProposals={[]}
        legacyScenarios={[]}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Impuestos' })).toBeTruthy();
    expect(screen.getByText('Obligaciones por periodo')).toBeTruthy();

    const capture = screen.getByText('Captura fiscal flexible').closest('section');
    expect(capture).toBeTruthy();
    const panel = within(capture as HTMLElement);

    fireEvent.change(panel.getAllByPlaceholderText('Monto')[1], { target: { value: '2500' } });
    fireEvent.change(panel.getByPlaceholderText('IMSS pendiente, convenio...'), { target: { value: 'IMSS pendiente' } });
    fireEvent.click(panel.getByRole('button', { name: /Obligación/i }));

    expect(screen.getByText(/IMSS pendiente capturada/i)).toBeTruthy();
    const stored = JSON.parse(localStorage.getItem('midas.taxes.v1') ?? '{}');
    expect(stored.obligations[0]).toMatchObject({
      taxType: 'IMSS',
      label: 'IMSS pendiente',
      totalAmount: 2500,
    });
  });
});

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

function client(): Client {
  const monthlyBilling = Array.from({ length: 12 }, () => 0);
  monthlyBilling[4] = 1160;
  return {
    id: 'client-1',
    name: 'Cliente IVA',
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 0,
    monthlyBilling,
    complianceRate: 1,
    ivaRate: 16,
  };
}

function budget(): Budget {
  const expenseTotal = Array.from({ length: 12 }, () => 0);
  expenseTotal[4] = 1000;
  return {
    year: 2026,
    scale: 'pesos',
    incomeTotal: Array.from({ length: 12 }, () => 0),
    incomeByConcept: [],
    expenseTotal,
    expenseByConcept: [{ concept: 'Nómina', monthly: expenseTotal }],
    uploadedAt: '2026-05-01T00:00:00Z',
  };
}

function bank(): BankAccountStatement {
  return {
    cia: '00001',
    banco: 'BANCO',
    cuenta: '123',
    moneda: 'MXN',
    fechaEstadoCuenta: TODAY,
    saldoInicial: 20_000,
    saldoFinal: 20_000,
    movimientos: [],
  };
}
