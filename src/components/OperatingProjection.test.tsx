import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import OperatingProjection from './OperatingProjection';
import type { Budget } from '../domain/budget';
import type { Client, CashFlowAssumptions } from '../domain/types';
import type { BankAccountStatement } from '../services/jde';

const TODAY = '2026-05-01';

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class ResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element) {
        this.callback(
          [
            {
              target,
              contentRect: {
                width: 1024,
                height: 240,
                top: 0,
                left: 0,
                bottom: 240,
                right: 1024,
                x: 0,
                y: 0,
                toJSON: () => ({}),
              },
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            },
          ],
          this,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00`));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('<OperatingProjection /> calendario operativo', () => {
  it('renders the monthly operating calendar and income drilldown', () => {
    render(
      <OperatingProjection
        companyCode="all"
        bankStatements={[bank({ saldoFinal: 10_000 })]}
        clients={[clientMonthly('c1', 'Cliente Calendario', 1000)]}
        providers={[]}
        cxpRecords={[]}
        assumptions={assumptions}
        budget={null}
      />,
    );

    expect(screen.getByText(/Calendario operativo diario/i)).toBeTruthy();
    expect(screen.getAllByText(/Cobranza proyectada/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Factura proyectada/i).length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue('1000').length).toBeGreaterThan(0);
  });

  it('opens the outflow drilldown from the consolidated detail tabs', () => {
    render(
      <OperatingProjection
        companyCode="all"
        bankStatements={[bank({ saldoFinal: 1_000_000_000 })]}
        clients={[]}
        providers={[]}
        cxpRecords={[]}
        assumptions={assumptions}
        budget={budgetWithMayExpense()}
      />,
    );

    expect(screen.getByText(/Calendario operativo diario/i)).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Egresos · [1-9]/i })[0]);

    expect(screen.getByText(/Egresos programados/i)).toBeTruthy();
    expect(screen.getAllByText(/Gastos de Operación/i).length).toBeGreaterThan(0);
  });
});

function clientMonthly(id: string, name: string, amount: number): Client {
  const monthlyBilling = Array.from({ length: 12 }, () => 0);
  monthlyBilling[4] = amount;
  return {
    id,
    name,
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 0,
    monthlyBilling,
    complianceRate: 1,
  };
}

function budgetWithMayExpense(): Budget {
  const expenseMonthly = Array.from({ length: 12 }, () => 0);
  expenseMonthly[4] = 500;
  return {
    year: 2026,
    scale: 'pesos',
    incomeTotal: Array.from({ length: 12 }, () => 0),
    incomeByConcept: [],
    expenseTotal: expenseMonthly,
    expenseByConcept: [
      {
        concept: 'Gastos de Operación',
        monthly: expenseMonthly,
      },
    ],
    uploadedAt: '2026-04-28T12:00:00Z',
  };
}

function bank(overrides: Partial<BankAccountStatement> = {}): BankAccountStatement {
  return {
    cia: '00001',
    banco: 'BANCO',
    cuenta: '1234567890',
    moneda: 'MXN',
    fechaEstadoCuenta: TODAY,
    saldoInicial: 0,
    saldoFinal: 0,
    movimientos: [],
    ...overrides,
  };
}
