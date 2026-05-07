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
      />,
    );

    expect(screen.getByRole('heading', { name: 'Impuestos' })).toBeTruthy();
    expect(screen.getByText('Obligaciones por periodo')).toBeTruthy();
    expect(screen.queryByText(/Escenario/i)).toBeNull();
    expect(screen.queryByText(/Impacto caja/i)).toBeNull();
    expect(screen.queryByText(/Cierre:/i)).toBeNull();
    expect(screen.getByText(/Causado \(/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Captura manual/i }));

    const capture = screen.getByText('Captura manual', { selector: 'h2' }).closest('section');
    expect(capture).toBeTruthy();
    const panel = within(capture as HTMLElement);

    fireEvent.click(panel.getByText('Obligación nueva'));

    fireEvent.change(panel.getByPlaceholderText('$0.00'), { target: { value: '2500' } });
    fireEvent.change(panel.getByPlaceholderText('IMSS pendiente...'), { target: { value: 'IMSS pendiente' } });
    fireEvent.click(panel.getByRole('button', { name: /Agregar/i }));

    expect(screen.getByText(/IMSS pendiente capturada/i)).toBeTruthy();
    const stored = JSON.parse(localStorage.getItem('midas.taxes.v1') ?? '{}');
    expect(stored.obligations[0]).toMatchObject({
      taxType: 'IMSS',
      label: 'IMSS pendiente',
      totalAmount: 2500,
    });
  });

  it('allows inline editing of tax amounts in the period table', () => {
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
      />,
    );

    expect(screen.getByText(/Haz clic en un monto/i)).toBeTruthy();
    expect(screen.getByText(/Pagos registrados/i)).toBeTruthy();
  });

  it('shows approved tax payments as connected cash outflows for planning and projection', () => {
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
      />,
    );

    expect(screen.getByText('Pagos fiscales en caja')).toBeTruthy();
    expect(screen.getByText('Conectado a Planeación/Proyección')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Pagos/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /Programar pago/i })[0]);

    expect(screen.getByText(/Pago fiscal programado/i)).toBeTruthy();
    expect(screen.getAllByText('Impacta Planeación/Proyección').length).toBeGreaterThan(0);

    const stored = JSON.parse(localStorage.getItem('midas.taxes.v1') ?? '{}');
    expect(stored.obligations[0].paymentPlan[0]).toMatchObject({
      status: 'APPROVED',
    });
  });

  it('shows budget IVA creditable for February and persists editable rate overrides', () => {
    render(
      <TaxDashboard
        companyCode="all"
        bankStatements={[bank()]}
        clients={[]}
        providers={[]}
        cxpRecords={[]}
        assumptions={assumptions}
        budget={budget({ dieselFeb: 1160 })}
        startingBalance={20_000}
      />,
    );

    fireEvent.click(screen.getByText('2026-02'));
    fireEvent.click(screen.getByRole('button', { name: /Acreditable/i }));

    expect(screen.queryByText(/Sin egresos acreditables/i)).toBeNull();
    const rate = screen.getByLabelText(/Tasa IVA Diésel presupuestado/i);
    expect(rate).toBeTruthy();
    fireEvent.change(rate, { target: { value: '8' } });

    const stored = JSON.parse(localStorage.getItem('midas.taxes.v1') ?? '{}');
    expect(stored.taxRateOverrides[0]).toMatchObject({
      targetType: 'CONCEPT',
      targetKey: 'DIESEL',
      rate: 8,
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
  monthlyBilling[4] = 1000;
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

function budget(input: { dieselFeb?: number } = {}): Budget {
  const expenseTotal = Array.from({ length: 12 }, () => 0);
  expenseTotal[4] = 1000;
  if (input.dieselFeb) expenseTotal[1] += input.dieselFeb;
  const payroll = Array.from({ length: 12 }, () => 0);
  payroll[4] = 1000;
  const diesel = Array.from({ length: 12 }, () => 0);
  diesel[1] = input.dieselFeb ?? 0;
  return {
    year: 2026,
    scale: 'pesos',
    incomeTotal: Array.from({ length: 12 }, () => 0),
    incomeByConcept: [],
    expenseTotal,
    expenseByConcept: [
      { concept: 'Nómina', monthly: payroll },
      ...(input.dieselFeb ? [{ concept: 'Diésel', monthly: diesel }] : []),
    ],
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
