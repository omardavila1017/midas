import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import TaxDashboard from './TaxDashboard';
import type { Budget } from '../../../domain/budget';
import type { CashFlowAssumptions, Client } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { BankStatementLine } from '../../../services/jdeTypes';
import type { CargoPaymentEnrichment } from '../../../domain/paymentReconciliationEngine';
import type { PurchaseReceiptRecord } from '../../shared-finance/types';

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
    expect(screen.getByText('Resumen')).toBeTruthy();
    expect(screen.getByText('Estado operativo')).toBeTruthy();

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
    expect(screen.getAllByText('Aprobado: impacta caja').length).toBeGreaterThan(0);

    const stored = JSON.parse(localStorage.getItem('midas.taxes.v1') ?? '{}');
    expect(stored.obligations[0].paymentPlan[0]).toMatchObject({
      status: 'APPROVED',
    });
  });

  it('deletes a scheduled tax payment without deleting the obligation', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /Pagos/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /Programar pago/i })[0]);

    expect(screen.getByTestId('tax-payment-card')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Borrar pago/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Borrar pago/i }));

    expect(screen.getByText(/Pago eliminado/i)).toBeTruthy();
    expect(screen.queryByTestId('tax-payment-card')).toBeNull();
    expect(screen.queryByText('Aprobado: impacta caja')).toBeNull();

    const stored = JSON.parse(localStorage.getItem('midas.taxes.v1') ?? '{}');
    expect(stored.obligations).toHaveLength(1);
    expect(stored.obligations[0].paymentPlan).toHaveLength(0);
  });

  it('does not add duplicate payments once the current obligation is already planned', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /Pagos/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /Programar pago/i })[0]);

    expect(screen.getByText(/Pago ya programado/i)).toBeTruthy();
    const stored = JSON.parse(localStorage.getItem('midas.taxes.v1') ?? '{}');
    expect(stored.obligations[0].paymentPlan).toHaveLength(1);
  });

  it('uses compact payment cards instead of the previous fixed wide grid', () => {
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

    fireEvent.click(screen.getByRole('button', { name: /Pagos/i }));
    fireEvent.click(screen.getAllByRole('button', { name: /Programar pago/i })[0]);

    const card = screen.getByTestId('tax-payment-card');
    expect(card.className).toContain('rounded');
    expect(card.className).not.toContain('md:grid-cols-[130px_1fr_120px_110px_160px]');
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
    fireEvent.click(screen.getByRole('button', { name: /IVA/i }));
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

  it('uses purchase receipts passed from App as creditable IVA in taxes', () => {
    render(
      <TaxDashboard
        companyCode="all"
        bankStatements={[bank()]}
        clients={[]}
        providers={[]}
        cxpRecords={[]}
        purchaseReceipts={[purchaseReceipt({ invoiceNo: 'OC-IVA-16' })]}
        assumptions={assumptions}
        budget={null}
        startingBalance={20_000}
      />,
    );

    fireEvent.click(screen.getByText('2026-05'));
    fireEvent.click(screen.getByRole('button', { name: /IVA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Acreditable/i }));

    expect(screen.getByText(/OC-IVA-16/i)).toBeTruthy();
    expect(screen.queryByText(/Sin egresos acreditables/i)).toBeNull();
  });

  it('uses PagoProveedor cargo enrichments from App to classify bank cargos as AP IVA creditable', () => {
    const movement = bankMovement({
      fechaOperacion: '2026-05-08',
      referencia: 'PP-1',
      concepto: 'Pago proveedor',
      tipoMovimiento: 'CARGO',
      importe: 1160,
    });
    const key = [
      movement.cia,
      movement.cuenta,
      movement.fechaOperacion,
      movement.referencia,
      movement.tipoMovimiento,
      movement.importe,
      movement.concepto,
    ].join('|');
    const cargoEnrichments = new Map<string, CargoPaymentEnrichment>([[
      key,
      {
        movementKey: key,
        status: 'MATCHED',
        payments: [{ noPago: 'P-1', nombreProveedor: 'Proveedor IVA', importe: 1160, tier: 'exact' }],
      },
    ]]);

    render(
      <TaxDashboard
        companyCode="all"
        bankStatements={[bank([movement])]}
        clients={[]}
        providers={[]}
        cxpRecords={[]}
        cargoEnrichments={cargoEnrichments}
        assumptions={assumptions}
        budget={null}
        startingBalance={20_000}
      />,
    );

    fireEvent.click(screen.getByText('2026-05'));
    fireEvent.click(screen.getByRole('button', { name: /IVA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Acreditable/i }));

    expect(screen.getByText(/Pago proveedor/i)).toBeTruthy();
    expect(screen.queryByText(/Sin egresos acreditables/i)).toBeNull();
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

function bank(movimientos: BankStatementLine[] = []): BankAccountStatement {
  return {
    cia: '00001',
    banco: 'BANCO',
    cuenta: '123',
    moneda: 'MXN',
    fechaEstadoCuenta: TODAY,
    saldoInicial: 20_000,
    saldoFinal: 20_000,
    movimientos,
  };
}

function bankMovement(patch: Partial<BankStatementLine>): BankStatementLine {
  return {
    cia: patch.cia ?? '00001',
    banco: patch.banco ?? 'BANCO',
    cuenta: patch.cuenta ?? '123',
    moneda: patch.moneda ?? 'MXN',
    fechaOperacion: patch.fechaOperacion ?? TODAY,
    referencia: patch.referencia ?? 'REF-1',
    concepto: patch.concepto ?? 'Movimiento banco',
    tipoMovimiento: patch.tipoMovimiento ?? 'CARGO',
    importe: patch.importe ?? 0,
  };
}

function purchaseReceipt(patch: Partial<PurchaseReceiptRecord> = {}): PurchaseReceiptRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? 'P-1',
    supplierName: patch.supplierName ?? 'Proveedor IVA',
    invoiceNo: patch.invoiceNo ?? 'OC-IVA',
    purchaseOrderNo: patch.purchaseOrderNo ?? 'PO-1',
    receiptNo: patch.receiptNo ?? 'REC-1',
    orderDate: patch.orderDate ?? '2026-05-01',
    receiptDate: patch.receiptDate ?? '2026-05-01',
    creditDays: patch.creditDays ?? 0,
    estimatedDueDate: patch.estimatedDueDate ?? '2026-05-15',
    currency: patch.currency ?? 'MXN',
    exchangeRate: patch.exchangeRate ?? 1,
    totalAmount: patch.totalAmount ?? 1160,
    amountMxn: patch.amountMxn ?? patch.totalAmount ?? 1160,
    taxRateCode: patch.taxRateCode ?? 'IVA16',
    taxRate: patch.taxRate ?? 16,
    taxTreatment: patch.taxTreatment ?? 'IVA_CREDITABLE',
    taxBaseAmount: patch.taxBaseAmount ?? 1000,
    taxAmount: patch.taxAmount ?? 160,
    isCancelled: patch.isCancelled ?? false,
    status: patch.status ?? 'PROJECTED_BASE',
  };
}
