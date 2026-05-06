import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FinancialPlanningDashboard from './FinancialPlanningDashboard';
import type { Budget } from '../../../domain/budget';
import type { Client, CashFlowAssumptions } from '../../../domain/types';
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

describe('<FinancialPlanningDashboard />', () => {
  it('bootstraps Base + Aprobado on first mount and shows the workbench', () => {
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
      />,
    );

    expect(screen.getByText('Planeación Financiera')).toBeTruthy();
    expect(screen.getAllByText('Escenario Base').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Escenario Aprobado').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Nueva propuesta/i })).toBeTruthy();
  });

  it('creates a draft when clicking "Nueva propuesta" and persists it', () => {
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
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Nueva propuesta/i }));

    const stored = JSON.parse(localStorage.getItem('midas.financialPlanning.scenarios.v1') ?? '[]');
    const drafts = stored.filter((scenario: { kind?: string }) => scenario.kind === 'DRAFT');
    expect(drafts.length).toBeGreaterThanOrEqual(1);
  });

  it('purges legacy scenario kinds during bootstrap', () => {
    localStorage.setItem(
      'midas.financialPlanning.scenarios.v1',
      JSON.stringify([
        { id: 'legacy-c', kind: 'CONSERVATIVE', name: 'Conservador', adjustmentIds: [], status: 'DRAFT', createdBy: 'x', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      ]),
    );

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
      />,
    );

    const stored = JSON.parse(localStorage.getItem('midas.financialPlanning.scenarios.v1') ?? '[]');
    const surviving = stored.filter((scenario: { id: string }) => scenario.id === 'legacy-c');
    expect(surviving.length).toBe(0);
  });

  it('creates expected commitments from the Planning commitments view', async () => {
    render(
      <FinancialPlanningDashboard
        companyCode="00001"
        bankStatements={[bank()]}
        clients={[client()]}
        providers={[]}
        cxpRecords={[]}
        assumptions={assumptions}
        budget={budget()}
        startingBalance={10_000}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Compromisos/i }));
    fireEvent.change(screen.getByLabelText('Concepto'), { target: { value: 'Nómina semanal' } });
    fireEvent.change(screen.getByLabelText('Monto'), { target: { value: '150000' } });
    fireEvent.change(screen.getByLabelText('Fecha'), { target: { value: '2026-05-22' } });
    fireEvent.change(screen.getByLabelText('Recurrencia'), { target: { value: 'WEEKLY' } });
    fireEvent.click(screen.getByRole('button', { name: /Agregar compromiso/i }));

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('midas.financialPlanning.manualEntries.v1') ?? '[]');
      expect(stored).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'Nómina semanal',
          category: 'PAYROLL',
          companyId: '00001',
          scenarioIds: ['approved'],
          status: 'APPROVED',
        }),
      ]));
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
