import { describe, expect, it } from 'vitest';
import type { CXPRecord } from '../../../domain/persistence';
import type { Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { FinancialMovement, ManualPlanningEntry } from '../../shared-finance/types';
import { buildSupplierCriticalAlerts } from './supplierCriticalAlerts';

describe('supplierCriticalAlerts', () => {
  it('marks critical supplier invoices as scheduled when the scenario covers them', () => {
    const [alert] = buildSupplierCriticalAlerts({
      providers: [provider()],
      cxpRecords: [cxp({ importePendientePesos: 1000 })],
      movements: [movement('Proveedor Critico', 1000)],
      manualEntries: [],
      bankStatements: [],
      scenarioId: 'scenario-a',
      today: '2026-05-01',
    });

    expect(alert.status).toBe('SCHEDULED');
    expect(alert.severity).toBe('INFO');
  });

  it('marks manual supplier commitments as committed manually', () => {
    const [alert] = buildSupplierCriticalAlerts({
      providers: [provider()],
      cxpRecords: [cxp({ importePendientePesos: 1000 })],
      movements: [],
      manualEntries: [manualEntry('scenario-a', 1000)],
      bankStatements: [],
      scenarioId: 'scenario-a',
      today: '2026-05-01',
    });

    expect(alert.status).toBe('MANUAL_COMMITTED');
  });

  it('distinguishes partial, overdue and bank-paid states', () => {
    const partial = buildSupplierCriticalAlerts({
      providers: [provider()],
      cxpRecords: [cxp({ importePendientePesos: 1000 })],
      movements: [movement('Proveedor Critico', 300)],
      manualEntries: [],
      bankStatements: [],
      scenarioId: 'scenario-a',
      today: '2026-05-01',
    })[0];
    const overdue = buildSupplierCriticalAlerts({
      providers: [provider()],
      cxpRecords: [cxp({ fechaVence: '2026-04-01', fechaProgramacionPago: '2026-04-01', diasVencida: 30 })],
      movements: [],
      manualEntries: [],
      bankStatements: [],
      scenarioId: 'scenario-a',
      today: '2026-05-01',
    })[0];
    const paid = buildSupplierCriticalAlerts({
      providers: [provider()],
      cxpRecords: [cxp({ importePendientePesos: 1000 })],
      movements: [],
      manualEntries: [],
      bankStatements: [bankEvidence()],
      scenarioId: 'scenario-a',
      today: '2026-05-01',
    })[0];

    expect(partial.status).toBe('PARTIAL');
    expect(overdue.status).toBe('OVERDUE');
    expect(paid.status).toBe('PAID_REAL');
  });
});

function provider(): Provider {
  return {
    id: 'P001',
    name: 'Proveedor Critico',
    type: 'Operación',
    risk: 'Alto',
    paymentPeriod: '30 días',
    flexibility: 'inamovible',
    clasificacionAlberto: 'CRITICO',
  };
}

function cxp(overrides: Partial<CXPRecord> = {}): CXPRecord {
  return {
    cia: '00001',
    noProveedor: 'P001',
    nombre: 'Proveedor Critico',
    noFactura: 'F-100',
    fechaFactura: '2026-04-01',
    fechaVence: '2026-05-15',
    fechaProgramacionPago: '2026-05-15',
    diasVencida: 0,
    importeBrutoPesos: 1000,
    importePendientePesos: 1000,
    importeSubtotalPesos: 862.07,
    importeImpuestosPesos: 137.93,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30',
    clasifica: '',
    clasificacionProveedor: '',
    edoPago: '',
    tipoCambio: 1,
    porVencer: 1000,
    v1_30: 0,
    v31_60: 0,
    v61_90: 0,
    v91_120: 0,
    v121_150: 0,
    v151_180: 0,
    mas180: 0,
    ...overrides,
  };
}

function movement(providerName: string, amount: number): FinancialMovement {
  return {
    id: `mov-${amount}`,
    sourceSystem: 'JDE',
    sourceObjectId: 'F-100',
    type: 'OUTFLOW',
    category: 'AP_PAYMENT',
    counterpartyName: providerName,
    concept: 'Pago factura F-100',
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate: '2026-05-15',
    confidenceScore: 80,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  };
}

function manualEntry(scenarioId: string, amount: number): ManualPlanningEntry {
  return {
    id: 'manual-1',
    scenarioIds: [scenarioId],
    type: 'OUTFLOW',
    category: 'SUPPLIER_PAYMENT',
    name: 'Pago manual F-100',
    amount,
    startDate: '2026-05-15',
    recurrence: 'ONE_TIME',
    counterpartyName: 'Proveedor Critico',
    taxTreatment: 'IVA_CREDITABLE',
    status: 'APPROVED',
    createdBy: 'test',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  };
}

function bankEvidence(): BankAccountStatement {
  return {
    cia: '00001',
    banco: 'BANCO',
    cuenta: '123',
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-05-15',
    saldoInicial: 2000,
    saldoFinal: 1000,
    movimientos: [{
      cia: '00001',
      banco: 'BANCO',
      cuenta: '123',
      fechaOperacion: '2026-05-15',
      tipoMovimiento: 'CARGO',
      importe: 1000,
      concepto: 'PAGO PROVEEDOR CRITICO F-100',
      referencia: 'F-100',
      moneda: 'MXN',
    }],
  };
}
