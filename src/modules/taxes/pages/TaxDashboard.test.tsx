import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import TaxDashboard from './TaxDashboard';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { AuxiliarReconLine, AuxiliarReconResult } from '../../../domain/auxiliarReconciliationEngine';
import type { CashFlowAssumptions, Client } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { BankStatementLine, CobranzaPayment } from '../../../services/jdeTypes';
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
        cobranzaPayments={[cobranzaPayment()]}
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
        cobranzaPayments={[cobranzaPayment()]}
        assumptions={assumptions}
        budget={budget()}
        startingBalance={20_000}
      />,
    );

    expect(screen.getByText(/Haz clic en un monto/i)).toBeTruthy();
    expect(screen.getByText(/Pagos registrados/i)).toBeTruthy();
  });

  it('does not create an adjustment (no duplication) when an inline edit is opened and blurred without changes', () => {
    render(
      <TaxDashboard
        companyCode="all"
        bankStatements={[bank()]}
        clients={[client()]}
        providers={[]}
        cxpRecords={[]}
        cobranzaPayments={[cobranzaPayment()]}
        assumptions={assumptions}
        budget={budget()}
        startingBalance={20_000}
      />,
    );

    // Period 2026-05 has IVA caused 160 from the default cobranza payment.
    const row = screen.getByText('2026-05').closest('tr') as HTMLElement;
    const ivaCell = within(row).getAllByText('$160.00')[0];
    fireEvent.click(ivaCell);

    const input = within(row).getByRole('spinbutton') as HTMLInputElement;
    expect(input.value).toBe('160');
    // Open + blur with no change must be a no-op — previously this appended an
    // additive IVA_PAYABLE equal to the full value and doubled the cell.
    fireEvent.blur(input);

    const afterNoop = JSON.parse(localStorage.getItem('midas.taxes.v1') ?? '{}');
    expect(afterNoop.adjustments ?? []).toHaveLength(0);
    expect(within(row).getAllByText('$160.00').length).toBeGreaterThan(0);

    // An actual change applies the DELTA so the cell becomes exactly the typed
    // value (160 → 500 stores +340), not 160 stacked on top of 160.
    fireEvent.click(within(row).getAllByText('$160.00')[0]);
    const input2 = within(row).getByRole('spinbutton') as HTMLInputElement;
    fireEvent.change(input2, { target: { value: '500' } });
    fireEvent.blur(input2);

    const afterEdit = JSON.parse(localStorage.getItem('midas.taxes.v1') ?? '{}');
    expect(afterEdit.adjustments).toHaveLength(1);
    expect(afterEdit.adjustments[0]).toMatchObject({
      taxType: 'IVA',
      period: '2026-05',
      kind: 'IVA_PAYABLE',
      amount: 340,
    });
  });

  it('shows approved tax payments as connected cash outflows for planning and projection', () => {
    render(
      <TaxDashboard
        companyCode="all"
        bankStatements={[bank()]}
        clients={[client()]}
        providers={[]}
        cxpRecords={[]}
        cobranzaPayments={[cobranzaPayment()]}
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
        cobranzaPayments={[cobranzaPayment()]}
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
        cobranzaPayments={[cobranzaPayment()]}
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
        cobranzaPayments={[cobranzaPayment()]}
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

  it('shows historic IVA paid from bank statements in the IVA detail', () => {
    render(
      <TaxDashboard
        companyCode="all"
        bankStatements={[bank([bankLine({ concepto: 'PAGO IVA MAYO', importe: 100 })])]}
        clients={[]}
        providers={[]}
        cxpRecords={[]}
        cobranzaPayments={[cobranzaPayment()]}
        assumptions={assumptions}
        budget={null}
        startingBalance={20_000}
      />,
    );

    fireEvent.click(screen.getByText('2026-05'));
    fireEvent.click(screen.getByRole('button', { name: /IVA/i }));
    expect(screen.getByText('IVA pagado')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pagado (1)' }));

    expect(screen.getByText('Pago IVA · PAGO IVA MAYO')).toBeTruthy();
    expect(screen.getByText('SAT — IVA')).toBeTruthy();
  });

  it('does not create creditable IVA from budget in the invoice-only tax dashboard', () => {
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

    expect(screen.queryByText('2026-02')).toBeNull();
    expect(screen.getByText(/Sin periodos fiscales visibles/i)).toBeTruthy();
  });

  it('uses CXP invoices, not standalone purchase receipts, as creditable IVA in taxes', () => {
    render(
      <TaxDashboard
        companyCode="all"
        bankStatements={[bank()]}
        clients={[]}
        providers={[]}
        cxpRecords={[cxpRecord({ noFactura: 'F-CXP-16' })]}
        auxiliarReconciliation={auxiliarResult([auxiliarLine({ noFactura: 'F-CXP-16' })])}
        purchaseReceipts={[purchaseReceipt({ invoiceNo: 'OC-IVA-16' })]}
        assumptions={assumptions}
        budget={null}
        startingBalance={20_000}
      />,
    );

    fireEvent.click(screen.getByText('2026-05'));
    fireEvent.click(screen.getByRole('button', { name: /IVA/i }));
    fireEvent.click(screen.getByRole('button', { name: /Acreditable/i }));

    expect(screen.getByText(/F-CXP-16/i)).toBeTruthy();
    expect(screen.queryByText(/OC-IVA-16/i)).toBeNull();
    expect(screen.queryByText(/Sin egresos acreditables/i)).toBeNull();
  });

  // Obsoleto en la branch del motor AuxiliarContable: TaxDashboard ya no
  // recibe `cargoEnrichments` (PagoProveedor↔CARGO). La reclasificación de
  // egresos como IVA acreditable ahora se deriva del cruce AuxiliarContable
  // dentro de la fuente de proyección. Reescribir cuando exista cobertura
  // de egresos verificada contra datos reales.
  it.skip('uses PagoProveedor cargo enrichments from App to classify bank cargos as AP IVA creditable', () => {
    // intentionally skipped — see comment above.
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

function cobranzaPayment(): CobranzaPayment {
  return {
    idPago: 'PAY-IVA',
    cia: '00001',
    fechaCobro: '2026-05-10',
    fechaContable: '2026-05-10',
    cuentaBancaria: '123',
    banco: 'BANCO',
    noRecibo: 'PAY-IVA',
    importeRecibo: 1160,
    pendienteAplicar: 0,
    noCliente: 'C-1',
    cliente: 'Cliente IVA',
    noBatch: 'B-1',
    tipoCambio: 1,
    applications: [{
      idPago: 'PAY-IVA',
      cia: '00001',
      fechaAplicacion: '2026-05-10',
      noCliente: 'C-1',
      cliente: 'Cliente IVA',
      tipoDocto: 'RI',
      noFactura: 'RI-IVA',
      noFacturaNormalizada: 'RI-IVA',
      fechaFactura: '2026-05-01',
      fechaVencimiento: '2026-05-31',
      diasAntiguedadFafv: 0,
      importeCobrado: 1160,
      importeOriginalFactura: 1160,
      tasaIva: 'IVA16',
      importeIvaFacturaOriginal: 160,
    }],
  };
}

function cxpRecord(patch: Partial<CXPRecord> = {}): CXPRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? 'P-1',
    nombre: patch.nombre ?? 'Proveedor IVA',
    noFactura: patch.noFactura ?? 'F-CXP',
    fechaFactura: patch.fechaFactura ?? '2026-05-01',
    fechaVence: patch.fechaVence ?? '2026-05-17',
    fechaProgramacionPago: patch.fechaProgramacionPago ?? '2026-05-17',
    diasVencida: patch.diasVencida ?? 0,
    importeBrutoPesos: patch.importeBrutoPesos ?? 1160,
    importePendientePesos: patch.importePendientePesos ?? 1160,
    importeSubtotalPesos: patch.importeSubtotalPesos ?? 1000,
    importeImpuestosPesos: patch.importeImpuestosPesos ?? 160,
    importeBrutoDolares: patch.importeBrutoDolares ?? 0,
    importePendienteDolares: patch.importePendienteDolares ?? 0,
    moneda: patch.moneda ?? 'MXN',
    condPago: patch.condPago ?? '',
    clasifica: patch.clasifica ?? '',
    clasificacionProveedor: patch.clasificacionProveedor ?? '',
    edoPago: patch.edoPago ?? '',
    tipoCambio: patch.tipoCambio ?? 1,
    porVencer: patch.porVencer ?? 0,
    v1_30: patch.v1_30 ?? 0,
    v31_60: patch.v31_60 ?? 0,
    v61_90: patch.v61_90 ?? 0,
    v91_120: patch.v91_120 ?? 0,
    v121_150: patch.v121_150 ?? 0,
    v151_180: patch.v151_180 ?? 0,
    mas180: patch.mas180 ?? 0,
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

function auxiliarResult(lines: AuxiliarReconLine[]): AuxiliarReconResult {
  return {
    lines,
    bankOrphans: [],
    inconsistencies: [],
    sourceConfirmation: new Map(),
    reconciledByCompanyMonth: new Map(),
    summary: {
      totalLineas: lines.length,
      ingresoLineas: 0,
      ingresoCruzadas: 0,
      ingresoMonto: 0,
      ingresoMontoCruzado: 0,
      pctIngresoCruzado: 0,
      egresoLineas: lines.length,
      egresoCruzadas: lines.length,
      egresoMonto: lines.reduce((sum, line) => sum + Math.abs(line.importe), 0),
      egresoMontoCruzado: lines.reduce((sum, line) => sum + Math.abs(line.importe), 0),
      pctEgresoCruzado: lines.length > 0 ? 100 : 0,
      conciliadasJde: 0,
      cruzadasSinR: 0,
      cajaLineas: 0,
      cajaMonto: 0,
      internoLineas: 0,
      internoMonto: 0,
      asientoInternoLineas: 0,
      asientoInternoMonto: 0,
      asientoContableLineas: 0,
      asientoContableMonto: 0,
      pendienteRevisionLineas: 0,
      pendienteRevisionMonto: 0,
      sinBancoLineas: 0,
      sinBancoMonto: 0,
      sinCuentaAuxLineas: 0,
      sinCuentaAuxMonto: 0,
      cuentaNoEnBancoLineas: 0,
      cuentaNoEnBancoMonto: 0,
      timingPendienteLineas: 0,
      timingPendienteMonto: 0,
      glOrphanLineas: 0,
      glOrphanMonto: 0,
      bankOrphanLineas: 0,
      bankOrphanMonto: 0,
      bankOrphanOutOfWindowLineas: 0,
      bankOrphanOutOfWindowMonto: 0,
      auxWindow: { min: null, max: null },
      ciaBreakdown: [],
      inconsistencyCounts: {
        'non-bank-batch-in-1020': 0,
      },
    },
  };
}

function auxiliarLine(patch: { noFactura: string; bankDate?: string; importe?: number }): AuxiliarReconLine {
  const bankDate = patch.bankDate ?? '2026-05-12';
  const importe = patch.importe ?? -1160;
  return {
    glKey: `00001::aux::PV::${patch.noFactura}`,
    cia: '00001',
    cuentaBanco: '123',
    nombreCuenta: 'BANCO',
    cuentaContable: '42.1020.0010409',
    cuentaObjeto: '1020',
    idCuenta: '0010409',
    flujo: 'egreso',
    esCaja: false,
    fechaContable: bankDate,
    importe,
    moneda: 'MXP',
    tipoDocto: 'PV',
    tipoDoctoDesc: 'Pago',
    estatusConciliado: '',
    matchTier: 'exact',
    confidence: 0.97,
    bankMovementKey: `bank:${patch.noFactura}`,
    bankDate,
    bankAmount: importe,
    source: {
      kind: 'factura',
      cia: '00001',
      ref: patch.noFactura,
      contraparte: 'Proveedor IVA',
    },
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

function bankLine(patch: Partial<BankStatementLine> = {}): BankStatementLine {
  return {
    cia: patch.cia ?? '00001',
    banco: patch.banco ?? 'BANCO',
    nombreBanco: patch.nombreBanco ?? 'BANCO',
    cuenta: patch.cuenta ?? '123',
    moneda: patch.moneda ?? 'MXN',
    fechaOperacion: patch.fechaOperacion ?? '2026-05-20',
    referencia: patch.referencia ?? 'REF-IVA',
    concepto: patch.concepto ?? 'PAGO IVA',
    tipoMovimiento: patch.tipoMovimiento ?? 'CARGO',
    importe: patch.importe ?? 100,
    infAdi1: patch.infAdi1,
    infAdi2: patch.infAdi2,
    infAdi3: patch.infAdi3,
    gsaid: patch.gsaid,
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
