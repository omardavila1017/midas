import { describe, expect, it } from 'vitest';
import type { Budget } from './budget';
import {
  buildOperatingProjection,
  type OperatingFixedRule,
} from './operatingProjectionModule';
import type {
  CashFlowAssumptions,
  Provider,
} from './types';
import type {
  AgedBalanceRecord,
  BankAccountStatement,
} from '../services/jdeTypes';

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

describe('buildOperatingProjection', () => {
  it('distributes diesel and gas only on Monday to Wednesday business days', () => {
    const result = buildOperatingProjection({
      startDate: '2026-05-01',
      endDate: '2026-05-31',
      bankStatements: [bank({ saldoFinal: 5_000 })],
      clients: [],
      providers: [],
      agedBalances: [],
      budget: budget({
        expenseByConcept: [
          monthlyRow('Diésel', 900),
          monthlyRow('Gas', 300),
        ],
      }),
      assumptions,
      fixedRules: [],
    });

    const dieselGasDays = result.days
      .filter((day) => day.scheduledOutflows.some((line) => line.category === 'Diésel' || line.category === 'Gas'))
      .map((day) => ({ date: day.date, dow: new Date(`${day.date}T12:00:00Z`).getUTCDay() }));

    expect(dieselGasDays.length).toBeGreaterThan(0);
    expect(dieselGasDays.every((entry) => entry.dow >= 1 && entry.dow <= 3)).toBe(true);

    const total = result.days
      .flatMap((day) => day.scheduledOutflows)
      .filter((line) => line.category === 'Diésel' || line.category === 'Gas')
      .reduce((sum, line) => sum + line.amount, 0);
    expect(total).toBeCloseTo(1_200, 4);
  });

  it('pays higher priority providers before lower blocks', () => {
    const result = buildOperatingProjection({
      startDate: '2026-05-05',
      endDate: '2026-05-05',
      bankStatements: [bank({ saldoFinal: 1_000 })],
      clients: [],
      providers: [
        provider('PROVEEDOR CRITICO', { risk: 'Alto', flexibility: 'inamovible' }),
        provider('PROVEEDOR FLEXIBLE', { risk: 'Bajo', flexibility: 'flexible' }),
      ],
      agedBalances: [
        aged('PROVEEDOR CRITICO', 700, '2026-05-05'),
        aged('PROVEEDOR FLEXIBLE', 700, '2026-05-05'),
      ],
      assumptions,
      fixedRules: [],
    });

    const payments = result.days[0].supplierPayments;
    const byProvider = new Map<string, number>();
    for (const payment of payments) {
      byProvider.set(payment.providerName, (byProvider.get(payment.providerName) ?? 0) + payment.amount);
    }

    expect(byProvider.get('PROVEEDOR CRITICO')).toBeCloseTo(700, 4);
    expect(byProvider.get('PROVEEDOR FLEXIBLE')).toBeCloseTo(300, 4);

    const criticalPayment = payments.find((payment) => payment.providerName === 'PROVEEDOR CRITICO');
    expect(criticalPayment).toEqual(expect.objectContaining({
      invoiceNumber: 'FAC-1',
      invoiceDate: '2026-04-01',
      invoiceAmount: 700,
      remainingAfterPayment: 0,
      reason: 'due',
      paymentExplanation: expect.stringContaining('programada'),
      priorityExplanation: expect.stringContaining('riesgo alto'),
    }));
  });

  it('reduces pressured credit lines to 80% before general due payments', () => {
    const result = buildOperatingProjection({
      startDate: '2026-05-05',
      endDate: '2026-05-05',
      bankStatements: [bank({ saldoFinal: 400 })],
      clients: [],
      providers: [
        provider('PROVEEDOR LINEA', { risk: 'Alto', flexibility: 'inamovible', creditLimit: 1_000 }),
        provider('PROVEEDOR HOY', { risk: 'Alto', flexibility: 'inamovible' }),
      ],
      agedBalances: [
        aged('PROVEEDOR LINEA', 500, '2026-05-30', 'F-1'),
        aged('PROVEEDOR LINEA', 500, '2026-05-30', 'F-2'),
        aged('PROVEEDOR HOY', 400, '2026-05-05', 'F-3'),
      ],
      assumptions,
      fixedRules: [],
    });

    const payments = result.days[0].supplierPayments;
    const creditPayments = payments.filter((payment) => payment.reason === 'credit_limit');
    const duePayments = payments.filter((payment) => payment.reason === 'due');

    expect(creditPayments.reduce((sum, payment) => sum + payment.amount, 0)).toBeCloseTo(200, 4);
    expect(creditPayments.every((payment) => payment.providerName === 'PROVEEDOR LINEA')).toBe(true);
    expect(creditPayments[0]).toEqual(expect.objectContaining({
      invoiceNumber: 'F-1',
      invoiceAmount: 500,
      remainingAfterPayment: 300,
      creditLimit: 1_000,
      paymentExplanation: expect.stringContaining('80%'),
      priorityExplanation: expect.stringContaining('no conviene mover fecha'),
    }));
    expect(duePayments.reduce((sum, payment) => sum + payment.amount, 0)).toBeCloseTo(200, 4);
    expect(duePayments.every((payment) => payment.providerName === 'PROVEEDOR HOY')).toBe(true);
  });

  it('moves fixed obligations from weekend to next business day', () => {
    const rules: OperatingFixedRule[] = [
      {
        id: 'weekend-fixed',
        label: 'Pago fin de semana',
        concept: 'Pasivos Financieros',
        amount: 500,
        anchorDate: '2026-06-20',
      },
    ];

    const result = buildOperatingProjection({
      startDate: '2026-06-20',
      endDate: '2026-06-22',
      bankStatements: [bank({ saldoFinal: 1_000 })],
      clients: [],
      providers: [],
      agedBalances: [],
      assumptions,
      fixedRules: rules,
    });

    const withOutflow = result.days.filter((day) => day.scheduledOutflows.length > 0);
    expect(withOutflow).toHaveLength(1);
    expect(withOutflow[0].date).toBe('2026-06-22');
    expect(withOutflow[0].scheduledOutflows[0].amount).toBe(500);
  });

  it('reserves cash for mandatory fixed obligations before supplier payments', () => {
    const result = buildOperatingProjection({
      startDate: '2026-05-01',
      endDate: '2026-05-05',
      bankStatements: [bank({ saldoFinal: 1_000 })],
      clients: [],
      providers: [provider('PROVEEDOR FLEXIBLE', { risk: 'Bajo', flexibility: 'flexible' })],
      agedBalances: [aged('PROVEEDOR FLEXIBLE', 1_000, '2026-05-01')],
      assumptions,
      fixedRules: [
        {
          id: 'mandatory-loan',
          label: 'Crédito obligatorio',
          concept: 'Pasivos Financieros',
          amount: 800,
          anchorDate: '2026-05-05',
        },
      ],
    });

    const firstDay = result.days[0];
    const supplierPaid = firstDay.supplierPayments.reduce((sum, payment) => sum + payment.amount, 0);
    expect(firstDay.mandatoryReserve).toBeCloseTo(800, 4);
    expect(firstDay.freeCash).toBeCloseTo(0, 4);
    expect(supplierPaid).toBeCloseTo(200, 4);

    const paymentDay = result.days.find((day) => day.date === '2026-05-05');
    expect(paymentDay).toBeTruthy();
    expect(paymentDay!.scheduledOutflows.reduce((sum, line) => sum + line.amount, 0)).toBeCloseTo(800, 4);
    expect(paymentDay!.unpaidScheduledAmount).toBeCloseTo(0, 4);
  });

  it('applies manual operating adjustments to projected cash', () => {
    const result = buildOperatingProjection({
      startDate: '2026-05-01',
      endDate: '2026-05-04',
      bankStatements: [bank({ saldoFinal: 1_000 })],
      clients: [],
      providers: [],
      agedBalances: [],
      assumptions,
      fixedRules: [],
      operatingAdjustments: [
        {
          id: 'manual-out',
          date: '2026-05-01',
          label: 'Pago manual',
          amount: 300,
          direction: 'outflow',
          affectsCash: true,
          category: 'Salida manual',
        },
        {
          id: 'manual-in',
          date: '2026-05-04',
          label: 'Depósito manual',
          amount: 500,
          direction: 'inflow',
          affectsCash: true,
          category: 'Entrada manual',
        },
      ],
    });

    expect(result.days[0].scheduledOutflows).toEqual([
      expect.objectContaining({
        label: 'Pago manual',
        amount: 300,
        source: 'adjustment',
      }),
    ]);
    expect(result.days[0].closingCash).toBeCloseTo(700, 4);
    expect(result.days[3].cashInflows).toEqual([
      expect.objectContaining({
        label: 'Depósito manual',
        amount: 500,
        source: 'adjustment',
      }),
    ]);
    expect(result.days[3].closingCash).toBeCloseTo(1_200, 4);
  });

  it('lets a scenario move a supplier invoice to a manual date and amount', () => {
    const invoiceKey = [
      'provider-PROVEEDOR MANUAL',
      'F-1',
      '2026-04-01',
      700,
    ].join('|');
    const result = buildOperatingProjection({
      startDate: '2026-05-05',
      endDate: '2026-05-06',
      bankStatements: [bank({ saldoFinal: 1_000 })],
      clients: [],
      providers: [
        provider('PROVEEDOR MANUAL', { risk: 'Alto', flexibility: 'inamovible' }),
      ],
      agedBalances: [
        aged('PROVEEDOR MANUAL', 700, '2026-05-05', 'F-1'),
      ],
      assumptions,
      fixedRules: [],
      supplierPaymentOverrides: [
        {
          invoiceKey,
          date: '2026-05-06',
          amount: 250,
          note: 'Negociado con compras',
        },
      ],
    });

    expect(result.days[0].supplierPayments).toHaveLength(0);
    expect(result.days[0].pendingSupplierAmount).toBeCloseTo(700, 4);

    expect(result.days[1].supplierPayments).toEqual([
      expect.objectContaining({
        providerName: 'PROVEEDOR MANUAL',
        invoiceKey,
        amount: 250,
        reason: 'manual',
        paymentExplanation: expect.stringContaining('Negociado con compras'),
        remainingAfterPayment: 450,
      }),
    ]);
    expect(result.days[1].pendingSupplierAmount).toBeCloseTo(450, 4);
  });

  it('exposes a supplier priority queue with moved status and algorithm context', () => {
    const invoiceKey = [
      'provider-PROVEEDOR MANUAL',
      'F-1',
      '2026-04-01',
      700,
    ].join('|');
    const result = buildOperatingProjection({
      startDate: '2026-05-05',
      endDate: '2026-05-06',
      bankStatements: [bank({ saldoFinal: 1_000 })],
      clients: [],
      providers: [
        provider('PROVEEDOR MANUAL', {
          risk: 'Alto',
          flexibility: 'inamovible',
          creditLimit: 500,
        }),
      ],
      agedBalances: [
        aged('PROVEEDOR MANUAL', 700, '2026-05-05', 'F-1'),
      ],
      assumptions,
      fixedRules: [],
      supplierPaymentOverrides: [
        {
          invoiceKey,
          date: '2026-05-06',
          amount: 250,
          note: 'Negociado con compras',
        },
      ],
    });

    expect(result.supplierQueue).toEqual([
      expect.objectContaining({
        invoiceKey,
        providerName: 'PROVEEDOR MANUAL',
        risk: 'Alto',
        flexibility: 'inamovible',
        status: 'moved',
        creditStatus: 'exceeded',
        plannedDate: '2026-05-06',
        plannedAmount: 250,
        paidAmount: 250,
        remainingAmount: 450,
        paymentExplanation: expect.stringContaining('Negociado con compras'),
        priorityExplanation: expect.stringContaining('riesgo alto'),
      }),
    ]);
  });

  it('honors split manual supplier payments without auto-paying the remaining invoice early', () => {
    const invoiceKey = [
      'provider-PROVEEDOR SPLIT',
      'F-SPLIT',
      '2026-04-01',
      900,
    ].join('|');
    const result = buildOperatingProjection({
      startDate: '2026-05-05',
      endDate: '2026-05-20',
      bankStatements: [bank({ saldoFinal: 2_000 })],
      clients: [],
      providers: [
        provider('PROVEEDOR SPLIT', { risk: 'Alto', flexibility: 'inamovible' }),
      ],
      agedBalances: [
        aged('PROVEEDOR SPLIT', 900, '2026-05-05', 'F-SPLIT'),
      ],
      assumptions,
      fixedRules: [],
      supplierPaymentOverrides: [
        { invoiceKey, date: '2026-05-05', amount: 300, note: 'Tramo 1' },
        { invoiceKey, date: '2026-05-12', amount: 300, note: 'Tramo 2' },
        { invoiceKey, date: '2026-05-19', amount: 300, note: 'Tramo 3' },
      ],
    });

    const payments = result.days.flatMap((day) => day.supplierPayments.map((payment) => ({ date: day.date, payment })));
    expect(payments).toEqual([
      expect.objectContaining({ date: '2026-05-05', payment: expect.objectContaining({ amount: 300, reason: 'manual' }) }),
      expect.objectContaining({ date: '2026-05-12', payment: expect.objectContaining({ amount: 300, reason: 'manual' }) }),
      expect.objectContaining({ date: '2026-05-19', payment: expect.objectContaining({ amount: 300, reason: 'manual' }) }),
    ]);
    expect(result.summary.pendingSupplierAmount).toBeCloseTo(0, 4);
  });

  it('uses manual tax events instead of budget fallback dates', () => {
    const result = buildOperatingProjection({
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      bankStatements: [bank({ saldoFinal: 2_000 })],
      clients: [],
      providers: [],
      agedBalances: [],
      assumptions,
      fixedRules: [],
      budget: budget({
        expenseByConcept: [
          {
            concept: 'Impuestos',
            monthly: [0, 0, 0, 0, 0, 300, 0, 0, 0, 0, 0, 0],
          },
        ],
      }),
      manualExpenseEvents: [
        {
          concept: 'Impuestos',
          date: '2026-06-20',
          amount: 120,
          label: 'ISR junio tramo 1',
        },
        {
          concept: 'Impuestos',
          date: '2026-06-29',
          amount: 180,
          label: 'ISR junio tramo 2',
        },
      ],
    });

    const taxFlows = result.days
      .flatMap((day) => day.scheduledOutflows)
      .filter((line) => line.category === 'Impuestos');

    expect(taxFlows).toHaveLength(2);
    expect(taxFlows.map((line) => line.amount)).toEqual([120, 180]);
    expect(taxFlows.map((line) => line.detail)).toEqual([
      'Manual · programado 2026-06-22',
      'Manual · programado 2026-06-29',
    ]);
    expect(result.alerts.some((alert) => alert.includes('sin carga manual'))).toBe(false);
  });

  it('allows a zero manual tax override to suppress the budget fallback', () => {
    const result = buildOperatingProjection({
      startDate: '2026-06-01',
      endDate: '2026-06-30',
      bankStatements: [bank({ saldoFinal: 2_000 })],
      clients: [],
      providers: [],
      agedBalances: [],
      assumptions,
      fixedRules: [],
      budget: budget({
        expenseByConcept: [
          {
            concept: 'Impuestos',
            monthly: [0, 0, 0, 0, 0, 300, 0, 0, 0, 0, 0, 0],
          },
        ],
      }),
      manualExpenseEvents: [
        {
          concept: 'Impuestos',
          date: '2026-06-30',
          amount: 0,
          label: 'Sin pago fiscal en escenario',
        },
      ],
    });

    const taxFlows = result.days
      .flatMap((day) => day.scheduledOutflows)
      .filter((line) => line.category === 'Impuestos');

    expect(taxFlows).toHaveLength(0);
    expect(result.summary.totalScheduledOutflows).toBeCloseTo(0, 4);
    expect(result.alerts.some((alert) => alert.includes('sin carga manual'))).toBe(false);
  });
});

function budget(overrides: Partial<Budget>): Budget {
  return {
    year: 2026,
    scale: 'pesos',
    incomeTotal: Array.from({ length: 12 }, () => 0),
    incomeByConcept: [],
    expenseTotal: Array.from({ length: 12 }, () => 0),
    expenseByConcept: [],
    uploadedAt: '2026-04-23T12:00:00Z',
    ...overrides,
  };
}

function monthlyRow(concept: string, mayAmount: number) {
  const monthly = Array.from({ length: 12 }, () => 0);
  monthly[4] = mayAmount;
  return { concept, monthly };
}

function provider(name: string, overrides: Partial<Provider> = {}): Provider {
  return {
    id: `provider-${name}`,
    name,
    type: 'Servicios',
    risk: 'Medio',
    paymentPeriod: '30 días',
    flexibility: 'revisar',
    ...overrides,
  };
}

function aged(
  nombre: string,
  importePendientePesos: number,
  fechaProgramacionPago: string,
  noFactura = 'FAC-1',
): AgedBalanceRecord {
  return {
    cia: '00001',
    noProveedor: nombre,
    nombre,
    noFactura,
    fechaFactura: '2026-04-01',
    fechaVence: fechaProgramacionPago,
    fechaProgramacionPago,
    diasVencida: 0,
    importeBrutoPesos: importePendientePesos,
    importePendientePesos,
    importeSubtotalPesos: importePendientePesos,
    importeImpuestosPesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30 días',
    clasifica: '',
    clasificacionProveedor: '',
    edoPago: '',
    tipoCambio: 1,
    porVencer: 0,
    v1_30: 0,
    v31_60: 0,
    v61_90: 0,
    v91_120: 0,
    v121_150: 0,
    v151_180: 0,
    mas180: 0,
  };
}

function bank(overrides: Partial<BankAccountStatement> = {}): BankAccountStatement {
  return {
    cia: '00001',
    banco: 'BANCO',
    cuenta: '1234567890',
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-05-05',
    saldoInicial: 0,
    saldoFinal: 0,
    movimientos: [],
    ...overrides,
  };
}
