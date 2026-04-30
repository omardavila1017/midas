import { describe, expect, it } from 'vitest';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client } from '../../../domain/types';
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
