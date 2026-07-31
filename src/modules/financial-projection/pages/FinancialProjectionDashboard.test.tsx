import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
    cb();
    return 1;
  });
  vi.stubGlobal('cancelIdleCallback', () => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('<FinancialProjectionDashboard />', () => {
  it('renders the operational projection even when a legacy budget is passed', async () => {
    renderDashboard();
    await flushProjectionWarmup();

    await waitFor(() => expect(screen.getByText('Caja final')).toBeTruthy());
    expect(screen.getByText('Días en déficit')).toBeTruthy();
  });

  // Regresión: "aparecieron todos los números pero no duraron ni un segundo".
  // `sourceKey` es huella de CONTENIDO de todos los inputs, así que una ola de
  // datos posterior al boot (delta de bancos, backfill, revalidación) la cambia.
  // Antes, ese instante hacía `source = null` y el tablero completo se
  // reemplazaba por `ProjectionWarmupShell` durante el debounce de 12s MÁS el
  // rebuild del canónico. Ahora se conservan las cifras del build previo
  // mientras el nuevo se computa.
  it('mantiene las cifras en pantalla cuando llega una ola de datos nueva', async () => {
    const view = renderDashboard();
    await flushProjectionWarmup();
    await waitFor(() => expect(screen.getByText('Caja final')).toBeTruthy());

    // Ola de fondo: basta mover la huella de los inputs (aquí el saldo inicial,
    // el delta más barato) para que `sourceKey` cambie y `sourceState` deje de
    // empatar — el mismo instante que antes vaciaba la pantalla.
    view.rerender(
      <FinancialProjectionDashboard
        companyCode="all"
        bankStatements={[bank()]}
        clients={[client()]}
        providers={[]}
        cxpRecords={[]}
        cobranzaRecords={[cobranza()]}
        assumptions={assumptions}
        budget={budget()}
        startingBalance={10_001}
      />,
    );

    // Sin await: éste es exactamente el instante en el que el tablero se vaciaba.
    expect(screen.queryByLabelText('Calculando proyección')).toBeNull();
    expect(screen.getByText('Caja final')).toBeTruthy();
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
