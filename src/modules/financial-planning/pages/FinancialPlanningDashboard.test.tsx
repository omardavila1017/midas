import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import FinancialPlanningDashboard from './FinancialPlanningDashboard';
import type { Budget } from '../../../domain/budget';
import type { Client, CashFlowAssumptions } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { Scenario } from '../../../types';

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

describe('<FinancialPlanningDashboard /> altas manuales', () => {
  it('captures a manual income in the active scenario and persists it', () => {
    render(
      <FinancialPlanningDashboard
        companyCode="all"
        bankStatements={[bank()]}
        clients={[client()]}
        providers={[]}
        cxpRecords={[]}
        assumptions={assumptions}
        budget={budget()}
        startingBalance={10_000}
        legacyProposals={[]}
        legacyScenarios={[scenario()]}
        legacyActiveScenarioId="scn-1"
        onLegacyScenariosChange={() => {}}
      />,
    );

    const section = screen.getByText('Altas manuales').closest('section');
    expect(section).toBeTruthy();
    const panel = within(section as HTMLElement);

    fireEvent.change(panel.getByPlaceholderText(/Viaje especial/i), {
      target: { value: 'Viaje especial Monterrey' },
    });
    fireEvent.change(panel.getByLabelText('Monto'), {
      target: { value: '1500' },
    });
    fireEvent.click(panel.getByRole('button', { name: /Agregar/i }));

    expect(panel.getByText('Viaje especial Monterrey')).toBeTruthy();
    const stored = JSON.parse(localStorage.getItem('midas.financialPlanning.manualEntries.v1') ?? '[]');
    expect(stored[0]).toMatchObject({
      name: 'Viaje especial Monterrey',
      amount: 1500,
      scenarioIds: ['legacy:scn-1'],
    });
  });
});

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

function scenario(): Scenario {
  return {
    id: 'scn-1',
    name: 'Escenario IMSS confirmado',
    proposalStates: {},
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  };
}

function client(): Client {
  const monthlyBilling = Array.from({ length: 12 }, () => 0);
  monthlyBilling[4] = 2000;
  return {
    id: 'c1',
    name: 'Cliente',
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 0,
    monthlyBilling,
    complianceRate: 1,
  };
}

function budget(): Budget {
  return {
    year: 2026,
    scale: 'pesos',
    incomeTotal: Array.from({ length: 12 }, () => 0),
    incomeByConcept: [],
    expenseTotal: Array.from({ length: 12 }, () => 0),
    expenseByConcept: [],
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
    saldoInicial: 10_000,
    saldoFinal: 10_000,
    movimientos: [],
  };
}
