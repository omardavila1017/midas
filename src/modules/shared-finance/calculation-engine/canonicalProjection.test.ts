import { describe, expect, it } from 'vitest';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement, BankStatementLine, CobranzaRecord } from '../../../services/jdeTypes';
import { buildHistoricalMonths } from '../../../domain/cashFlowEngine';
import type {
  RealReconciliationMatch,
  RealReconciliationResult,
} from '../../../domain/realReconciliationEngine';
import { buildCanonicalProjection } from './canonicalProjection';

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

describe('canonicalProjection IVA metadata', () => {
  it('projects client IVA from net invoice base and defaults missing client rate to 16%', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [client({ ivaRate: undefined })],
      providers: [],
      cxpRecords: [],
      assumptions,
      budget: budget({ incomeMay: 1000 }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const movement = canonical.movements.find((item) => item.category === 'AR_COLLECTION' && item.projectedDate === '2026-05-04');
    expect(movement).toBeTruthy();
    expect(movement?.projectedAmount).toBeCloseTo(1000);
    expect(movement?.taxRate).toBe(16);
    expect(movement?.taxBaseAmount).toBeCloseTo(1000);
    expect(movement?.taxAmount).toBeCloseTo(160);
  });

  it('projects CXP IVA from JDE invoice fields and prorates partial pending amounts', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [
        cxpRecord({
          importeSubtotalPesos: 1000,
          importeImpuestosPesos: 160,
          importeBrutoPesos: 1160,
          importePendientePesos: 580,
        }),
      ],
      assumptions,
      budget: budget({ expenseMay: 580, expenseConcept: null }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const movement = canonical.movements.find((item) => item.category === 'AP_PAYMENT' && item.projectedDate === '2026-05-17');
    expect(movement).toBeTruthy();
    expect(movement?.projectedAmount).toBeCloseTo(580);
    expect(movement?.taxRate).toBe(16);
    expect(movement?.taxBaseAmount).toBeCloseTo(500);
    expect(movement?.taxAmount).toBeCloseTo(80);
  });

  it('keeps overdue open CXP as supplier payments from today with original due date', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [
        bankStatement({
          cia: '00001',
          cuenta: 'CTA-1',
          movimientos: [
            bankMovement({ cia: '00001', cuenta: 'CTA-1', tipoMovimiento: 'ABONO', importe: 1, fechaOperacion: '2026-05-01' }),
          ],
        }),
      ],
      clients: [],
      providers: [provider()],
      cxpRecords: [
        cxpRecord({
          noProveedor: 'P-1',
          nombre: 'Proveedor IVA',
          noFactura: 'F-VENCIDA',
          fechaFactura: '2026-04-01',
          fechaVence: '2026-04-15',
          fechaProgramacionPago: '2026-04-20',
          importePendientePesos: 580,
        }),
      ],
      assumptions,
      budget: budget({ expenseMay: 0, expenseConcept: null }),
      startingBalance: 10_000,
      asOfDate: '2026-05-06',
    });

    const movement = canonical.movements.find((item) => item.id.startsWith('cxp:') && item.sourceObjectId === 'F-VENCIDA');
    expect(movement).toBeTruthy();
    expect(movement?.sourceSystem).toBe('JDE');
    expect(movement?.category).toBe('AP_PAYMENT');
    expect(movement?.counterpartyType).toBe('SUPPLIER');
    expect(movement?.counterpartyId).toBe('provider-1');
    expect(movement?.projectedDate).toBe('2026-05-06');
    expect(movement?.dueDate).toBe('2026-04-15');
    expect(movement?.projectedAmount).toBe(580);
  });

  it('adds regimen 601 IVA creditable metadata to projected budget OPEX', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [],
      assumptions,
      budget: budget({ expenseMay: 1160, expenseConcept: 'Diésel' }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const movement = canonical.movements.find((item) => item.category === 'OPEX' && item.projectedDate === '2026-05-03');
    expect(movement).toBeTruthy();
    expect(movement?.projectedAmount).toBeCloseTo(1160);
    expect(movement?.taxTreatment).toBe('IVA_CREDITABLE');
    expect(movement?.taxRate).toBe(16);
    expect(movement?.taxBaseAmount).toBeCloseTo(1000);
    expect(movement?.taxAmount).toBeCloseTo(160);
  });

  it('adds open JDE CXC invoices as projected inflows using the pending balance', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [client()],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [
        cobranzaRecord({
          noCliente: '1',
          nombreCliente: 'Cliente IVA',
          noFactura: 'CXC-1',
          fechaFactura: '2026-05-01',
          fechaVence: '2026-05-15',
          importeBrutoPesos: 1160,
          importePendientePesos: 580,
        }),
      ],
      assumptions,
      budget: budget({ incomeMay: 0 }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const movement = canonical.movements.find((item) => item.id === 'cxc:00001:1:CXC-1');
    expect(movement).toBeTruthy();
    expect(movement?.sourceSystem).toBe('JDE');
    expect(movement?.category).toBe('AR_COLLECTION');
    expect(movement?.counterpartyType).toBe('CUSTOMER');
    expect(movement?.projectedDate).toBe('2026-05-04');
    expect(movement?.baseAmount).toBe(580);
    expect(movement?.projectedAmount).toBe(580);
    expect(movement?.taxTreatment).toBe('IVA_CAUSED');
    expect(movement?.taxBaseAmount).toBeCloseTo(500);
    expect(movement?.taxAmount).toBeCloseTo(80);
  });

  it('skips internal bank transfers (pair-matched CARGO/ABONO) from FinancialMovement[]', () => {
    // Dos cuentas del mismo grupo. El mismo día se ve un CARGO en una y
    // un ABONO simétrico en la otra: traspaso interno. Si se cuelan a
    // FinancialMovement[], la gráfica de Caja proyectada infla ingresos
    // y egresos por igual y no empata con el Dashboard.
    const bankStatements: BankAccountStatement[] = [
      bankStatement({
        cia: '00001',
        cuenta: 'CTA-A',
        movimientos: [
          bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'CARGO', importe: 50_000, fechaOperacion: '2026-04-10', concepto: 'Mov interno' }),
          bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'ABONO', importe: 10_000, fechaOperacion: '2026-04-15', concepto: 'Cobro cliente real' }),
        ],
      }),
      bankStatement({
        cia: '00001',
        cuenta: 'CTA-B',
        movimientos: [
          bankMovement({ cia: '00001', cuenta: 'CTA-B', tipoMovimiento: 'ABONO', importe: 50_000, fechaOperacion: '2026-04-10', concepto: 'Mov interno' }),
        ],
      }),
    ];

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements,
      clients: [],
      providers: [],
      cxpRecords: [],
      assumptions,
      budget: budget({}),
      startingBalance: 0,
      asOfDate: '2026-04-22',
    });

    const aprilHistorical = canonical.movements.filter(
      (m) => m.status === 'REAL' && m.projectedDate?.startsWith('2026-04'),
    );
    // Sólo el ABONO de 10k del cliente real debe sobrevivir; el par interno se filtra.
    expect(aprilHistorical).toHaveLength(1);
    expect(aprilHistorical[0]?.projectedAmount).toBe(10_000);
    expect(aprilHistorical[0]?.type).toBe('INFLOW');

    // Y los totales históricos del Dashboard deben empatar con la suma
    // de movements REAL — antes el desfase era exactamente el monto interno.
    const dashboardMonths = buildHistoricalMonths(bankStatements);
    const aprilDashboard = dashboardMonths.find((m) => m.yearMonth === '2026-04');
    const sumInflows = aprilHistorical
      .filter((m) => m.type === 'INFLOW')
      .reduce((s, m) => s + m.projectedAmount, 0);
    const sumOutflows = aprilHistorical
      .filter((m) => m.type === 'OUTFLOW')
      .reduce((s, m) => s + m.projectedAmount, 0);
    expect(sumInflows).toBe(aprilDashboard?.income ?? 0);
    expect(sumOutflows).toBe(aprilDashboard?.expense ?? 0);
  });

  it('suppresses CXC facturas already cross-matched to a bank ABONO (cobrada-banco)', () => {
    // Dos facturas: CXC-1 ya cruzó al banco (no debe re-proyectarse),
    // CXC-2 sigue pendiente (sí debe aparecer en la proyección).
    const reconciliation = reconciliationResult([
      reconMatch({ cia: '00001', noFactura: 'CXC-1', status: 'cobrada-banco' }),
      reconMatch({ cia: '00001', noFactura: 'CXC-2', status: 'pendiente' }),
    ]);

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [client()],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [
        cobranzaRecord({ noFactura: 'CXC-1', importePendientePesos: 1_000, fechaFactura: '2026-05-01' }),
        cobranzaRecord({ noFactura: 'CXC-2', importePendientePesos: 2_000, fechaFactura: '2026-05-01' }),
      ],
      cobranzaReconciliation: reconciliation,
      assumptions,
      budget: budget({ incomeMay: 0 }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const cxcMovements = canonical.movements.filter((m) => m.id.startsWith('cxc:'));
    const ids = cxcMovements.map((m) => m.id);
    expect(ids).toContain('cxc:00001:1:CXC-2');
    expect(ids).not.toContain('cxc:00001:1:CXC-1');
  });

  it('keeps CXC facturas in projection when status is cobrada-jde-sin-banco or pendiente', () => {
    // Cruce dudoso (JDE marca cobrada pero no aparece en banco) NO reduce
    // la CXC proyectada — sólo cuando hay match automático con banco.
    const reconciliation = reconciliationResult([
      reconMatch({ cia: '00001', noFactura: 'CXC-A', status: 'cobrada-jde-sin-banco' }),
      reconMatch({ cia: '00001', noFactura: 'CXC-B', status: 'pendiente' }),
    ]);

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [client()],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [
        cobranzaRecord({ noFactura: 'CXC-A', importePendientePesos: 500, fechaFactura: '2026-05-01' }),
        cobranzaRecord({ noFactura: 'CXC-B', importePendientePesos: 700, fechaFactura: '2026-05-01' }),
      ],
      cobranzaReconciliation: reconciliation,
      assumptions,
      budget: budget({ incomeMay: 0 }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const cxcIds = canonical.movements.filter((m) => m.id.startsWith('cxc:')).map((m) => m.id);
    expect(cxcIds).toContain('cxc:00001:1:CXC-A');
    expect(cxcIds).toContain('cxc:00001:1:CXC-B');
  });

  it('does not duplicate the same client cycle as a catalog forecast when CXC already exists', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [client()],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [
        cobranzaRecord({
          noCliente: '1',
          nombreCliente: 'Cliente IVA',
          noFactura: 'CXC-1',
          fechaFactura: '2026-05-01',
          importePendientePesos: 580,
        }),
      ],
      assumptions,
      budget: budget({ incomeMay: 0 }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const mayAr = canonical.movements.filter(
      (item) => item.category === 'AR_COLLECTION' && item.projectedDate.slice(0, 7) === '2026-05',
    );
    expect(mayAr).toHaveLength(1);
    expect(mayAr[0]?.sourceSystem).toBe('JDE');
  });
});

function client(patch: Partial<Client> = {}): Client {
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
    ...patch,
  };
}

function provider(patch: Partial<Provider> = {}): Provider {
  return {
    id: patch.id ?? 'provider-1',
    name: patch.name ?? 'Proveedor IVA',
    type: patch.type ?? 'Operativo',
    risk: patch.risk ?? 'Medio',
    paymentPeriod: patch.paymentPeriod ?? '30 días',
    score: patch.score ?? 88,
    numProveedorJDE: patch.numProveedorJDE ?? 'P-1',
    ...patch,
  };
}

function budget({
  incomeMay = 0,
  expenseMay = 0,
  expenseConcept = 'Gastos de Operación',
}: {
  incomeMay?: number;
  expenseMay?: number;
  expenseConcept?: string | null;
}): Budget {
  const incomeTotal = Array.from({ length: 12 }, () => 0);
  const expenseTotal = Array.from({ length: 12 }, () => 0);
  const expenseMonthly = Array.from({ length: 12 }, () => 0);
  incomeTotal[4] = incomeMay;
  expenseTotal[4] = expenseMay;
  expenseMonthly[4] = expenseMay;
  return {
    year: 2026,
    scale: 'pesos',
    incomeTotal,
    incomeByConcept: [],
    expenseTotal,
    expenseByConcept: expenseMay > 0 && expenseConcept ? [{ concept: expenseConcept, monthly: expenseMonthly }] : [],
    uploadedAt: '2026-01-01T00:00:00Z',
  };
}

function cxpRecord(patch: Partial<CXPRecord>): CXPRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? 'P-1',
    nombre: patch.nombre ?? 'Proveedor IVA',
    noFactura: patch.noFactura ?? 'F-1',
    fechaFactura: patch.fechaFactura ?? '2026-05-01',
    fechaVence: patch.fechaVence ?? '2026-05-17',
    fechaProgramacionPago: patch.fechaProgramacionPago ?? '2026-05-17',
    diasVencida: patch.diasVencida ?? 0,
    importeBrutoPesos: patch.importeBrutoPesos ?? 0,
    importePendientePesos: patch.importePendientePesos ?? 0,
    importeSubtotalPesos: patch.importeSubtotalPesos ?? 0,
    importeImpuestosPesos: patch.importeImpuestosPesos ?? 0,
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

function cobranzaRecord(patch: Partial<CobranzaRecord>): CobranzaRecord {
  return {
    cia: patch.cia ?? '00001',
    noCliente: patch.noCliente ?? '1',
    nombreCliente: patch.nombreCliente ?? 'Cliente IVA',
    noFactura: patch.noFactura ?? 'CXC-1',
    fechaFactura: patch.fechaFactura ?? '2026-05-01',
    fechaVence: patch.fechaVence ?? '2026-05-15',
    fechaCobro: patch.fechaCobro ?? '',
    diasVencida: patch.diasVencida ?? 0,
    importeBrutoPesos: patch.importeBrutoPesos ?? 0,
    importePendientePesos: patch.importePendientePesos ?? 0,
    importeBrutoDolares: patch.importeBrutoDolares ?? 0,
    importePendienteDolares: patch.importePendienteDolares ?? 0,
    moneda: patch.moneda ?? 'MXN',
    condPago: patch.condPago ?? '',
    estatus: patch.estatus ?? 'PENDIENTE',
    tipoCambio: patch.tipoCambio ?? 1,
    raw: patch.raw,
  };
}

function bankMovement(patch: Partial<BankStatementLine> & Pick<BankStatementLine, 'cia' | 'cuenta' | 'tipoMovimiento' | 'importe' | 'fechaOperacion'>): BankStatementLine {
  return {
    cia: patch.cia,
    banco: patch.banco ?? 'BANK-X',
    nombreBanco: patch.nombreBanco,
    cuenta: patch.cuenta,
    moneda: patch.moneda ?? 'MXN',
    fechaOperacion: patch.fechaOperacion,
    fechaValor: patch.fechaValor,
    referencia: patch.referencia ?? '',
    concepto: patch.concepto ?? '',
    tipoMovimiento: patch.tipoMovimiento,
    importe: patch.importe,
    saldo: patch.saldo,
  };
}

function bankStatement(patch: Partial<BankAccountStatement> & Pick<BankAccountStatement, 'cia' | 'cuenta' | 'movimientos'>): BankAccountStatement {
  return {
    cia: patch.cia,
    banco: patch.banco ?? 'BANK-X',
    nombreBanco: patch.nombreBanco,
    cuenta: patch.cuenta,
    moneda: patch.moneda ?? 'MXN',
    fechaEstadoCuenta: patch.fechaEstadoCuenta ?? '2026-04-30',
    saldoInicial: patch.saldoInicial ?? 0,
    saldoFinal: patch.saldoFinal,
    movimientos: patch.movimientos,
  };
}

function reconMatch(patch: Partial<RealReconciliationMatch> & Pick<RealReconciliationMatch, 'cia' | 'noFactura' | 'status'>): RealReconciliationMatch {
  return {
    cia: patch.cia,
    noFactura: patch.noFactura,
    noCliente: patch.noCliente ?? '1',
    nombreCliente: patch.nombreCliente ?? 'Cliente IVA',
    status: patch.status,
    importeBruto: patch.importeBruto ?? 0,
    importePendiente: patch.importePendiente ?? 0,
    fechaFactura: patch.fechaFactura ?? '2026-05-01',
    fechaVence: patch.fechaVence ?? '2026-05-15',
    diasVencida: patch.diasVencida ?? 0,
    moneda: patch.moneda ?? 'MXN',
    reviewStatus: patch.reviewStatus ?? (patch.status === 'cobrada-banco' ? 'auto' : 'unmatched'),
    matchTier: patch.matchTier,
    confidence: patch.confidence,
    matchReason: patch.matchReason,
    bankRef: patch.bankRef,
    bankAmount: patch.bankAmount,
    bankDate: patch.bankDate,
    bankConcept: patch.bankConcept,
    bankAccount: patch.bankAccount,
    bankCia: patch.bankCia,
    subsetGroupId: patch.subsetGroupId,
    subsetSize: patch.subsetSize,
  } as RealReconciliationMatch;
}

function reconciliationResult(matches: RealReconciliationMatch[]): RealReconciliationResult {
  return {
    matches,
    abonoEnrichments: [],
    reviewCandidates: [],
    summary: {
      totalFacturas: matches.length,
      facturasCobradasBanco: matches.filter((m) => m.status === 'cobrada-banco').length,
      facturasCobradasJdeSinBanco: matches.filter((m) => m.status === 'cobrada-jde-sin-banco').length,
      facturasPendientes: matches.filter((m) => m.status === 'pendiente').length,
      totalSaldoBruto: 0,
      totalSaldoPendiente: 0,
      totalCobradoBanco: 0,
      totalAbonos: 0,
      totalAbonoMonto: 0,
      abonosFacturaCobrada: 0,
      abonosSinFactura: 0,
      abonosTraspasoInterno: 0,
      pctAbonosCruzados: 0,
      pctFacturasCruzadas: 0,
      ciaBreakdown: [],
    } as RealReconciliationResult['summary'],
    bankCoverage: { loadedDates: 0, totalMovements: 0, totalAbonos: 0 } as unknown as RealReconciliationResult['bankCoverage'],
    timingsMs: { totalMs: 0, indexMs: 0, matchMs: 0 } as unknown as RealReconciliationResult['timingsMs'],
  };
}
