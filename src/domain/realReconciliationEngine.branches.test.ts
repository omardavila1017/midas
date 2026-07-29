/**
 * Cobertura de RAMAS del motor de conciliación real (Cobranza JDE ↔ ABONOs).
 *
 * Complemento de `realReconciliationEngine.test.ts`: aquel pinea los tiers de
 * negocio; éste ejercita los caminos defensivos y los desempates que no se
 * alcanzaban — fechas ilegibles/truncadas, moneda alterna (USD / vacía),
 * facturas sin objetivo de monto, recibos con tokens degenerados, `ciaFilter`,
 * el cruce por `No_recibo_Se_Pago_Factura`, la poda del subset-sum y la cola de
 * revisión. Todas las aserciones describen el comportamiento REAL observado —
 * no se tocó una línea del motor.
 *
 * Ramas documentadas como INALCANZABLES desde `reconcileRealCollections`
 * (no se testean a propósito):
 *   • `computeConfidence`, ramas de los tiers `payment-confirmed-ref`,
 *     `payment-auto-unique`, `payment-ambiguous` e `invoice-receipt-ref`:
 *     esos cruces asignan la confianza como literal y NUNCA llaman a
 *     `computeConfidence` (sólo la llaman invoice/customer/exact/tolerance,
 *     `subset` y `multi-abono`).
 *   • `nowMs` rama `Date.now()`: jsdom siempre define `performance`.
 *   • `indexKey` → `(moneda || 'MXN')`: todos los llamadores ya normalizan la
 *     moneda antes de pasarla, así que nunca llega vacía.
 *   • `groupByCobranzaReceipt` → `noReciboSePagoFactura ?? ''` y
 *     `applyCobranzaReceiptMatch` → `?? abono.noRecibo` / `if (!state)`: sólo
 *     entran facturas que YA venían indexadas por su recibo y por su llave.
 *   • `reviewCandidates` → `enrichment.matchReason ?? candidates[0].matchReason`:
 *     el bloque que puebla `candidateFacturas` también fija `matchReason`.
 *   • `evaluateTarget` → `mismaMoneda` sólo es alcanzable vía
 *     `targetsByFactura`/`targetsByCliente` (no scopeados por moneda); el
 *     camino por monto ya viene scopeado, así que ahí nunca falla. SÍ se
 *     cubre por el camino de identidad de cliente (ver test dedicado).
 *   • `trySubsetForCliente` → `facturasPorCliente.get(clienteKey) ?? []`:
 *     toda `clienteKey` proviene de una factura ya indexada.
 *   • `trySubsetForCliente` identificado → `result.confidence > bestSubset.confidence`:
 *     el piso `0.9` domina a `computeConfidence('subset', …)` (base 0.9 × factor
 *     ≤ 1), así que dos subsets identificados SIEMPRE empatan en 0.9.
 *   • Ranking `if (a.exact !== b.exact)`: exige empate EXACTO de confianza entre
 *     una evaluación exacta y una tolerada; los pisos/techos por tier
 *     (0.98/0.92/0.93/0.9/0.92/0.82) lo hacen no construible.
 *   • `totalCobradoBanco` → `m.bankAmount ?? 0`: todo status `cobrada-banco`
 *     asigna `bankAmount` numérico.
 *   • `ciaBreakdown` de matches → `ciaCounts.get(c) ?? {…}`: la cía de un match
 *     ya se contó en el recorrido de facturas.
 */
import { describe, expect, it } from 'vitest';
import { reconcileRealCollections } from './realReconciliationEngine';
import type {
  BankAccountStatement,
  BankStatementLine,
  CobranzaPayment,
  CobranzaPaymentApplication,
  CobranzaRecord,
} from '../services/jdeTypes';

// ── Builders (espejo de realReconciliationEngine.test.ts) ───────────────────

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
  /** Se deja vacía a propósito en los tests que ejercitan el default MXN. */
  moneda?: string;
}): BankAccountStatement {
  return {
    cia: p.cia,
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    cuenta: p.cuenta,
    moneda: p.moneda ?? 'MXN',
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
    tasaIva: p.tasaIva ?? 'IVA16',
    importeIvaFacturaOriginal: p.importeIvaFacturaOriginal ?? 0,
    ...p,
  };
}

// ── Fechas degradadas ──────────────────────────────────────────────────────

describe('reconcileRealCollections — fechas degradadas', () => {
  it('no cruza cuando el ABONO no trae fecha de operación', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'F-1', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100000,
    });
    const abono = makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '', importe: 100000 });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('pendiente');
  });

  it('no cruza con fechas truncadas (< 10 caracteres) en ambos lados', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'F-1', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100000, fechaVence: '2026-2-1',
    });
    const abono = makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '2026-2-1', importe: 100000 });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('pendiente');
  });

  it('no cruza cuando la fecha de vencimiento es ilegible', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'F-1', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100000, fechaVence: 'FECHA-MALISIMA',
    });
    const abono = makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 100000 });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('pendiente');
  });

  it('descarta un candidato de monto correcto pero fuera de la ventana de fecha', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'F-1', noCliente: '90011', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100000, fechaVence: '2026-02-01',
    });
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-08-01', importe: 100000,
      concepto: 'PAGO 90011',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('pendiente');
    expect(result.abonoEnrichments[0].status).toBe('cobranza-sin-factura');
  });
});

// ── Moneda ─────────────────────────────────────────────────────────────────

describe('reconcileRealCollections — moneda', () => {
  it('cruza una factura USD contra su ABONO USD usando los importes en dólares', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'F-USD', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      moneda: 'USD',
      importeBrutoPesos: 10000,
      importePendientePesos: 10000,
      importeBrutoDolares: 500,
      importePendienteDolares: 500,
    });
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 500, moneda: 'USD',
      concepto: 'TRANSFERENCIA SPEI',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('cobrada-banco');
    expect(result.matches[0].matchTier).toBe('exact');
  });

  it('trata la moneda vacía como MXN en factura y ABONO', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'F-1', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100000, moneda: '',
    });
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 100000,
      moneda: '', concepto: '', referencia: '',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', moneda: '', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('cobrada-banco');
  });

  it('respeta la ventana corta cuando la factura ya trae fecha de cobro del ERP', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'F-COBRO', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100000, fechaVence: '2026-02-01', fechaCobro: '2026-03-01',
    });
    // A 3 días de fechaCobro cruza (ventana ±5d)…
    const dentro = reconcileRealCollections(
      [factura],
      [makeAccount({
        cia: '00011', cuenta: '1',
        movimientos: [makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '2026-03-04', importe: 100000, concepto: 'TRANSFERENCIA SPEI' })],
      })],
    );
    expect(dentro.matches[0].status).toBe('cobrada-banco');
    // …pero a 20 días ya no, aunque siga dentro de los 60d de fechaVence.
    const fuera = reconcileRealCollections(
      [factura],
      [makeAccount({
        cia: '00011', cuenta: '1',
        movimientos: [makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '2026-03-21', importe: 100000, concepto: 'TRANSFERENCIA SPEI' })],
      })],
    );
    expect(fuera.matches[0].status).toBe('pendiente');
  });

  it('descarta un candidato del mismo cliente en OTRA moneda', () => {
    // El índice por cliente NO está scopeado por moneda: la factura USD del
    // mismo cliente llega a evaluarse y la rechaza el filtro de moneda.
    const mxn = makeFactura({
      cia: '00011', noFactura: 'F-MXN', noCliente: '90011', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100000,
    });
    const usd = makeFactura({
      cia: '00011', noFactura: 'F-USD', noCliente: '90011', nombreCliente: 'CLIENTE',
      moneda: 'USD',
      importeBrutoPesos: 100000,
      importeBrutoDolares: 100000,
      importePendienteDolares: 100000,
    });
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 100000,
      concepto: 'PAGO 90011',
    });
    const result = reconcileRealCollections(
      [mxn, usd],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches.find(m => m.noFactura === 'F-MXN')?.status).toBe('cobrada-banco');
    expect(result.matches.find(m => m.noFactura === 'F-USD')?.status).toBe('pendiente');
  });
});

// ── Objetivos de monto por factura ─────────────────────────────────────────

describe('reconcileRealCollections — objetivos de monto de la factura', () => {
  it('cruza contra el importe YA PAGADO cuando el ABONO coincide con esa porción', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'F-PARCIAL', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 1000, importePendientePesos: 400, fechaVence: '2026-02-01',
    });
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 600,
      concepto: 'TRANSFERENCIA SPEI',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('cobrada-banco');
    expect(result.matches[0].bankAmount).toBe(600);
  });

  it('una factura en ceros no genera objetivo de monto pero sí referencias de texto', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'RI-99001', noCliente: '90011', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 0, importePendientePesos: 0,
    });
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 5000,
      referencia: 'PAGO RI-99001 CLIENTE 90011',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('cobrada-jde-sin-banco');
    expect(result.abonoEnrichments[0].status).toBe('cobranza-sin-factura');
  });

  it('una factura sin fecha de cobro ni de vencimiento no genera objetivos', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'F-SINFECHA', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 1000, fechaVence: '', fechaCobro: '',
    });
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 1000,
      concepto: 'TRANSFERENCIA SPEI',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].status).toBe('pendiente');
  });

  it('aplica la tasa de IVA declarada por la factura al probar variantes de monto', () => {
    const conIva = makeFactura({
      cia: '00011', noFactura: 'F-IVA', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 1000, subTotal: 1000, importeIVA: 160, fechaVence: '2026-02-01',
    });
    const result = reconcileRealCollections(
      [conIva],
      [makeAccount({
        cia: '00011', cuenta: '1',
        movimientos: [makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 1160, concepto: 'TRANSFERENCIA SPEI' })],
      })],
    );
    expect(result.matches[0].status).toBe('cobrada-banco');
    expect(result.matches[0].matchReason).toMatch(/ajuste IVA/);
  });

  it('ignora un subTotal no positivo y cae a la tasa de IVA por defecto', () => {
    const raro = makeFactura({
      cia: '00011', noFactura: 'F-RARA', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 1000, subTotal: -1, importeIVA: 160, fechaVence: '2026-02-01',
    });
    const result = reconcileRealCollections(
      [raro],
      [makeAccount({
        cia: '00011', cuenta: '1',
        movimientos: [makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 1160, concepto: 'TRANSFERENCIA SPEI' })],
      })],
    );
    expect(result.matches[0].status).toBe('cobrada-banco');
  });
});

// ── Identidad por referencia ───────────────────────────────────────────────

describe('reconcileRealCollections — identidad por referencia', () => {
  it('cruza por número de factura aunque el monto sólo caiga en tolerancia', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'RI-85022', noCliente: 'C-7777', nombreCliente: 'CLIENTE ESPECIAL',
      importeBrutoPesos: 1155.44, fechaVence: '2026-02-01',
    });
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 1150,
      referencia: 'PAGO RI-85022',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].matchTier).toBe('invoice-reference');
    expect(result.matches[0].confidence).toBeGreaterThanOrEqual(0.92);
  });

  it('usa el nombre del cliente en la explicación cuando no hay número de cliente', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'F-SINCLI', noCliente: '', nombreCliente: 'ALTAMIRENSE',
      importeBrutoPesos: 50000, fechaVence: '2026-02-01',
    });
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 50000,
      concepto: 'PAGO ALTAMIRENSE',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches[0].matchTier).toBe('customer-reference');
    expect(result.matches[0].matchReason).toMatch(/menciona cliente ALTAMIRENSE/);
  });
});

// ── Recibos con tokens degenerados ─────────────────────────────────────────

describe('reconcileRealCollections — normalización de No_Recibo', () => {
  it('tolera recibos de puros ceros y descarta tokens de año', () => {
    const abonos = [
      makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 100, noRecibo: '0000' }),
      makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '2026-02-02', importe: 200, noRecibo: 'RI-2025-0000' }),
    ];
    const result = reconcileRealCollections(
      [],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: abonos })],
    );
    expect(result.summary.abonosSinFactura).toBe(2);
    expect(result.abonoEnrichments.every(e => e.paymentMatchStatus === undefined)).toBe(true);
  });

  it('cruza por No_recibo_Se_Pago_Factura informado en /cobranza (tier invoice-receipt-ref)', () => {
    const f1 = makeFactura({
      cia: '00011', noFactura: 'RI-701', noCliente: 'C-1', nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 1000, noReciboSePagoFactura: 'REC-5551',
    });
    const f2 = makeFactura({
      cia: '00011', noFactura: 'RI-702', noCliente: 'C-1', nombreCliente: 'CLIENTE RECIBO',
      importeBrutoPesos: 500, noReciboSePagoFactura: 'REC-5551',
    });
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 1500,
      noRecibo: 'REC-5551', concepto: 'TRANSFERENCIA SPEI',
    });
    const result = reconcileRealCollections(
      [f1, f2],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches.every(m => m.status === 'cobrada-banco')).toBe(true);
    expect(result.matches.every(m => m.matchTier === 'invoice-receipt-ref')).toBe(true);
    expect(result.abonoEnrichments[0]).toMatchObject({
      status: 'factura-cobrada',
      matchTier: 'invoice-receipt-ref',
      noRecibo: 'REC-5551',
    });
  });
});

// ── IndicadoresCobranza: caminos alternos ──────────────────────────────────

describe('reconcileRealCollections — IndicadoresCobranza (caminos alternos)', () => {
  it('cruza por el respaldo (cía + fecha + importe) cuando la cuenta no alinea, con cía vacía', () => {
    const factura = makeFactura({
      cia: '', noFactura: 'RI-800', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 1000,
    });
    const abono = makeAbono({
      cia: '', cuenta: '999', fechaOperacion: '2026-02-01', importe: 1000, moneda: '',
      concepto: 'TRANSFERENCIA SPEI',
    });
    const payment = makePayment({
      idPago: 'PAY-LAXO', cia: '', fechaCobro: '2026-02-01',
      cuentaBancaria: 'CTA-QUE-NO-CRUZA', noRecibo: 'RECIBO-1234', importeRecibo: 1000,
      applications: [makeApplication({ idPago: 'PAY-LAXO', cia: '', noFactura: 'RI-800', importeCobrado: 1000 })],
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '', cuenta: '999', movimientos: [abono] })],
      { cobranzaPayments: [payment] },
    );
    expect(result.matches[0]).toMatchObject({
      status: 'cobrada-banco',
      matchTier: 'payment-auto-unique',
      paymentMatchStatus: 'AUTO_UNIQUE',
    });
    expect(result.summary.ciaBreakdown[0].cia).toBe('(sin cia)');
    expect(result.summary.ciaBreakdown[0].matches).toBe(1);
  });

  it('marca el ABONO como cobranza-sin-factura cuando ninguna aplicación mapea a una factura conocida', () => {
    const abono = makeAbono({
      cia: '00011', cuenta: '000123', cuentaContable: '11.1020.0011302',
      fechaOperacion: '2026-02-10', importe: 1000, concepto: 'TRANSFERENCIA SPEI',
    });
    const payment = makePayment({
      idPago: 'PAY-HUERFANO', cia: '00011', fechaCobro: '2026-02-10',
      cuentaBancaria: '11.1020.0011302', noRecibo: 'RI-777', importeRecibo: 1000,
      applications: [makeApplication({ idPago: 'PAY-HUERFANO', cia: '00011', noFactura: 'NO-EXISTE', importeCobrado: 1000 })],
    });
    const result = reconcileRealCollections(
      [],
      [makeAccount({ cia: '00011', cuenta: '000123', movimientos: [abono] })],
      { cobranzaPayments: [payment] },
    );
    expect(result.abonoEnrichments[0]).toMatchObject({
      status: 'cobranza-sin-factura',
      paymentMatchStatus: 'AUTO_UNIQUE',
    });
    expect(result.abonoEnrichments[0].facturas).toBeUndefined();
    expect(result.abonoEnrichments[0].matchReason).toMatch(/No se encontró factura CXC/);
  });

  it('cae al importe del recibo cuando la aplicación viene en cero', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'RI-900', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 1000,
    });
    const abono = makeAbono({
      cia: '00011', cuenta: '000123', cuentaContable: '11.1020.0011302',
      fechaOperacion: '2026-02-10', importe: 1000, concepto: 'TRANSFERENCIA SPEI',
    });
    const payment = makePayment({
      idPago: 'PAY-CERO', cia: '00011', fechaCobro: '2026-02-10',
      cuentaBancaria: '11.1020.0011302', noRecibo: 'RI-900', importeRecibo: 1000,
      applications: [makeApplication({
        idPago: 'PAY-CERO', cia: '00011', noFactura: 'RI-900',
        importeCobrado: 0, importeOriginalFactura: 0,
      })],
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '000123', movimientos: [abono] })],
      { cobranzaPayments: [payment] },
    );
    expect(result.matches[0].bankAmount).toBe(1000);
    expect(result.abonoEnrichments[0].facturas?.[0].importeBruto).toBe(1000);
    expect(result.paymentReconciliations[0].applications[0].ivaCausadoProporcional).toBe(0);
  });

  it('deja AMBIGUOUS cuando dos Id Pago comparten No_Recibo bancario E importe', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'RI-950', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 1000,
    });
    const abono = makeAbono({
      cia: '00011', cuenta: '000123', fechaOperacion: '2026-02-10', importe: 1000,
      noRecibo: '339563', concepto: 'TRANSFERENCIA SPEI',
    });
    const payments = [
      makePayment({
        idPago: 'PAY-1', cia: '00011', fechaCobro: '2026-02-10',
        cuentaBancaria: '11.1020.0011302', noRecibo: '339563', importeRecibo: 1000,
        applications: [makeApplication({ idPago: 'PAY-1', cia: '00011', noFactura: 'RI-950', importeCobrado: 1000 })],
      }),
      makePayment({
        idPago: 'PAY-2', cia: '00011', fechaCobro: '2026-02-10',
        cuentaBancaria: '11.1020.0011302', noRecibo: '339563', importeRecibo: 1000,
        applications: [makeApplication({ idPago: 'PAY-2', cia: '00011', noFactura: 'RI-950', importeCobrado: 1000 })],
      }),
    ];
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '000123', movimientos: [abono] })],
      { cobranzaPayments: payments },
    );
    expect(result.abonoEnrichments[0].paymentMatchStatus).toBe('AMBIGUOUS');
    expect(result.abonoEnrichments[0].matchReason).toMatch(/2 Id Pago comparten No_Recibo bancario/);
    expect(result.summary.pagosAmbiguos).toBe(2);
  });

  it('no cruza cuando el No_Recibo bancario no corresponde a ningún Id Pago', () => {
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-10', importe: 1000,
      noRecibo: 'REC-8888',
    });
    const payment = makePayment({
      idPago: 'PAY-OTRO', cia: '00011', fechaCobro: '2026-03-15',
      cuentaBancaria: 'CTA-X', noRecibo: 'REC-1111', importeRecibo: 55,
    });
    const result = reconcileRealCollections(
      [],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
      { cobranzaPayments: [payment] },
    );
    expect(result.abonoEnrichments[0].paymentMatchStatus).toBeUndefined();
    expect(result.summary.pagosSinBanco).toBe(1);
  });

  it('acumula el monto conciliado de pagos multi-factura resueltos por AUTO_UNIQUE', () => {
    const facturas = [
      makeFactura({ cia: '00011', noFactura: 'RI-100', noCliente: 'C-1', nombreCliente: 'CLIENTE', importeBrutoPesos: 1000 }),
      makeFactura({ cia: '00011', noFactura: 'RI-101', noCliente: 'C-1', nombreCliente: 'CLIENTE', importeBrutoPesos: 500 }),
    ];
    const abono = makeAbono({
      cia: '00011', cuenta: '000123', cuentaContable: '11.1020.0011302',
      fechaOperacion: '2026-02-10', importe: 1500, concepto: 'TRANSFERENCIA SPEI',
    });
    const payment = makePayment({
      idPago: 'PAY-MULTI', cia: '00011', fechaCobro: '2026-02-10',
      cuentaBancaria: '11.1020.0011302', noRecibo: 'RI-100', importeRecibo: 1500,
      applications: [
        makeApplication({ idPago: 'PAY-MULTI', cia: '00011', noFactura: 'RI-100', importeCobrado: 1000 }),
        makeApplication({ idPago: 'PAY-MULTI', cia: '00011', noFactura: 'RI-101', importeCobrado: 500 }),
      ],
    });
    const result = reconcileRealCollections(
      facturas,
      [makeAccount({ cia: '00011', cuenta: '000123', movimientos: [abono] })],
      { cobranzaPayments: [payment] },
    );
    expect(result.paymentReconciliations[0].status).toBe('AUTO_UNIQUE');
    expect(result.summary.pagosMultiFactura).toBe(1);
    expect(result.summary.montoPagosMultiFacturaConciliado).toBe(1500);
  });
});

// ── Filtro de compañía y herencia de campos ────────────────────────────────

describe('reconcileRealCollections — ciaFilter y herencia de campos', () => {
  it('acota facturas, ABONOs y pagos de Indicadores a las cías del filtro', () => {
    const facturas = [
      makeFactura({ cia: '00011', noFactura: 'F-IN', noCliente: 'C-1', nombreCliente: 'CLIENTE', importeBrutoPesos: 1000 }),
      makeFactura({ cia: '00038', noFactura: 'F-OUT', noCliente: 'C-2', nombreCliente: 'OTRO', importeBrutoPesos: 2000 }),
    ];
    const payments = [
      makePayment({ idPago: 'P-IN', cia: '00011', fechaCobro: '2026-02-01', cuentaBancaria: 'X', noRecibo: 'R1', importeRecibo: 1 }),
      makePayment({ idPago: 'P-OUT', cia: '00038', fechaCobro: '2026-02-01', cuentaBancaria: 'X', noRecibo: 'R2', importeRecibo: 1 }),
    ];
    const result = reconcileRealCollections(
      facturas,
      [
        makeAccount({ cia: '00011', cuenta: '1', movimientos: [makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 999 })] }),
        makeAccount({ cia: '00038', cuenta: '2', movimientos: [makeAbono({ cia: '00038', cuenta: '2', fechaOperacion: '2026-02-01', importe: 888 })] }),
      ],
      { ciaFilter: new Set(['00011']), cobranzaPayments: payments },
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].noFactura).toBe('F-IN');
    expect(result.summary.totalAbonos).toBe(1);
    expect(result.summary.totalPagosIndicadores).toBe(1);
  });

  it('hereda cia/banco/cuenta/moneda del estado de cuenta cuando el movimiento viene vacío', () => {
    const desnudo = {
      ...makeAbono({ cia: '', cuenta: '', fechaOperacion: '2026-02-01', importe: 100000 }),
      banco: '',
      nombreBanco: undefined,
      moneda: '',
      concepto: 'TRANSFERENCIA SPEI',
    } as BankStatementLine;
    const factura = makeFactura({
      cia: '00011', noFactura: 'F-1', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100000,
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '12345', movimientos: [desnudo] })],
    );
    expect(result.abonoEnrichments[0].cia).toBe('00011');
    expect(result.abonoEnrichments[0].cuenta).toBe('12345');
    expect(result.matches[0].status).toBe('cobrada-banco');
  });

  it('tolera un ABONO con importe no numérico', () => {
    const roto = makeAbono({ cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: Number.NaN });
    const result = reconcileRealCollections(
      [],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [roto] })],
    );
    expect(result.abonoEnrichments[0].status).toBe('cobranza-sin-factura');
    expect(result.summary.totalAbonos).toBe(1);
  });
});

// ── Subset-sum: poda y camino genérico ─────────────────────────────────────

describe('reconcileRealCollections — subset-sum', () => {
  it('arma subset genérico (sin identidad de cliente) cuando el ABONO es grande', () => {
    const f1 = makeFactura({ cia: '00011', noFactura: 'G-1', noCliente: 'C-9', nombreCliente: 'CLIENTE GEN', importeBrutoPesos: 6000 });
    const f2 = makeFactura({ cia: '00011', noFactura: 'G-2', noCliente: 'C-9', nombreCliente: 'CLIENTE GEN', importeBrutoPesos: 5000 });
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 11000,
      concepto: 'TRANSFERENCIA SPEI',
    });
    const result = reconcileRealCollections(
      [f1, f2],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    const cobradas = result.matches.filter(m => m.status === 'cobrada-banco');
    expect(cobradas).toHaveLength(2);
    expect(cobradas[0].matchTier).toBe('subset');
    // El piso del subset NO identificado es 0.8, pero `computeConfidence`
    // (base 0.9, monto y fecha perfectos) lo supera: la confianza final es 0.9.
    expect(cobradas[0].confidence).toBeCloseTo(0.9);
    // La leyenda con el nombre del cliente confirma que fue el camino genérico
    // (sin identidad de cliente en el texto bancario).
    expect(cobradas[0].matchReason).toMatch(/mismo cliente \(CLIENTE GEN\)/);
  });

  it('no arma subset cuando ninguna combinación cuadra (poda por cota superior)', () => {
    const facturas = [
      makeFactura({ cia: '00011', noFactura: 'P-1', noCliente: 'C-9', nombreCliente: 'CLIENTE GEN', importeBrutoPesos: 9000 }),
      makeFactura({ cia: '00011', noFactura: 'P-2', noCliente: 'C-9', nombreCliente: 'CLIENTE GEN', importeBrutoPesos: 8000 }),
      makeFactura({ cia: '00011', noFactura: 'P-3', noCliente: 'C-9', nombreCliente: 'CLIENTE GEN', importeBrutoPesos: 500 }),
    ];
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 11000,
      concepto: 'TRANSFERENCIA SPEI',
    });
    const result = reconcileRealCollections(
      facturas,
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches.filter(m => m.status === 'cobrada-banco')).toHaveLength(0);
  });

  it('descarta el subset cuando ninguna de sus facturas tiene fecha de referencia', () => {
    const facturas = [
      makeFactura({ cia: '00011', noFactura: 'D-1', noCliente: 'C-9', nombreCliente: 'CLIENTE GEN', importeBrutoPesos: 6000, fechaVence: '', fechaCobro: '' }),
      makeFactura({ cia: '00011', noFactura: 'D-2', noCliente: 'C-9', nombreCliente: 'CLIENTE GEN', importeBrutoPesos: 5000, fechaVence: '', fechaCobro: '' }),
    ];
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 11000,
      concepto: 'TRANSFERENCIA SPEI',
    });
    const result = reconcileRealCollections(
      facturas,
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches.filter(m => m.status === 'cobrada-banco')).toHaveLength(0);
  });

  it('descarta el subset cuyas facturas quedan fuera de la ventana de 60 días', () => {
    const facturas = [
      makeFactura({ cia: '00011', noFactura: 'W-1', noCliente: 'C-9', nombreCliente: 'CLIENTE GEN', importeBrutoPesos: 6000, fechaVence: '2026-01-01' }),
      makeFactura({ cia: '00011', noFactura: 'W-2', noCliente: 'C-9', nombreCliente: 'CLIENTE GEN', importeBrutoPesos: 5000, fechaVence: '2026-01-01' }),
    ];
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-06-01', importe: 11000,
      concepto: 'TRANSFERENCIA SPEI',
    });
    const result = reconcileRealCollections(
      facturas,
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches.filter(m => m.status === 'cobrada-banco')).toHaveLength(0);
  });

  it('descarta el cliente cuyas facturas están en otra moneda antes de intentar el subset', () => {
    const facturas = [
      makeFactura({
        cia: '00011', noFactura: 'U-1', noCliente: 'C-9', nombreCliente: 'CLIENTE GEN',
        moneda: 'USD', importeBrutoPesos: 6000, importeBrutoDolares: 6000, importePendienteDolares: 6000,
      }),
      makeFactura({
        cia: '00011', noFactura: 'U-2', noCliente: 'C-9', nombreCliente: 'CLIENTE GEN',
        moneda: 'USD', importeBrutoPesos: 5000, importeBrutoDolares: 5000, importePendienteDolares: 5000,
      }),
    ];
    const abono = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 11000,
      concepto: 'TRANSFERENCIA SPEI',
    });
    const result = reconcileRealCollections(
      facturas,
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abono] })],
    );
    expect(result.matches.filter(m => m.status === 'cobrada-banco')).toHaveLength(0);
  });
});

// ── Cola de revisión ───────────────────────────────────────────────────────

describe('reconcileRealCollections — cola de revisión', () => {
  it('expone como candidato a revisión un match de confianza intermedia', () => {
    const revisable = makeFactura({
      cia: '00011', noFactura: 'F-REVIEW', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100000, fechaVence: '2026-02-01',
    });
    const cruzada = makeFactura({
      cia: '00011', noFactura: 'F-OK', noCliente: 'C-2', nombreCliente: 'OTRO CLIENTE',
      importeBrutoPesos: 7000, fechaVence: '2026-02-01',
    });
    const abonoRevisable = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 99000,
      concepto: 'TRANSFERENCIA SPEI',
    });
    const abonoCruzado = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 7000,
      concepto: 'TRANSFERENCIA SPEI', referencia: 'B',
    });
    const result = reconcileRealCollections(
      [revisable, cruzada],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [abonoRevisable, abonoCruzado] })],
    );
    const review = result.matches.find(m => m.noFactura === 'F-REVIEW');
    expect(review?.status).toBe('pendiente');
    expect(review?.reviewStatus).toBe('review');
    expect(result.reviewCandidates).toHaveLength(1);
    expect(result.reviewCandidates[0].candidateFacturas[0].noFactura).toBe('F-REVIEW');
    expect(result.matches.find(m => m.noFactura === 'F-OK')?.status).toBe('cobrada-banco');
  });

  it('retira el candidato de revisión cuando un ABONO posterior cobra esa factura', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'F-DOBLE', noCliente: 'C-1', nombreCliente: 'CLIENTE',
      importeBrutoPesos: 100000, fechaVence: '2026-02-05',
    });
    const parecido = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 99000,
      concepto: 'TRANSFERENCIA SPEI', referencia: 'PARECIDO',
    });
    const exacto = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-05', importe: 100000,
      concepto: 'TRANSFERENCIA SPEI', referencia: 'EXACTO',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [parecido, exacto] })],
    );
    expect(result.matches[0].status).toBe('cobrada-banco');
    expect(result.matches[0].bankRef).toBe('EXACTO');
    // El ABONO parecido pierde su candidato: la factura ya quedó cobrada.
    expect(result.reviewCandidates).toHaveLength(0);
    const parecidoEnr = result.abonoEnrichments.find(e => e.referencia === 'PARECIDO');
    expect(parecidoEnr?.candidateFacturas).toBeUndefined();
  });
});

// ── Multi-abono: caminos alternos ──────────────────────────────────────────

describe('reconcileRealCollections — multi-abono (caminos alternos)', () => {
  it('cae al importe pendiente cuando el bruto no cuadra con la suma de ABONOs', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'M-1', noCliente: 'C-1', nombreCliente: 'ZACATECANA',
      importeBrutoPesos: 300000, importePendientePesos: 200000, moneda: '',
      fechaVence: '2026-02-01',
    });
    const a1 = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 120000,
      concepto: 'PAGO ZACATECANA', referencia: 'A1', moneda: '',
    });
    const a2 = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-02', importe: 80000,
      concepto: 'PAGO ZACATECANA', referencia: 'A2', moneda: '',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', moneda: '', movimientos: [a1, a2] })],
    );
    expect(result.matches[0].matchTier).toBe('multi-abono');
    expect(result.matches[0].bankAmount).toBe(200000);
    expect(result.matches[0].bankMovements).toHaveLength(2);
  });

  it('los ABONOs ya consumidos por una factura no vuelven a ofrecerse a otra', () => {
    const f1 = makeFactura({
      cia: '00011', noFactura: 'M-A', noCliente: 'C-1', nombreCliente: 'ZACATECANA',
      importeBrutoPesos: 200000, fechaVence: '2026-02-01',
    });
    const f2 = makeFactura({
      cia: '00011', noFactura: 'M-B', noCliente: 'C-1', nombreCliente: 'ZACATECANA',
      importeBrutoPesos: 200000, fechaVence: '2026-02-01',
    });
    const a1 = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 120000,
      concepto: 'PAGO ZACATECANA', referencia: 'A1',
    });
    const a2 = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-02', importe: 80000,
      concepto: 'PAGO ZACATECANA', referencia: 'A2',
    });
    const result = reconcileRealCollections(
      [f1, f2],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [a1, a2] })],
    );
    const cobradas = result.matches.filter(m => m.status === 'cobrada-banco');
    expect(cobradas).toHaveLength(1);
    expect(cobradas[0].matchTier).toBe('multi-abono');
  });

  it('salta las facturas sin fecha de referencia en la pasada multi-abono', () => {
    const sinFecha = makeFactura({
      cia: '00011', noFactura: 'M-SINFECHA', noCliente: 'C-1', nombreCliente: 'ZACATECANA',
      importeBrutoPesos: 200000, fechaVence: '', fechaCobro: '',
    });
    const conFecha = makeFactura({
      cia: '00011', noFactura: 'M-CONFECHA', noCliente: 'C-1', nombreCliente: 'ZACATECANA',
      importeBrutoPesos: 200000, fechaVence: '2026-02-01',
    });
    const a1 = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 120000,
      concepto: 'PAGO ZACATECANA', referencia: 'A1',
    });
    const a2 = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-02', importe: 80000,
      concepto: 'PAGO ZACATECANA', referencia: 'A2',
    });
    const result = reconcileRealCollections(
      [sinFecha, conFecha],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [a1, a2] })],
    );
    expect(result.matches.find(m => m.noFactura === 'M-SINFECHA')?.status).toBe('pendiente');
    expect(result.matches.find(m => m.noFactura === 'M-CONFECHA')?.matchTier).toBe('multi-abono');
  });

  it('descarta los ABONOs del cliente que están en otra moneda', () => {
    const factura = makeFactura({
      cia: '00011', noFactura: 'M-MON', noCliente: 'C-1', nombreCliente: 'ZACATECANA',
      importeBrutoPesos: 200000, fechaVence: '2026-02-01',
    });
    const a1 = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-01', importe: 120000,
      concepto: 'PAGO ZACATECANA', referencia: 'A1',
    });
    const a2usd = makeAbono({
      cia: '00011', cuenta: '1', fechaOperacion: '2026-02-02', importe: 80000,
      concepto: 'PAGO ZACATECANA', referencia: 'A2', moneda: 'USD',
    });
    const result = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '1', movimientos: [a1, a2usd] })],
    );
    expect(result.matches[0].status).toBe('pendiente');
  });
});
