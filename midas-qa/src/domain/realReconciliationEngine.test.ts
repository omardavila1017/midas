import { describe, expect, it } from 'vitest';
import { reconcileRealCollections } from './realReconciliationEngine';
import type {
  BankAccountStatement,
  BankStatementLine,
  CobranzaPayment,
  CobranzaPaymentApplication,
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

function makePayment(p: Partial<CobranzaPayment> & Pick<CobranzaPayment, 'idPago' | 'cia' | 'fechaCobro' | 'cuentaBancaria' | 'noRecibo' | 'importeRecibo'>): CobranzaPayment {
  return {
    fechaContable: p.fechaContable ?? p.fechaCobro,
    banco: p.banco ?? 'BANAMEX',
    pendienteAplicar: p.pendienteAplicar ?? 0,
    noCliente: p.noCliente ?? 'C-9001',
    cliente: p.cliente ?? 'CLIENTE',
    noBatch: p.noBatch ?? 'B-1',
    tipoCambio: p.tipoCambio ?? 1,
    applications: p.applications ?? [],
    ...p,
  };
}

function makeApplication(p: Partial<CobranzaPaymentApplication> & Pick<CobranzaPaymentApplication, 'idPago' | 'cia' | 'noFactura' | 'importeCobrado'>): CobranzaPaymentApplication {
  return {
    fechaAplicacion: p.fechaAplicacion ?? '2026-02-01',
    noCliente: p.noCliente ?? 'C-9001',
    cliente: p.cliente ?? 'CLIENTE',
    tipoDocto: p.tipoDocto ?? 'RI',
    noFacturaNormalizada: p.noFacturaNormalizada ?? p.noFactura.toUpperCase().replace(/\s*-\s*/g, '-').replace(/\s+/g, ''),
    fechaFactura: p.fechaFactura ?? '2026-01-01',
    fechaVencimiento: p.fechaVencimiento ?? '2026-02-01',
    diasAntiguedadFafv: p.diasAntiguedadFafv ?? 0,
    importeOriginalFactura: p.importeOriginalFactura ?? p.importeCobrado,
    importePteFactura: p.importePteFactura ?? 0,
    tasaIva: p.tasaIva ?? 'IVA16',
    importeIvaFacturaOriginal: p.importeIvaFacturaOriginal ?? 0,
    ...p,
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

  it('auto-confirma un match de monto exacto/fecha incluso sin identidad de cliente', () => {
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
    expect(result.matches[0].status).toBe('cobrada-banco');
    expect(result.matches[0].reviewStatus).toBe('auto');
    expect(result.matches[0].matchTier).toBe('exact');
    expect(result.summary.abonosFacturaCobrada).toBe(1);
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

describe('reconcileRealCollections — IndicadoresCobranza', () => {
  it('cruza banco → recibo por cuenta, fecha, importe y No Recibo; después distribuye a 2 facturas', () => {
    const f1 = makeFactura({
      cia: '00011',
      noFactura: 'RI-90829',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 1160,
    });
    const f2 = makeFactura({
      cia: '00011',
      noFactura: 'RI-90830',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 580,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '000123',
      cuentaContable: '11.1020.0011302',
      fechaOperacion: '2026-02-10',
      importe: 1740,
      referencia: 'SPEI',
      infAdi1: 'PAGO RECIBO RI-90829',
    });
    const payment = makePayment({
      idPago: 'PAY-1',
      cia: '00011',
      fechaCobro: '2026-02-10',
      cuentaBancaria: '11.1020.0011302',
      noRecibo: 'RI - 90829',
      importeRecibo: 1740,
      applications: [
        makeApplication({ idPago: 'PAY-1', cia: '00011', noFactura: 'RI - 90829', importeCobrado: 1160 }),
        makeApplication({ idPago: 'PAY-1', cia: '00011', noFactura: 'RI-90830', importeCobrado: 580 }),
      ],
    });

    const result = reconcileRealCollections(
      [f1, f2],
      [makeAccount({ cia: '00011', cuenta: '000123', movimientos: [abono] })],
      { cobranzaPayments: [payment] },
    );

    expect(result.matches).toHaveLength(2);
    expect(result.matches.every(match => match.status === 'cobrada-banco')).toBe(true);
    expect(result.matches.every(match => match.matchTier === 'payment-confirmed-ref')).toBe(true);
    expect(result.matches.every(match => match.paymentMatchStatus === 'CONFIRMED_REF')).toBe(true);
    expect(result.matches.map(match => match.idPago)).toEqual(['PAY-1', 'PAY-1']);
    expect(result.abonoEnrichments[0]).toMatchObject({
      status: 'factura-cobrada',
      matchTier: 'payment-confirmed-ref',
      idPago: 'PAY-1',
      noRecibo: 'RI - 90829',
      paymentMatchStatus: 'CONFIRMED_REF',
    });
    expect(result.abonoEnrichments[0].facturas).toHaveLength(2);
    expect(result.summary.totalPagosIndicadores).toBe(1);
    expect(result.summary.pagosConciliadosBanco).toBe(1);
    expect(result.summary.pagosMultiFactura).toBe(1);
    expect(result.summary.montoPagosMultiFacturaConciliado).toBe(1740);
    expect(result.paymentReconciliations[0]).toMatchObject({
      idPago: 'PAY-1',
      noRecibo: 'RI - 90829',
      status: 'CONFIRMED_REF',
      applicationCount: 2,
      importeAplicado: 1740,
    });
    expect(result.paymentReconciliations[0].bankMovement?.referencia).toBe('SPEI');
  });

  it('cruza automáticamente cuando cuenta, fecha e importe identifican un único Id Pago aunque el banco no traiga No Recibo', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'RI-100',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 1000,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '000123',
      cuentaContable: '11.1020.0011302',
      fechaOperacion: '2026-02-10',
      importe: 1000,
      concepto: 'TRANSFERENCIA SPEI',
    });
    const payment = makePayment({
      idPago: 'PAY-UNIQUE',
      cia: '00011',
      fechaCobro: '2026-02-10',
      cuentaBancaria: '11.1020.0011302',
      noRecibo: 'RI-100',
      importeRecibo: 1000,
      applications: [
        makeApplication({ idPago: 'PAY-UNIQUE', cia: '00011', noFactura: 'RI-100', importeCobrado: 1000 }),
      ],
    });

    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '000123', movimientos: [abono] })],
      { cobranzaPayments: [payment] },
    );

    expect(result.matches[0].status).toBe('cobrada-banco');
    expect(result.matches[0].matchTier).toBe('payment-auto-unique');
    expect(result.matches[0].paymentMatchStatus).toBe('AUTO_UNIQUE');
    expect(result.abonoEnrichments[0].paymentMatchStatus).toBe('AUTO_UNIQUE');
    expect(result.paymentReconciliations[0].status).toBe('AUTO_UNIQUE');
  });

  it('cruza automáticamente cuando Indicadores usa Cuenta_Bancos en vez de Cuenta_Contable', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'RI-BANCO',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 1000,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '999999',
      cuentaContable: '11.1020.0011302',
      cuentaBancos: '000123',
      fechaOperacion: '2026-02-10',
      importe: 1000,
      concepto: 'TRANSFERENCIA SPEI',
    });
    const payment = makePayment({
      idPago: 'PAY-CUENTA-BANCOS',
      cia: '00011',
      fechaCobro: '2026-02-10',
      cuentaBancaria: '000123',
      noRecibo: 'RI-BANCO',
      importeRecibo: 1000,
      applications: [
        makeApplication({ idPago: 'PAY-CUENTA-BANCOS', cia: '00011', noFactura: 'RI-BANCO', importeCobrado: 1000 }),
      ],
    });

    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '999999', movimientos: [abono] })],
      { cobranzaPayments: [payment] },
    );

    expect(result.matches[0]).toMatchObject({
      status: 'cobrada-banco',
      matchTier: 'payment-auto-unique',
      paymentMatchStatus: 'AUTO_UNIQUE',
      idPago: 'PAY-CUENTA-BANCOS',
    });
    expect(result.paymentReconciliations[0].status).toBe('AUTO_UNIQUE');
  });

  it('cruza por No_Recibo bancario aunque referencia y concepto no mencionen el recibo', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'RI-555',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 1000,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '000123',
      fechaOperacion: '2026-02-12',
      importe: 1000,
      referencia: 'SPEI',
      concepto: 'TRANSFERENCIA CLIENTE',
      noRecibo: 'RI-555',
    });
    const payment = makePayment({
      idPago: 'PAY-NORECIBO',
      cia: '00011',
      fechaCobro: '2026-02-10',
      cuentaBancaria: '11.1020.0011302',
      noRecibo: 'RI - 555',
      importeRecibo: 1000,
      applications: [
        makeApplication({ idPago: 'PAY-NORECIBO', cia: '00011', noFactura: 'RI-555', importeCobrado: 1000 }),
      ],
    });

    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '000123', movimientos: [abono] })],
      { cobranzaPayments: [payment] },
    );

    expect(result.matches[0]).toMatchObject({
      status: 'cobrada-banco',
      matchTier: 'payment-confirmed-ref',
      idPago: 'PAY-NORECIBO',
      paymentMatchStatus: 'CONFIRMED_REF',
    });
    expect(result.paymentReconciliations[0].bankMovement?.noRecibo).toBe('RI-555');
    expect(result.paymentReconciliations[0].matchReason).toMatch(/No_Recibo bancario RI-555/);
  });

  it('usa No_Recibo bancario para desambiguar dos Id Pago con la misma cuenta, fecha e importe', () => {
    const f1 = makeFactura({
      cia: '00011',
      noFactura: 'RI-101',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 1000,
    });
    const f2 = makeFactura({
      cia: '00011',
      noFactura: 'RI-102',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 1000,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '000123',
      cuentaContable: '11.1020.0011302',
      fechaOperacion: '2026-02-10',
      importe: 1000,
      noRecibo: 'RI-102',
      concepto: 'TRANSFERENCIA SPEI',
    });
    const payments = [
      makePayment({
        idPago: 'PAY-A',
        cia: '00011',
        fechaCobro: '2026-02-10',
        cuentaBancaria: '11.1020.0011302',
        noRecibo: 'RI-101',
        importeRecibo: 1000,
        applications: [
          makeApplication({ idPago: 'PAY-A', cia: '00011', noFactura: 'RI-101', importeCobrado: 1000 }),
        ],
      }),
      makePayment({
        idPago: 'PAY-B',
        cia: '00011',
        fechaCobro: '2026-02-10',
        cuentaBancaria: '11.1020.0011302',
        noRecibo: 'RI-102',
        importeRecibo: 1000,
        applications: [
          makeApplication({ idPago: 'PAY-B', cia: '00011', noFactura: 'RI-102', importeCobrado: 1000 }),
        ],
      }),
    ];

    const result = reconcileRealCollections(
      [f1, f2],
      [makeAccount({ cia: '00011', cuenta: '000123', movimientos: [abono] })],
      { cobranzaPayments: payments },
    );

    expect(result.matches.find(match => match.noFactura === 'RI-101')?.status).toBe('pendiente');
    expect(result.matches.find(match => match.noFactura === 'RI-102')).toMatchObject({
      status: 'cobrada-banco',
      idPago: 'PAY-B',
      paymentMatchStatus: 'CONFIRMED_REF',
    });
    expect(result.paymentReconciliations.map(payment => [payment.idPago, payment.status])).toEqual([
      ['PAY-A', 'UNMATCHED'],
      ['PAY-B', 'CONFIRMED_REF'],
    ]);
  });

  it('usa importe para elegir un único Id Pago cuando varios comparten el mismo No_Recibo', () => {
    const f1 = makeFactura({
      cia: '00011',
      noFactura: 'RI-201',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 1000,
    });
    const f2 = makeFactura({
      cia: '00011',
      noFactura: 'RI-202',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 1200,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '000123',
      fechaOperacion: '2026-02-10',
      importe: 1200,
      noRecibo: '339563',
      concepto: 'TRANSFERENCIA SPEI',
    });
    const payments = [
      makePayment({
        idPago: 'PAY-OLD',
        cia: '00011',
        fechaCobro: '2026-02-09',
        cuentaBancaria: '11.1020.0011302',
        noRecibo: '339563',
        importeRecibo: 1000,
        applications: [
          makeApplication({ idPago: 'PAY-OLD', cia: '00011', noFactura: 'RI-201', importeCobrado: 1000 }),
        ],
      }),
      makePayment({
        idPago: 'PAY-MATCH',
        cia: '00011',
        fechaCobro: '2026-02-10',
        cuentaBancaria: '11.1020.0011302',
        noRecibo: '339563',
        importeRecibo: 1200,
        applications: [
          makeApplication({ idPago: 'PAY-MATCH', cia: '00011', noFactura: 'RI-202', importeCobrado: 1200 }),
        ],
      }),
    ];

    const result = reconcileRealCollections(
      [f1, f2],
      [makeAccount({ cia: '00011', cuenta: '000123', movimientos: [abono] })],
      { cobranzaPayments: payments },
    );

    expect(result.matches.find(match => match.noFactura === 'RI-201')?.status).toBe('pendiente');
    expect(result.matches.find(match => match.noFactura === 'RI-202')).toMatchObject({
      status: 'cobrada-banco',
      idPago: 'PAY-MATCH',
      paymentMatchStatus: 'CONFIRMED_REF',
    });
  });

  it('deja ambiguo cuando No_Recibo bancario apunta a un recibo con importe distinto', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'RI-300',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 1000,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '000123',
      fechaOperacion: '2026-02-10',
      importe: 1000,
      noRecibo: 'RI-300',
      referencia: 'RI-300',
    });
    const payment = makePayment({
      idPago: 'PAY-MISMATCH',
      cia: '00011',
      fechaCobro: '2026-02-10',
      cuentaBancaria: '11.1020.0011302',
      noRecibo: 'RI-300',
      importeRecibo: 900,
      applications: [
        makeApplication({ idPago: 'PAY-MISMATCH', cia: '00011', noFactura: 'RI-300', importeCobrado: 900 }),
      ],
    });

    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '000123', movimientos: [abono] })],
      { cobranzaPayments: [payment] },
    );

    expect(result.matches[0].status).toBe('pendiente');
    expect(result.abonoEnrichments[0]).toMatchObject({
      status: 'cobranza-sin-factura',
      matchTier: 'payment-ambiguous',
      paymentMatchStatus: 'AMBIGUOUS',
    });
    expect(result.paymentReconciliations[0]).toMatchObject({
      idPago: 'PAY-MISMATCH',
      status: 'AMBIGUOUS',
    });
    expect(result.abonoEnrichments[0].matchReason).toMatch(/importe banco 1000 no coincide con recibo 900/);
  });

  it('deja en revisión cuando dos Id Pago tienen la misma cuenta, fecha e importe', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'RI-AMB',
      noCliente: 'C-9001',
      nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 1000,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '000123',
      cuentaContable: '11.1020.0011302',
      fechaOperacion: '2026-02-10',
      importe: 1000,
      concepto: 'TRANSFERENCIA SPEI',
    });
    const payments = [
      makePayment({
        idPago: 'PAY-A',
        cia: '00011',
        fechaCobro: '2026-02-10',
        cuentaBancaria: '11.1020.0011302',
        noRecibo: 'RI-101',
        importeRecibo: 1000,
        applications: [
          makeApplication({ idPago: 'PAY-A', cia: '00011', noFactura: 'RI-AMB', importeCobrado: 1000 }),
        ],
      }),
      makePayment({
        idPago: 'PAY-B',
        cia: '00011',
        fechaCobro: '2026-02-10',
        cuentaBancaria: '11.1020.0011302',
        noRecibo: 'RI-102',
        importeRecibo: 1000,
        applications: [
          makeApplication({ idPago: 'PAY-B', cia: '00011', noFactura: 'RI-AMB', importeCobrado: 1000 }),
        ],
      }),
    ];

    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '000123', movimientos: [abono] })],
      { cobranzaPayments: payments },
    );

    expect(result.matches[0].status).toBe('pendiente');
    expect(result.abonoEnrichments[0]).toMatchObject({
      status: 'cobranza-sin-factura',
      matchTier: 'payment-ambiguous',
      paymentMatchStatus: 'AMBIGUOUS',
    });
    expect(result.summary.pagosConciliadosBanco).toBe(0);
    expect(result.summary.pagosAmbiguos).toBe(2);
    expect(result.summary.pagosSinBanco).toBe(0);
    expect(result.paymentReconciliations.map(payment => payment.status)).toEqual(['AMBIGUOUS', 'AMBIGUOUS']);
  });

  it('expone pagos de Indicadores sin banco como UNMATCHED', () => {
    const payment = makePayment({
      idPago: 'PAY-NOBANK',
      cia: '00011',
      fechaCobro: '2026-02-10',
      cuentaBancaria: '11.1020.0011302',
      noRecibo: 'RI-404',
      importeRecibo: 1000,
      applications: [
        makeApplication({ idPago: 'PAY-NOBANK', cia: '00011', noFactura: 'RI-404', importeCobrado: 1000 }),
      ],
    });

    const result = reconcileRealCollections([], [], { cobranzaPayments: [payment] });

    expect(result.paymentReconciliations).toHaveLength(1);
    expect(result.paymentReconciliations[0]).toMatchObject({
      idPago: 'PAY-NOBANK',
      status: 'UNMATCHED',
      applicationCount: 1,
      importeAplicado: 1000,
    });
    expect(result.summary.pagosSinBanco).toBe(1);
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
