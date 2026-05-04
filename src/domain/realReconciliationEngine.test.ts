import { describe, expect, it } from 'vitest';
import { reconcileRealCollections } from './realReconciliationEngine';
import type {
  BankAccountStatement,
  BankStatementLine,
  CobranzaRecord,
} from '../services/jdeTypes';

// ── Builders defensivos ────────────────────────────────────────────────────

function makeFactura(p: Partial<CobranzaRecord> & Pick<CobranzaRecord, 'cia' | 'noFactura' | 'noCliente' | 'nombreCliente' | 'importeBrutoPesos'>): CobranzaRecord {
  return {
    fechaFactura: '2026-01-01',
    fechaVence: '2026-02-01',
    fechaCobro: '',
    diasVencida: 0,
    importePendientePesos: p.importePendientePesos ?? p.importeBrutoPesos,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30',
    estatus: 'PENDIENTE',
    tipoCambio: 1,
    ...p,
  };
}

function makeAbono(p: Partial<BankStatementLine> & Pick<BankStatementLine, 'cia' | 'cuenta' | 'fechaOperacion' | 'importe'>): BankStatementLine {
  return {
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    moneda: 'MXN',
    fechaValor: undefined,
    referencia: 'REF',
    concepto: '',
    tipoMovimiento: 'ABONO',
    saldo: undefined,
    ...p,
  };
}

function makeAccount(p: {
  cia: string;
  cuenta: string;
  movimientos: BankStatementLine[];
}): BankAccountStatement {
  return {
    cia: p.cia,
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    cuenta: p.cuenta,
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-02-15',
    saldoInicial: 0,
    saldoFinal: 0,
    movimientos: p.movimientos,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('reconcileRealCollections — match exacto (capa 1)', () => {
  it('cruza por número de factura en referencia bancaria', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'RI-85022',
      noCliente: 'C-7777',
      nombreCliente: 'CLIENTE ESPECIAL',
      importeBrutoPesos: 1155.44,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '12345',
      fechaOperacion: '2026-02-01',
      importe: 1155.44,
      referencia: 'PAGO RI-85022',
      concepto: 'TRANSFERENCIA SPEI',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '12345', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('cobrada-banco');
    expect(result.matches[0].matchTier).toBe('invoice-reference');
    expect(result.matches[0].matchReason).toMatch(/factura RI-85022/i);
  });

  it('cruza una factura con un ABONO al céntimo dentro de ventana', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-100',
      noCliente: 'C-9001',
      nombreCliente: 'CONSTRUCTORA NORTE',
      importeBrutoPesos: 116000,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '12345',
      fechaOperacion: '2026-02-05', // 4 días post-vencimiento
      importe: 116000,
      concepto: 'PAGO CONSTRUCTORA NORTE',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '12345', movimientos: [abono] })],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].status).toBe('cobrada-banco');
    expect(result.matches[0].matchTier).toBe('customer-reference');
    expect(result.matches[0].bankAmount).toBe(116000);
    expect(result.summary.pctAbonosCruzados).toBe(1);
  });

  it('respeta cia — factura cia=00011 no cruza con ABONO cia=00038', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-100',
      noCliente: 'C-9001',
      nombreCliente: 'ALFA NORTE',
      importeBrutoPesos: 50000,
    });
    const abono = makeAbono({
      cia: '00038',
      cuenta: '999',
      fechaOperacion: '2026-02-01',
      importe: 50000,
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00038', cuenta: '999', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('pendiente');
    expect(result.summary.abonosSinFactura).toBe(1);
  });

  it('respeta moneda — factura MXN no cruza con ABONO USD', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-USD',
      noCliente: 'C-1',
      nombreCliente: 'CLIENTE',
      moneda: 'MXN',
      importeBrutoPesos: 100,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '1',
      fechaOperacion: '2026-02-01',
      importe: 100,
      moneda: 'USD',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('pendiente');
  });
});

describe('reconcileRealCollections — match con tolerancia (capa 2)', () => {
  it('cruza con diferencia de 0.3% (comisión bancaria)', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-200',
      noCliente: 'C-9001',
      nombreCliente: 'ALFA NORTE',
      importeBrutoPesos: 100000,
    });
    // ABONO llega 0.3% menor por comisión SPEI.
    const abono = makeAbono({
      cia: '00011',
      cuenta: '1',
      fechaOperacion: '2026-02-01',
      importe: 99700,
      concepto: 'PAGO ALFA NORTE',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('cobrada-banco');
    expect(result.matches[0].matchTier).toBe('customer-reference');
  });

  it('deja un match de solo monto/fecha en revisión, no como cobro automático', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-REV',
      noCliente: 'C-1',
      nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100000,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '1',
      fechaOperacion: '2026-02-01',
      importe: 100000,
      concepto: 'TRANSFERENCIA SPEI',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('pendiente');
    expect(result.matches[0].reviewStatus).toBe('review');
    expect(result.reviewCandidates).toHaveLength(1);
    expect(result.summary.abonosFacturaCobrada).toBe(0);
  });

  it('no cruza cuando la diferencia rebasa 0.5%', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-200',
      noCliente: 'C-1',
      nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100000,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '1',
      fechaOperacion: '2026-02-01',
      importe: 95000, // 5% menor
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('pendiente');
  });
});

describe('reconcileRealCollections — subset-sum (capa 3)', () => {
  it('cruza un ABONO grande con 2 facturas del mismo cliente', () => {
    const f1 = makeFactura({
      cia: '00011',
      noFactura: 'F-A',
      noCliente: 'C-9001',
      nombreCliente: 'GRUPO ALTAMIRA',
      importeBrutoPesos: 200000,
    });
    const f2 = makeFactura({
      cia: '00011',
      noFactura: 'F-B',
      noCliente: 'C-9001',
      nombreCliente: 'GRUPO ALTAMIRA',
      importeBrutoPesos: 187234.55,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '1',
      fechaOperacion: '2026-02-01',
      importe: 387234.55,
      concepto: 'TRANSFERENCIA GRUPO ALTAMIRA SPEI',
    });
    const result = reconcileRealCollections(
      [f1, f2],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    const cobradas = result.matches.filter(m => m.status === 'cobrada-banco');
    expect(cobradas).toHaveLength(2);
    expect(cobradas[0].matchTier).toBe('subset');
    expect(cobradas[1].matchTier).toBe('subset');
    expect(cobradas[0].subsetGroupId).toBe(cobradas[1].subsetGroupId);
    expect(cobradas[0].subsetSize).toBe(2);
  });

  it('NO entra a subset si el ABONO no menciona al cliente (riesgo de falso positivo)', () => {
    const f1 = makeFactura({
      cia: '00011',
      noFactura: 'F-A',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE A',
      importeBrutoPesos: 100,
    });
    const f2 = makeFactura({
      cia: '00011',
      noFactura: 'F-B',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE A',
      importeBrutoPesos: 200,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '1',
      fechaOperacion: '2026-02-01',
      importe: 300,
      concepto: 'TRANSFERENCIA SPEI', // no menciona cliente
    });
    const result = reconcileRealCollections(
      [f1, f2],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    const cobradas = result.matches.filter(m => m.status === 'cobrada-banco');
    expect(cobradas).toHaveLength(0);
  });
});

describe('reconcileRealCollections — multi-abono', () => {
  it('cruza varios ABONOs del mismo cliente contra una factura', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-MULTI',
      noCliente: 'C-9001',
      nombreCliente: 'ALFA NORTE',
      importeBrutoPesos: 300000,
    });
    const a1 = makeAbono({
      cia: '00011',
      cuenta: '1',
      fechaOperacion: '2026-02-01',
      importe: 120000,
      concepto: 'PAGO ALFA NORTE',
      referencia: 'A1',
    });
    const a2 = makeAbono({
      cia: '00011',
      cuenta: '1',
      fechaOperacion: '2026-02-02',
      importe: 180000,
      concepto: 'PAGO ALFA NORTE',
      referencia: 'A2',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [a1, a2] })],
    );
    expect(result.matches[0].status).toBe('cobrada-banco');
    expect(result.matches[0].matchTier).toBe('multi-abono');
    expect(result.matches[0].bankMovements).toHaveLength(2);
    expect(result.summary.abonosFacturaCobrada).toBe(2);
  });
});

describe('reconcileRealCollections — sin match', () => {
  it('excluye ABONOs que son traspasos internos pareados CARGO/ABONO entre cuentas propias', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-INTERNA',
      noCliente: 'C-1',
      nombreCliente: 'CLIENTE',
      importeBrutoPesos: 3000000,
    });
    const cargo = makeAbono({
      cia: '00011',
      cuenta: '0190000001',
      fechaOperacion: '2026-02-01',
      importe: 3000000,
      tipoMovimiento: 'CARGO',
      concepto: 'MOVIMIENTO ENTRE CUENTAS',
      referencia: 'T-1',
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '0190000002',
      fechaOperacion: '2026-02-01',
      importe: 3000000,
      concepto: 'MOVIMIENTO ENTRE CUENTAS',
      referencia: 'T-2',
    });

    const result = reconcileRealCollections(
      [factura],
      [
        makeAccount({ cia: '00011', cuenta: '0190000001', movimientos: [cargo] }),
        makeAccount({ cia: '00011', cuenta: '0190000002', movimientos: [abono] }),
      ],
    );

    expect(result.summary.totalAbonos).toBe(0);
    expect(result.summary.abonosTraspasoInterno).toBe(1);
    expect(result.matches[0].status).toBe('pendiente');
  });

  it('factura sin ABONO queda pendiente', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-1',
      noCliente: 'C-1',
      nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100,
    });
    const result = reconcileRealCollections([factura], []);
    expect(result.matches[0].status).toBe('pendiente');
    expect(result.summary.facturasCobradasBanco).toBe(0);
    expect(result.bankCoverage.loadedDates).toHaveLength(0);
  });

  it('factura ya cobrada en JDE (pendiente=0) sin abono se marca cobrada-jde-sin-banco', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-1',
      noCliente: 'C-1',
      nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100,
      importePendientePesos: 0,
    });
    const result = reconcileRealCollections([factura], []);
    expect(result.matches[0].status).toBe('cobrada-jde-sin-banco');
  });

  it('ABONO de un cliente sin facturas se marca cobranza-sin-factura', () => {
    const abono = makeAbono({
      cia: '00011',
      cuenta: '1',
      fechaOperacion: '2026-02-01',
      importe: 50000,
    });
    const result = reconcileRealCollections(
      [],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.abonoEnrichments[0].status).toBe('cobranza-sin-factura');
    expect(result.summary.abonosSinFactura).toBe(1);
  });
});

describe('reconcileRealCollections — KPIs', () => {
  it('% facturas cruzadas y % abonos cruzados calculan correctamente', () => {
    const facturas: CobranzaRecord[] = [
      makeFactura({ cia: '00011', noFactura: 'F-1', noCliente: 'C-1001', nombreCliente: 'ALFA NORTE', importeBrutoPesos: 100 }),
      makeFactura({ cia: '00011', noFactura: 'F-2', noCliente: 'C-2002', nombreCliente: 'BETA SUR', importeBrutoPesos: 200 }),
    ];
    const abonos = [
      makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 100, concepto: 'PAGO ALFA NORTE' }),
      makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '2026-02-02', importe: 999 }),
    ];
    const result = reconcileRealCollections(
      facturas,
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: abonos })],
    );
    // 1 de 2 facturas cruzadas = 50%
    expect(result.summary.pctFacturasCruzadas).toBeCloseTo(0.5);
    // 1 de 2 abonos cruzados = 50%
    expect(result.summary.pctAbonosCruzados).toBeCloseTo(0.5);
  });
});

describe('reconcileRealCollections — orden cronológico previene robo de match', () => {
  it('ABONO viejo se queda con su match aunque haya otro reciente del mismo monto', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-1',
      noCliente: 'C-9001',
      nombreCliente: 'ALFA NORTE',
      fechaVence: '2026-01-15',
      importeBrutoPesos: 50000,
    });
    const abonoViejo = makeAbono({
      cia: '00011',
      cuenta: '1',
      fechaOperacion: '2026-01-20', // dentro de ventana
      importe: 50000,
      concepto: 'PAGO ALFA NORTE',
      referencia: 'OLD',
    });
    const abonoReciente = makeAbono({
      cia: '00011',
      cuenta: '1',
      fechaOperacion: '2026-02-15',
      importe: 50000,
      concepto: 'PAGO ALFA NORTE',
      referencia: 'NEW',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abonoReciente, abonoViejo] })],
    );
    // El viejo debe quedarse con la factura
    expect(result.matches[0].bankRef).toBe('OLD');
  });
});

describe('reconcileRealCollections — performance indexada', () => {
  it('procesa un dataset sintético grande con métricas de timing', () => {
    const facturas: CobranzaRecord[] = [];
    const movimientos: BankStatementLine[] = [];
    for (let i = 0; i < 300; i++) {
      const noFactura = `RI-${String(80000 + i)}`;
      facturas.push(makeFactura({
        cia: '00011',
        noFactura,
        noCliente: `C-${90000 + i}`,
        nombreCliente: `CLIENTE PERF ${i}`,
        fechaVence: '2026-02-01',
        importeBrutoPesos: 1000 + i,
      }));
      movimientos.push(makeAbono({
        cia: '00011',
        cuenta: '1',
        fechaOperacion: '2026-02-02',
        importe: 1000 + i,
        referencia: `PAGO ${noFactura}`,
      }));
    }
    const result = reconcileRealCollections(
      facturas,
      [makeAccount({ cia: '00011', cuenta: '1', movimientos })],
    );
    expect(result.summary.facturasCobradasBanco).toBe(300);
    expect(result.timingsMs.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.bankCoverage.totalAbonos).toBe(300);
  });
});
