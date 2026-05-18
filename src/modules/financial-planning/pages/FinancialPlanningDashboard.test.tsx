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
  // Outer dashboard schedules `buildFinancialProjectionSourceData` through
  // requestIdleCallback to keep the warmup shell on screen on real browsers.
  // In tests we want the full inner UI to mount synchronously so assertions
  // don't have to wait — fire the idle callback immediately.
  vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
    cb();
    return 1;
  });
  vi.stubGlobal('cancelIdleCallback', () => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('<FinancialPlanningDashboard />', () => {
  it('bootstraps Base + Aprobado on first mount and shows the workbench', async () => {
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

    await flushPlanningWarmup();
    expect(screen.getByText('Planeación Financiera')).toBeTruthy();
    expect(screen.getAllByText('Escenario Base').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Escenario Aprobado').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Nueva propuesta/i })).toBeTruthy();
  });

  it('creates a draft when clicking "Nueva propuesta" and persists it', async () => {
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

    await flushPlanningWarmup();
    fireEvent.click(screen.getByRole('button', { name: /Nueva propuesta/i }));

    const stored = JSON.parse(localStorage.getItem('midas.financialPlanning.scenarios.v1') ?? '[]');
    const drafts = stored.filter((scenario: { kind?: string }) => scenario.kind === 'DRAFT');
    expect(drafts.length).toBeGreaterThanOrEqual(1);
  });

  it('shows proposal actions and opens the pending-change review', async () => {
    localStorage.setItem(
      'midas.financialPlanning.scenarios.v1',
      JSON.stringify([{
        id: 'draft-test',
        name: 'Propuesta Prueba',
        kind: 'DRAFT',
        status: 'DRAFT',
        adjustmentIds: [],
        parentScenarioId: 'approved',
        createdBy: 'test',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      }]),
    );
    localStorage.setItem(
      'midas.financialPlanning.customRows.v1',
      JSON.stringify([{
        id: 'custom-row-test',
        scenarioId: 'draft-test',
        conceptKey: 'custom:OUTFLOW:pago-extra:abc123',
        label: 'Pago extra',
        type: 'OUTFLOW',
        category: 'MANUAL',
        createdBy: 'test',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      }]),
    );
    localStorage.setItem(
      'midas.financialPlanning.cellOverrides.v1',
      JSON.stringify([{
        id: 'co-test',
        scenarioId: 'draft-test',
        conceptKey: 'custom:OUTFLOW:pago-extra:abc123',
        granularity: 'monthly',
        bucketKey: '2026-05-01',
        type: 'OUTFLOW',
        mode: 'REPLACE',
        value: 1000,
        createdBy: 'test',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      }]),
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

    await flushPlanningWarmup();
    fireEvent.click(screen.getByText('Propuesta Prueba'));
    expect(screen.getByRole('button', { name: /Aplicar al Aprobado/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Revisar cambios/i }));
    expect(screen.getByRole('dialog', { name: /Aplicar propuesta al Aprobado/i })).toBeTruthy();
    expect(screen.getByText(/Cambios a aplicar/i)).toBeTruthy();
  });

  it('purges legacy scenario kinds during bootstrap', async () => {
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

    await flushPlanningWarmup();
    const stored = JSON.parse(localStorage.getItem('midas.financialPlanning.scenarios.v1') ?? '[]');
    const surviving = stored.filter((scenario: { id: string }) => scenario.id === 'legacy-c');
    expect(surviving.length).toBe(0);
  });

  it('preserves approved manual planning entries without the legacy commitments button', async () => {
    localStorage.setItem(
      'midas.financialPlanning.manualEntries.v1',
      JSON.stringify([{
        id: 'manual-entry-test',
        name: 'Nómina semanal',
        type: 'OUTFLOW',
        category: 'PAYROLL',
        amount: 150000,
        startDate: '2026-05-22',
        recurrence: 'WEEKLY',
        companyId: '00001',
        scenarioIds: ['approved'],
        status: 'APPROVED',
        createdBy: 'test',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      }]),
    );

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

    await flushPlanningWarmup();
    expect(screen.queryByRole('button', { name: /Compromisos/i })).toBeNull();

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

async function flushPlanningWarmup() {
  await waitFor(() => expect(screen.queryByLabelText('Cargando planeación')).toBeNull());
}

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
