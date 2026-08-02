import { afterEach, describe, expect, it } from 'vitest';
import { GL_FLOW_RULES, __resetGlFlowWarnings } from '../../../config/glAccountFlowCatalog';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { AuxiliarReconLine } from '../../../domain/auxiliarReconciliationEngine';
import { comprasToPurchaseReceipts } from '../../../domain/comprasToPurchaseReceipts';
import type { BankAccountStatement, BankStatementLine, CobranzaRecord, ComprasRecord, RolRecord } from '../../../services/jdeTypes';
import { isRealShortTermApiMovement } from '../../financial-planning/services/scenarioForecastRun';
import { buildHistoricalMonths } from '../../../domain/cashFlowEngine';
import { bankMovementKey } from '../../../domain/bankMovementKey';
import type { PayrollCostRecord, PurchaseReceiptRecord } from '../types';
import {
  buildCanonicalProjection,
  buildHistoricalReconciledMovements,
  buildShortTermProjectionMovements,
  takeCitiAttributionDiagnostics,
} from './canonicalProjection';

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

describe('canonicalProjection IVA metadata', () => {
  // Branch no-long-term-projection: `client:` rule-based projection removed.
  it.skip('projects client IVA from net invoice base and defaults missing client rate to 16%', () => {
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

  it('classifies CXP supplier payments with provider catalog category using tolerant name and JDE matches', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [
        provider({
          name: 'ACCERTIFY INC',
          type: 'TECNOLOGIA Y SOPORTE',
          numProveedorJDE: '000123',
        }),
      ],
      cxpRecords: [
        cxpRecord({
          noProveedor: '123',
          nombre: 'Accertify, Inc.',
          noFactura: 'F-CAT',
          importePendientePesos: 900,
        }),
      ],
      assumptions,
      budget: budget({ expenseMay: 900, expenseConcept: null }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const movement = canonical.movements.find((item) => item.id.startsWith('cxp:') && item.sourceObjectId === 'F-CAT');

    expect(movement).toBeTruthy();
    expect(movement?.counterpartyName).toBe('Accertify, Inc.');
    expect(movement?.subcategory).toBe('TECNOLOGIA Y SOPORTE');
  });

  it('uses direct JDE CXP classification when the provider catalog has no category', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [
        provider({
          name: 'PROVEEDOR CHASIS',
          type: 'Sin categoría',
          numProveedorJDE: '777',
        }),
      ],
      cxpRecords: [
        cxpRecord({
          noProveedor: '777',
          nombre: 'PROVEEDOR CHASIS',
          noFactura: 'F-CHASIS',
          clasifica: 'CHASIS',
          importePendientePesos: 900,
        }),
      ],
      assumptions,
      budget: budget({ expenseMay: 900, expenseConcept: null }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const movement = canonical.movements.find((item) => item.id.startsWith('cxp:') && item.sourceObjectId === 'F-CHASIS');

    expect(movement).toBeTruthy();
    expect(movement?.subcategory).toBe('CHASIS');
    expect(movement?.providerCategory).toBe('CHASIS');
  });

  it('excludes intercompany CXP (filial classification or group company name)', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [
        // Empresa interna detectada por clasificación JDE "Filiales".
        cxpRecord({
          noProveedor: 'INT-1',
          nombre: 'SERVICIOS DEL GRUPO',
          noFactura: 'F-FILIAL',
          clasificacionProveedor: 'Filiales',
          importePendientePesos: 500_000,
          fechaVence: '2026-05-17',
        }),
        // Empresa interna detectada por nombre (razón social del grupo).
        cxpRecord({
          noProveedor: 'INT-2',
          nombre: 'MULTICARGA SA DE CV',
          noFactura: 'F-MULTI',
          importePendientePesos: 158_300,
          fechaVence: '2026-05-17',
        }),
        // Proveedor externo de control: SÍ se proyecta.
        cxpRecord({
          noProveedor: 'EXT-1',
          nombre: 'PROVEEDOR EXTERNO SA',
          noFactura: 'F-EXT',
          clasificacionProveedor: 'REFACCIONARIO',
          importePendientePesos: 90_000,
          fechaVence: '2026-05-17',
        }),
      ],
      assumptions,
      budget: budget({ expenseMay: 0, expenseConcept: null }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const cxpIds = canonical.movements
      .filter((item) => item.id.startsWith('cxp:'))
      .map((item) => item.sourceObjectId);
    expect(cxpIds).toContain('F-EXT');
    expect(cxpIds).not.toContain('F-FILIAL');
    expect(cxpIds).not.toContain('F-MULTI');
  });

  // Branch no-long-term-projection: recurring-provider:/recurring-operating: removed.
  it.skip('adds future AP_PAYMENT rows from recurring bank/provider patterns when there is no future CXP', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [
        bankStatement({
          cia: '00001',
          cuenta: 'CTA-1',
          movimientos: recurringBankMovements('PAGO NOMINA MX', 50_000),
        }),
      ],
      clients: [],
      providers: [
        provider({
          id: 'provider-nomina',
          name: 'NOMINA MX',
          type: 'NOMINA',
          flexibility: 'inamovible',
          numProveedorJDE: 'NOMINA',
        }),
      ],
      cxpRecords: [],
      assumptions,
      budget: null,
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const may = canonical.movements.find(
      (item) => item.id === 'recurring-provider:2026-05:provider-nomina',
    );
    const nextMarch = canonical.movements.find(
      (item) => item.id === 'recurring-provider:2027-03:provider-nomina',
    );
    expect(may).toBeTruthy();
    expect(nextMarch).toBeTruthy();
    expect(may?.category).toBe('AP_PAYMENT');
    expect(may?.counterpartyName).toBe('NOMINA MX');
    expect(may?.providerCategory).toBe('NOMINA');
    expect(may?.projectedAmount).toBe(50_000);
    expect(may?.projectedDate).toBe('2026-05-05');
    expect(nextMarch?.projectedAmount).toBe(50_000);
    expect(nextMarch?.projectedDate).toBe('2027-03-05');
  });

  // Branch no-long-term-projection: recurring-provider: complement removed.
  it.skip('adds only the recurring complement when CXP is lower than the provider pattern', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [
        bankStatement({
          cia: '00001',
          cuenta: 'CTA-1',
          movimientos: recurringBankMovements('PAGO RENTA MENSUAL', 25_000, '01'),
        }),
      ],
      clients: [],
      providers: [
        provider({
          id: 'provider-renta',
          name: 'RENTA MENSUAL',
          type: 'ARRENDAMIENTO',
          flexibility: 'inamovible',
        }),
      ],
      cxpRecords: [
        cxpRecord({
          noProveedor: 'RENTA',
          nombre: 'RENTA MENSUAL',
          noFactura: 'RENTA-MAY',
          fechaProgramacionPago: '2026-05-01',
          fechaVence: '2026-05-01',
          importePendientePesos: 10_000,
        }),
      ],
      assumptions,
      budget: null,
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const mayAp = canonical.movements.filter(
      (item) => item.category === 'AP_PAYMENT' && item.projectedDate.slice(0, 7) === '2026-05',
    );
    const cxp = mayAp.find((item) => item.sourceSystem === 'JDE' && item.sourceObjectId === 'RENTA-MAY');
    const recurring = mayAp.find((item) => item.id === 'recurring-provider:2026-05:provider-renta');
    expect(cxp?.projectedAmount).toBe(10_000);
    expect(recurring?.projectedAmount).toBe(15_000);
    expect(mayAp.reduce((sum, item) => sum + item.projectedAmount, 0)).toBe(25_000);
  });

  // Branch no-long-term-projection: bank-pattern outflow projection removed.
  it.skip('proyecta egresos futuros desde la historia bancaria aunque no haya proveedor identificado', () => {
    // El motor predictivo (Holt-Winters tiered) aprende de TODO el histórico
    // bancario, incluyendo movimientos tipo TARJ.NO sin proveedor en el
    // catálogo. El user explícitamente pidió esto: "ingreso y egreso
    // proyectado, por cia/cliente/proveedor/concepto" — el modelo toma cada
    // CARGO recurrente como señal y lo proyecta hacia adelante.
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [
        bankStatement({
          cia: '00001',
          cuenta: 'CTA-1',
          movimientos: recurringBankMovements('TARJ.NO.5579 6211 F.TRANS.2', 30_000),
        }),
      ],
      clients: [],
      providers: [],
      cxpRecords: [],
      assumptions,
      budget: null,
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const futureOutflows = canonical.movements.filter(
      (item) => item.type === 'OUTFLOW' && item.status === 'PROJECTED_BASE',
    );
    expect(futureOutflows.length).toBeGreaterThan(0);
    // El total proyectado debe ser cercano al recurrente histórico × meses
    // futuros (30k × 11 meses ≈ 330k). Tolerancia amplia porque Holt-Winters
    // puede ajustar la tendencia.
    const totalProjected = futureOutflows.reduce((s, m) => s + m.projectedAmount, 0);
    expect(totalProjected).toBeGreaterThan(100_000);
  });

  // Branch no-long-term-projection: budget-opex-gap: reserve removed.
  it.skip('emits a synthetic OPEX remainder when the budget exceeds explicit operating expenses', () => {
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

    const movement = canonical.movements.find((item) => item.id === 'budget-opex-gap:2026-05');
    expect(movement).toBeTruthy();
    expect(movement?.category).toBe('OPEX');
    expect(movement?.projectedAmount).toBe(1160);
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

  it('re-emits the net of ASYMMETRIC internal transfers so cash reconciles to the bank', () => {
    // Un traspaso interno cuya contraparte NO está cargada (cuenta destino en
    // otra empresa/Bajío fuera del dataset): se detecta por leyenda y se
    // descarta, pero su pata gemela nunca llega. Sin reconciliación la caja
    // queda 30k por debajo del banco real. El movimiento INTERNAL_RECON
    // devuelve ese neto a la caja sin re-inflar los brutos.
    const bankStatements: BankAccountStatement[] = [
      bankStatement({
        cia: '00001',
        cuenta: 'CTA-A',
        saldoInicial: 0,
        movimientos: [
          // Interno (leyenda) sin contraparte cargada → descartado, residual +30k.
          bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'ABONO', importe: 30_000, fechaOperacion: '2026-04-10', concepto: 'TRASPASO REF 99' }),
          // Cobro real → INFLOW.
          bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'ABONO', importe: 10_000, fechaOperacion: '2026-04-15', concepto: 'Cobro cliente real' }),
          // Pago real → OUTFLOW.
          bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'CARGO', importe: 5_000, fechaOperacion: '2026-04-12', concepto: 'Disposicion folio 7001' }),
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

    const recon = canonical.movements.filter((m) => m.category === 'INTERNAL_RECON');
    expect(recon).toHaveLength(1);
    expect(recon[0]?.type).toBe('INFLOW');
    expect(recon[0]?.projectedAmount).toBe(30_000);
    // El residual sobrevive el filtro de Base (real corto plazo).
    expect(isRealShortTermApiMovement(recon[0]!)).toBe(true);

    // Reconciliación: el neto de TODOS los movimientos REAL (incluido el
    // recon) debe igualar el neto real del banco (30k traspaso + 10k − 5k = 35k).
    const real = canonical.movements.filter(
      (m) => m.status === 'REAL' && m.projectedDate?.startsWith('2026-04'),
    );
    const netCash = real.reduce(
      (s, m) => s + (m.type === 'INFLOW' ? m.projectedAmount : -m.projectedAmount),
      0,
    );
    expect(netCash).toBe(35_000);
  });

  it('labels unidentified bank CARGOs per origin account instead of one collapsed row', () => {
    // Dos CARGOs sin cruce a pago/proveedor ni patrón fiscal, en dos cuentas
    // distintas. Antes ambos caían a un counterpartyName constante
    // ('Sin identificar') → un solo conceptKey → una fila gigante imposible
    // de auditar. Ahora se etiquetan por cuenta de banco origen.
    const bankStatements: BankAccountStatement[] = [
      bankStatement({
        cia: '00001',
        cuenta: 'CTA-A',
        movimientos: [
          bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'CARGO', importe: 90_000, fechaOperacion: '2026-04-10', concepto: 'Disposicion folio 88001' }),
        ],
      }),
      bankStatement({
        cia: '00001',
        cuenta: 'CTA-B',
        movimientos: [
          bankMovement({ cia: '00001', cuenta: 'CTA-B', tipoMovimiento: 'CARGO', importe: 90_000, fechaOperacion: '2026-04-11', concepto: 'Disposicion folio 88001' }),
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

    const unidentified = canonical.movements.filter(
      (m) => m.type === 'OUTFLOW' && m.category === 'TRANSFER' && m.status === 'REAL',
    );
    expect(unidentified).toHaveLength(2);
    for (const m of unidentified) {
      expect(m.counterpartyName).toMatch(/^Sin identificar · /);
    }
    const names = new Set(unidentified.map((m) => m.counterpartyName));
    // Mismo concepto + monto, distinta cuenta → distinto label → no colapsan.
    expect(names.size).toBe(2);
    expect(unidentified.some((m) => m.counterpartyName?.includes('CTA-A'))).toBe(true);
    expect(unidentified.some((m) => m.counterpartyName?.includes('CTA-B'))).toBe(true);
  });

  it('uses direct PagoProveedor JDE classification on matched bank CARGOs', () => {
    const cargo = bankMovement({
      cia: '00001',
      cuenta: 'CTA-PAGO',
      tipoMovimiento: 'CARGO',
      importe: 12_500,
      fechaOperacion: '2026-04-15',
      concepto: 'PAGO PROVEEDOR JDE',
    });
    const cargoEnrichments = new Map([
      [bankMovementKey(cargo), {
        status: 'MATCHED' as const,
        payments: [{
          claveProveedor: '888',
          nombreProveedor: 'PROVEEDOR CLASIFICADO JDE',
          clasificacionProveedor: 'CHASIS',
          clasificacionProveedorFinanciera: '220 - Por Clasificar',
          importe: 12_500,
        }],
      }],
    ]);

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [
        bankStatement({
          cia: '00001',
          cuenta: 'CTA-PAGO',
          movimientos: [cargo],
        }),
      ],
      clients: [],
      providers: [],
      cxpRecords: [],
      assumptions,
      budget: budget({}),
      startingBalance: 0,
      asOfDate: '2026-05-01',
      cargoEnrichments,
    });

    const movement = canonical.movements.find((m) => m.status === 'REAL' && m.category === 'AP_PAYMENT');

    expect(movement).toBeTruthy();
    expect(movement?.counterpartyName).toBe('PROVEEDOR CLASIFICADO JDE');
    expect(movement?.subcategory).toBe('CHASIS');
    expect(movement?.providerCategory).toBe('CHASIS');
  });

  it('classifies historic AuxiliarContable IVA payments as tax movements', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [
        bankStatement({
          cia: '00002',
          cuenta: 'CTA-OTHER',
          movimientos: [
            bankMovement({ cia: '00002', cuenta: 'CTA-OTHER', tipoMovimiento: 'ABONO', importe: 1, fechaOperacion: '2026-04-01' }),
          ],
        }),
      ],
      clients: [],
      providers: [],
      cxpRecords: [],
      assumptions,
      budget: budget({}),
      startingBalance: 0,
      asOfDate: '2026-05-01',
      auxiliarReconLines: [
        auxiliarLine({
          glKey: '00001::aux::IVA',
          fechaContable: '2026-04-17',
          importe: -250,
          sourceRef: 'PAGO IVA MARZO',
          contraparte: 'SAT',
        }),
      ],
    });

    const iva = canonical.movements.find((m) => m.id === 'auxiliar-historic:00001::aux::IVA');
    expect(iva).toBeTruthy();
    expect(iva?.category).toBe('TAX');
    expect(iva?.subcategory).toBe('IVA');
    expect(iva?.counterpartyName).toBe('SAT — IVA');
    expect(iva?.counterpartyType).toBe('TAX_AUTHORITY');
  });

  // Branch no-long-term-projection: regla de negocio — la cobranza con
  // cliente/factura clasifica como Clientes Citi. El businessUnitId del
  // catálogo se conserva como metadato pero no reclasifica el cobro.
  it('classifies non-Federal bank inflows as Clientes Citi while preserving businessUnit metadata', () => {
    const abono = bankMovement({
      cia: '00001',
      banco: 'BANAMEX',
      cuenta: '06787361240',
      tipoMovimiento: 'ABONO',
      importe: 25_000,
      fechaOperacion: '2026-04-16',
      concepto: 'Cobro cliente Sendex',
      referencia: 'REF-MULTI',
    });
    const abonoEnrichments = [{
      movementKey: bankMovementKey(abono),
      status: 'factura-cobrada' as const,
      facturas: [{
        cia: '00001',
        noFactura: 'F-100',
        noCliente: 'C-100',
        nombreCliente: 'ACME INDUSTRIAL SA DE CV',
        importeBruto: 25_000,
      }],
      catalogClientId: 'C-100',
      catalogClientName: 'ACME INDUSTRIAL SA DE CV',
    }];

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [
        bankStatement({
          cia: '00001',
          banco: 'BANAMEX',
          cuenta: '06787361240',
          movimientos: [abono],
        }),
      ],
      clients: [],
      providers: [],
      cxpRecords: [],
      abonoEnrichments,
      assumptions,
      budget: budget({}),
      startingBalance: 0,
      asOfDate: '2026-04-22',
    });

    const movement = canonical.movements.find((m) => m.sourceObjectId === 'REF-MULTI');
    expect(movement?.businessUnitId).toBe('MULTICARGA');
    expect(movement?.subcategory).toBe('Clientes Citi');
    expect(movement?.category).toBe('AR_COLLECTION');
    expect(movement?.counterpartyName).toBe('ACME INDUSTRIAL SA DE CV');
    expect(movement?.bankAccountId).toBe('06787361240');
  });

  it('classifies crossed Federal-account cobranza as Clientes Citi while preserving Federal metadata', () => {
    const abono = bankMovement({
      cia: '00011',
      banco: 'BANAMEX',
      cuenta: '70138237069',
      tipoMovimiento: 'ABONO',
      importe: 40_000,
      fechaOperacion: '2026-04-16',
      concepto: 'Cobro cliente Citi en cuenta Federal',
      referencia: 'REF-FED-CITI',
    });
    const abonoEnrichments = [{
      movementKey: bankMovementKey(abono),
      status: 'factura-cobrada' as const,
      facturas: [{
        cia: '00011',
        noFactura: 'F-200',
        noCliente: 'C-200',
        nombreCliente: 'CITI INDUSTRIAL SA DE CV',
        importeBruto: 40_000,
      }],
      catalogClientId: 'C-200',
      catalogClientName: 'CITI INDUSTRIAL SA DE CV',
    }];

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [
        bankStatement({
          cia: '00011',
          banco: 'BANAMEX',
          cuenta: '70138237069',
          movimientos: [abono],
        }),
      ],
      clients: [],
      providers: [],
      cxpRecords: [],
      abonoEnrichments,
      assumptions,
      budget: budget({}),
      startingBalance: 0,
      asOfDate: '2026-04-22',
    });

    const movement = canonical.movements.find((m) => m.sourceObjectId === 'REF-FED-CITI');
    expect(movement?.businessUnitId).toBe('FEDERAL');
    expect(movement?.subcategory).toBe('Clientes Citi');
    expect(movement?.category).toBe('AR_COLLECTION');
    expect(movement?.counterpartyName).toBe('CITI INDUSTRIAL SA DE CV');
    expect(movement?.bankAccountId).toBe('70138237069');
  });

  it('classifies unmatched Federal-account inflows as Federal', () => {
    const abono = bankMovement({
      cia: '00011',
      banco: 'BANAMEX',
      cuenta: '70138237069',
      tipoMovimiento: 'ABONO',
      importe: 15_000,
      fechaOperacion: '2026-04-16',
      concepto: 'Venta Federal sin factura cruzada',
      referencia: 'REF-FED-UNMATCHED',
    });

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [
        bankStatement({
          cia: '00011',
          banco: 'BANAMEX',
          cuenta: '70138237069',
          movimientos: [abono],
        }),
      ],
      clients: [],
      providers: [],
      cxpRecords: [],
      assumptions,
      budget: budget({}),
      startingBalance: 0,
      asOfDate: '2026-04-22',
    });

    const movement = canonical.movements.find((m) => m.sourceObjectId === 'REF-FED-UNMATCHED');
    expect(movement?.businessUnitId).toBe('FEDERAL');
    expect(movement?.subcategory).toBe('Federal');
    expect(movement?.category).toBe('TRANSFER');
    expect(movement?.counterpartyType).toBe('BANK');
  });

  it('excludes catalog-neutral bank accounts from real inflows and outflows', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [
        bankStatement({
          cia: '00001',
          banco: 'BANAMEX',
          cuenta: '70144758151',
          movimientos: [
            bankMovement({
              cia: '00001',
              banco: 'BANAMEX',
              cuenta: '70144758151',
              tipoMovimiento: 'ABONO',
              importe: 5_000,
              fechaOperacion: '2026-04-16',
              concepto: 'Fondo ahorro',
              referencia: 'NEUTRO',
            }),
          ],
        }),
      ],
      clients: [],
      providers: [],
      cxpRecords: [],
      assumptions,
      budget: budget({}),
      startingBalance: 0,
      asOfDate: '2026-04-22',
    });

    expect(canonical.movements.some((m) => m.sourceObjectId === 'NEUTRO')).toBe(false);
  });

  it('suppresses CXC facturas already cross-matched to a bank ABONO (cobrada-banco)', () => {
    // Dos facturas: CXC-1 ya cruzó al banco (no debe re-proyectarse),
    // CXC-2 sigue pendiente (sí debe aparecer en la proyección).
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
      cobradaBancoKeys: new Set(['00001::CXC-1']),
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
    // la CXC proyectada — sólo cuando hay match automático con banco. Sin
    // entradas en `cobradaBancoKeys`, ambas facturas siguen proyectándose.
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
      cobradaBancoKeys: new Set<string>(),
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

  it('adds active purchase receipts as early AP commitments with IVA16 metadata', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [],
      purchaseReceipts: [
        purchaseReceipt({
          invoiceNo: 'P-IVA16',
          totalAmount: 1160,
          amountMxn: 1160,
          taxRateCode: 'IVA16',
          taxRate: 16,
          taxTreatment: 'IVA_CREDITABLE',
          taxBaseAmount: 1000,
          taxAmount: 160,
        }),
      ],
      assumptions,
      budget: budget({ expenseMay: 0, expenseConcept: null }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const movement = canonical.movements.find((item) => item.id.includes('P-IVA16'));
    expect(movement).toBeTruthy();
    expect(movement?.category).toBe('AP_PAYMENT');
    expect(movement?.projectedDate).toBe('2026-05-31');
    expect(movement?.projectedAmount).toBe(1160);
    expect(movement?.taxRate).toBe(16);
    expect(movement?.taxBaseAmount).toBeCloseTo(1000);
    expect(movement?.taxAmount).toBeCloseTo(160);
  });

  it('does not add cancelled purchase receipts or receipts already represented by CXP', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [
        cxpRecord({
          noProveedor: '59570032',
          noFactura: 'MATCHED',
          importePendientePesos: 1160,
        }),
      ],
      purchaseReceipts: [
        purchaseReceipt({ invoiceNo: 'CANCELLED', cancelledAt: '2026-05-10', isCancelled: true, status: 'CANCELLED' }),
        purchaseReceipt({ invoiceNo: 'MATCHED', noProveedor: '59570032' }),
      ],
      assumptions,
      budget: budget({ expenseMay: 1160, expenseConcept: null }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    expect(canonical.movements.some((item) => item.id.includes('CANCELLED'))).toBe(false);
    expect(canonical.movements.some((item) => item.id.startsWith('purchase:') && item.id.includes('MATCHED'))).toBe(false);
    expect(canonical.movements.some((item) => item.id.startsWith('cxp:') && item.sourceObjectId === 'MATCHED')).toBe(true);
  });

  it('does not project past OCs filtered out by the compras adapter', () => {
    const purchaseReceipts = comprasToPurchaseReceipts([
      compraRecord({
        noOrden: 'OLD-OC',
        fechaPedido: '2024-11-25',
        fechaRecepcion: '2024-12-23',
        fechaPagoProyectada: '2025-01-22',
      }),
    ], {
      asOfDate: '2026-05-13',
      excludePastUnexecuted: true,
      futureOrderLookaheadMonths: 3,
    });

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [],
      purchaseReceipts,
      assumptions,
      budget: budget({ expenseMay: 0, expenseConcept: null }),
      startingBalance: 10_000,
      asOfDate: '2026-05-13',
    });

    expect(purchaseReceipts).toHaveLength(0);
    expect(canonical.movements.some((item) => item.sourceObjectId === 'OLD-OC')).toBe(false);
  });

  it('keeps OCs whose projected payment date is past but still inside the 1-month grace window', () => {
    const purchaseReceipts = comprasToPurchaseReceipts([
      compraRecord({
        noOrden: 'RECENT-PAST-OC',
        fechaPedido: '2026-03-15',
        fechaRecepcion: '2026-03-20',
        fechaPagoProyectada: '2026-04-20',
      }),
    ], {
      asOfDate: '2026-05-13',
      excludePastUnexecuted: true,
      futureOrderLookaheadMonths: 3,
    });

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
      providers: [],
      cxpRecords: [],
      purchaseReceipts,
      assumptions,
      budget: budget({ expenseMay: 0, expenseConcept: null }),
      startingBalance: 10_000,
      asOfDate: '2026-05-13',
    });

    const movement = canonical.movements.find((item) => item.sourceObjectId === 'RECENT-PAST-OC');
    expect(movement).toBeTruthy();
    expect(movement?.projectedDate).toBe('2026-05-13');
  });

  it('projects future OCs from compras inside the 3-month window', () => {
    const purchaseReceipts = comprasToPurchaseReceipts([
      compraRecord({
        noOrden: 'FUTURE-OC',
        fechaPedido: '2026-06-01',
        fechaRecepcion: '',
        fechaPagoProyectada: '',
        diasCredito: 0,
      }),
    ], {
      asOfDate: '2026-05-13',
      excludePastUnexecuted: true,
      futureOrderLookaheadMonths: 3,
    });

    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [],
      purchaseReceipts,
      assumptions,
      budget: budget({ expenseMay: 0, expenseConcept: null }),
      startingBalance: 10_000,
      asOfDate: '2026-05-13',
    });

    const movement = canonical.movements.find((item) => item.sourceObjectId === 'FUTURE-OC');
    expect(movement).toBeTruthy();
    expect(movement?.category).toBe('AP_PAYMENT');
    expect(movement?.projectedDate).toBe('2026-06-22');
  });

  it('adds TRESS payroll costs but skips deduction-only concepts', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [],
      payrollCosts: [
        payrollCost({ conceptId: 1, conceptName: 'SUELDO ORDINARIO', conceptType: 'Percepción', amount: 1000, cashTreatment: 'CASH_OUT' }),
        payrollCost({ conceptId: 51, conceptName: 'ISR (TRABAJADOR)', conceptType: 'Deducción', amount: 300, cashTreatment: 'DEDUCTION' }),
        payrollCost({ conceptId: 97, conceptName: 'IMSS PATRONAL', conceptType: 'Obligación Empresa', amount: 200, cashTreatment: 'EMPLOYER_TAX' }),
      ],
      assumptions,
      budget: budget({ expenseMay: 0, expenseConcept: null }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const payroll = canonical.movements.filter((item) => item.sourceSystem === 'PAYROLL');
    // buildPayrollCostMovements replica la pauta del baseline (abril 2026)
    // hacia adelante hasta el horizonte (11 meses). 2 conceptos cash-affecting
    // (SUELDO + IMSS) × 11 meses futuros = 22 movements. ISR sigue excluido
    // por ser pura deducción.
    expect(payroll.length).toBeGreaterThanOrEqual(2);
    expect(payroll.some((item) => item.concept.includes('ISR'))).toBe(false);
    expect(payroll.find((item) => item.concept.includes('SUELDO'))?.category).toBe('PAYROLL');
    expect(payroll.find((item) => item.concept.includes('IMSS'))?.category).toBe('AP_PAYMENT');
    expect(payroll.every((item) => item.taxTreatment === 'IVA_EXEMPT')).toBe(true);
  });
});

describe('canonicalProjection ROL projection (modelo corregido)', () => {
  it('proyecta viaje ejecutado NO facturado como ingreso `rol:` fechado por la regla del catálogo', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [client({ id: 'client-1', creditDays: 30, paymentDay: { kind: 'ANY' } })],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [],
      rolRecords: [
        rolRecord({ claveJDE: '1', fechaViaje: '2026-05-04', subTotal: 1000, iva: 16, viajes: 5, efectuado: true }),
      ],
      assumptions,
      budget: budget({ incomeMay: 0 }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const rol = canonical.movements.find((m) => m.id.startsWith('rol:'));
    expect(rol).toBeTruthy();
    expect(rol?.id).toMatch(/^rol:00001:client-1:\d{4}-\d{2}-\d{2}$/);
    expect(rol?.category).toBe('AR_COLLECTION');
    expect(rol?.counterpartyId).toBe('client-1');
    expect(rol?.counterpartyType).toBe('CUSTOMER');
    // 1000 subtotal × 1.16 IVA = 1160 bruto a banco; trip + 30d crédito → junio.
    expect(rol?.projectedAmount).toBeCloseTo(1160);
    expect(rol?.taxBaseAmount).toBeCloseTo(1000);
    expect(rol?.taxAmount).toBeCloseTo(160);
    expect(rol!.projectedDate.slice(0, 7)).toBe('2026-06');
    expect(rol!.projectedDate > '2026-04-22').toBe(true);
    // Invariante Base: `rol:` predicho NO es real short-term → fuera de Base.
    expect(isRealShortTermApiMovement(rol!)).toBe(false);
  });

  it('NO proyecta `rol:` para un viaje ya facturado (predicted ⊥ invoiced; sin doble conteo con cxc:)', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [client({ id: 'client-1', creditDays: 30 })],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [
        cobranzaRecord({ noCliente: '1', noFactura: 'RI-900', importePendientePesos: 1000, fechaFactura: '2026-05-01' }),
      ],
      rolRecords: [
        rolRecord({ claveJDE: '1', factura: 'RI-900', fechaViaje: '2026-05-04', subTotal: 1000, efectuado: true }),
      ],
      assumptions,
      budget: budget({ incomeMay: 0 }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    expect(canonical.movements.some((m) => m.id.startsWith('rol:'))).toBe(false);
    // El viaje facturado vive como cxc: (cobranza JDE), no duplicado.
    expect(canonical.movements.some((m) => m.id.startsWith('cxc:'))).toBe(true);
  });

  it('suprime la proyección genérica `client:` cuando ROL cubre ese cliente/mes de cobro (sin doble conteo ROL↔client)', () => {
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      // creditDays 0 + ANY → fecha de cobro ≈ fecha del viaje (mayo).
      clients: [client({ id: 'client-1', creditDays: 0, paymentDay: { kind: 'ANY' } })],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [],
      rolRecords: [
        rolRecord({ claveJDE: '1', fechaViaje: '2026-05-20', subTotal: 2000, iva: 16, viajes: 3, efectuado: true }),
      ],
      assumptions,
      budget: budget({ incomeMay: 0 }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    const mayClient1Ar = canonical.movements.filter(
      (m) => m.category === 'AR_COLLECTION'
        && m.counterpartyId === 'client-1'
        && m.projectedDate.slice(0, 7) === '2026-05',
    );
    expect(mayClient1Ar.length).toBeGreaterThan(0);
    expect(mayClient1Ar.every((m) => m.id.startsWith('rol:'))).toBe(true);
    expect(mayClient1Ar.some((m) => m.id.startsWith('client:'))).toBe(false);
  });

  it('no proyecta ROL sin cliente en catálogo (sin regla de pago confiable)', () => {
    // claveJDE no matchea por dígito Y los tokens de dCliente/cCliente no
    // empatan con NINGÚN nombre del catálogo → orphan. El fallback por
    // tokens (introducido 2026-05-24) sólo recupera cuando el name SÍ
    // existe en el catálogo bajo otra forma — viajes totalmente foráneos
    // siguen siendo huérfanos.
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [client({ id: 'client-1', creditDays: 30 })],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [],
      rolRecords: [
        rolRecord({
          claveJDE: '999999',
          cCliente: 'XYZ',
          dCliente: 'Foraneo Sin Match En Catalogo',
          fechaViaje: '2026-05-04',
          subTotal: 5000,
          efectuado: true,
        }),
      ],
      assumptions,
      budget: budget({ incomeMay: 0 }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    expect(canonical.movements.some((m) => m.id.startsWith('rol:'))).toBe(false);
  });

  it('recupera ROL huérfano vía token de nombre cuando claveJDE no matchea', () => {
    // claveJDE='999999' no matchea dígito, pero dCliente='Cliente IVA' SÍ
    // empata por tokens al catálogo `client-1` (name='Cliente IVA').
    // Fallback recupera el ingreso — antes (sin fallback) este viaje quedaba
    // sin proyectar pese a tener nombre conocido en catálogo.
    const canonical = buildCanonicalProjection({
      companyCode: 'all',
      bankStatements: [],
      clients: [client({ id: 'client-1', creditDays: 30 })],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [],
      rolRecords: [
        rolRecord({
          claveJDE: '999999',
          dCliente: 'Cliente IVA',
          fechaViaje: '2026-05-04',
          subTotal: 5000,
          efectuado: true,
        }),
      ],
      assumptions,
      budget: budget({ incomeMay: 0 }),
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    });

    expect(canonical.movements.some((m) => m.id.startsWith('rol:'))).toBe(true);
  });
});

describe('two-engine seam (MOTOR 1 histórico / MOTOR 2 corto plazo)', () => {
  it('particiona por fecha: MOTOR 1 ≤ hoy (incluye bank:), MOTOR 2 > hoy (incluye cxc:)', () => {
    const asOfDate = '2026-04-22';
    const inputs = {
      companyCode: 'all',
      bankStatements: [bankStatement({
        cia: '00001',
        cuenta: 'CTA-A',
        movimientos: [
          bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'ABONO', importe: 10_000, fechaOperacion: '2026-03-15', concepto: 'Cobro cliente' }),
        ],
      })],
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
      budget: budget({}),
      startingBalance: 0,
      asOfDate,
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const historical = buildHistoricalReconciledMovements({ monthly, inputs });
    const future = buildShortTermProjectionMovements({ monthly, inputs });

    // MOTOR 1: histórico ≤ hoy; incluye el `bank:`, sin proyecciones `cxc:`.
    expect(historical.some((m) => m.id.startsWith('bank:'))).toBe(true);
    expect(historical.some((m) => m.id.startsWith('cxc:'))).toBe(false);
    for (const m of historical) {
      expect((m.actualDate ?? m.projectedDate ?? '') <= asOfDate).toBe(true);
    }

    // MOTOR 2: corto plazo > hoy; incluye el `cxc:`, sin `bank:` histórico.
    expect(future.some((m) => m.id.startsWith('cxc:'))).toBe(true);
    expect(future.some((m) => m.id.startsWith('bank:'))).toBe(false);
    for (const m of future) {
      expect((m.projectedDate ?? '') >= asOfDate).toBe(true);
    }

    // Invariante: ningún movimiento futuro de MOTOR 2 entra al Escenario Base
    // (Base = MOTOR 1: real corto plazo ≤ hoy).
    expect(
      future.every((m) => !(isRealShortTermApiMovement(m) && (m.projectedDate ?? '') <= asOfDate)),
    ).toBe(true);
  });
});

describe('canonicalProjection · categorización por cuenta contable (GL)', () => {
  // Limpia las reglas inyectadas tras cada caso (GL_FLOW_RULES es módulo-global).
  afterEach(() => {
    GL_FLOW_RULES.length = 0;
    __resetGlFlowWarnings();
  });

  it('re-categoriza un CARGO TRANSFER por su cuenta contable SIN alterar montos ni el set de movimientos', () => {
    const cargo = bankMovement({
      cia: '00001',
      cuenta: 'CTA-1',
      tipoMovimiento: 'CARGO',
      importe: 1234,
      fechaOperacion: '2026-02-10',
      referencia: 'R-77',
      concepto: 'CARGO GENERICO SIN PATRON',
    });
    const abono = bankMovement({
      cia: '00001',
      cuenta: 'CTA-1',
      tipoMovimiento: 'ABONO',
      importe: 5000,
      fechaOperacion: '2026-02-05',
      referencia: 'R-10',
      concepto: 'DEPOSITO',
    });
    const inputs = {
      companyCode: '00001',
      bankStatements: [bankStatement({ cia: '00001', cuenta: 'CTA-1', saldoInicial: 0, movimientos: [abono, cargo] })],
      clients: [],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [],
      assumptions,
      budget: null,
      startingBalance: undefined,
      asOfDate: '2026-03-01',
      // Línea del mayor cruzada al CARGO por `bankMovementKey`, con cuenta
      // contable mapeable. La presencia de la línea no cambia nada hasta que
      // exista una regla en el catálogo.
      auxiliarReconLines: [{
        glKey: '00001::aux::PV::1',
        cia: '00001',
        cuentaBanco: 'CTA-1',
        nombreCuenta: 'BANCO',
        cuentaContable: '60.1020.0060001',
        cuentaObjeto: '1020',
        idCuenta: '60001',
        flujo: 'egreso',
        esCaja: false,
        fechaContable: '2026-02-10',
        importe: -1234,
        moneda: 'MXN',
        // tipo_docto NO mapeado en DOC_TYPE_FLOW → aísla la prueba al catálogo GL.
        tipoDocto: 'JX',
        tipoDoctoDesc: 'Revaluación FX',
        estatusConciliado: 'R',
        matchTier: 'exact',
        confidence: 1,
        bankMovementKey: bankMovementKey(cargo),
        source: { kind: 'otro', cia: '00001', ref: '', contraparte: '' },
      } satisfies AuxiliarReconLine],
    };

    const monthly = buildCanonicalProjection(inputs).monthly;

    // Run 1: catálogo vacío → el CARGO cae al genérico TRANSFER.
    const before = buildHistoricalReconciledMovements({ monthly, inputs });
    const cargoBefore = before.find((m) => m.id.startsWith('bank:') && m.type === 'OUTFLOW' && m.projectedAmount === 1234);
    expect(cargoBefore?.category).toBe('TRANSFER');

    // Run 2: una regla mapea esa cuenta contable a OPEX.
    GL_FLOW_RULES.push({
      cuentaObjeto: '1020',
      idCuentaFrom: 60000,
      idCuentaTo: 60002,
      mapping: { category: 'OPEX', label: 'Servicios operativos (test)' },
    });
    const after = buildHistoricalReconciledMovements({ monthly, inputs });
    const cargoAfter = after.find((m) => m.id === cargoBefore!.id);
    expect(cargoAfter?.category).toBe('OPEX');

    // Invariante de totales: ingresos/egresos por monto NO cambian.
    const sum = (list: typeof before, type: 'INFLOW' | 'OUTFLOW') =>
      list.filter((m) => m.type === type).reduce((s, m) => s + m.projectedAmount, 0);
    expect(sum(after, 'OUTFLOW')).toBe(sum(before, 'OUTFLOW'));
    expect(sum(after, 'INFLOW')).toBe(sum(before, 'INFLOW'));

    // Mismo set de movimientos (no se crea ni se borra ninguno).
    expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort());

    // Sólo category/subcategory difieren — el resto del movimiento es idéntico.
    const strip = (m: (typeof before)[number]) => {
      const { category: _c, subcategory: _s, ...rest } = m;
      return rest;
    };
    const beforeById = new Map(before.map((m) => [m.id, m]));
    for (const m of after) {
      expect(strip(m)).toEqual(strip(beforeById.get(m.id)!));
    }
  });

  it('categoriza CARGOs por tipo_docto (P*→AP, QD→OPEX con fila por concepto) sin cambiar montos', () => {
    const pago = bankMovement({ cia: '00001', cuenta: 'CTA-1', tipoMovimiento: 'CARGO', importe: 700, fechaOperacion: '2026-02-11', referencia: 'R-PK', concepto: 'CARGO SIN PATRON' });
    const arrend = bankMovement({ cia: '00001', cuenta: 'CTA-1', tipoMovimiento: 'CARGO', importe: 300, fechaOperacion: '2026-02-12', referencia: 'R-QD', concepto: 'CARGO SIN PATRON' });
    const mkLine = (mov: typeof pago, glKey: string, tipoDocto: string): AuxiliarReconLine => ({
      glKey, cia: '00001', cuentaBanco: 'CTA-1', nombreCuenta: 'BANCO',
      cuentaContable: '00.1020.0000000', cuentaObjeto: '1020', idCuenta: '0',
      flujo: 'egreso', esCaja: false, fechaContable: '2026-02-11', importe: -1, moneda: 'MXN',
      tipoDocto, tipoDoctoDesc: '', estatusConciliado: 'R', matchTier: 'exact', confidence: 1,
      bankMovementKey: bankMovementKey(mov), source: { kind: 'otro', cia: '00001', ref: '', contraparte: '' },
    });
    const inputs = {
      companyCode: '00001',
      bankStatements: [bankStatement({ cia: '00001', cuenta: 'CTA-1', saldoInicial: 0, movimientos: [pago, arrend] })],
      clients: [], providers: [], cxpRecords: [], cobranzaRecords: [],
      assumptions, budget: null, startingBalance: undefined, asOfDate: '2026-03-01',
      auxiliarReconLines: [mkLine(pago, 'gl-pago', 'PK'), mkLine(arrend, 'gl-arr', 'QD')],
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildHistoricalReconciledMovements({ monthly, inputs });

    const pk = mv.find((m) => m.type === 'OUTFLOW' && m.projectedAmount === 700);
    const qd = mv.find((m) => m.type === 'OUTFLOW' && m.projectedAmount === 300);
    // PK (Cheques automatizados) → pago a proveedor (sale de "sin identificar").
    expect(pk?.category).toBe('AP_PAYMENT');
    // QD (ARRENDAMIENTO) → OPEX con su propia fila/etiqueta por concepto.
    expect(qd?.category).toBe('OPEX');
    expect(qd?.subcategory).toBe('Arrendamiento');
    expect(qd?.counterpartyName).toBe('Arrendamiento');
    // Montos preservados (categorización invariante en totales).
    expect(mv.filter((m) => m.type === 'OUTFLOW').reduce((s, m) => s + m.projectedAmount, 0)).toBe(1000);
  });

  it('categoriza egresos por el rol de la cuenta de banco (pagadora/proveedores → AP) sin GL ni tipo_docto', () => {
    // Cuenta real del catálogo (pagadora/proveedores, flow egreso).
    const cuenta = '7014 1027881';
    const cargo = bankMovement({ cia: '00001', cuenta, tipoMovimiento: 'CARGO', importe: 555, fechaOperacion: '2026-02-14', referencia: 'R-PROV', concepto: 'CARGO SIN PATRON' });
    const inputs = {
      companyCode: '00001',
      bankStatements: [bankStatement({ cia: '00001', cuenta, saldoInicial: 0, movimientos: [cargo] })],
      clients: [], providers: [], cxpRecords: [], cobranzaRecords: [],
      assumptions, budget: null, startingBalance: undefined, asOfDate: '2026-03-01',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildHistoricalReconciledMovements({ monthly, inputs });
    const prov = mv.find((m) => m.type === 'OUTFLOW' && m.projectedAmount === 555);
    // Sin cruce a proveedor/GL/tipo_docto, el rol de la cuenta (pagadora de
    // proveedores) lo saca de "sin identificar" hacia Proveedores.
    expect(prov?.category).toBe('AP_PAYMENT');
  });
});

// Prorrateo del depósito a la concentradora Citi. El peso por cliente debe
// medirse SOLO contra la cobranza que sigue sin atribuir; si el denominador
// incluye a los clientes cuyo ABONO ya se cruzó a factura (y que por tanto ya
// salieron del pool a prorratear), todo cliente no cruzado se diluye por el
// factor `pool / cobranzaTotal` — el defecto que reportó Santiago con 3M.
describe('prorateCitiConcentradoraByClient — denominador del peso', () => {
  // Cuenta real del catálogo: CONCENTRADORA CLIENTES CITI (subRole clientes_citi).
  const CONCENTRADORA = '06780038436';
  const CIA = '00011';
  // Cifras reales del caso reportado (2026-02).
  const TRES_M = 221_201.53;
  const OTRO = 221_778_798.47; // cobranza del resto del mes, ya cruzada a factura
  const asOfDate = '2026-03-01';

  /**
   * Un mes con DOS cobros a la concentradora:
   *   - 3M: ABONO que NO cruzó a factura → cae al pool del prorrateo.
   *   - Otro cliente: ABONO que SÍ cruzó → sale del pool (category AR_COLLECTION).
   * Ambos tienen cobranza JDE con `fechaCobro` en el mes.
   */
  function buildInputs() {
    const abono3M = bankMovement({
      cia: CIA, banco: 'BANAMEX', cuenta: CONCENTRADORA,
      tipoMovimiento: 'ABONO', importe: TRES_M, fechaOperacion: '2026-02-12',
      referencia: 'REF-3M', concepto: '102 3M MEXICO SA DE CV',
    });
    const abonoOtro = bankMovement({
      cia: CIA, banco: 'BANAMEX', cuenta: CONCENTRADORA,
      tipoMovimiento: 'ABONO', importe: OTRO, fechaOperacion: '2026-02-20',
      referencia: 'REF-OTRO', concepto: 'Cobro cliente cruzado',
    });
    return {
      companyCode: 'all',
      bankStatements: [bankStatement({
        cia: CIA, banco: 'BANAMEX', cuenta: CONCENTRADORA,
        saldoInicial: 0, movimientos: [abono3M, abonoOtro],
      })],
      // Solo el ABONO del "otro" cliente cruza a factura.
      abonoEnrichments: [{
        movementKey: bankMovementKey(abonoOtro),
        status: 'factura-cobrada' as const,
        facturas: [{
          cia: CIA, noFactura: 'F-OTRO', noCliente: 'C-OTRO',
          nombreCliente: 'CLIENTE CRUZADO SA DE CV', importeBruto: OTRO,
        }],
        catalogClientId: 'C-OTRO',
        catalogClientName: 'CLIENTE CRUZADO SA DE CV',
      }],
      cobranzaRecords: [
        cobranzaRecord({
          cia: CIA, noCliente: '103246', nombreCliente: '3M MEXICO S.A. DE C.V.',
          noFactura: 'RI-301306', fechaFactura: '2025-12-16', fechaCobro: '2026-02-12',
          importeBrutoPesos: TRES_M,
        }),
        cobranzaRecord({
          cia: CIA, noCliente: 'C-OTRO', nombreCliente: 'CLIENTE CRUZADO SA DE CV',
          noFactura: 'F-OTRO', fechaFactura: '2025-12-20', fechaCobro: '2026-02-20',
          importeBrutoPesos: OTRO,
        }),
      ],
      clients: [], providers: [], cxpRecords: [],
      assumptions, budget: null, startingBalance: undefined, asOfDate,
    };
  }

  function citiRowsFor(name: RegExp) {
    const movements = buildCanonicalProjection(buildInputs()).movements;
    return movements.filter((m) =>
      m.type === 'INFLOW'
      && (m.actualDate ?? m.projectedDate ?? '').startsWith('2026-02')
      && name.test(m.counterpartyName ?? ''));
  }

  it('atribuye a 3M su cobro real, no una fracción diluida por los clientes ya cruzados', () => {
    const total = citiRowsFor(/3M MEXICO/i).reduce((s, m) => s + m.projectedAmount, 0);
    // El defecto producía 221201.53 × (221201.53 / 222_000_000) ≈ $220.4.
    expect(total).toBeGreaterThan(200_000);
    expect(total).toBeCloseTo(TRES_M, 2);
  });

  it('conserva el total bancario del grupo prorrateado (cuadre Planeación ↔ banco)', () => {
    const movements = buildCanonicalProjection(buildInputs()).movements;
    const citiInflow = movements
      .filter((m) => m.type === 'INFLOW'
        && m.subcategory === 'Clientes Citi'
        && (m.actualDate ?? m.projectedDate ?? '').startsWith('2026-02'))
      .reduce((s, m) => s + m.projectedAmount, 0);
    // Σ (prorrateo + cruzados) === Σ ABONOs reales a la concentradora.
    expect(citiInflow).toBeCloseTo(TRES_M + OTRO, 2);
  });

  it('no le da al cliente ya cruzado una porción extra del prorrateo (sin doble conteo)', () => {
    const total = citiRowsFor(/CLIENTE CRUZADO/i).reduce((s, m) => s + m.projectedAmount, 0);
    expect(total).toBeCloseTo(OTRO, 2);
  });

  // Hoy todas las fuentes emiten la cía con padding a 5 dígitos, pero un
  // mismatch aquí no falla ruidosamente: deja el mes sin desglosar por cliente.
  it('cruza el depósito con la cobranza aunque la cía venga sin padding', () => {
    const inputs = buildInputs();
    const movements = buildCanonicalProjection({
      ...inputs,
      bankStatements: [bankStatement({
        ...inputs.bankStatements[0], cia: '11',
        movimientos: inputs.bankStatements[0].movimientos.map((m) => ({ ...m, cia: '11' })),
      })],
      cobranzaRecords: inputs.cobranzaRecords.map((r) => ({ ...r, cia: '00011' })),
      abonoEnrichments: [],
    }).movements;
    const tresMRows = movements.filter((m) => /3M MEXICO/i.test(m.counterpartyName ?? ''));
    const tresM = tresMRows.reduce((s, m) => s + m.projectedAmount, 0);
    // Sin cruces, el pool es todo el depósito y 3M pesa lo suyo sobre el total.
    expect(tresM).toBeGreaterThan(0);
    expect(tresM).toBeCloseTo((TRES_M + OTRO) * (TRES_M / (TRES_M + OTRO)), 2);
    // La cía sale NORMALIZADA en el movimiento sintético, no la '11' cruda del
    // banco: el filtro por companyId de las propuestas compara por igualdad.
    for (const row of tresMRows.filter((m) => m.id.startsWith('citi-prorrateo:'))) {
      expect(row.companyId).toBe('00011');
      expect(row.id.startsWith('citi-prorrateo:00011:')).toBe(true);
    }
  });
});

/**
 * El prorrateo por peso sólo es válido si el pool (depósitos sin cruzar) y el
 * denominador (cobranza sin atribuir) son la MISMA población. En producción no
 * lo son: hay cobranza del mes sin pierna bancaria en la concentradora
 * (compensaciones, depósito en otro banco, cruce fechado en otro mes). Estos
 * casos fijan que un número correcto NO dependa de esa suposición.
 */
describe('prorateCitiConcentradoraByClient — atribución exacta y no-dilución', () => {
  const CONCENTRADORA = '06780038436';
  const CIA = '00011';
  const TRES_M = 221_201.53;
  const asOfDate = '2026-03-01';

  function inputs(patch: {
    deposits: { importe: number; fecha: string; referencia: string }[];
    cobranza: { noCliente: string; nombreCliente: string; importe: number; fechaCobro: string }[];
  }) {
    return {
      companyCode: 'all',
      bankStatements: [bankStatement({
        cia: CIA, banco: 'BANAMEX', cuenta: CONCENTRADORA, saldoInicial: 0,
        movimientos: patch.deposits.map((d) => bankMovement({
          cia: CIA, banco: 'BANAMEX', cuenta: CONCENTRADORA, tipoMovimiento: 'ABONO',
          importe: d.importe, fechaOperacion: d.fecha, referencia: d.referencia,
          concepto: `Deposito ${d.referencia}`,
        })),
      })],
      abonoEnrichments: [],
      cobranzaRecords: patch.cobranza.map((c) => cobranzaRecord({
        cia: CIA, noCliente: c.noCliente, nombreCliente: c.nombreCliente,
        noFactura: `F-${c.noCliente}`, fechaFactura: '2025-12-16',
        fechaCobro: c.fechaCobro, importeBrutoPesos: c.importe,
      })),
      clients: [], providers: [], cxpRecords: [],
      assumptions, budget: null, startingBalance: undefined, asOfDate,
    };
  }

  const citiInflow = (movements: ReturnType<typeof buildCanonicalProjection>['movements']) =>
    movements.filter((m) => m.type === 'INFLOW'
      && m.subcategory === 'Clientes Citi'
      && (m.actualDate ?? m.projectedDate ?? '').startsWith('2026-02'));

  const forClient = (movements: ReturnType<typeof buildCanonicalProjection>['movements'], name: RegExp) =>
    citiInflow(movements).filter((m) => name.test(m.counterpartyName ?? ''))
      .reduce((sum, m) => sum + m.projectedAmount, 0);

  it('acredita el depósito completo al cliente cuyo importe coincide, aunque el resto de la cobranza del mes no tenga pierna bancaria', () => {
    // Caso real 3M (2026-02): su depósito NO cruzó a factura, y la cobranza del
    // mes trae $221.7M de otro cliente que se liquidó por compensación (nunca
    // entró al banco). Repartir por peso devolvía 221201.53 × (221201.53/222M)
    // ≈ $220.41 — el número que reportó Santiago.
    const movements = buildCanonicalProjection(inputs({
      deposits: [{ importe: TRES_M, fecha: '2026-02-12', referencia: 'REF-3M' }],
      cobranza: [
        { noCliente: '103246', nombreCliente: '3M MEXICO S.A. DE C.V.', importe: TRES_M, fechaCobro: '2026-02-12' },
        { noCliente: 'C-COMP', nombreCliente: 'CLIENTE COMPENSACION SA DE CV', importe: 221_778_798.47, fechaCobro: '2026-02-20' },
      ],
    })).movements;
    expect(forClient(movements, /3M MEXICO/i)).toBeCloseTo(TRES_M, 2);
    // El de la compensación no recibe nada: su cobro nunca entró a la concentradora.
    expect(forClient(movements, /COMPENSACION/i)).toBe(0);
    // Cuadre: el total del mes sigue siendo el ABONO real.
    expect(citiInflow(movements).reduce((s, m) => s + m.projectedAmount, 0)).toBeCloseTo(TRES_M, 2);
  });

  it('no reparte cuando la cobranza sin atribuir no corresponde al depósito: deja la fila sin desglosar', () => {
    const movements = buildCanonicalProjection(inputs({
      deposits: [{ importe: 1_000_000, fecha: '2026-02-10', referencia: 'REF-X' }],
      cobranza: [{ noCliente: 'C-A', nombreCliente: 'CLIENTE A SA DE CV', importe: 50_000_000, fechaCobro: '2026-02-11' }],
    })).movements;
    // Ratio 0.02: repartir le daría al cliente 1/50 de lo suyo. No se atribuye.
    expect(forClient(movements, /CLIENTE A/i)).toBe(0);
    const lump = citiInflow(movements);
    expect(lump).toHaveLength(1);
    expect(lump[0].category).toBe('TRANSFER');
    expect(lump[0].projectedAmount).toBeCloseTo(1_000_000, 2);
  });

  it('nunca infla a un cliente por encima de su cobranza: el excedente va a una fila por identificar', () => {
    const movements = buildCanonicalProjection(inputs({
      deposits: [{ importe: 1_000_000, fecha: '2026-02-10', referencia: 'REF-Y' }],
      cobranza: [{ noCliente: 'C-B', nombreCliente: 'CLIENTE B SA DE CV', importe: 600_000, fechaCobro: '2026-02-11' }],
    })).movements;
    // Escalar por peso le habría dado el millón completo (67% de más).
    expect(forClient(movements, /CLIENTE B/i)).toBeCloseTo(600_000, 2);
    expect(forClient(movements, /por identificar/i)).toBeCloseTo(400_000, 2);
    expect(citiInflow(movements).reduce((s, m) => s + m.projectedAmount, 0)).toBeCloseTo(1_000_000, 2);
  });

  it('no atribuye por importe cuando dos clientes empatan (ambiguo) — cae al reparto por peso', () => {
    const movements = buildCanonicalProjection(inputs({
      deposits: [{ importe: 500_000, fecha: '2026-02-10', referencia: 'REF-Z' }],
      cobranza: [
        { noCliente: 'C-C', nombreCliente: 'CLIENTE C SA DE CV', importe: 500_000, fechaCobro: '2026-02-11' },
        { noCliente: 'C-D', nombreCliente: 'CLIENTE D SA DE CV', importe: 500_000, fechaCobro: '2026-02-11' },
      ],
    })).movements;
    expect(forClient(movements, /CLIENTE C/i)).toBeCloseTo(250_000, 2);
    expect(forClient(movements, /CLIENTE D/i)).toBeCloseTo(250_000, 2);
    expect(citiInflow(movements).reduce((s, m) => s + m.projectedAmount, 0)).toBeCloseTo(500_000, 2);
  });

  it('reporta el periodo como sin desglosar cuando queda pool sin repartir, aunque un depósito sí se haya identificado', () => {
    // El diagnóstico es lo único que avisa de un depósito que se quedó sin
    // atribuir: si un match 1:1 marcara el periodo como 'exacto', el resto del
    // pool volvería a fallar en silencio — el modo de falla que costó meses
    // detectar en el caso 3M.
    const movements = buildCanonicalProjection(inputs({
      deposits: [
        { importe: TRES_M, fecha: '2026-02-12', referencia: 'REF-3M' },
        { importe: 1_000_000, fecha: '2026-02-18', referencia: 'REF-X' },
      ],
      cobranza: [
        { noCliente: '103246', nombreCliente: '3M MEXICO S.A. DE C.V.', importe: TRES_M, fechaCobro: '2026-02-12' },
        { noCliente: 'C-A', nombreCliente: 'CLIENTE A SA DE CV', importe: 50_000_000, fechaCobro: '2026-02-11' },
      ],
    })).movements;
    expect(forClient(movements, /3M MEXICO/i)).toBeCloseTo(TRES_M, 2);
    // El millón no corresponde a la cobranza pendiente (ratio 0.02): se queda sin desglosar.
    expect(forClient(movements, /CLIENTE A/i)).toBe(0);
    const diagnostics = (window as unknown as { __midas__?: { citiProrrateo?: { ym: string; mode: string; matchedDeposits: number; leftoverPool: number }[] } })
      .__midas__?.citiProrrateo ?? [];
    const feb = diagnostics.find((d) => d.ym === '2026-02');
    expect(feb?.matchedDeposits).toBe(1);
    expect(feb?.leftoverPool).toBeCloseTo(1_000_000, 2);
    expect(feb?.mode).toBe('sin-desglosar');
  });

  it('reporta el periodo aunque NO haya ninguna cobranza que empate con el grupo', () => {
    // Peor caso y el más silencioso: cero pesos para el (cía, mes) — el mes cae
    // fuera de la ventana de backfill, toda la cobranza queda filtrada, o la
    // cía no empata. El depósito se deja íntegro como una sola fila a nombre de
    // la cuenta y ninguna fila de cliente: EXACTAMENTE el síntoma reportado.
    // Antes ese grupo salía del bucle antes de registrar diagnóstico, así que
    // no aparecía ni en `window.__midas__.citiProrrateo` ni en el aviso de
    // consola — el reparto fallaba sin dejar rastro.
    const movements = buildCanonicalProjection(inputs({
      deposits: [{ importe: 5_000_000, fecha: '2026-02-14', referencia: 'REF-SOLO' }],
      cobranza: [],
    })).movements;
    // Sin pesos no se desglosa nada: el depósito se conserva tal cual.
    expect(citiInflow(movements).some((m) => m.id.startsWith('citi-prorrateo:'))).toBe(false);
    expect(citiInflow(movements).reduce((s, m) => s + m.projectedAmount, 0)).toBeCloseTo(5_000_000, 2);

    const diagnostics = (window as unknown as { __midas__?: { citiProrrateo?: { ym: string; mode: string; leftoverPool: number; leftoverExpected: number; clients: number }[] } })
      .__midas__?.citiProrrateo ?? [];
    const feb = diagnostics.find((d) => d.ym === '2026-02');
    expect(feb).toBeTruthy();
    expect(feb!.mode).toBe('sin-desglosar');
    expect(feb!.leftoverPool).toBeCloseTo(5_000_000, 2);
    expect(feb!.leftoverExpected).toBe(0);
    expect(feb!.clients).toBe(0);
  });

  it('identifica varios depósitos del mismo mes, cada uno con su cliente y su fecha', () => {
    const movements = buildCanonicalProjection(inputs({
      deposits: [
        { importe: TRES_M, fecha: '2026-02-12', referencia: 'REF-3M' },
        { importe: 987_654.32, fecha: '2026-02-25', referencia: 'REF-E' },
      ],
      cobranza: [
        { noCliente: '103246', nombreCliente: '3M MEXICO S.A. DE C.V.', importe: TRES_M, fechaCobro: '2026-02-12' },
        { noCliente: 'C-E', nombreCliente: 'CLIENTE E SA DE CV', importe: 987_654.32, fechaCobro: '2026-02-24' },
      ],
    })).movements;
    expect(forClient(movements, /3M MEXICO/i)).toBeCloseTo(TRES_M, 2);
    expect(forClient(movements, /CLIENTE E/i)).toBeCloseTo(987_654.32, 2);
    // Cada línea lleva la fecha de SU depósito, no la del más grande del mes.
    const eLine = citiInflow(movements).find((m) => /CLIENTE E/i.test(m.counterpartyName ?? ''));
    expect(eLine?.actualDate).toBe('2026-02-25');
  });

  it('deja el diagnóstico en el buzón que vacía el worker, y sólo una vez por corrida', () => {
    // El motor corre dentro de `financialProjectionSource.worker.ts`, donde no
    // hay `window`: la publicación directa es no-op y la clave documentada
    // quedaba VACÍA en producción. El buzón es el que lo cruza al hilo
    // principal. Se vacía al leerlo porque `buildFinancialProjectionSourceData`
    // está memoizado — un job que pega en el memo NO corre el motor, y
    // devolverle el diagnóstico anterior lo haría pasar por el de esa corrida.
    takeCitiAttributionDiagnostics(); // limpia lo que dejaron los casos previos
    buildCanonicalProjection(inputs({
      deposits: [{ importe: TRES_M, fecha: '2026-02-12', referencia: 'REF-3M' }],
      cobranza: [{ noCliente: '103246', nombreCliente: '3M MEXICO S.A. DE C.V.', importe: TRES_M, fechaCobro: '2026-02-12' }],
    }));

    const first = takeCitiAttributionDiagnostics();
    expect(first?.find((d) => d.ym === '2026-02')?.mode).toBe('exacto');
    // Segunda lectura sin corrida nueva: nada que reportar (no se recicla).
    expect(takeCitiAttributionDiagnostics()).toBeNull();
  });
});

// El depósito que SÍ cruzó al libro mayor con un tipo_docto de cobranza (RC)
// llega al prorrateo como AR_COLLECTION SIN cliente — la conciliación va contra
// el objeto 1010-1020, no contra la línea CXC. Tomar sólo `TRANSFER` como pool
// dejaba fuera a esa población (la mayoritaria) sin sacar su cobranza del
// denominador: los clientes del mes salían diluidos y, con el piso de ratio,
// EN BLANCO. Cifras verificadas contra la BD (2026-07-31, cía 00011):
//   · jde.Auxiliar_Contable objeto 1020 Ano 26 Periodo 2 tipo_docto RC → $184,627,055.90
//   · jde.Cobranza_Citi Fecha_Pago 2026-02 → $198,822,157.27 (1039 facturas)
//   · 3M MEXICO (No_Cliente 103246) 2026-02 → 1 factura, $221,201.53
//   · jde.Bancos cuenta 06780038436 2026-02-12 ABONO $221,201.53 ("3M MEXICO SA DE CV")
describe('prorateCitiConcentradoraByClient — depósito tipificado como cobranza por el mayor', () => {
  const CONCENTRADORA = '06780038436';
  const CIA = '00011';
  const TRES_M = 221_201.53;
  const RESTO = 5_000_000;
  const asOfDate = '2026-03-01';

  /** Línea del mayor que cruza el ABONO con tipo_docto RC (→ AR_COLLECTION). */
  function reconLine(movement: ReturnType<typeof bankMovement>, importe: number): AuxiliarReconLine {
    return {
      glKey: `${CIA}::aux::RC::${movement.referencia}`,
      cia: CIA,
      cuentaBanco: CONCENTRADORA,
      nombreCuenta: 'BANAMEX 67838436',
      cuentaContable: '11.1020.0011302',
      cuentaObjeto: '1020',
      idCuenta: '11302',
      flujo: 'ingreso',
      esCaja: false,
      fechaContable: movement.fechaOperacion,
      importe,
      moneda: 'MXN',
      tipoDocto: 'RC',
      tipoDoctoDesc: 'Cobros - CC',
      estatusConciliado: 'R',
      matchTier: 'exact',
      confidence: 1,
      bankMovementKey: bankMovementKey(movement),
      source: { kind: 'otro', cia: CIA, ref: '', contraparte: '' },
    };
  }

  function inputs() {
    const abono3M = bankMovement({
      cia: CIA, banco: 'BANAMEX', cuenta: CONCENTRADORA, tipoMovimiento: 'ABONO',
      importe: TRES_M, fechaOperacion: '2026-02-12', referencia: 'REF-3M',
      concepto: '102 3M MEXICO SA DE CV',
    });
    const abonoResto = bankMovement({
      cia: CIA, banco: 'BANAMEX', cuenta: CONCENTRADORA, tipoMovimiento: 'ABONO',
      importe: RESTO, fechaOperacion: '2026-02-20', referencia: 'REF-RESTO',
      concepto: 'ORDEN DE ABONO',
    });
    return {
      companyCode: 'all',
      bankStatements: [bankStatement({
        cia: CIA, banco: 'BANAMEX', cuenta: CONCENTRADORA, saldoInicial: 0,
        movimientos: [abono3M, abonoResto],
      })],
      abonoEnrichments: [],
      // Ambos ABONOs cruzan al mayor como cobranza (RC) pero SIN cliente.
      auxiliarReconLines: [reconLine(abono3M, TRES_M), reconLine(abonoResto, RESTO)],
      cobranzaRecords: [
        cobranzaRecord({
          cia: CIA, noCliente: '103246', nombreCliente: '3M MEXICO S.A. DE C.V.',
          noFactura: 'RI-301306', fechaFactura: '2025-12-16', fechaCobro: '2026-02-12',
          importeBrutoPesos: TRES_M,
        }),
        cobranzaRecord({
          cia: CIA, noCliente: 'C-B', nombreCliente: 'CLIENTE B SA DE CV',
          noFactura: 'F-B', fechaFactura: '2025-12-20', fechaCobro: '2026-02-18',
          importeBrutoPesos: RESTO,
        }),
      ],
      clients: [], providers: [], cxpRecords: [],
      assumptions, budget: null, startingBalance: undefined, asOfDate,
    };
  }

  const citiFeb = (movements: ReturnType<typeof buildCanonicalProjection>['movements']) =>
    movements.filter((m) => m.type === 'INFLOW'
      && m.subcategory === 'Clientes Citi'
      && (m.actualDate ?? m.projectedDate ?? '').startsWith('2026-02'));

  const forClient = (movements: ReturnType<typeof buildCanonicalProjection>['movements'], name: RegExp) =>
    citiFeb(movements).filter((m) => name.test(m.counterpartyName ?? ''))
      .reduce((sum, m) => sum + m.projectedAmount, 0);

  it('desglosa por cliente el depósito que el mayor tipificó como cobranza (RC) sin identificar al cliente', () => {
    const movements = buildCanonicalProjection(inputs()).movements;
    // El caso pineado: 3M cobra $221,201.53 y eso es lo que debe verse.
    expect(forClient(movements, /3M MEXICO/i)).toBeCloseTo(TRES_M, 2);
    expect(forClient(movements, /CLIENTE B/i)).toBeCloseTo(RESTO, 2);
    // Y ya no queda el montón sin desglosar a nombre de la cuenta bancaria.
    expect(forClient(movements, /CONCENTRADORA/i)).toBe(0);
  });

  it('conserva exacto el total bancario del mes al desglosarlo', () => {
    const movements = buildCanonicalProjection(inputs()).movements;
    expect(citiFeb(movements).reduce((s, m) => s + m.projectedAmount, 0))
      .toBeCloseTo(TRES_M + RESTO, 2);
  });

  it('no re-prorratea el depósito que YA tiene cliente por cruce banco↔factura (sin doble conteo)', () => {
    const base = inputs();
    const abonoCruzado = base.bankStatements[0].movimientos[0];
    const movements = buildCanonicalProjection({
      ...base,
      // El ABONO de 3M cruza a SU factura: llega como AR_COLLECTION CON cliente.
      abonoEnrichments: [{
        movementKey: bankMovementKey(abonoCruzado),
        status: 'factura-cobrada' as const,
        facturas: [{
          cia: CIA, noFactura: 'RI-301306', noCliente: '103246',
          nombreCliente: '3M MEXICO S.A. DE C.V.', importeBruto: TRES_M,
        }],
        catalogClientId: '103246',
        catalogClientName: '3M MEXICO S.A. DE C.V.',
      }],
    }).movements;
    // Se acredita UNA vez: el cruce directo, no el cruce + una porción del reparto.
    expect(forClient(movements, /3M MEXICO/i)).toBeCloseTo(TRES_M, 2);
    expect(citiFeb(movements).reduce((s, m) => s + m.projectedAmount, 0))
      .toBeCloseTo(TRES_M + RESTO, 2);
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

function compraRecord(patch: Partial<ComprasRecord> = {}): ComprasRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? '59570032',
    nombreProveedor: patch.nombreProveedor ?? 'NEW WORLD FUEL SA DE CV',
    noOrden: patch.noOrden ?? 'OC-1',
    tipoOrden: patch.tipoOrden ?? 'OS',
    descTipoOrden: patch.descTipoOrden ?? 'Catalogadas almacén',
    lineaOrden: patch.lineaOrden ?? 1,
    noProducto: patch.noProducto ?? 'DIESEL',
    descProducto: patch.descProducto ?? 'DIESEL AUTOCONSUMO',
    concepto: patch.concepto ?? 'Compra test',
    cantidad: patch.cantidad ?? 1,
    precioUnitario: patch.precioUnitario ?? 1160,
    importeTotal: patch.importeTotal ?? 1160,
    moneda: patch.moneda ?? 'MXP',
    tipoCambio: patch.tipoCambio ?? 1,
    fechaPedido: patch.fechaPedido ?? '2026-06-01',
    fechaRecepcion: patch.fechaRecepcion ?? '',
    diasCredito: patch.diasCredito ?? 0,
    fechaPagoProyectada: patch.fechaPagoProyectada ?? '',
    noFactura: patch.noFactura ?? '',
    centroCostos: patch.centroCostos ?? '101',
    categoria: patch.categoria ?? 'IND',
    descCategoria: patch.descCategoria ?? 'Indirectos',
    familia: patch.familia ?? 'DIE',
    descFamilia: patch.descFamilia ?? 'DIESEL AUTOCONSUMO',
    subFamilia: patch.subFamilia ?? 'DIE',
    descSubFamilia: patch.descSubFamilia ?? 'DIESEL',
    estadoSiguiente: patch.estadoSiguiente ?? '',
    tasaFiscal: patch.tasaFiscal ?? 'IVA16',
    cancelada: patch.cancelada ?? false,
    facturada: patch.facturada ?? false,
  };
}

function purchaseReceipt(patch: Partial<PurchaseReceiptRecord> = {}): PurchaseReceiptRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? '59570032',
    supplierName: patch.supplierName ?? 'NEW WORLD FUEL SA DE CV',
    invoiceNo: patch.invoiceNo ?? 'P-1',
    purchaseOrderNo: patch.purchaseOrderNo ?? 'OC-1',
    receiptNo: patch.receiptNo ?? 'REC-1',
    orderDate: patch.orderDate ?? '2026-05-01',
    receiptDate: patch.receiptDate ?? '2026-05-01',
    creditDays: patch.creditDays ?? 30,
    estimatedDueDate: patch.estimatedDueDate ?? '2026-05-31',
    currency: patch.currency ?? 'MXN',
    exchangeRate: patch.exchangeRate ?? 1,
    totalAmount: patch.totalAmount ?? 1160,
    amountMxn: patch.amountMxn ?? patch.totalAmount ?? 1160,
    taxCode: patch.taxCode,
    taxRateCode: patch.taxRateCode,
    taxRate: patch.taxRate,
    taxTreatment: patch.taxTreatment ?? 'UNCLASSIFIED',
    taxBaseAmount: patch.taxBaseAmount,
    taxAmount: patch.taxAmount,
    cancelledAt: patch.cancelledAt,
    isCancelled: patch.isCancelled ?? false,
    status: patch.status ?? 'PROJECTED_BASE',
    costCenter: patch.costCenter,
    productCode: patch.productCode,
    productDescription: patch.productDescription,
    productType: patch.productType,
    categoryCode: patch.categoryCode,
    categoryName: patch.categoryName ?? 'Combustibles',
    familyCode: patch.familyCode,
    familyName: patch.familyName ?? 'DIESEL AUTOCONSUMO',
    subfamilyCode: patch.subfamilyCode,
    subfamilyName: patch.subfamilyName ?? 'DIESEL',
  };
}

function payrollCost(patch: Partial<PayrollCostRecord>): PayrollCostRecord {
  return {
    cia: patch.cia ?? '00001',
    empresaNomina: patch.empresaNomina ?? 'SIR',
    year: patch.year ?? 2026,
    month: patch.month ?? 5,
    paymentDate: patch.paymentDate ?? '2026-05-15',
    periodStartDate: patch.periodStartDate,
    periodEndDate: patch.periodEndDate,
    payrollPeriod: patch.payrollPeriod ?? 1,
    payrollType: patch.payrollType ?? 'Semanal',
    conceptId: patch.conceptId ?? 1,
    conceptName: patch.conceptName ?? 'SUELDO ORDINARIO',
    conceptType: patch.conceptType ?? 'Percepción',
    cashTreatment: patch.cashTreatment ?? 'CASH_OUT',
    amount: patch.amount ?? 1000,
    costCenter: patch.costCenter,
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
  };
}

function rolRecord(patch: Partial<RolRecord> = {}): RolRecord {
  return {
    cia: patch.cia ?? '00001',
    empresa: patch.empresa ?? 'SERVICIO INDUSTRIAL',
    kCliente: patch.kCliente ?? 125,
    cCliente: patch.cCliente ?? 'CLI',
    dCliente: patch.dCliente ?? 'Cliente IVA',
    rfc: patch.rfc ?? 'XAXX010101000',
    claveJDE: patch.claveJDE ?? '1',
    facturacionTipo: patch.facturacionTipo ?? 'MENSUAL',
    iva: patch.iva ?? 16,
    tipoViaje: patch.tipoViaje ?? 'SENCILL',
    ruta: patch.ruta ?? 'RUTA TEST',
    costoRuta: patch.costoRuta ?? 200,
    viajes: patch.viajes ?? 5,
    subTotal: patch.subTotal ?? 1000,
    despachado: patch.despachado ?? true,
    efectuado: patch.efectuado ?? true,
    anio: patch.anio ?? 2026,
    semana: patch.semana ?? 19,
    fechaViaje: patch.fechaViaje ?? '2026-05-04',
    factura: patch.factura,
    uuidFiscal: patch.uuidFiscal,
    plazaCiti: patch.plazaCiti,
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

function recurringBankMovements(concepto: string, importe: number, day = '05'): BankStatementLine[] {
  return ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03'].map((ym) => bankMovement({
    cia: '00001',
    cuenta: 'CTA-1',
    tipoMovimiento: 'CARGO',
    importe,
    fechaOperacion: `${ym}-${day}`,
    concepto,
  }));
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

function auxiliarLine(patch: {
  glKey: string;
  fechaContable: string;
  importe: number;
  sourceRef: string;
  contraparte?: string;
}): AuxiliarReconLine {
  return {
    glKey: patch.glKey,
    cia: '00001',
    cuentaBanco: 'CTA-1',
    nombreCuenta: 'BANCO',
    cuentaContable: '42.1020.0010409',
    cuentaObjeto: '1020',
    idCuenta: '0010409',
    flujo: 'egreso',
    esCaja: false,
    fechaContable: patch.fechaContable,
    importe: patch.importe,
    moneda: 'MXN',
    tipoDocto: 'PV',
    tipoDoctoDesc: 'Pago',
    estatusConciliado: 'R',
    matchTier: 'jde-reconciled',
    confidence: 1,
    source: {
      kind: 'otro',
      cia: '00001',
      ref: patch.sourceRef,
      contraparte: patch.contraparte,
    },
  };
}
