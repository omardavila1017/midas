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
