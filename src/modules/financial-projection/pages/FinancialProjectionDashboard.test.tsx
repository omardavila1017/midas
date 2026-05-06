import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FinancialProjectionDashboard from './FinancialProjectionDashboard';
import type { Budget } from '../../../domain/budget';
import type { CashFlowAssumptions, Client } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaRecord } from '../../../services/jdeTypes';

const TODAY = '2026-05-05';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
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

describe('<FinancialProjectionDashboard />', () => {
  it('generates an automatic predictive draft from Projection', async () => {
    renderDashboard();
    await flushProjectionWarmup();

    await waitFor(() => expect(screen.getByText('Motor predictivo')).toBeTruthy());

    const generateButtons = screen.getAllByRole('button', { name: /Generar draft/i });
    const enabled = generateButtons.find((button) => !(button as HTMLButtonElement).disabled);
    expect(enabled).toBeTruthy();
    fireEvent.click(enabled!);

    const stored = JSON.parse(localStorage.getItem('midas.financialPlanning.scenarios.v1') ?? '[]');
    const predictiveDrafts = stored.filter((scenario: { kind?: string; name?: string }) => (
      scenario.kind === 'DRAFT' && scenario.name?.includes('Predictivo')
    ));
    expect(predictiveDrafts.length).toBeGreaterThanOrEqual(1);
  });

  it('saves quick estimated supplier outflows through planning manual entries', async () => {
    renderDashboard();
    await flushProjectionWarmup();

    await waitFor(() => expect(screen.getByText('Movimientos')).toBeTruthy());
    const outflowButton = screen.getAllByRole('button')
      .find((button) => button.textContent?.trim() === 'Egreso');
    expect(outflowButton).toBeTruthy();
    fireEvent.click(outflowButton!);

    const dialog = screen.getByRole('dialog', { name: /Agregar estimado/i });
    fireEvent.change(within(dialog).getByLabelText('Concepto'), { target: { value: 'Pago diesel estimado' } });
    fireEvent.change(within(dialog).getByLabelText('Proveedor'), { target: { value: 'Proveedor Flexible' } });
    fireEvent.change(within(dialog).getByLabelText('Monto'), { target: { value: '150000' } });
    fireEvent.change(within(dialog).getByLabelText('Fecha'), { target: { value: '2026-06-12' } });
    fireEvent.change(within(dialog).getByLabelText('Categoría'), { target: { value: 'AP_PAYMENT' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Agregar/i }));

    const stored = JSON.parse(localStorage.getItem('midas.financialPlanning.manualEntries.v1') ?? '[]');
    expect(stored).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'SUPPLIER_PAYMENT',
        counterpartyName: 'Proveedor Flexible',
        name: 'Pago diesel estimado',
      }),
    ]));
  });
});

function renderDashboard() {
  return render(
    <FinancialProjectionDashboard
      companyCode="all"
      bankStatements={[bank()]}
      clients={[client()]}
      providers={[]}
      cxpRecords={[]}
      cobranzaRecords={[cobranza()]}
      assumptions={assumptions}
      budget={budget()}
      startingBalance={10_000}
    />,
  );
}

async function flushProjectionWarmup() {
  await waitFor(() => expect(screen.queryByLabelText('Calculando proyección')).toBeNull());
}

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

function client(): Client {
  return {
    id: 'cliente-norte',
    name: 'Cliente Norte',
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 20,
    monthlyBilling: Array.from({ length: 12 }, () => 250_000),
    complianceRate: 0.9,
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
    uploadedAt: `${TODAY}T00:00:00.000Z`,
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

function cobranza(): CobranzaRecord {
  return {
    cia: '00001',
    noCliente: 'cliente-norte',
    nombreCliente: 'Cliente Norte',
    noFactura: 'F-100',
    fechaFactura: '2026-05-20',
    fechaVence: '2026-06-20',
    fechaCobro: '',
    diasVencida: 0,
    importeBrutoPesos: 290_000,
    importePendientePesos: 250_000,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '',
    estatus: 'ABIERTO',
    tipoCambio: 1,
    tasaFiscal: '16',
    subTotal: 250_000,
    importeIVA: 40_000,
    importeRetencion: 0,
  };
}
