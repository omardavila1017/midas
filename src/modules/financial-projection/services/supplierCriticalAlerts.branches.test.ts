import { describe, expect, it } from 'vitest';
import type { CXPRecord } from '../../../domain/persistence';
import type { Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { FinancialMovement, ManualPlanningEntry } from '../../shared-finance/types';
import { buildSupplierCriticalAlerts, supplierCriticalStatusLabel } from './supplierCriticalAlerts';

// Unreachable branches left uncovered on purpose:
//  • `record.edoPago || 'JDE'` (supplierCriticalAlerts.ts:170) — the PAID_REAL detail is only
//    rendered when `bankEvidenceCount > 0` (truthy, short-circuits) or `edoPago` contains
//    "PAG" (truthy), so the 'JDE' fallback can never be reached.
//  • `record.importePendientePesos || record.importeBrutoPesos || 0` (line 181) —
//    `buildSupplierCriticalAlerts` filters on `importePendientePesos > 0` before calling
//    `countBankEvidence`, so the two fallbacks are dead through the public entry point.

const TODAY = '2026-05-01';

describe('buildSupplierCriticalAlerts — critical provider selection', () => {
  it('accepts every critical signal, drops non-critical providers and matches by supplier number', () => {
    const alerts = buildSupplierCriticalAlerts({
      providers: [
        provider({ id: 'P-RISK', name: 'POR RIESGO', risk: 'Alto' }),
        provider({ id: 'P-FLEX', name: 'POR INAMOVIBLE', risk: 'Bajo', flexibility: 'inamovible' }),
        provider({ id: 'P-CLASS', name: 'POR CLASIFICACION', risk: 'Bajo', flexibility: 'flexible', clasificacionAlberto: 'CRITICO' }),
        provider({ id: '', name: 'CRITICO SIN ID', risk: 'Alto' }),
        provider({ id: 'P-NO', name: 'NO CRITICO', risk: 'Bajo', flexibility: 'flexible', clasificacionAlberto: 'FLEX_BAJO' }),
      ],
      cxpRecords: [
        cxp({ nombre: 'POR RIESGO', noProveedor: 'X-1', noFactura: 'A' }),
        cxp({ nombre: 'POR INAMOVIBLE', noProveedor: 'X-2', noFactura: 'B' }),
        cxp({ nombre: 'POR CLASIFICACION', noProveedor: 'X-3', noFactura: 'C' }),
        // Name does not match any critical provider, but the supplier number equals a critical provider id.
        cxp({ nombre: 'RAZON SOCIAL DISTINTA', noProveedor: 'P-FLEX', noFactura: 'D' }),
        cxp({ nombre: 'NO CRITICO', noProveedor: 'P-NO', noFactura: 'E' }),
        // Nothing pending → filtered out before the critical check.
        cxp({ nombre: 'POR RIESGO', noProveedor: 'X-9', noFactura: 'F', importePendientePesos: 0 }),
      ],
      movements: [],
      manualEntries: [],
      bankStatements: [],
      scenarioId: 'scenario-a',
      today: TODAY,
    });

    expect(alerts.map((alert) => alert.invoiceNumber).sort()).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('buildSupplierCriticalAlerts — coverage matching', () => {
  it('matches scheduled movements and manual entries through concept and description fallbacks', () => {
    const [alert] = buildSupplierCriticalAlerts({
      providers: [provider({ id: 'P001', name: 'PROVEEDOR CRITICO', risk: 'Alto' })],
      cxpRecords: [cxp({ importePendientePesos: 1000 })],
      movements: [
        // Different counterparty, unrelated sourceObjectId → only the concept carries the invoice.
        movement({ id: 'mov-concept', counterpartyName: 'OTRA RAZON', sourceObjectId: 'OTRO-DOC', concept: 'Pago de la factura F-100', amount: 400 }),
        // No counterparty name at all → the normalizer must tolerate undefined.
        movement({ id: 'mov-sin-nombre', counterpartyName: undefined, sourceObjectId: 'F-100', concept: 'Pago', amount: 100 }),
        // Wrong category / direction → ignored.
        movement({ id: 'mov-opex', counterpartyName: 'PROVEEDOR CRITICO', concept: 'Gasto', amount: 999, category: 'OPEX' }),
        movement({ id: 'mov-inflow', counterpartyName: 'PROVEEDOR CRITICO', concept: 'Cobro', amount: 999, type: 'INFLOW' }),
      ],
      manualEntries: [
        manual({ id: 'me-description', counterpartyName: 'OTRA RAZON', description: 'Cubre F-100', name: 'Pago parcial', amount: 50 }),
        manual({ id: 'me-name', counterpartyName: undefined, description: undefined, name: 'Anticipo F-100', amount: 25 }),
        manual({ id: 'me-otro-escenario', scenarioIds: ['scenario-b'], amount: 999 }),
        manual({ id: 'me-otra-categoria', category: 'OPEX', amount: 999 }),
        manual({ id: 'me-ingreso', type: 'INFLOW', amount: 999 }),
      ],
      bankStatements: [],
      scenarioId: 'scenario-a',
      today: TODAY,
    });

    expect(alert.movementIds).toEqual(['mov-concept', 'mov-sin-nombre']);
    expect(alert.manualEntryIds).toEqual(['me-description', 'me-name']);
    expect(alert.scheduledAmount).toBe(500);
    expect(alert.manualAmount).toBe(75);
    expect(alert.status).toBe('PARTIAL');
    expect(alert.severity).toBe('WARNING');
    expect(alert.detail).toBe('Cubierto parcialmente: escenario 500.00, manual 75.00.');
  });
});

describe('buildSupplierCriticalAlerts — status and date branches', () => {
  it('reports PENDING when nothing covers the invoice and it is not yet due', () => {
    const [alert] = buildSupplierCriticalAlerts({
      providers: [provider({ id: 'P001', name: 'PROVEEDOR CRITICO', risk: 'Alto' })],
      cxpRecords: [cxp({ fechaProgramacionPago: '2026-06-15', fechaVence: '2026-06-15' })],
      movements: [],
      manualEntries: [],
      bankStatements: [],
      scenarioId: 'scenario-a',
      today: TODAY,
    });

    expect(alert.status).toBe('PENDING');
    expect(alert.severity).toBe('CRITICAL');
    expect(alert.detail).toBe('Proveedor crítico sin pago cubierto en el escenario.');
    expect(alert.dueDate).toBe('2026-06-15');
  });

  it('falls back through programming date, due date and invoice date, then to diasVencida', () => {
    const byVence = buildSupplierCriticalAlerts(scoped([cxp({ fechaProgramacionPago: '', fechaVence: '2026-06-10' })]))[0];
    const byFactura = buildSupplierCriticalAlerts(scoped([cxp({ fechaProgramacionPago: '', fechaVence: '', fechaFactura: '2026-06-20' })]))[0];
    const noDates = buildSupplierCriticalAlerts(scoped([
      cxp({ fechaProgramacionPago: '', fechaVence: '', fechaFactura: '', noProveedor: '', noFactura: '', diasVencida: 12 }),
    ]))[0];

    expect(byVence.dueDate).toBe('2026-06-10');
    expect(byFactura.dueDate).toBe('2026-06-20');
    // No usable date at all → overdue decided by diasVencida, and every blank field drops to undefined.
    expect(noDates.status).toBe('OVERDUE');
    expect(noDates.detail).toBe('Factura vencida por 12 días sin pago cubierto.');
    expect(noDates.dueDate).toBeUndefined();
    expect(noDates.supplierNumber).toBeUndefined();
    expect(noDates.invoiceNumber).toBeUndefined();
    expect(noDates.invoiceDate).toBeUndefined();
  });

  it('treats a JDE "pagada" state as real evidence even without bank lines', () => {
    const [alert] = buildSupplierCriticalAlerts(scoped([cxp({ edoPago: 'PAGADA' })]));
    expect(alert.status).toBe('PAID_REAL');
    expect(alert.detail).toBe('Con evidencia real (PAGADA).');
  });

  it('sorts by severity first and by pending amount inside the same severity', () => {
    const alerts = buildSupplierCriticalAlerts({
      providers: [
        provider({ id: 'P001', name: 'PROVEEDOR CRITICO', risk: 'Alto' }),
        provider({ id: 'P002', name: 'OTRO CRITICO', risk: 'Alto' }),
      ],
      cxpRecords: [
        cxp({ noFactura: 'PAGADA', edoPago: 'PAGADA', importePendientePesos: 9000 }),
        cxp({ noFactura: 'PEND-CHICA', fechaProgramacionPago: '2026-06-15', fechaVence: '2026-06-15', importePendientePesos: 100 }),
        cxp({ noFactura: 'PEND-GRANDE', fechaProgramacionPago: '2026-06-15', fechaVence: '2026-06-15', importePendientePesos: 800 }),
        cxp({ nombre: 'OTRO CRITICO', noProveedor: 'P002', noFactura: 'PARCIAL', importePendientePesos: 1000 }),
      ],
      movements: [movement({ id: 'mov-parcial', counterpartyName: 'OTRO CRITICO', concept: 'Abono a cuenta', amount: 300 })],
      manualEntries: [],
      bankStatements: [],
      scenarioId: 'scenario-a',
      today: TODAY,
    });

    expect(alerts.map((alert) => `${alert.invoiceNumber}:${alert.severity}`)).toEqual([
      'PEND-GRANDE:CRITICAL',
      'PEND-CHICA:CRITICAL',
      'PARCIAL:WARNING',
      'PAGADA:INFO',
    ]);
  });
});

describe('countBankEvidence branches', () => {
  it('ignores statements without lines, non-CARGO lines and lines whose amount does not match', () => {
    const [alert] = buildSupplierCriticalAlerts({
      providers: [provider({ id: 'P001', name: 'PROVEEDOR CRITICO', risk: 'Alto' })],
      cxpRecords: [cxp({ importePendientePesos: 1000 })],
      movements: [],
      manualEntries: [],
      bankStatements: [
        statement(undefined),
        statement([
          { tipoMovimiento: 'ABONO', concepto: 'PAGO F-100', referencia: 'F-100', importe: 1000 },
          // No text at all → neither provider nor invoice matches, and no importe.
          { tipoMovimiento: 'CARGO', concepto: undefined, referencia: undefined, importe: undefined },
          // Invoice matches through the reference even though the provider name does not appear.
          { tipoMovimiento: 'CARGO', concepto: 'TRANSFERENCIA SPEI', referencia: 'F-100', importe: 1000 },
          // Invoice matches but the amount is far off → not evidence.
          { tipoMovimiento: 'CARGO', concepto: 'F-100 parcialidad', referencia: undefined, importe: 5 },
        ]),
      ],
      scenarioId: 'scenario-a',
      today: TODAY,
    });

    expect(alert.bankEvidenceCount).toBe(1);
    expect(alert.status).toBe('PAID_REAL');
    expect(alert.detail).toBe('Con evidencia real (1).');
  });
});

describe('supplierCriticalStatusLabel', () => {
  it('has a Spanish label for every status', () => {
    expect([
      'PAID_REAL',
      'SCHEDULED',
      'MANUAL_COMMITTED',
      'PARTIAL',
      'PENDING',
      'OVERDUE',
    ].map((status) => supplierCriticalStatusLabel(status as never))).toEqual([
      'Pagado real',
      'Programado',
      'Comprometido manual',
      'Parcial',
      'Pendiente',
      'Vencido',
    ]);
  });
});

function scoped(cxpRecords: CXPRecord[]) {
  return {
    providers: [provider({ id: 'P001', name: 'PROVEEDOR CRITICO', risk: 'Alto' as const })],
    cxpRecords,
    movements: [],
    manualEntries: [],
    bankStatements: [],
    scenarioId: 'scenario-a',
    today: TODAY,
  };
}

function provider(patch: Partial<Provider> & Pick<Provider, 'id' | 'name'>): Provider {
  return {
    type: 'Operación',
    risk: 'Bajo',
    paymentPeriod: '30 días',
    ...patch,
  };
}

function cxp(overrides: Partial<CXPRecord> = {}): CXPRecord {
  return {
    cia: '00001',
    noProveedor: 'P001',
    nombre: 'PROVEEDOR CRITICO',
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

function movement(patch: {
  id: string;
  counterpartyName?: string;
  sourceObjectId?: string;
  concept: string;
  amount: number;
  category?: FinancialMovement['category'];
  type?: FinancialMovement['type'];
}): FinancialMovement {
  return {
    id: patch.id,
    sourceSystem: 'JDE',
    sourceObjectId: patch.sourceObjectId,
    type: patch.type ?? 'OUTFLOW',
    category: patch.category ?? 'AP_PAYMENT',
    counterpartyName: patch.counterpartyName,
    concept: patch.concept,
    currency: 'MXN',
    originalAmount: patch.amount,
    baseAmount: patch.amount,
    projectedAmount: patch.amount,
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

function manual(patch: {
  id: string;
  amount: number;
  scenarioIds?: string[];
  counterpartyName?: string;
  description?: string;
  name?: string;
  category?: ManualPlanningEntry['category'];
  type?: ManualPlanningEntry['type'];
}): ManualPlanningEntry {
  return {
    id: patch.id,
    scenarioIds: patch.scenarioIds ?? ['scenario-a'],
    type: patch.type ?? 'OUTFLOW',
    category: patch.category ?? 'SUPPLIER_PAYMENT',
    name: patch.name ?? 'Pago manual',
    amount: patch.amount,
    startDate: '2026-05-15',
    recurrence: 'ONE_TIME',
    counterpartyName: 'counterpartyName' in patch ? patch.counterpartyName : 'PROVEEDOR CRITICO',
    description: patch.description,
    taxTreatment: 'IVA_CREDITABLE',
    status: 'APPROVED',
    createdBy: 'test',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
  };
}

/**
 * `concepto` / `referencia` / `importe` are declared non-optional on `BankStatementLine`, but
 * `countBankEvidence` defends against them being absent at runtime (the JDE payload is not
 * guaranteed). The cast is what lets those defensive branches be exercised.
 */
type PartialBankLine = {
  tipoMovimiento: 'CARGO' | 'ABONO';
  concepto?: string;
  referencia?: string;
  importe?: number;
};

function statement(movimientos: PartialBankLine[] | undefined): BankAccountStatement {
  return {
    cia: '00001',
    banco: 'BANCO',
    cuenta: '123',
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-05-15',
    saldoInicial: 2000,
    saldoFinal: 1000,
    movimientos: movimientos?.map((line) => ({
      cia: '00001',
      banco: 'BANCO',
      cuenta: '123',
      fechaOperacion: '2026-05-15',
      moneda: 'MXN',
      ...line,
    })) as unknown as BankAccountStatement['movimientos'],
  };
}
