/**
 * Cash-flow truth suite for Planeación Financiera.
 *
 * Goal: prove the Base scenario of Planning shows the truth — every movement
 * traces to a real upstream source (JDE cobranza / CXP / compras, TRESS
 * payroll, banco), nothing is invented, no double counting, no future
 * contracts leak in, and the cross-validation invariants documented in
 * CLAUDE.md hold.
 *
 * The suite uses the public pipeline (buildScenarioForecastRun + the
 * canonical projection used by the Planning page) so a regression in
 * canonical → planning is caught here even if individual unit tests pass.
 */
import { describe, expect, it } from 'vitest';

import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { CobranzaRecord, RolRecord } from '../../../services/jdeTypes';
import { buildCanonicalProjection } from '../../shared-finance/calculation-engine/canonicalProjection';
import {
  buildPayrollCostMovements,
  buildPurchaseReceiptMovements,
} from '../../shared-finance/sourceRecords';
import { adaptAuxiliarForProjection } from '../../../domain/auxiliarProjectionAdapter';
import {
  emptyAuxiliarReconResult,
  type AuxiliarReconResult,
  type AuxiliarSourceConfirmation,
} from '../../../domain/auxiliarReconciliationEngine';
import {
  buildScenarioForecastRun,
  buildScenarioPipeline,
  isRealShortTermApiMovement,
} from './scenarioForecastRun';
import { defaultTaxStore } from '../../taxes/services/taxModuleService';
import type {
  CellOverride,
  FinancialAdjustment,
  FinancialMovement,
  ManualPlanningEntry,
  PayrollCostRecord,
  PurchaseReceiptRecord,
} from '../../shared-finance/types';

const ASSUMPTIONS: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

const TODAY = '2026-05-15';
const WINDOW_START = '2026-01-01';
const WINDOW_END = '2026-12-31';

// ────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Base invariant: only real short-term API records make it in.
// ────────────────────────────────────────────────────────────────────────────

describe('Planning cash-flow truth · Base allowlist filter', () => {
  it('accepts every id prefix that traces to a real JDE/TRESS source', () => {
    const accepted: FinancialMovement[] = [
      movement('cxc:00001:1:F-1', 'INFLOW', 'AR_COLLECTION', 1000, { sourceSystem: 'JDE' }),
      movement('cxc:especial:00001:1:F-2', 'INFLOW', 'AR_COLLECTION', 500, { sourceSystem: 'JDE' }),
      movement('purchase:00001:P-1:OC-1', 'OUTFLOW', 'AP_PAYMENT', 600, { sourceSystem: 'JDE' }),
      movement('po:00001:P-1:OC-2', 'OUTFLOW', 'AP_PAYMENT', 300, { sourceSystem: 'JDE' }),
      movement('payroll:00001:Semanal:1:1:0', 'OUTFLOW', 'PAYROLL', 800, { sourceSystem: 'PAYROLL' }),
      movement('bank:00001:CTA-1:ref:2026-05-01:0', 'INFLOW', 'TRANSFER', 1200, {
        sourceSystem: 'BANK',
        status: 'REAL',
      }),
    ];
    for (const m of accepted) {
      expect(isRealShortTermApiMovement(m), `expected ${m.id} to be accepted`).toBe(true);
    }
  });

  it('rejects every projected id prefix eliminated by the no-long-term-projection branch', () => {
    // These prefixes correspond to projections that lack an upstream API
    // record (rule-based, recurring patterns, budget reserve, synthetic
    // balancer, payroll replication, ROL predicted, tax reserve, convenio).
    // Note: `cxc:especial:viaje:` IS accepted because viajes especiales come
    // from a real API with K_Cliente + dias_credito — per CLAUDE.md it is
    // intentionally short-term real.
    const projectedPrefixes = [
      'client:cliente-a:2026-06',
      'recurring-provider:p:2026-06',
      'recurring-operating:r:2026-06',
      'budget-opex-gap:2026-06',
      'federal-forecast:2026-06',
      'canonical-outflow:2026-06',
      'canonical-inflow:2026-06',
      'payroll:00001:Semanal:1:1:forecast:0',
      'rol:cliente-a:2026-06-15',
      'tax:iva:2026-06',
      'convenio-payment:approved:2026Q3',
    ];
    for (const id of projectedPrefixes) {
      const m = movement(id, 'INFLOW', 'AR_COLLECTION', 1, { sourceSystem: 'FORECAST' });
      expect(isRealShortTermApiMovement(m), `expected ${id} to be rejected`).toBe(false);
    }
  });

  it('accepts cxc:especial:viaje: (viajes especiales no facturados) — short-term API with K_Cliente', () => {
    const m = movement('cxc:especial:viaje:00001:K-1', 'INFLOW', 'AR_COLLECTION', 1000, {
      sourceSystem: 'JDE',
    });
    expect(isRealShortTermApiMovement(m)).toBe(true);
  });

  it('accepts a movement marked status=REAL regardless of its id prefix', () => {
    const synthetic = movement('auxiliar-historic:abc', 'OUTFLOW', 'AP_PAYMENT', 100, {
      sourceSystem: 'JDE',
      status: 'REAL',
    });
    expect(isRealShortTermApiMovement(synthetic)).toBe(true);
  });

  it('rejects payroll forecast replication even though it shares the payroll: prefix', () => {
    const replicated = movement(
      'payroll:00001:Semanal:6:1:forecast:0',
      'OUTFLOW',
      'PAYROLL',
      1000,
      { sourceSystem: 'FORECAST' },
    );
    expect(isRealShortTermApiMovement(replicated)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Base pipeline: contractual obligations and projections never
// leak into Base, even when fully wired upstream.
// ────────────────────────────────────────────────────────────────────────────

describe('Planning cash-flow truth · Base pipeline isolation', () => {
  it('ignores adjustments / manual entries / overrides / convenio / tax / fideicomiso for Base', () => {
    const sourceMovements: FinancialMovement[] = [
      movement('cxc:00001:1:F-OPEN', 'INFLOW', 'AR_COLLECTION', 700, {
        sourceSystem: 'JDE',
        projectedDate: '2026-05-10',
      }),
      // Future-dated real cobranza — must be cut by the today filter in Base.
      movement('cxc:00001:1:F-FUTURE', 'INFLOW', 'AR_COLLECTION', 5000, {
        sourceSystem: 'JDE',
        projectedDate: '2026-08-30',
      }),
      // Projected synthetic that should never enter Base.
      movement('client:cliente-a:2026-08', 'INFLOW', 'AR_COLLECTION', 9999, {
        sourceSystem: 'FORECAST',
        projectedDate: '2026-08-15',
      }),
    ];

    const adjustments: FinancialAdjustment[] = [
      {
        id: 'adj-1',
        name: 'No debe tocar Base',
        scenarioIds: ['base'],
        type: 'ADD_MOVEMENT',
        targetType: 'DATE_RANGE',
        targetExpression: '2026-05-01..2026-05-31',
        adjustedValue: {
          id: 'manual-inflow',
          type: 'INFLOW',
          category: 'MANUAL',
          projectedAmount: 10_000,
          projectedDate: '2026-05-20',
        },
        reasonCode: 'LIQUIDITY',
        justification: 'test',
        status: 'APPROVED',
        createdBy: 'x',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];

    const manualEntries: ManualPlanningEntry[] = [
      {
        id: 'me-1',
        scenarioIds: ['base'],
        type: 'INFLOW',
        category: 'MANUAL_INFLOW',
        name: 'Manual fake',
        amount: 50_000,
        startDate: '2026-05-12',
        recurrence: 'ONE_TIME',
        taxTreatment: 'UNCLASSIFIED',
        status: 'APPROVED',
        createdBy: 'x',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];

    const overrides: CellOverride[] = [
      {
        id: 'ov-1',
        scenarioId: 'base',
        conceptKey: 'INFLOW:AR_COLLECTION:cliente-a',
        granularity: 'monthly',
        bucketKey: '2026-05-01',
        type: 'INFLOW',
        mode: 'REPLACE',
        value: 99_999,
        createdBy: 'x',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];

    const pipeline = buildScenarioPipeline({
      scenarioId: 'base',
      scenarioName: 'Base',
      scenarioKind: 'BASE',
      sourceMovements,
      adjustments,
      manualEntries,
      customRows: [],
      overrides,
      clients: [],
      providers: [],
      assumptions: ASSUMPTIONS,
      cxpRecords: [],
      budget: null,
      companyCode: 'all',
      taxStore: defaultTaxStore(),
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      today: TODAY,
      initialCash: 100,
      supplierInitialCash: 100,
      minimumCash: 0,
      granularity: 'monthly',
    });

    const ids = pipeline.movements.map((m) => m.id).sort();
    expect(ids).toEqual(['cxc:00001:1:F-OPEN']);
    expect(pipeline.isBase).toBe(true);
    // Base bucket window collapses to today.
    expect(pipeline.projectionEndDate).toBe(TODAY);
  });

  it('Base run sum equals only the past/today real source amounts (no synthetic add)', () => {
    const sourceMovements: FinancialMovement[] = [
      movement('cxc:00001:1:F-A', 'INFLOW', 'AR_COLLECTION', 1000, {
        sourceSystem: 'JDE',
        projectedDate: '2026-05-01',
      }),
      movement('cxp:00001:P-1:F-B:0', 'OUTFLOW', 'AP_PAYMENT', 400, {
        sourceSystem: 'JDE',
        projectedDate: '2026-05-05',
      }),
      // Future — must be cut.
      movement('cxc:00001:1:F-FUTURE', 'INFLOW', 'AR_COLLECTION', 7777, {
        sourceSystem: 'JDE',
        projectedDate: '2026-06-30',
      }),
      // Projected synthetic — must be cut.
      movement('canonical-inflow:2026-05', 'INFLOW', 'AR_COLLECTION', 8888, {
        sourceSystem: 'FORECAST',
        projectedDate: '2026-05-10',
      }),
    ];

    const run = buildScenarioForecastRun({
      scenarioId: 'base',
      scenarioName: 'Base',
      scenarioKind: 'BASE',
      sourceMovements,
      adjustments: [],
      manualEntries: [],
      customRows: [],
      overrides: [],
      clients: [],
      providers: [],
      assumptions: ASSUMPTIONS,
      cxpRecords: [],
      budget: null,
      companyCode: 'all',
      taxStore: defaultTaxStore(),
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      today: TODAY,
      initialCash: 100,
      supplierInitialCash: 100,
      minimumCash: 0,
      granularity: 'monthly',
    });

    // Note: cxp: is NOT in the Base allowlist — only cxc, purchase, po,
    // payroll (non-forecast) and status=REAL. So the cxp: entry above is
    // dropped too. This documents the spec.
    const ids = run.movements.map((m) => m.id).sort();
    expect(ids).toEqual(['cxc:00001:1:F-A']);
    const totalInflow = run.movements
      .filter((m) => m.type === 'INFLOW')
      .reduce((acc, m) => acc + m.projectedAmount, 0);
    expect(totalInflow).toBe(1000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Cross-source fidelity: every movement the canonical engine
// emits for Base maps back to a real upstream record.
// ────────────────────────────────────────────────────────────────────────────

describe('Planning cash-flow truth · cross-source fidelity', () => {
  it('every cxc: movement in Base traces back to a cobranza record (no synthetic invoices)', () => {
    const cobranzaRecords: CobranzaRecord[] = [
      cobranza({ noCliente: '1', noFactura: 'F-1', importePendientePesos: 1000, fechaFactura: '2026-05-01' }),
      cobranza({ noCliente: '2', noFactura: 'F-2', importePendientePesos: 500, fechaFactura: '2026-05-02' }),
    ];

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [clientFixture({ id: '1', name: 'Cliente Uno' }), clientFixture({ id: '2', name: 'Cliente Dos' })],
      providers: [],
      cxpRecords: [],
      cobranzaRecords,
      assumptions: ASSUMPTIONS,
      budget: null,
      startingBalance: 0,
      asOfDate: TODAY,
      enablePredictive: false,
    });

    const cxcMovements = canonical.movements.filter((m) => m.id.startsWith('cxc:') && !m.id.startsWith('cxc:especial:'));
    expect(cxcMovements.length).toBeGreaterThan(0);

    // Build a lookup of valid invoices.
    const invoiceIndex = new Set(
      cobranzaRecords.map((r) => `${r.cia}|${r.noCliente}|${r.noFactura}`),
    );

    for (const m of cxcMovements) {
      const parts = m.id.split(':');
      // shape: cxc:${cia}:${noCliente}:${noFactura}
      expect(parts.length).toBeGreaterThanOrEqual(4);
      const cia = parts[1];
      const noCliente = parts[2];
      const noFactura = parts.slice(3).join(':');
      const key = `${cia}|${noCliente}|${noFactura}`;
      expect(invoiceIndex.has(key), `orphan cxc id ${m.id} has no source cobranza`).toBe(true);
      expect(m.sourceSystem).toBe('JDE');
      expect(m.projectedAmount).toBeGreaterThan(0);
    }
  });

  it('every purchase:/po: movement traces back to a compras / receipt record', () => {
    const purchaseReceipts: PurchaseReceiptRecord[] = [
      // Confirmed receipt → `purchase:` prefix.
      receipt({
        noProveedor: 'P-1',
        invoiceNo: 'R-100',
        orderDate: '2026-05-01',
        receiptDate: '2026-05-01',
        estimatedDueDate: '2026-06-15',
        confidence: 'CONFIRMED',
      }),
      // Pure OC without receipt → `po:` prefix.
      receipt({
        noProveedor: 'P-2',
        invoiceNo: '',
        purchaseOrderNo: 'OC-99',
        receiptNo: '',
        receiptDate: '',
        orderDate: '2026-06-01',
        estimatedDueDate: '2026-07-15',
        confidence: 'PROJECTED',
      }),
    ];

    const movements = buildPurchaseReceiptMovements({
      purchaseReceipts,
      cxpRecords: [],
      companyCode: 'all',
      asOfDate: TODAY,
    });

    expect(movements.length).toBe(2);
    expect(movements.some((m) => m.id.startsWith('purchase:'))).toBe(true);
    expect(movements.some((m) => m.id.startsWith('po:'))).toBe(true);

    for (const m of movements) {
      expect(m.sourceSystem).toBe('JDE');
      expect(m.type).toBe('OUTFLOW');
      // shape: ${tag}:${cia}:${noProveedor}:${invoice|po|receipt|index}
      const parts = m.id.split(':');
      expect(['purchase', 'po']).toContain(parts[0]);
      expect(parts[1]).toBe('00001');
      const supplier = parts[2];
      expect(
        purchaseReceipts.some((r) => r.noProveedor === supplier),
        `purchase ${m.id} not in receipts`,
      ).toBe(true);
      // Pass the Base allowlist.
      expect(isRealShortTermApiMovement(m)).toBe(true);
    }
  });

  it('every payroll: (non-forecast) movement traces back to a TRESS payroll record', () => {
    const payrollCosts: PayrollCostRecord[] = [
      payroll({ conceptId: 1, conceptName: 'SUELDO', amount: 1000, cashTreatment: 'CASH_OUT', paymentDate: '2026-05-20' }),
      payroll({ conceptId: 97, conceptName: 'IMSS PATRONAL', amount: 200, cashTreatment: 'EMPLOYER_TAX', paymentDate: '2026-05-25' }),
      // ISR puramente deducción — debe ser omitido (no afecta caja).
      payroll({ conceptId: 51, conceptName: 'ISR', amount: 300, cashTreatment: 'DEDUCTION', conceptType: 'Deducción', paymentDate: '2026-05-20' }),
    ];

    const movements = buildPayrollCostMovements({
      payrollCosts,
      companyCode: 'all',
      asOfDate: TODAY,
    });

    // 2 cash-affecting concepts (SUELDO + IMSS); ISR pure deduction dropped.
    expect(movements.length).toBe(2);
    expect(movements.some((m) => m.concept.includes('ISR'))).toBe(false);

    const conceptIds = new Set(payrollCosts.map((p) => String(p.conceptId)));
    for (const m of movements) {
      // shape: payroll:${cia}:${type}:${period}:${conceptId}:${index}
      const parts = m.id.split(':');
      expect(parts[0]).toBe('payroll');
      const conceptId = parts[4];
      expect(conceptIds.has(conceptId), `payroll ${m.id} concept ${conceptId} not in TRESS data`).toBe(true);
      expect(m.sourceSystem).toBe('PAYROLL');
      expect(m.type).toBe('OUTFLOW');
      // Non-forecast → must pass the Base allowlist.
      expect(isRealShortTermApiMovement(m)).toBe(true);
    }
  });

  it('drops payroll already paid (paymentDate < asOfDate) — bank movement already realised', () => {
    const movements = buildPayrollCostMovements({
      payrollCosts: [
        payroll({ paymentDate: '2026-04-30', amount: 1000 }),  // antes de asOf
        payroll({ paymentDate: TODAY, amount: 1000 }),         // hoy
        payroll({ paymentDate: '2026-05-20', amount: 1000 }),  // futuro corto
      ],
      companyCode: 'all',
      asOfDate: TODAY,
    });
    // Solo los dos con paymentDate >= asOf.
    expect(movements.length).toBe(2);
    expect(movements.every((m) => m.projectedDate >= TODAY)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 4 — No double counting: a single business fact appears once.
// ────────────────────────────────────────────────────────────────────────────

describe('Planning cash-flow truth · no double counting', () => {
  it('a factura cruzada NO se proyecta también como rol: (predicted ⊥ invoiced)', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [clientFixture({ id: 'cli-1', creditDays: 30 })],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [
        cobranza({ noCliente: '1', noFactura: 'RI-INVOICED', importePendientePesos: 1000, fechaFactura: '2026-05-01' }),
      ],
      rolRecords: [
        rol({ claveJDE: '1', factura: 'RI-INVOICED', fechaViaje: '2026-05-04', subTotal: 1000, efectuado: true }),
      ],
      assumptions: ASSUMPTIONS,
      budget: null,
      startingBalance: 0,
      asOfDate: TODAY,
      enablePredictive: false,
    });

    const rolMovements = canonical.movements.filter((m) => m.id.startsWith('rol:'));
    expect(rolMovements).toEqual([]);
    expect(canonical.movements.some((m) => m.id.includes('RI-INVOICED'))).toBe(true);
  });

  it('una OC ya cruzada a banco (paidPurchaseOrderKeys) no se proyecta como egreso futuro', () => {
    const purchaseReceipts: PurchaseReceiptRecord[] = [
      receipt({
        noProveedor: 'P-1',
        invoiceNo: '',
        purchaseOrderNo: 'OC-PAID',
        receiptNo: '',
        receiptDate: '',
        orderDate: '2026-06-01',
        estimatedDueDate: '2026-07-15',
        confidence: 'PROJECTED',
      }),
      receipt({
        noProveedor: 'P-2',
        invoiceNo: '',
        purchaseOrderNo: 'OC-OPEN',
        receiptNo: '',
        receiptDate: '',
        orderDate: '2026-06-01',
        estimatedDueDate: '2026-07-15',
        confidence: 'PROJECTED',
      }),
    ];

    const movements = buildPurchaseReceiptMovements({
      purchaseReceipts,
      cxpRecords: [],
      companyCode: 'all',
      asOfDate: TODAY,
      paidPurchaseOrderKeys: new Set(['00001::OC-PAID']),
    });

    const oc1 = movements.find((m) => m.id.includes('OC-PAID'));
    const oc2 = movements.find((m) => m.id.includes('OC-OPEN'));
    expect(oc1, 'paid OC must be suppressed from future projection').toBeUndefined();
    expect(oc2, 'open OC must remain projected').toBeDefined();
  });

  it('movement ids are unique within a single canonical run (no duplicate emission)', () => {
    const cobranzaRecords: CobranzaRecord[] = Array.from({ length: 30 }, (_, i) =>
      cobranza({
        noCliente: String((i % 5) + 1),
        noFactura: `F-${i}`,
        importePendientePesos: 100 + i,
        fechaFactura: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`,
      }),
    );
    const cxpRecords: CXPRecord[] = Array.from({ length: 30 }, (_, i) =>
      cxp({
        noProveedor: `P-${(i % 4) + 1}`,
        noFactura: `CXP-${i}`,
        importePendientePesos: 100 + i,
        fechaVence: `2026-05-${String((i % 28) + 1).padStart(2, '0')}`,
      }),
    );

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [clientFixture({ id: '1' }), clientFixture({ id: '2' })],
      providers: [],
      cxpRecords,
      cobranzaRecords,
      assumptions: ASSUMPTIONS,
      budget: null,
      startingBalance: 0,
      asOfDate: TODAY,
      enablePredictive: false,
    });

    const ids = canonical.movements.map((m) => m.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Cruce con banco: AuxiliarContable → adapter → canonical.
// Cobranza/CXP/OC confirmadas en el libro mayor (GL) ya cruzado a banco no
// se re-proyectan como ingreso/egreso pendiente — el dinero ya está en los
// movimientos bancarios históricos.
// ────────────────────────────────────────────────────────────────────────────

describe('Planning cash-flow truth · bank cross-validation', () => {
  it('cobranza confirmada en banco (cobradaBancoKeys) NO se re-proyecta como CXC pendiente', () => {
    const cobranzaRecords: CobranzaRecord[] = [
      cobranza({ noCliente: '1', noFactura: 'F-BANK-OK', importePendientePesos: 1000 }),
      cobranza({ noCliente: '1', noFactura: 'F-OPEN', importePendientePesos: 1500 }),
    ];

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [clientFixture({ id: '1' })],
      providers: [],
      cxpRecords: [],
      cobranzaRecords,
      cobradaBancoKeys: new Set(['00001::F-BANK-OK']),
      assumptions: ASSUMPTIONS,
      budget: null,
      startingBalance: 0,
      asOfDate: TODAY,
      enablePredictive: false,
    });

    const cxc = canonical.movements.filter((m) => m.id.startsWith('cxc:'));
    expect(cxc.some((m) => m.id.endsWith(':F-BANK-OK')), 'paid cobranza must be suppressed').toBe(false);
    expect(cxc.some((m) => m.id.endsWith(':F-OPEN')), 'open cobranza must remain projected').toBe(true);
  });

  it('CXP pagada en banco (paidCxpKeys) NO se re-proyecta como egreso pendiente', () => {
    const cxpRecords: CXPRecord[] = [
      cxp({ noProveedor: 'P-1', noFactura: 'CXP-PAID', importePendientePesos: 800, fechaVence: '2026-06-15', fechaProgramacionPago: '2026-06-15' }),
      cxp({ noProveedor: 'P-1', noFactura: 'CXP-OPEN', importePendientePesos: 1200, fechaVence: '2026-06-20', fechaProgramacionPago: '2026-06-20' }),
    ];

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords,
      paidCxpKeys: new Set(['00001::CXP-PAID::P-1']),
      assumptions: ASSUMPTIONS,
      budget: null,
      startingBalance: 0,
      asOfDate: TODAY,
      enablePredictive: false,
    });

    const cxpMovements = canonical.movements.filter((m) => m.id.startsWith('cxp:'));
    expect(cxpMovements.some((m) => m.id.includes('CXP-PAID')), 'paid CXP must be suppressed').toBe(false);
    expect(cxpMovements.some((m) => m.id.includes('CXP-OPEN')), 'open CXP must remain projected').toBe(true);
  });

  it('adapter translates AuxiliarReconResult to the three paid-key Sets that canonical respects', () => {
    const cobranzaRecords: CobranzaRecord[] = [
      cobranza({ noCliente: '1', noFactura: 'F-100', importePendientePesos: 1000 }),
    ];
    const cxpRecords: CXPRecord[] = [
      cxp({ noProveedor: 'P-1', noFactura: 'CXP-PAID-1', importePendientePesos: 500, fechaVence: '2026-06-15', fechaProgramacionPago: '2026-06-15' }),
      cxp({ noProveedor: 'P-1', noFactura: 'CXP-NOT-IN-GL', importePendientePesos: 700, fechaVence: '2026-06-22', fechaProgramacionPago: '2026-06-22' }),
    ];

    // Synthetic AuxiliarReconResult: 1 ABONO factura confirmed, 1 CARGO
    // factura confirmed, 1 OC egreso confirmed. The adapter must produce
    // exactly the three Sets that canonical consumes.
    const auxResult = auxiliarReconResult([
      ['factura:00001::F-100', confirmation({ flujo: 'ingreso', importe: 1000 })],
      ['factura:00001::CXP-PAID-1', confirmation({ flujo: 'egreso', importe: 500 })],
      ['oc:00001::OC-CLEARED', confirmation({ flujo: 'egreso', importe: 700 })],
      // Unconfirmed entry → does NOT leak into any Set.
      ['factura:00001::CXP-NOT-IN-GL', confirmation({ flujo: 'egreso', importe: 700, confirmed: false })],
    ]);

    const bridge = adaptAuxiliarForProjection(auxResult, cxpRecords, cobranzaRecords);

    expect([...bridge.cobradaBancoKeys].sort()).toEqual(['00001::F-100']);
    expect([...bridge.paidCxpKeys].sort()).toEqual(['00001::CXP-PAID-1::P-1']);
    expect([...bridge.paidPurchaseOrderKeys].sort()).toEqual(['00001::OC-CLEARED']);

    // Now feed the bridge straight into canonical and verify the open CXP
    // remains projected while the paid one is gone — end-to-end bank cross.
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [clientFixture({ id: '1' })],
      providers: [],
      cxpRecords,
      cobranzaRecords,
      cobradaBancoKeys: bridge.cobradaBancoKeys,
      paidCxpKeys: bridge.paidCxpKeys,
      paidPurchaseOrderKeys: bridge.paidPurchaseOrderKeys,
      assumptions: ASSUMPTIONS,
      budget: null,
      startingBalance: 0,
      asOfDate: TODAY,
      enablePredictive: false,
    });

    expect(canonical.movements.some((m) => m.id.includes('F-100'))).toBe(false);
    expect(canonical.movements.some((m) => m.id.includes('CXP-PAID-1'))).toBe(false);
    expect(canonical.movements.some((m) => m.id.includes('CXP-NOT-IN-GL'))).toBe(true);
  });

  it('an unconfirmed GL entry (confirmed=false) is NOT added to any paid-key Set', () => {
    const auxResult = auxiliarReconResult([
      ['factura:00001::F-PENDING', confirmation({ flujo: 'ingreso', confirmed: false, importe: 999 })],
      ['oc:00001::OC-PENDING', confirmation({ flujo: 'egreso', confirmed: false, importe: 999 })],
    ]);

    const bridge = adaptAuxiliarForProjection(auxResult, [], []);

    expect(bridge.cobradaBancoKeys.size).toBe(0);
    expect(bridge.paidCxpKeys.size).toBe(0);
    expect(bridge.paidPurchaseOrderKeys.size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Approved scenario sanity: contractual obligations flow only
// here, never in Base.
// ────────────────────────────────────────────────────────────────────────────

describe('Planning cash-flow truth · Approved-only contracts', () => {
  it('convenio-payment (DEBT) movements appear in Approved and never in Base', () => {
    const baseRun = buildScenarioForecastRun({
      ...baseRunArgs(),
      scenarioId: 'base',
      scenarioKind: 'BASE',
    });
    const approvedRun = buildScenarioForecastRun({
      ...baseRunArgs(),
      scenarioId: 'approved',
      scenarioKind: 'APPROVED',
    });

    expect(baseRun.movements.some((m) => m.id.startsWith('convenio-payment:'))).toBe(false);
    expect(approvedRun.movements.some((m) => m.id.startsWith('convenio-payment:'))).toBe(true);
    // Convenio movements must be LOCKED (legal obligation) and DEBT category.
    const convenio = approvedRun.movements.filter((m) => m.id.startsWith('convenio-payment:'));
    expect(convenio.every((m) => m.lockState === 'LOCKED')).toBe(true);
    expect(convenio.every((m) => m.category === 'DEBT')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function movement(
  id: string,
  type: FinancialMovement['type'],
  category: FinancialMovement['category'],
  amount: number,
  patch: Partial<FinancialMovement> = {},
): FinancialMovement {
  return {
    id,
    sourceSystem: patch.sourceSystem ?? 'JDE',
    sourceObjectId: patch.sourceObjectId ?? id,
    type,
    category,
    counterpartyName: patch.counterpartyName ?? 'Test',
    counterpartyType: type === 'INFLOW' ? 'CUSTOMER' : 'SUPPLIER',
    concept: patch.concept ?? 'Test',
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate: patch.projectedDate ?? '2026-05-10',
    confidenceScore: 80,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: patch.status ?? 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...patch,
  };
}

function baseRunArgs() {
  return {
    scenarioName: 'X',
    sourceMovements: [
      movement('cxc:00001:1:F-1', 'INFLOW', 'AR_COLLECTION', 1000, {
        sourceSystem: 'JDE' as const,
        projectedDate: '2026-05-10',
      }),
    ],
    adjustments: [] as FinancialAdjustment[],
    manualEntries: [] as ManualPlanningEntry[],
    customRows: [],
    overrides: [] as CellOverride[],
    clients: [] as Client[],
    providers: [] as Provider[],
    assumptions: ASSUMPTIONS,
    cxpRecords: [] as CXPRecord[],
    budget: null,
    companyCode: 'all',
    taxStore: defaultTaxStore(),
    startDate: WINDOW_START,
    endDate: WINDOW_END,
    today: TODAY,
    initialCash: 100,
    supplierInitialCash: 100,
    minimumCash: 0,
    granularity: 'monthly' as const,
  };
}

function clientFixture(patch: Partial<Client> = {}): Client {
  const monthlyBilling = Array.from({ length: 12 }, () => 0);
  monthlyBilling[4] = 1000;
  return {
    id: 'client-1',
    name: 'Cliente Test',
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 30,
    monthlyBilling,
    complianceRate: 1,
    ...patch,
  };
}

function cobranza(patch: Partial<CobranzaRecord>): CobranzaRecord {
  return {
    cia: patch.cia ?? '00001',
    noCliente: patch.noCliente ?? '1',
    nombreCliente: patch.nombreCliente ?? 'Cliente',
    noFactura: patch.noFactura ?? 'F-1',
    fechaFactura: patch.fechaFactura ?? '2026-05-01',
    fechaVence: patch.fechaVence ?? '2026-05-15',
    fechaCobro: patch.fechaCobro ?? '',
    diasVencida: patch.diasVencida ?? 0,
    importeBrutoPesos: patch.importeBrutoPesos ?? patch.importePendientePesos ?? 1000,
    importePendientePesos: patch.importePendientePesos ?? 1000,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '',
    estatus: 'PENDIENTE',
    tipoCambio: 1,
  };
}

function cxp(patch: Partial<CXPRecord>): CXPRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? 'P-1',
    nombre: patch.nombre ?? 'Proveedor',
    noFactura: patch.noFactura ?? 'CXP-1',
    fechaFactura: patch.fechaFactura ?? '2026-05-01',
    fechaVence: patch.fechaVence ?? '2026-05-15',
    fechaProgramacionPago: patch.fechaProgramacionPago ?? '2026-05-15',
    diasVencida: patch.diasVencida ?? 0,
    importeBrutoPesos: patch.importeBrutoPesos ?? patch.importePendientePesos ?? 1000,
    importePendientePesos: patch.importePendientePesos ?? 1000,
    importeSubtotalPesos: 0,
    importeImpuestosPesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '',
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

function receipt(patch: Partial<PurchaseReceiptRecord>): PurchaseReceiptRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? 'P-1',
    supplierName: patch.supplierName ?? 'Proveedor',
    invoiceNo: patch.invoiceNo ?? 'INV-1',
    purchaseOrderNo: patch.purchaseOrderNo ?? 'OC-1',
    receiptNo: patch.receiptNo ?? 'REC-1',
    orderDate: patch.orderDate ?? '2026-05-01',
    receiptDate: patch.receiptDate ?? '2026-05-01',
    creditDays: patch.creditDays ?? 30,
    estimatedDueDate: patch.estimatedDueDate ?? '2026-05-31',
    currency: 'MXN',
    exchangeRate: 1,
    totalAmount: patch.totalAmount ?? 1000,
    amountMxn: patch.amountMxn ?? 1000,
    taxTreatment: patch.taxTreatment ?? 'UNCLASSIFIED',
    isCancelled: patch.isCancelled ?? false,
    status: patch.status ?? 'PROJECTED_BASE',
    confidence: patch.confidence,
    projectedLeadTimeDays: patch.projectedLeadTimeDays,
    projectedLeadTimeSource: patch.projectedLeadTimeSource,
    categoryName: 'Test',
    familyName: 'Test',
  };
}

function payroll(patch: Partial<PayrollCostRecord>): PayrollCostRecord {
  return {
    cia: patch.cia ?? '00001',
    empresaNomina: patch.empresaNomina ?? 'SIR',
    year: patch.year ?? 2026,
    month: patch.month ?? 5,
    paymentDate: patch.paymentDate ?? '2026-05-10',
    payrollPeriod: patch.payrollPeriod ?? 1,
    payrollType: patch.payrollType ?? 'Semanal',
    conceptId: patch.conceptId ?? 1,
    conceptName: patch.conceptName ?? 'SUELDO',
    conceptType: patch.conceptType ?? 'Percepción',
    cashTreatment: patch.cashTreatment ?? 'CASH_OUT',
    amount: patch.amount ?? 1000,
  };
}

function auxiliarReconResult(entries: Array<[string, AuxiliarSourceConfirmation]>): AuxiliarReconResult {
  const base = emptyAuxiliarReconResult();
  return {
    ...base,
    sourceConfirmation: new Map(entries),
  };
}

function confirmation(patch: Partial<AuxiliarSourceConfirmation> = {}): AuxiliarSourceConfirmation {
  return {
    confirmed: patch.confirmed ?? true,
    flujo: patch.flujo ?? 'ingreso',
    importe: patch.importe ?? 1000,
    bankDate: patch.bankDate,
    fechaContable: patch.fechaContable ?? TODAY,
  };
}

function rol(patch: Partial<RolRecord> = {}): RolRecord {
  return {
    cia: patch.cia ?? '00001',
    empresa: 'SERVICIO INDUSTRIAL',
    kCliente: patch.kCliente ?? 1,
    cCliente: patch.cCliente ?? 'CLI',
    dCliente: patch.dCliente ?? 'Cliente Test',
    rfc: 'XAXX010101000',
    claveJDE: patch.claveJDE ?? '1',
    facturacionTipo: 'MENSUAL',
    iva: patch.iva ?? 16,
    tipoViaje: 'SENCILL',
    ruta: 'RUTA',
    costoRuta: 200,
    viajes: patch.viajes ?? 5,
    subTotal: patch.subTotal ?? 1000,
    despachado: true,
    efectuado: patch.efectuado ?? true,
    anio: 2026,
    semana: 19,
    fechaViaje: patch.fechaViaje ?? '2026-05-04',
    factura: patch.factura,
    uuidFiscal: patch.uuidFiscal,
  };
}

