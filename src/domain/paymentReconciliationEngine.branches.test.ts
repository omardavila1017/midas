/**
 * Cobertura de RAMAS del motor de conciliación de pagos (Pagos ↔ CXP ↔ Bancos).
 *
 * Complemento de `paymentReconciliationEngine.test.ts`: aquel pinea las
 * invariantes de negocio de cada tier; éste ejercita los caminos defensivos y
 * los desempates que no se alcanzaban (fechas ilegibles, importes ≤ 0, cuentas
 * sin dígitos, cobertura bancaria, poda de los backtrackings, ranking de
 * candidatos). Todas las aserciones describen el comportamiento REAL observado
 * — no se cambió una sola línea del motor.
 *
 * Ramas documentadas como INALCANZABLES desde `reconcilePayments` (no se
 * testean a propósito):
 *   • `findSubsetMatch` línea ~1009 (`importePendientePesos > 0 ? … : bruto`):
 *     el filtro `eligibleCxps` ya exige `importePendientePesos > 0`.
 *   • `buildReason` línea ~1068 (etiqueta `'subset'` con UNA sola CXP):
 *     `findSubsetMatch` sólo devuelve grupos de ≥2 facturas.
 *   • `buildReason` línea ~1080 (`cargo.extraMovements?.length ?? 0`): el tier
 *     `subset` siempre setea `extraMovements` con ≥1 elemento.
 *   • `findCrossAccountCargo`/`findBatchCargo`/`findUnmatchedCandidate`
 *     (`!amountsClose(...) continue`): la ventana del binary-search es
 *     exactamente la tolerancia, así que todo cargo escaneado ya está dentro.
 *   • `findBatchCargo` desempate por `seq` con importes IGUALES en la misma
 *     cuenta: el orden de iteración post-sort coincide con el de `seq`.
 */
import { describe, it, expect } from 'vitest';
import { reconcilePayments } from './paymentReconciliationEngine';
import type { PagoProveedorRecord, BankAccountStatement, BankStatementLine } from '../services/jdeTypes';
import type { CXPRecord } from './persistence';

// ── Builders (espejo de paymentReconciliationEngine.test.ts) ────────────────

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

// ── Cobertura CXP: acumulación sobre una llave repetida ─────────────────────

describe('reconcilePayments — acumulación de cxpCoverage', () => {
  it('acumula sobre una entrada existente cuando el subset toma dos CXP con la MISMA llave', () => {
    // Dos registros CXP duplicados (misma cia/factura/proveedor) que el
    // subset-sum toma juntos: la segunda vuelta de acumulación cae en la rama
    // `existing`. NOTA: el motor suma `payment.importePesos` COMPLETO por cada
    // hit, así que un duplicado real inflaría `totalPaidPesos` — comportamiento
    // observado, no corregido aquí.
    const result = reconcilePayments({
      payments: [pago({ importePesos: 1500, comentarioPago: 'sin folio' })],
      cxpRecords: [
        cxp({ noFactura: 'DUPE', importeBrutoPesos: 750, importePendientePesos: 750 }),
        cxp({ noFactura: 'DUPE', importeBrutoPesos: 750, importePendientePesos: 750 }),
      ],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches).toHaveLength(2);
    const cov = result.cxpCoverage.get('00038::DUPE::3228');
    expect(cov?.payments).toHaveLength(2);
    expect(cov?.totalPaidPesos).toBe(3000);
    expect(cov?.status).toBe('PAID');
  });

  it('marca OPEN cuando la CXP tiene importe bruto 0 (no hay base para el ratio)', () => {
    const result = reconcilePayments({
      payments: [pago({ importePesos: 500 })],
      cxpRecords: [cxp({ importeBrutoPesos: 0, importePendientePesos: 8695 })],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches[0].tier).toBe('folio-exact');
    expect(result.cxpCoverage.get('00038::VALE21829::3228')?.status).toBe('OPEN');
  });

  it('marca OPEN cuando lo pagado es < 5% del bruto de la CXP', () => {
    const result = reconcilePayments({
      payments: [pago({ importePesos: 1000 })],
      cxpRecords: [cxp({ importeBrutoPesos: 100000, importePendientePesos: 100000 })],
      bankStatements: [],
    });
    expect(result.cxpCoverage.get('00038::VALE21829::3228')?.status).toBe('OPEN');
  });

  it('ignora CXPs cuyo proveedor no normaliza a dígitos (no entran al índice)', () => {
    const result = reconcilePayments({
      payments: [pago({ comentarioPago: 'sin folio' })],
      cxpRecords: [cxp({ noProveedor: 'SIN-CLAVE' })],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches).toHaveLength(0);
    expect(result.paymentMatches[0].status).toBe('UNMATCHED');
  });

  it('un pago sin clave de proveedor no cruza CXP alguna', () => {
    const result = reconcilePayments({
      payments: [pago({ claveProveedor: '', comentarioPago: '' })],
      cxpRecords: [cxp()],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches).toHaveLength(0);
  });
});

// ── Ventana de fecha CXP ───────────────────────────────────────────────────

describe('reconcilePayments — ventana de fecha CXP', () => {
  it('acepta una CXP sin fechaFactura ni fechaVence (ventana abierta)', () => {
    const result = reconcilePayments({
      payments: [pago({ comentarioPago: 'sin folio' })],
      cxpRecords: [cxp({ fechaFactura: '', fechaVence: '' })],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches[0].tier).toBe('invoice-amount');
  });

  it('descarta una CXP cuya factura es MUY posterior al pago (> 7 días antes)', () => {
    const result = reconcilePayments({
      payments: [pago({ fechaPago: '2026-01-01', comentarioPago: 'sin folio' })],
      cxpRecords: [cxp({ fechaFactura: '2026-04-01', fechaVence: '2026-04-30' })],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches).toHaveLength(0);
  });

  it('descarta una CXP vencida hace más de 60 días y se queda con la que sí está en ventana', () => {
    const result = reconcilePayments({
      payments: [pago({ comentarioPago: 'sin folio' })],
      cxpRecords: [
        cxp({ noFactura: 'VIEJA', fechaFactura: '2025-01-01', fechaVence: '2025-01-31' }),
        cxp({ noFactura: 'VIGENTE' }),
      ],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches).toHaveLength(1);
    expect(result.paymentMatches[0].cxpMatches[0].cxp.noFactura).toBe('VIGENTE');
  });

  it('un pago con fecha ilegible no cruza CXP por monto (la ventana lo rechaza)', () => {
    const result = reconcilePayments({
      payments: [pago({ fechaPago: 'SIN FECHA', comentarioPago: 'sin folio' })],
      cxpRecords: [cxp()],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches).toHaveLength(0);
    expect(result.paymentMatches[0].status).toBe('UNMATCHED');
  });
});

// ── Backtracking del subset CXP ────────────────────────────────────────────

describe('reconcilePayments — poda del subset-sum de CXP', () => {
  it('no arma subset cuando ninguna combinación cuadra (poda por sobre-tiro)', () => {
    const result = reconcilePayments({
      payments: [pago({ importePesos: 1500, comentarioPago: 'sin folio' })],
      cxpRecords: [
        cxp({ noFactura: 'S1', importeBrutoPesos: 700, importePendientePesos: 700 }),
        cxp({ noFactura: 'S2', importeBrutoPesos: 700, importePendientePesos: 700 }),
        cxp({ noFactura: 'S3', importeBrutoPesos: 700, importePendientePesos: 700 }),
      ],
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches).toHaveLength(0);
  });

  it('corta la búsqueda al rebasar el máximo de facturas por subset', () => {
    // 6 facturas de 100 contra un pago de 1000: la rama profunda se poda al
    // llegar al 5º pick y ninguna combinación de ≤4 llega a 1000.
    const result = reconcilePayments({
      payments: [pago({ importePesos: 1000, comentarioPago: 'sin folio' })],
      cxpRecords: Array.from({ length: 6 }, (_, i) =>
        cxp({ noFactura: `M${i}`, importeBrutoPesos: 100, importePendientePesos: 100 }),
      ),
      bankStatements: [],
    });
    expect(result.paymentMatches[0].cxpMatches).toHaveLength(0);
  });
});

// ── Ranking de CARGO en la misma cuenta ────────────────────────────────────

describe('reconcilePayments — ranking del cruce CARGO misma cuenta', () => {
  it('prefiere el CARGO exacto sobre uno dentro de tolerancia aunque venga después', () => {
    const result = reconcilePayments({
      payments: [pago()],
      cxpRecords: [],
      bankStatements: [statement([
        cargo({ importe: 8660, fechaOperacion: '2026-05-06', referencia: 'TOL' }),
        cargo({ importe: 8695, fechaOperacion: '2026-05-04', referencia: 'EXACTO' }),
      ])],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('exact');
    expect(result.paymentMatches[0].cargoMatch?.movement.referencia).toBe('EXACTO');
  });

  it('con dos CARGOs en tolerancia gana el más cercano en fecha', () => {
    const result = reconcilePayments({
      payments: [pago()],
      cxpRecords: [],
      bankStatements: [statement([
        cargo({ importe: 8660, fechaOperacion: '2026-05-10', referencia: 'LEJOS' }),
        cargo({ importe: 8680, fechaOperacion: '2026-05-05', referencia: 'CERCA' }),
      ])],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('tolerance');
    expect(result.paymentMatches[0].cargoMatch?.movement.referencia).toBe('CERCA');
  });

  it('a igualdad de tier y días gana el CARGO de menor orden original (seq)', () => {
    // Orden original: 8680 (seq 0) y 8660 (seq 1). El índice ordena por importe
    // ascendente, así que 8660 se evalúa primero; el desempate por `seq`
    // devuelve el 8680 (primero en el estado de cuenta).
    const result = reconcilePayments({
      payments: [pago()],
      cxpRecords: [],
      bankStatements: [statement([
        cargo({ importe: 8680, fechaOperacion: '2026-05-06', referencia: 'PRIMERO' }),
        cargo({ importe: 8660, fechaOperacion: '2026-05-06', referencia: 'SEGUNDO' }),
      ])],
    });
    expect(result.paymentMatches[0].cargoMatch?.movement.referencia).toBe('PRIMERO');
  });

  it('descarta un CARGO dentro de la banda de búsqueda pero fuera de la tolerancia real', () => {
    const result = reconcilePayments({
      payments: [pago({ claveProveedor: '99999', comentarioPago: 'x' })],
      cxpRecords: [],
      // 8795 cae en la banda escaneada (±4× tolerancia) pero no en el ±0.5%.
      bankStatements: [statement([cargo({ importe: 8795 })])],
    });
    expect(result.paymentMatches[0].cargoMatch).toBeUndefined();
    expect(result.paymentMatches[0].status).toBe('UNMATCHED');
    expect(result.paymentMatches[0].bankCoverage).toBe('covered');
  });

  it('descarta un CARGO del mismo importe fuera de la ventana de 120 días', () => {
    const result = reconcilePayments({
      payments: [pago({ fechaPago: '2026-05-04', claveProveedor: '99999', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([cargo({ fechaOperacion: '2026-11-30' })])],
    });
    expect(result.paymentMatches[0].cargoMatch).toBeUndefined();
    expect(result.paymentMatches[0].bankCoverage).toBe('out-of-range');
  });

  it('un segundo pago idéntico no puede reclamar el CARGO ya tomado', () => {
    const result = reconcilePayments({
      payments: [pago({ noPago: 'P1', claveProveedor: '1', comentarioPago: 'x' }),
        pago({ noPago: 'P2', claveProveedor: '2', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([cargo()])],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('exact');
    expect(result.paymentMatches[1].cargoMatch).toBeUndefined();
    expect(result.paymentMatches[1].status).toBe('UNMATCHED');
  });
});

// ── Fechas ilegibles / importes no positivos ───────────────────────────────

describe('reconcilePayments — datos degradados del pago', () => {
  it('un pago con fecha ilegible queda UNMATCHED y se reporta como covered (no hay evidencia de falta de datos)', () => {
    const result = reconcilePayments({
      payments: [pago({ fechaPago: 'SIN FECHA', claveProveedor: '99999', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([cargo()])],
    });
    const pm = result.paymentMatches[0];
    expect(pm.cargoMatch).toBeUndefined();
    expect(pm.status).toBe('UNMATCHED');
    expect(pm.bankCoverage).toBe('covered');
    expect(pm.unmatchedCandidate).toBeUndefined();
    // El CARGO queda huérfano.
    expect(Array.from(result.cargoEnrichments.values())[0].status).toBe('ORPHAN');
  });

  it('un lote con fecha ilegible no arma cruce batch', () => {
    const result = reconcilePayments({
      payments: [
        pago({ noPago: 'B1', batchPago: '777', importePesos: 3000, fechaPago: '', claveProveedor: '1', comentarioPago: 'x' }),
        pago({ noPago: 'B2', batchPago: '777', importePesos: 7000, fechaPago: '', claveProveedor: '2', comentarioPago: 'x' }),
      ],
      cxpRecords: [],
      bankStatements: [statement([cargo({ importe: 10000 })])],
    });
    for (const pm of result.paymentMatches) expect(pm.cargoMatch).toBeUndefined();
  });

  it('un lote cuyo total es 0 no arma cruce batch', () => {
    const result = reconcilePayments({
      payments: [
        pago({ noPago: 'Z1', batchPago: '778', importePesos: 0, claveProveedor: '1', comentarioPago: 'x' }),
        pago({ noPago: 'Z2', batchPago: '778', importePesos: 0, claveProveedor: '2', comentarioPago: 'x' }),
      ],
      cxpRecords: [],
      bankStatements: [statement([cargo({ importe: 10000 })])],
    });
    for (const pm of result.paymentMatches) {
      expect(pm.cargoMatch).toBeUndefined();
      expect(pm.unmatchedCandidate).toBeUndefined();
    }
  });

  it('un pago sin batchPago nunca entra a la agrupación de lote', () => {
    const result = reconcilePayments({
      payments: [
        pago({ noPago: 'N1', batchPago: '', importePesos: 3000, claveProveedor: '1', comentarioPago: 'x' }),
        pago({ noPago: 'N2', batchPago: '   ', importePesos: 7000, claveProveedor: '2', comentarioPago: 'x' }),
      ],
      cxpRecords: [],
      bankStatements: [statement([cargo({ importe: 10000 })])],
    });
    for (const pm of result.paymentMatches) expect(pm.cargoMatch).toBeUndefined();
  });
});

// ── Batch: ventana y ranking ───────────────────────────────────────────────

describe('reconcilePayments — cruce batch', () => {
  it('el CARGO agregado fuera de la ventana estrecha (±7d) no cierra el lote', () => {
    const result = reconcilePayments({
      payments: [
        pago({ noPago: 'B1', batchPago: '901', importePesos: 3000, claveProveedor: '1', comentarioPago: 'x' }),
        pago({ noPago: 'B2', batchPago: '901', importePesos: 4000, claveProveedor: '2', comentarioPago: 'x' }),
      ],
      cxpRecords: [],
      bankStatements: [statement([cargo({ importe: 7000, fechaOperacion: '2026-05-20' })])],
    });
    for (const pm of result.paymentMatches) expect(pm.cargoMatch).toBeUndefined();
  });

  it('entre dos CARGOs agregados válidos gana el más cercano en fecha', () => {
    const result = reconcilePayments({
      payments: [
        pago({ noPago: 'B1', batchPago: '902', importePesos: 3000, claveProveedor: '1', comentarioPago: 'x' }),
        pago({ noPago: 'B2', batchPago: '902', importePesos: 4000, claveProveedor: '2', comentarioPago: 'x' }),
      ],
      cxpRecords: [],
      bankStatements: [statement([
        cargo({ importe: 7000, fechaOperacion: '2026-05-09', referencia: 'LEJOS' }),
        cargo({ importe: 7000, fechaOperacion: '2026-05-05', referencia: 'CERCA' }),
      ])],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('batch');
    expect(result.paymentMatches[0].cargoMatch?.movement.referencia).toBe('CERCA');
  });

  it('a igualdad de fecha el lote toma el CARGO de menor orden original (seq)', () => {
    // Insertados 7000 (seq 0) y 6980 (seq 1); el índice los ordena por importe,
    // así que 6980 se evalúa primero y el desempate por `seq` devuelve 7000.
    const result = reconcilePayments({
      payments: [
        pago({ noPago: 'B1', batchPago: '903', importePesos: 3000, claveProveedor: '1', comentarioPago: 'x' }),
        pago({ noPago: 'B2', batchPago: '903', importePesos: 4000, claveProveedor: '2', comentarioPago: 'x' }),
      ],
      cxpRecords: [],
      bankStatements: [statement([
        cargo({ importe: 7000, referencia: 'PRIMERO' }),
        cargo({ importe: 6980, referencia: 'SEGUNDO' }),
      ])],
    });
    expect(result.paymentMatches[0].cargoMatch?.movement.referencia).toBe('PRIMERO');
  });

  it('el lote que además cruzó CXP queda MATCHED_FULL', () => {
    const result = reconcilePayments({
      payments: [
        pago({ noPago: 'B1', batchPago: '904', importePesos: 3000, claveProveedor: '1', comentarioPago: 'FL FACT-A' }),
        pago({ noPago: 'B2', batchPago: '904', importePesos: 4000, claveProveedor: '2', comentarioPago: 'FL FACT-B' }),
      ],
      cxpRecords: [
        cxp({ noProveedor: '1', noFactura: 'FACT-A', importeBrutoPesos: 3000, importePendientePesos: 3000 }),
        cxp({ noProveedor: '2', noFactura: 'FACT-B', importeBrutoPesos: 4000, importePendientePesos: 4000 }),
      ],
      bankStatements: [statement([cargo({ importe: 7000, concepto: 'DISPERSION LOTE' })])],
    });
    for (const pm of result.paymentMatches) {
      expect(pm.cargoMatch?.tier).toBe('batch');
      expect(pm.status).toBe('MATCHED_FULL');
      expect(pm.reason).toMatch(/CARGO agregado del lote/);
    }
  });
});

// ── 2a pasada: cross-account y subset de CARGOs ────────────────────────────

describe('reconcilePayments — 2a pasada cross-account / subset', () => {
  it('el cruce cross-account con CXP previa deja el pago en MATCHED_FULL', () => {
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '111111111' })],
      cxpRecords: [cxp()],
      bankStatements: [statement([cargo()], { cuenta: '70138708851' })],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('cross-account');
    expect(result.paymentMatches[0].status).toBe('MATCHED_FULL');
    expect(result.paymentMatches[0].reason).toMatch(/otra cuenta/);
  });

  it('un segundo pago no puede tomar el CARGO ya reclamado en cross-account', () => {
    const result = reconcilePayments({
      payments: [
        pago({ noPago: 'C1', cuentaBanco: '111111111', claveProveedor: '1', comentarioPago: 'x' }),
        pago({ noPago: 'C2', cuentaBanco: '222222222', claveProveedor: '2', comentarioPago: 'x' }),
      ],
      cxpRecords: [],
      bankStatements: [statement([cargo()], { cuenta: '70138708851' })],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('cross-account');
    expect(result.paymentMatches[1].cargoMatch).toBeUndefined();
  });

  it('cross-account gana el CARGO más cercano en fecha entre varias cuentas', () => {
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '999999999', claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [
        statement([cargo({ cuenta: '70138708851', fechaOperacion: '2026-05-09', referencia: 'LEJOS' })],
          { cuenta: '70138708851' }),
        statement([cargo({ cuenta: '81111111111', fechaOperacion: '2026-05-06', referencia: 'CERCA' })],
          { cuenta: '81111111111' }),
      ],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('cross-account');
    expect(result.paymentMatches[0].cargoMatch?.movement.referencia).toBe('CERCA');
  });

  it('cross-account desempata por orden original cuando la distancia en días es igual', () => {
    // La cuenta B trae un relleno primero, así que su CARGO de 8695 queda con
    // seq 1; el de la cuenta A queda con seq 0 y gana el desempate.
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '999999999', claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [
        statement([
          cargo({ cuenta: '81111111111', importe: 5000, fechaOperacion: '2026-05-07', referencia: 'RELLENO' }),
          cargo({ cuenta: '81111111111', fechaOperacion: '2026-05-07', referencia: 'SEQ-1' }),
        ], { cuenta: '81111111111' }),
        statement([
          cargo({ cuenta: '70138708851', fechaOperacion: '2026-05-07', referencia: 'SEQ-0' }),
        ], { cuenta: '70138708851' }),
      ],
    });
    expect(result.paymentMatches[0].cargoMatch?.movement.referencia).toBe('SEQ-0');
  });

  it('el subset de CARGOs se poda al llegar al máximo de tranches', () => {
    // 5 cargos de 1000 contra un pago de 10000: ninguna combinación de ≤4 suma.
    const result = reconcilePayments({
      payments: [pago({ importePesos: 10000, claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement(
        Array.from({ length: 5 }, (_, i) =>
          cargo({ importe: 1000, fechaOperacion: '2026-05-05', referencia: `T${i}` })),
      )],
    });
    expect(result.paymentMatches[0].cargoMatch).toBeUndefined();
    expect(result.paymentMatches[0].status).toBe('UNMATCHED');
  });

  it('el subset de CARGOs poda la rama que se pasa del importe del pago', () => {
    const result = reconcilePayments({
      payments: [pago({ importePesos: 10000, claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([
        cargo({ importe: 6000, fechaOperacion: '2026-05-05', referencia: 'A' }),
        cargo({ importe: 6000, fechaOperacion: '2026-05-06', referencia: 'B' }),
      ])],
    });
    expect(result.paymentMatches[0].cargoMatch).toBeUndefined();
  });
});

// ── Diagnóstico: CARGO candidato de un pago huérfano ───────────────────────

describe('reconcilePayments — candidato del pago huérfano', () => {
  it('expone el CARGO parecido más cercano aunque esté en otra cuenta y fuera de la ventana de cruce', () => {
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '999999999', claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([cargo({ fechaOperacion: '2026-05-24' })], { cuenta: '70138708851' })],
    });
    const pm = result.paymentMatches[0];
    expect(pm.status).toBe('UNMATCHED');
    expect(pm.unmatchedCandidate).toBeDefined();
    expect(pm.unmatchedCandidate?.daysOff).toBe(20);
    expect(pm.unmatchedCandidate?.sameAccount).toBe(false);
    expect(pm.unmatchedCandidate?.claimed).toBe(false);
  });

  it('elige el candidato más cercano en fecha entre varios', () => {
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '999999999', claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [
        statement([cargo({ cuenta: '70138708851', fechaOperacion: '2026-05-24', referencia: 'LEJOS' })],
          { cuenta: '70138708851' }),
        statement([cargo({ cuenta: '81111111111', fechaOperacion: '2026-05-14', referencia: 'CERCA' })],
          { cuenta: '81111111111' }),
      ],
    });
    expect(result.paymentMatches[0].unmatchedCandidate?.movement.referencia).toBe('CERCA');
    expect(result.paymentMatches[0].unmatchedCandidate?.daysOff).toBe(10);
  });

  it('no expone candidato cuando el CARGO parecido queda fuera de los 45 días', () => {
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '999999999', claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([cargo({ fechaOperacion: '2026-08-01' })], { cuenta: '70138708851' })],
    });
    expect(result.paymentMatches[0].unmatchedCandidate).toBeUndefined();
  });
});

// ── Resolución de la cuenta del pago ───────────────────────────────────────

describe('reconcilePayments — resolución de la cuenta del pago', () => {
  it('colapsa Bajío a la misma llave sintética en ambos lados', () => {
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '', cuentaBancaria: 'BANBAJIO 33850201', claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([cargo({ cuenta: 'BANBAJIO' })], { cuenta: 'BANBAJIO', banco: 'BANBAJIO' })],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('exact');
    expect(result.paymentMatches[0].bankCoverage).toBe('covered');
  });

  it('usa el cluster numérico más largo de cuentaBancaria cuando cuentaBanco es demasiado corta', () => {
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '38', cuentaBancaria: 'CIA 38 CTA 70138708851', claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([cargo()])],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('exact');
  });

  it('conserva el primer cluster cuando los siguientes son más cortos', () => {
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '', cuentaBancaria: 'CTA 70138708851 SUC 38', claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([cargo()])],
    });
    expect(result.paymentMatches[0].cargoMatch?.tier).toBe('exact');
  });

  it('un pago sin cuenta reconocible no encuentra cobertura bancaria', () => {
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '', cuentaBancaria: 'SIN CUENTA', claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([cargo({ importe: 123456 })])],
    });
    expect(result.paymentMatches[0].bankCoverage).toBe('no-account');
    expect(result.paymentMatches[0].reason).toMatch(/no tiene estados de cuenta cargados/);
  });

  it('tolera un pago con AMBOS campos de cuenta vacíos', () => {
    const result = reconcilePayments({
      payments: [pago({ cuentaBanco: '', cuentaBancaria: '', claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([cargo({ importe: 123456 })])],
    });
    expect(result.paymentMatches[0].status).toBe('UNMATCHED');
    expect(result.paymentMatches[0].bankCoverage).toBe('no-account');
  });
});

// ── Normalización de estados de cuenta ─────────────────────────────────────

describe('reconcilePayments — normalización de estados de cuenta', () => {
  it('tolera un estado de cuenta sin arreglo de movimientos', () => {
    const sinMovs = { ...statement([]), movimientos: undefined } as unknown as BankAccountStatement;
    const result = reconcilePayments({
      payments: [pago({ claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [sinMovs],
    });
    expect(result.paymentMatches[0].cargoMatch).toBeUndefined();
    expect(result.paymentMatches[0].bankCoverage).toBe('no-account');
    expect(result.cargoEnrichments.size).toBe(0);
  });

  it('hereda cia/banco/cuenta/moneda del estado de cuenta cuando la línea viene vacía', () => {
    const desnuda = {
      ...cargo(),
      cia: '',
      banco: '',
      nombreBanco: undefined,
      cuenta: '',
      moneda: '',
    } as BankStatementLine;
    const result = reconcilePayments({
      payments: [pago({ claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([desnuda])],
    });
    const cm = result.paymentMatches[0].cargoMatch;
    expect(cm?.tier).toBe('exact');
    expect(cm?.movement.cuenta).toBe('70138708851');
    expect(cm?.movement.banco).toBe('BANAMEX');
    expect(cm?.movement.moneda).toBe('MXN');
  });

  it('tolera movimientos con fecha de operación ilegible', () => {
    const result = reconcilePayments({
      payments: [pago({ claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([cargo({ fechaOperacion: '' })])],
    });
    expect(result.paymentMatches[0].cargoMatch).toBeUndefined();
    // Sin fecha legible no hay cobertura de fechas para la cuenta.
    expect(result.paymentMatches[0].bankCoverage).toBe('no-account');
  });

  it('ignora movimientos cuya cuenta no tiene dígitos al construir la cobertura', () => {
    const result = reconcilePayments({
      payments: [pago({ claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([cargo({ cuenta: '', importe: 111 })], { cuenta: 'N/A' })],
    });
    expect(result.paymentMatches[0].bankCoverage).toBe('no-account');
  });

  it('extiende hacia atrás el rango de cobertura cuando llega un movimiento anterior', () => {
    const result = reconcilePayments({
      payments: [pago({ fechaPago: '2026-05-02', importePesos: 555, claveProveedor: '99', comentarioPago: 'x' })],
      cxpRecords: [],
      bankStatements: [statement([
        cargo({ importe: 111, fechaOperacion: '2026-05-04' }),
        cargo({ importe: 222, fechaOperacion: '2026-05-01' }),
      ])],
    });
    // 2026-05-02 cae dentro de [2026-05-01, 2026-05-04] gracias al segundo mov.
    expect(result.paymentMatches[0].bankCoverage).toBe('covered');
  });
});
