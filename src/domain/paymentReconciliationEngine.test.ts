import { describe, it, expect } from 'vitest';
import { reconcilePayments } from './paymentReconciliationEngine';
import type { PagoProveedorRecord, BankAccountStatement, BankStatementLine } from '../services/jdeTypes';
import type { CXPRecord } from './persistence';

function pago(overrides: Partial<PagoProveedorRecord> = {}): PagoProveedorRecord {
  return {
    tipoPago: 'PT',
    noPago: '393866',
    cia: '00038',
    nombreCia: 'SERVICIOS T DE N',
    cuentaBancaria: '38.1020.0010405 - BANAMEX - 7013 8708851',
    cuentaBanco: '70138708851',
    fechaPago: '2026-05-04',
    importePesos: 8695,
    moneda: 'MXP',
    batchPago: '84523896',
    claveProveedor: '3228',
    rfcProveedor: 'LEAM720824M35',
    nombreProveedor: 'MARCO ANTONIO LERMA ALDAPE',
    tipoBusqueda: 'Suppliers',
    clasificacionProveedor: 'Servicios',
    clasificacionProveedorFinanciera: '220 - Por Clasificar',
    comentarioPago: 'FL CXP-VALE21829',
    ...overrides,
  };
}

function cxp(overrides: Partial<CXPRecord> = {}): CXPRecord {
  return {
    cia: '00038',
    noProveedor: '3228',
    nombre: 'MARCO ANTONIO LERMA ALDAPE',
    noFactura: 'VALE21829',
    fechaFactura: '2026-04-01',
    fechaVence: '2026-04-30',
    fechaProgramacionPago: '2026-05-01',
    diasVencida: 0,
    importeBrutoPesos: 8695,
    importePendientePesos: 8695,
    importeSubtotalPesos: 7495,
    importeImpuestosPesos: 1200,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXP',
    condPago: '30',
    clasifica: '',
    clasificacionProveedor: '',
    edoPago: 'A',
    tipoCambio: 1,
    porVencer: 0,
    v1_30: 0, v31_60: 0, v61_90: 0, v91_120: 0, v121_150: 0, v151_180: 0, mas180: 0,
    ...overrides,
  };
}

function cargo(overrides: Partial<BankStatementLine> = {}): BankStatementLine {
  return {
    cia: '00038',
    banco: 'BANAMEX',
    cuenta: '70138708851',
    moneda: 'MXN',
    fechaOperacion: '2026-05-04',
    referencia: 'REF123',
    concepto: 'PAGO PROVEEDOR',
    tipoMovimiento: 'CARGO',
    importe: 8695,
    ...overrides,
  };
}

function statement(movs: BankStatementLine[], overrides: Partial<BankAccountStatement> = {}): BankAccountStatement {
  return {
    cia: '00038',
    banco: 'BANAMEX',
    cuenta: '70138708851',
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-05-04',
    movimientos: movs,
    ...overrides,
  };
}

describe('reconcilePayments — CXP matching', () => {
  it('matches CXP via folio embedded in comentarioPago (tier folio-exact)', () => {
    const result = reconcilePayments({
      payments: [pago({ comentarioPago: 'FL CXP-VALE21829' })],
      cxpRecords: [cxp()],
      bankStatements: [],
    });
    expect(result.paymentMatches).toHaveLength(1);
    expect(result.paymentMatches[0].cxpMatches).toHaveLength(1);
    expect(result.paymentMatches[0].cxpMatches[0].tier).toBe('folio-exact');
    expect(result.paymentMatches[0].status).toBe('MATCHED_CXP_ONLY');
  });

  it('matches CXP via exact amount when no folio in comment', () => {
    const result = reconcilePayments({
      payments: [pago({ comentarioPago: 'Pago general' })],
      cxpRecords: [cxp()],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches[0].tier).toBe('invoice-amount');
  });

  it('matches CXP via tolerance amount (±0.5%)', () => {
    const result = reconcilePayments({
      payments: [pago({ importePesos: 8730, comentarioPago: 'sin folio' })],
      cxpRecords: [cxp({ importeBrutoPesos: 8695, importePendientePesos: 8695 })],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches[0].tier).toBe('amount-tolerance');
  });

  it('matches subset-sum (1 pago = N facturas) when no single match works', () => {
    const result = reconcilePayments({
      payments: [pago({ importePesos: 1500, comentarioPago: 'misc' })],
      cxpRecords: [
        cxp({ noFactura: 'A', importeBrutoPesos: 500, importePendientePesos: 500 }),
        cxp({ noFactura: 'B', importeBrutoPesos: 500, importePendientePesos: 500 }),
        cxp({ noFactura: 'C', importeBrutoPesos: 500, importePendientePesos: 500 }),
      ],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches.length).toBeGreaterThanOrEqual(2);
    expect(result.paymentMatches[0].cxpMatches[0].tier).toBe('subset-sum');
  });

  it('skips CXP matching for employee payments (tipoBusqueda)', () => {
    const result = reconcilePayments({
      payments: [pago({ tipoBusqueda: 'Employees' })],
      cxpRecords: [cxp()],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches).toHaveLength(0);
  });

  it('UNMATCHED status when no CXP and no CARGO', () => {
    const result = reconcilePayments({
      payments: [pago({ claveProveedor: '99999', comentarioPago: 'unknown' })],
      cxpRecords: [cxp()],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].status).toBe('UNMATCHED');
  });

  it('excludes already-claimed CXP (one CXP cannot match two payments)', () => {
    const result = reconcilePayments({
      payments: [pago({ noPago: '1' }), pago({ noPago: '2' })],
      cxpRecords: [cxp()],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches).toHaveLength(1);
    expect(result.paymentMatches[1].cxpMatches).toHaveLength(0);
  });
});

describe('reconcilePayments — CARGO matching', () => {
  it('matches CARGO exact (cuenta + fecha + monto)', () => {
    const result = reconcilePayments({
      payments: [pago()],
      cxpRecords: [],
      bankStatements: [statement([cargo()])],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('exact');
    expect(result.paymentMatches[0].status).toBe('MATCHED_BANK_ONLY');
  });

  it('matches CARGO with date tolerance (±2 days)', () => {
    const result = reconcilePayments({
      payments: [pago({ fechaPago: '2026-05-04' })],
      cxpRecords: [],
      bankStatements: [statement([cargo({ fechaOperacion: '2026-05-06' })])],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('tolerance');
  });

  it('matches CARGO from a different account via cross-account tier', () => {
    // El registro de pago nombra una cuenta, pero el CARGO salió de otra
    // (patrón de cuentas concentradoras). 2a pasada lo caza.
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '111111111' })],
      cxpRecords: [],
      bankStatements: [statement([cargo()], { cuenta: '70138708851' })],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('cross-account');
    expect(result.paymentMatches[0].status).toBe('MATCHED_BANK_ONLY');
  });

  it('cross-account does NOT match when dates are far apart', () => {
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '111111111', fechaPago: '2026-05-04' })],
      cxpRecords: [],
      bankStatements: [statement([cargo({ fechaOperacion: '2026-03-01' })], { cuenta: '70138708851' })],
    });
    expect(result.paymentMatches[0].cargoMatch).toBeUndefined();
  });

  it('matches a split payment via cargo subset (tier subset)', () => {
    // Un pago dispersado en 2 CARGOs de la misma cuenta que suman el importe.
    const result = reconcilePayments({
      payments: [pago({ importePesos: 10000, cuentaBanco: '70138708851' })],
      cxpRecords: [],
      bankStatements: [statement([
        cargo({ importe: 6000, fechaOperacion: '2026-05-04', referencia: 'SPLIT-A' }),
        cargo({ importe: 4000, fechaOperacion: '2026-05-05', referencia: 'SPLIT-B' }),
      ])],
    });
    const cm = result.paymentMatches[0].cargoMatch;
    expect(cm?.tier).toBe('subset');
    expect(cm?.extraMovements?.length).toBe(1);
    expect(result.paymentMatches[0].status).toBe('MATCHED_BANK_ONLY');
  });

  it('marks unclaimed CARGOs as ORPHAN', () => {
    const result = reconcilePayments({
      payments: [],
      cxpRecords: [],
      bankStatements: [statement([cargo()])],
    });
    expect(result.cargoEnrichments.size).toBe(1);
    const orphan = Array.from(result.cargoEnrichments.values())[0];
    expect(orphan.status).toBe('ORPHAN');
  });

  it('ABONO movements are NOT considered for matching', () => {
    const result = reconcilePayments({
      payments: [pago()],
      cxpRecords: [],
      bankStatements: [statement([{ ...cargo(), tipoMovimiento: 'ABONO' }])],
    });
    expect(result.paymentMatches[0].cargoMatch).toBeUndefined();
    expect(result.cargoEnrichments.size).toBe(0);
  });

  it('marks payments that match internal CARGOs and excludes those cargos from enrichment', () => {
    const result = reconcilePayments({
      payments: [pago()],
      cxpRecords: [],
      bankStatements: [statement([cargo({ concepto: 'TRASPASO REF 123' })])],
    });

    expect(result.internalPaymentKeys.has('00038::393866')).toBe(true);
    expect(result.paymentMatches[0].cargoMatch).toBeUndefined();
    expect(result.cargoEnrichments.size).toBe(0);
    expect(result.totals.internalPayments).toBe(1);
    expect(result.totals.totalPaidPesos).toBe(0);
    expect(result.totals.totalInternalPesos).toBe(8695);
  });

  it('treats pair-matched CARGO/ABONO transfers as internal, not provider payments', () => {
    const internalCargo = cargo({
      importe: 5000,
      concepto: 'Movimiento interno salida',
      referencia: 'INT-1',
      cuenta: '70138708851',
    });
    const internalAbono: BankStatementLine = {
      ...cargo({
        tipoMovimiento: 'ABONO',
        importe: 5000,
        concepto: 'Movimiento interno entrada',
        referencia: 'INT-2',
        cuenta: '22222222222',
      }),
    };

    const result = reconcilePayments({
      payments: [pago({ importePesos: 5000 })],
      cxpRecords: [],
      bankStatements: [
        statement([internalCargo]),
        statement([internalAbono], { cuenta: '22222222222' }),
      ],
    });

    expect(result.internalPaymentKeys.has('00038::393866')).toBe(true);
    expect(result.paymentMatches[0].cargoMatch).toBeUndefined();
    expect(result.cargoEnrichments.size).toBe(0);
    expect(result.totals.internalPayments).toBe(1);
  });
});

describe('reconcilePayments — full integration', () => {
  it('MATCHED_FULL when both CXP and CARGO match', () => {
    const result = reconcilePayments({
      payments: [pago()],
      cxpRecords: [cxp()],
      bankStatements: [statement([cargo()])],
    });
    expect(result.paymentMatches[0].status).toBe('MATCHED_FULL');
    expect(result.totals.matchedFull).toBe(1);
  });

  it('computes CXP coverage status PAID when payment covers full amount', () => {
    const result = reconcilePayments({
      payments: [pago()],
      cxpRecords: [cxp()],
      bankStatements: [],
    });
    const cov = result.cxpCoverage.get('00038::VALE21829::3228');
    expect(cov?.status).toBe('PAID');
  });

  it('totals reflect counts correctly', () => {
    const result = reconcilePayments({
      payments: [
        pago({ noPago: 'A' }),
        pago({ noPago: 'B', claveProveedor: 'X', comentarioPago: 'unknown', importePesos: 999 }),
      ],
      cxpRecords: [cxp()],
      bankStatements: [],
    });
    expect(result.totals.payments).toBe(2);
    expect(result.totals.matchedCxp).toBe(1);
    expect(result.totals.unmatched).toBe(1);
  });

  it('PROJECTED-style CXP keys exclude paid CXPs (PARTIAL stays open)', () => {
    const result = reconcilePayments({
      payments: [pago({ importePesos: 4000 })], // 4000 of 8695 = ~46%
      cxpRecords: [cxp()],
      bankStatements: [],
    });
    const cov = result.cxpCoverage.get('00038::VALE21829::3228');
    expect(cov?.status).toBe('PARTIAL');
  });
});
