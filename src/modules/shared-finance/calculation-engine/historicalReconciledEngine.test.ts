import { describe, expect, it } from 'vitest';
import type { AuxiliarReconLine } from '../../../domain/auxiliarReconciliationEngine';
import { bankMovementKey } from '../../../domain/bankMovementKey';
import type { CashFlowAssumptions } from '../../../domain/types';
import type { BankAccountStatement, BankStatementLine, CobranzaRecord } from '../../../services/jdeTypes';
import { buildCanonicalProjection } from './canonicalProjection';
import { buildHistoricalReconciledMovements } from './historicalReconciledEngine';

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

describe('buildHistoricalReconciledMovements (MOTOR 1)', () => {
  it('emite movimientos bank: desde el estado de cuenta con categoría/subcategoría por defecto', () => {
    const inputs = {
      companyCode: 'all',
      bankStatements: [bankStatement({
        cia: '00001',
        cuenta: 'CTA-A',
        movimientos: [
          bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'ABONO', importe: 10_000, fechaOperacion: '2026-04-15', concepto: 'Cobro cliente real' }),
          bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'CARGO', importe: 5_000, fechaOperacion: '2026-04-12', concepto: 'Disposicion folio 7001' }),
        ],
      })],
      clients: [],
      providers: [],
      cxpRecords: [],
      assumptions,
      budget: null,
      startingBalance: 0,
      asOfDate: '2026-04-22',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildHistoricalReconciledMovements({ monthly, inputs });

    const abono = mv.find((m) => m.type === 'INFLOW' && m.projectedAmount === 10_000);
    expect(abono).toBeTruthy();
    expect(abono!.id.startsWith('bank:00001:CTA-A:')).toBe(true);
    expect(abono!.category).toBe('TRANSFER');
    expect(abono!.subcategory).toBe('Clientes Citi');
    expect(abono!.counterpartyType).toBe('BANK');
    expect(abono!.actualDate).toBe('2026-04-15');
    expect(abono!.status).toBe('REAL');
    expect(abono!.lockState).toBe('LOCKED');

    const cargo = mv.find((m) => m.type === 'OUTFLOW' && m.projectedAmount === 5_000);
    expect(cargo).toBeTruthy();
    expect(cargo!.category).toBe('TRANSFER');
    // CARGO sin cruce ni patrón → etiquetado por cuenta de banco origen.
    expect(cargo!.counterpartyName).toBe('Sin identificar · BANK-X CTA-A');
  });

  it('precedencia: cobranza-factura (AR_COLLECTION) gana sobre tipo_docto JT (TAX) del ledger', () => {
    const abono = bankMovement({
      cia: '00001',
      cuenta: 'CTA-A',
      tipoMovimiento: 'ABONO',
      importe: 25_000,
      fechaOperacion: '2026-04-16',
      concepto: 'Deposito cliente',
      referencia: 'REF-COB',
    });
    const inputs = {
      companyCode: 'all',
      bankStatements: [bankStatement({ cia: '00001', cuenta: 'CTA-A', movimientos: [abono] })],
      clients: [],
      providers: [],
      cxpRecords: [],
      abonoEnrichments: [{
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
      }],
      // Ledger cruzado con tipo_docto JT (→ TAX). Con menor precedencia que la
      // factura cobrada, NO debe reclasificar el ABONO.
      auxiliarReconLines: [auxLine({
        glKey: 'gl-jt',
        cia: '00001',
        flujo: 'ingreso',
        fechaContable: '2026-04-16',
        importe: 25_000,
        tipoDocto: 'JT',
        bankKey: bankMovementKey(abono),
      })],
      assumptions,
      budget: null,
      startingBalance: 0,
      asOfDate: '2026-04-22',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildHistoricalReconciledMovements({ monthly, inputs });

    const movement = mv.find((m) => m.sourceObjectId === 'REF-COB');
    expect(movement).toBeTruthy();
    expect(movement!.category).toBe('AR_COLLECTION');
    expect(movement!.counterpartyType).toBe('CUSTOMER');
    expect(movement!.counterpartyName).toBe('ACME INDUSTRIAL SA DE CV');
  });

  it('precedencia: pagoProveedor (AP_PAYMENT) gana sobre tipo_docto T1 (PAYROLL) del ledger', () => {
    const cargo = bankMovement({
      cia: '00001',
      cuenta: 'CTA-PAGO',
      tipoMovimiento: 'CARGO',
      importe: 12_500,
      fechaOperacion: '2026-04-15',
      concepto: 'PAGO PROVEEDOR JDE',
      referencia: 'R-AP',
    });
    const inputs = {
      companyCode: 'all',
      bankStatements: [bankStatement({ cia: '00001', cuenta: 'CTA-PAGO', movimientos: [cargo] })],
      clients: [],
      providers: [],
      cxpRecords: [],
      cargoEnrichments: new Map([
        [bankMovementKey(cargo), {
          status: 'MATCHED' as const,
          payments: [{
            claveProveedor: '888',
            nombreProveedor: 'PROVEEDOR CLASIFICADO JDE',
            clasificacionProveedor: 'CHASIS',
            importe: 12_500,
          }],
        }],
      ]),
      auxiliarReconLines: [auxLine({
        glKey: 'gl-t1',
        cia: '00001',
        flujo: 'egreso',
        fechaContable: '2026-04-15',
        importe: -12_500,
        tipoDocto: 'T1',
        bankKey: bankMovementKey(cargo),
      })],
      assumptions,
      budget: null,
      startingBalance: 0,
      asOfDate: '2026-05-01',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildHistoricalReconciledMovements({ monthly, inputs });

    const movement = mv.find((m) => m.sourceObjectId === 'R-AP');
    expect(movement).toBeTruthy();
    // Si T1 hubiera decidido, sería PAYROLL/'Nómina'.
    expect(movement!.category).toBe('AP_PAYMENT');
    expect(movement!.counterpartyName).toBe('PROVEEDOR CLASIFICADO JDE');
    expect(movement!.subcategory).toBe('CHASIS');
  });

  it('precedencia: tipo_docto T1 (PAYROLL) gana sobre el rol de cuenta pagadora (AP_PAYMENT)', () => {
    // Cuenta real del catálogo con role pagadora / subRole proveedores.
    const cuenta = '7014 1027881';
    const nomina = bankMovement({ cia: '00001', cuenta, tipoMovimiento: 'CARGO', importe: 700, fechaOperacion: '2026-02-11', referencia: 'R-T1', concepto: 'CARGO SIN PATRON' });
    const generico = bankMovement({ cia: '00001', cuenta, tipoMovimiento: 'CARGO', importe: 555, fechaOperacion: '2026-02-14', referencia: 'R-ROLE', concepto: 'CARGO SIN PATRON' });
    const inputs = {
      companyCode: '00001',
      bankStatements: [bankStatement({ cia: '00001', cuenta, saldoInicial: 0, movimientos: [nomina, generico] })],
      clients: [],
      providers: [],
      cxpRecords: [],
      auxiliarReconLines: [auxLine({
        glKey: 'gl-nom',
        cia: '00001',
        flujo: 'egreso',
        fechaContable: '2026-02-11',
        importe: -700,
        tipoDocto: 'T1',
        bankKey: bankMovementKey(nomina),
      })],
      assumptions,
      budget: null,
      startingBalance: 0,
      asOfDate: '2026-03-01',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildHistoricalReconciledMovements({ monthly, inputs });

    const conT1 = mv.find((m) => m.type === 'OUTFLOW' && m.projectedAmount === 700);
    const sinLedger = mv.find((m) => m.type === 'OUTFLOW' && m.projectedAmount === 555);
    // T1 (mayor precedencia) levanta la nómina real a PAYROLL aunque la cuenta
    // mixta/pagadora mapee a AP_PAYMENT.
    expect(conT1?.category).toBe('PAYROLL');
    expect(conT1?.subcategory).toBe('Nómina');
    // Sin ledger, el rol de la cuenta (pagadora/proveedores) decide.
    expect(sinLedger?.category).toBe('AP_PAYMENT');
  });

  it('no emite traspasos internos individualmente y acumula el neto asimétrico en internal-recon:', () => {
    const inputs = {
      companyCode: 'all',
      bankStatements: [
        bankStatement({
          cia: '00001',
          cuenta: 'CTA-A',
          movimientos: [
            // Par simétrico cross-cuenta mismo día → interno, neto 0.
            bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'CARGO', importe: 50_000, fechaOperacion: '2026-04-10', concepto: 'Mov interno' }),
            // Interno por leyenda SIN contraparte cargada → residual +30k.
            bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'ABONO', importe: 30_000, fechaOperacion: '2026-04-11', concepto: 'TRASPASO REF 99' }),
            // Real.
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
      ],
      clients: [],
      providers: [],
      cxpRecords: [],
      assumptions,
      budget: null,
      startingBalance: 0,
      asOfDate: '2026-04-22',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildHistoricalReconciledMovements({ monthly, inputs });

    // Los traspasos individuales (50k par + 30k leyenda) nunca salen como bank:.
    expect(mv.some((m) => m.id.startsWith('bank:') && (m.projectedAmount === 50_000 || m.projectedAmount === 30_000))).toBe(false);
    // Sobrevive el cobro real.
    expect(mv.some((m) => m.id.startsWith('bank:') && m.projectedAmount === 10_000)).toBe(true);
    // UN solo internal-recon: por (cia, mes) con el neto asimétrico (par 50k
    // netea a 0; queda el +30k del traspaso sin contraparte).
    const recon = mv.filter((m) => m.category === 'INTERNAL_RECON');
    expect(recon).toHaveLength(1);
    expect(recon[0]!.id.startsWith('internal-recon:00001:')).toBe(true);
    expect(recon[0]!.type).toBe('INFLOW');
    expect(recon[0]!.projectedAmount).toBe(30_000);
    expect(recon[0]!.subcategory).toBe('Traspasos internos (neto)');
  });

  it('la recategorización por ledger NUNCA cambia monto/fecha ni el set de movimientos', () => {
    const cargo = bankMovement({ cia: '00001', cuenta: 'CTA-1', tipoMovimiento: 'CARGO', importe: 1_234, fechaOperacion: '2026-02-10', referencia: 'R-77', concepto: 'CARGO GENERICO SIN PATRON' });
    const abono = bankMovement({ cia: '00001', cuenta: 'CTA-1', tipoMovimiento: 'ABONO', importe: 5_000, fechaOperacion: '2026-02-05', referencia: 'R-10', concepto: 'DEPOSITO' });
    const baseInputs = {
      companyCode: '00001',
      bankStatements: [bankStatement({ cia: '00001', cuenta: 'CTA-1', saldoInicial: 0, movimientos: [abono, cargo] })],
      clients: [],
      providers: [],
      cxpRecords: [],
      assumptions,
      budget: null,
      startingBalance: 0,
      asOfDate: '2026-03-01',
    };
    const monthly = buildCanonicalProjection(baseInputs).monthly;

    const before = buildHistoricalReconciledMovements({ monthly, inputs: baseInputs });
    const after = buildHistoricalReconciledMovements({
      monthly,
      inputs: {
        ...baseInputs,
        auxiliarReconLines: [auxLine({
          glKey: 'gl-inv',
          cia: '00001',
          flujo: 'egreso',
          fechaContable: '2026-02-10',
          importe: -1_234,
          tipoDocto: 'T1',
          bankKey: bankMovementKey(cargo),
        })],
      },
    });

    // La señal SÍ recategoriza el CARGO…
    const cargoBefore = before.find((m) => m.type === 'OUTFLOW' && m.projectedAmount === 1_234);
    const cargoAfter = after.find((m) => m.id === cargoBefore!.id);
    expect(cargoBefore?.category).toBe('TRANSFER');
    expect(cargoAfter?.category).toBe('PAYROLL');

    // …pero totales, fechas e ids son idénticos con y sin señal.
    const sum = (list: typeof before, type: 'INFLOW' | 'OUTFLOW') =>
      list.filter((m) => m.type === type).reduce((s, m) => s + m.projectedAmount, 0);
    expect(sum(after, 'INFLOW')).toBe(sum(before, 'INFLOW'));
    expect(sum(after, 'OUTFLOW')).toBe(sum(before, 'OUTFLOW'));
    expect(after.map((m) => m.id).sort()).toEqual(before.map((m) => m.id).sort());

    const strip = (m: (typeof before)[number]) => {
      const { category: _c, subcategory: _s, counterpartyName: _n, ...rest } = m;
      return rest;
    };
    const beforeById = new Map(before.map((m) => [m.id, m]));
    for (const m of after) {
      expect(strip(m)).toEqual(strip(beforeById.get(m.id)!));
    }
  });

  it('emite cobranza-historic: solo para (cia, mes) SIN cobertura bancaria', () => {
    const anchorStatement = bankStatement({
      cia: '00002',
      cuenta: 'CTA-OTHER',
      movimientos: [
        bankMovement({ cia: '00002', cuenta: 'CTA-OTHER', tipoMovimiento: 'ABONO', importe: 1, fechaOperacion: '2026-04-01', concepto: 'DEPOSITO' }),
      ],
    });
    const cobrada: CobranzaRecord = cobranzaRecord({
      cia: '00001',
      noCliente: '1',
      nombreCliente: 'Cliente Historico',
      noFactura: 'CXC-H',
      fechaFactura: '2026-03-10',
      fechaCobro: '2026-04-10',
      importeBrutoPesos: 4_000,
    });
    const inputs = {
      companyCode: 'all',
      bankStatements: [anchorStatement],
      clients: [],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [cobrada],
      assumptions,
      budget: null,
      startingBalance: 0,
      asOfDate: '2026-05-01',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildHistoricalReconciledMovements({ monthly, inputs });

    // La cia 00001 NO tiene estado de cuenta en 2026-04 → relleno sintético.
    const filler = mv.find((m) => m.id === 'cobranza-historic:00001:1:CXC-H:2026-04-10');
    expect(filler).toBeTruthy();
    expect(filler!.type).toBe('INFLOW');
    expect(filler!.category).toBe('AR_COLLECTION');
    expect(filler!.projectedAmount).toBe(4_000);
    expect(filler!.actualDate).toBe('2026-04-10');
    expect(filler!.status).toBe('REAL');

    // Con cobertura bancaria para (00001, 2026-04) el sintético se suprime
    // (el ABONO real del banco es la verdad — evitar doble conteo).
    const coveredInputs = {
      ...inputs,
      bankStatements: [
        anchorStatement,
        bankStatement({
          cia: '00001',
          cuenta: 'CTA-A',
          movimientos: [
            bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'ABONO', importe: 7, fechaOperacion: '2026-04-03', concepto: 'DEPOSITO' }),
          ],
        }),
      ],
    };
    const coveredMonthly = buildCanonicalProjection(coveredInputs).monthly;
    const coveredMv = buildHistoricalReconciledMovements({ monthly: coveredMonthly, inputs: coveredInputs });
    expect(coveredMv.some((m) => m.id.startsWith('cobranza-historic:'))).toBe(false);
  });

  it('la cobertura bancaria empata aunque la cía llegue sin padding (blindaje anti doble conteo)', () => {
    // Las tres fuentes hoy emiten la cía con padding a 5 dígitos, así que este
    // caso no está vivo — pero si alguna derivara, el mismatch NO daría error:
    // el mes se leería como "sin estado de cuenta" y los sintéticos se
    // emitirían ENCIMA de las líneas `bank:` que ya lo cubren (doble conteo de
    // ingreso ~2×). El join normaliza en los tres lados; esto lo pinea.
    const inputs = {
      companyCode: 'all',
      // Estado de cuenta con la cía SIN padding …
      bankStatements: [bankStatement({
        cia: '11',
        cuenta: 'CTA-A',
        movimientos: [
          bankMovement({ cia: '11', cuenta: 'CTA-A', tipoMovimiento: 'ABONO', importe: 4_000, fechaOperacion: '2026-04-10', concepto: 'DEPOSITO' }),
        ],
      })],
      clients: [],
      providers: [],
      cxpRecords: [],
      // … y las dos fuentes de relleno con la cía padded.
      cobranzaRecords: [cobranzaRecord({
        cia: '00011',
        noCliente: '1',
        nombreCliente: 'Cliente Historico',
        noFactura: 'CXC-H',
        fechaFactura: '2026-03-10',
        fechaCobro: '2026-04-10',
        importeBrutoPesos: 4_000,
      })],
      auxiliarReconLines: [auxLine({
        glKey: 'gl-egreso',
        cia: '00011',
        flujo: 'egreso',
        fechaContable: '2026-04-17',
        importe: -250,
        tipoDocto: 'PV',
        contraparte: 'PROVEEDOR X SA',
      })],
      assumptions,
      budget: null,
      startingBalance: 0,
      asOfDate: '2026-05-01',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildHistoricalReconciledMovements({ monthly, inputs });

    expect(mv.some((m) => m.id.startsWith('cobranza-historic:'))).toBe(false);
    expect(mv.some((m) => m.id.startsWith('auxiliar-historic:'))).toBe(false);
  });

  it('emite auxiliar-historic: sin banco y omite líneas GL con matchTier interno', () => {
    const inputs = {
      companyCode: 'all',
      bankStatements: [bankStatement({
        cia: '00002',
        cuenta: 'CTA-OTHER',
        movimientos: [
          bankMovement({ cia: '00002', cuenta: 'CTA-OTHER', tipoMovimiento: 'ABONO', importe: 1, fechaOperacion: '2026-04-01', concepto: 'DEPOSITO' }),
        ],
      })],
      clients: [],
      providers: [],
      cxpRecords: [],
      auxiliarReconLines: [
        auxLine({
          glKey: 'gl-egreso',
          cia: '00001',
          flujo: 'egreso',
          fechaContable: '2026-04-17',
          importe: -250,
          tipoDocto: 'PV',
          contraparte: 'PROVEEDOR X SA',
        }),
        auxLine({
          glKey: 'gl-interno',
          cia: '00001',
          flujo: 'egreso',
          fechaContable: '2026-04-18',
          importe: -900,
          tipoDocto: 'PV',
          matchTier: 'interno',
        }),
      ],
      assumptions,
      budget: null,
      startingBalance: 0,
      asOfDate: '2026-05-01',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildHistoricalReconciledMovements({ monthly, inputs });

    const filler = mv.find((m) => m.id === 'auxiliar-historic:gl-egreso');
    expect(filler).toBeTruthy();
    expect(filler!.type).toBe('OUTFLOW');
    expect(filler!.projectedAmount).toBe(250);
    expect(filler!.actualDate).toBe('2026-04-17');
    expect(filler!.status).toBe('REAL');
    // Traspaso intercompañía etiquetado por el motor de conciliación → fuera.
    expect(mv.some((m) => m.id === 'auxiliar-historic:gl-interno')).toBe(false);
  });
});

// ── Fixtures ─────────────────────────────────────────────────────────────

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

function auxLine(patch: {
  glKey: string;
  cia: string;
  flujo: AuxiliarReconLine['flujo'];
  fechaContable: string;
  importe: number;
  tipoDocto: string;
  bankKey?: string;
  matchTier?: AuxiliarReconLine['matchTier'];
  contraparte?: string;
}): AuxiliarReconLine {
  return {
    glKey: patch.glKey,
    cia: patch.cia,
    cuentaBanco: 'CTA-1',
    nombreCuenta: 'BANCO',
    cuentaContable: '00.1020.0000000',
    cuentaObjeto: '1020',
    idCuenta: '0',
    flujo: patch.flujo,
    esCaja: false,
    fechaContable: patch.fechaContable,
    importe: patch.importe,
    moneda: 'MXN',
    tipoDocto: patch.tipoDocto,
    tipoDoctoDesc: '',
    estatusConciliado: 'R',
    matchTier: patch.matchTier ?? 'exact',
    confidence: 1,
    bankMovementKey: patch.bankKey,
    source: { kind: 'otro', cia: patch.cia, ref: 'CH-123', contraparte: patch.contraparte ?? '' },
  };
}
