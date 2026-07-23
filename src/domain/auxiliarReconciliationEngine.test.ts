import { describe, it, expect } from 'vitest';
import { reconcileAuxiliar, deriveFlujo, emptyAuxiliarReconResult } from './auxiliarReconciliationEngine';
import { adaptAuxiliarForProjection } from './auxiliarProjectionAdapter';
import { buildHistoricalMonths } from './cashFlowEngine';
import type { AuxiliarContableRecord, BankAccountStatement, BankStatementLine, CobranzaRecord } from '../services/jdeTypes';
import type { CXPRecord } from './persistence';

const ACCT = '99988877766';

function glLine(patch: Partial<AuxiliarContableRecord> = {}): AuxiliarContableRecord {
  return {
    cia: '00042',
    cuentaContable: '42.1020.0010409',
    idCuenta: patch.idCuenta ?? '0164',
    cuentaObjeto: '1020',
    nombreCuenta: 'BANAMEX - 7013',
    cuentaBanco: ACCT,
    tipoDocto: 'RI',
    noDocto: 1,
    noFactura: '',
    noOrdenCompra: '',
    fechaContable: '2026-04-13',
    tipoLibro: 'AA',
    noBatch: 1,
    tipoBatch: 'G',
    estatusConciliado: '',
    importe: 1000,
    moneda: 'MXP',
    tipoCambio: 0,
    posteo: 'P',
    reversa: '',
    concepto: 'cobro',
    explicacion: 'cobro cliente',
    nombre: 'Cliente X',
    tipoPago: '',
    noPago: '',
    fechaPago: '',
    documentoOriginal: '',
    importeOriginal: 0,
    ...patch,
  };
}

function bankLine(patch: Partial<BankStatementLine> = {}): BankStatementLine {
  return {
    cia: '00042',
    banco: 'BANAMEX',
    cuenta: ACCT,
    moneda: 'MXN',
    fechaOperacion: '2026-04-13',
    referencia: 'R1',
    concepto: 'deposito',
    tipoMovimiento: 'ABONO',
    importe: 1000,
    ...patch,
  };
}

function statement(movimientos: BankStatementLine[]): BankAccountStatement {
  return {
    cia: '00042',
    banco: 'BANAMEX',
    cuenta: ACCT,
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-04-30',
    movimientos,
  };
}

describe('deriveFlujo', () => {
  it('positive importe → ingreso, negative → egreso', () => {
    expect(deriveFlujo({ importe: 500 })).toBe('ingreso');
    expect(deriveFlujo({ importe: -500 })).toBe('egreso');
  });
});

describe('reconcileAuxiliar', () => {
  it('matches a GL ingreso line to an ABONO at exact amount + date', () => {
    const res = reconcileAuxiliar([glLine()], [statement([bankLine()])]);
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].matchTier).toBe('exact');
    expect(res.lines[0].bankMovementKey).toBeTruthy();
    expect(res.bankOrphans).toHaveLength(0);
    expect(res.summary.ingresoCruzadas).toBe(1);
  });

  it('matches within tolerance (amount ±0.5%, date ±5d)', () => {
    const res = reconcileAuxiliar(
      [glLine({ importe: 1000 })],
      [statement([bankLine({ importe: 1003, fechaOperacion: '2026-04-15' })])],
    );
    expect(res.lines[0].matchTier).toBe('tolerance');
  });

  it('flags estatusConciliado="R" as jde-reconciled', () => {
    const res = reconcileAuxiliar([glLine({ estatusConciliado: 'R' })], [statement([])]);
    expect(res.lines[0].matchTier).toBe('jde-reconciled');
  });

  it('leaves a GL line with no matching bank movement as pendiente-revision', () => {
    // La cuenta SÍ tiene un movimiento bancario cargado, pero el importe está
    // muy fuera de tolerancia — match falla en la fase de candidatos.
    // Los gl-orphans no-asiento-contable se promueven a pendiente-revision
    // (cola humana, fuera del denominador del % cruce).
    const res = reconcileAuxiliar(
      [glLine({ importe: 1000 })],
      [statement([bankLine({ importe: 99999, fechaOperacion: '2026-04-13' })])],
    );
    expect(res.lines[0].matchTier).toBe('pendiente-revision');
    expect(res.summary.pendienteRevisionLineas).toBe(1);
    expect(res.summary.glOrphanLineas).toBe(0);
  });

  it('buckets a GL line whose cuenta has no bank movements as cuenta-no-en-banco', () => {
    // statement([]) significa que la cía tiene banco cargado pero ESTA cuenta
    // específica no tiene movimientos — gap estructural, no orphan real.
    const res = reconcileAuxiliar([glLine()], [statement([])]);
    expect(res.lines[0].matchTier).toBe('cuenta-no-en-banco');
    expect(res.summary.cuentaNoEnBancoLineas).toBe(1);
    expect(res.summary.glOrphanLineas).toBe(0);
  });

  it('does not cross USD aux against MXN bank movement (currency-aware match)', () => {
    // Línea aux en USD: no debe emparejar con movimiento bancario MXN del
    // mismo importe absoluto — pools separados por moneda. Cae a
    // pendiente-revision (no es asiento-contable porque RI no es journal).
    const res = reconcileAuxiliar(
      [glLine({ importe: 1000, moneda: 'USD' })],
      [statement([bankLine({ importe: 1000, moneda: 'MXN' })])],
    );
    expect(res.lines[0].matchTier).toBe('pendiente-revision');
  });

  it('matches USD aux against USD bank movement', () => {
    const res = reconcileAuxiliar(
      [glLine({ importe: 1000, moneda: 'USD' })],
      [statement([bankLine({ importe: 1000, moneda: 'USD' })])],
    );
    expect(res.lines[0].matchTier).toBe('exact');
  });

  it('buckets journal tipoDocto orphans (JX, JG, JR, VR, etc.) as asiento-contable', () => {
    // JX = Revaluación moneda extranjera — asiento contable puro, no es mov
    // bancario. Sin contraparte → asiento-contable (no pendiente-revision).
    const res = reconcileAuxiliar(
      [glLine({ tipoDocto: 'JX' })],
      [statement([bankLine({ importe: 9999 })])],
    );
    expect(res.lines[0].matchTier).toBe('asiento-contable');
    expect(res.summary.asientoContableLineas).toBe(1);
    expect(res.summary.pendienteRevisionLineas).toBe(0);
  });

  it('reports a bank movement with no GL line as a bank-orphan', () => {
    const res = reconcileAuxiliar([], [statement([bankLine({ concepto: 'comision' })])]);
    expect(res.bankOrphans).toHaveLength(1);
    expect(res.bankOrphans[0].concepto).toBe('comision');
  });

  it('buckets objeto-1010 lines as caja, never gl-orphan', () => {
    const res = reconcileAuxiliar([glLine({ cuentaObjeto: '1010' })], [statement([])]);
    expect(res.lines[0].matchTier).toBe('caja');
    expect(res.lines[0].esCaja).toBe(true);
    expect(res.summary.cajaLineas).toBe(1);
    expect(res.summary.glOrphanLineas).toBe(0);
  });

  it('matches a GL egreso line to a CARGO', () => {
    const res = reconcileAuxiliar(
      [glLine({ importe: -2000, tipoDocto: 'PK' })],
      [statement([bankLine({ tipoMovimiento: 'CARGO', importe: 2000 })])],
    );
    expect(res.lines[0].flujo).toBe('egreso');
    expect(res.lines[0].matchTier).toBe('exact');
    expect(res.summary.egresoCruzadas).toBe(1);
  });

  it('does not cross an ingreso GL line against a CARGO (direction must match)', () => {
    // Ingreso aux vs CARGO bancario: pools de flujo separados, no cruzan.
    // Cae a pendiente-revision (RI no es journal-style → no asiento-contable).
    const res = reconcileAuxiliar(
      [glLine({ importe: 1000 })],
      [statement([bankLine({ tipoMovimiento: 'CARGO', importe: 1000 })])],
    );
    expect(res.lines[0].matchTier).toBe('pendiente-revision');
  });

  it('records source confirmation keyed by factura', () => {
    const res = reconcileAuxiliar([glLine({ noFactura: 'RI-77' })], [statement([bankLine()])]);
    const conf = res.sourceConfirmation.get('factura:00042::RI-77');
    expect(conf?.confirmed).toBe(true);
    expect(conf?.flujo).toBe('ingreso');
  });

  it('classifies egresos with tipoPago/noPago as pago even when No_Factura is populated', () => {
    const res = reconcileAuxiliar(
      [glLine({
        importe: -1160,
        tipoDocto: 'PV',
        noFactura: 'PV900',
        tipoPago: 'PV',
        noPago: '900',
        nombre: 'Proveedor Pago',
      })],
      [statement([bankLine({ tipoMovimiento: 'CARGO', importe: 1160 })])],
    );

    expect(res.lines[0].source).toMatchObject({
      kind: 'pago',
      ref: 'PV900',
      contraparte: 'Proveedor Pago',
    });
    expect(res.sourceConfirmation.get('pago:00042::PV900')?.confirmed).toBe(true);
    expect(res.sourceConfirmation.get('factura:00042::PV900')?.confirmed).toBe(true);
  });

  it('empty result has zeroed summary', () => {
    const empty = emptyAuxiliarReconResult();
    expect(empty.lines).toHaveLength(0);
    expect(empty.summary.totalLineas).toBe(0);
    expect(empty.inconsistencies).toEqual([]);
    expect(empty.summary.inconsistencyCounts['non-bank-batch-in-1020']).toBe(0);
    expect(empty.summary.cruzadasSinR).toBe(0);
  });
});

describe('reconcileAuxiliar — inconsistencies', () => {
  it('flags non-bank-batch-in-1020 when Tipo_Batch is outside BANK_TIPO_BATCH', () => {
    const res = reconcileAuxiliar(
      [glLine({ tipoBatch: 'N', cuentaObjeto: '1020' })],
      [statement([])],
    );
    expect(res.summary.inconsistencyCounts['non-bank-batch-in-1020']).toBe(1);
    expect(
      res.inconsistencies.some(
        (i) => i.kind === 'non-bank-batch-in-1020' && i.detail.includes('N'),
      ),
    ).toBe(true);
  });

  it('does NOT flag non-bank-batch for objeto 1010 (caja)', () => {
    const res = reconcileAuxiliar(
      [glLine({ tipoBatch: 'N', cuentaObjeto: '1010' })],
      [statement([])],
    );
    expect(res.summary.inconsistencyCounts['non-bank-batch-in-1020']).toBe(0);
  });

  it('skips non-bank-batch detection when tipoBatchFilter is null', () => {
    const res = reconcileAuxiliar(
      [glLine({ tipoBatch: 'RB' })],
      [statement([])],
      { tipoBatchFilter: null },
    );
    expect(res.summary.inconsistencyCounts['non-bank-batch-in-1020']).toBe(0);
  });

  it('counts matched-without-R as cruzadasSinR (info only, not an inconsistency)', () => {
    const res = reconcileAuxiliar(
      [glLine({ estatusConciliado: '' })],
      [statement([bankLine()])],
    );
    expect(res.lines[0].matchTier).toBe('exact');
    expect(res.summary.cruzadasSinR).toBe(1);
    expect(res.summary.conciliadasJde).toBe(0);
    expect(res.inconsistencies.some((i) => (i.kind as string) === 'jde-not-marked-reconciled')).toBe(false);
  });

  it('R promotes match to jde-reconciled and counts as conciliadasJde', () => {
    const res = reconcileAuxiliar(
      [glLine({ estatusConciliado: 'R' })],
      [statement([bankLine()])],
    );
    expect(res.lines[0].matchTier).toBe('jde-reconciled');
    expect(res.summary.conciliadasJde).toBe(1);
    expect(res.summary.cruzadasSinR).toBe(0);
  });

  // gsaid es el ID JDE de la cuenta bancaria (account-level); repetirse en
  // múltiples líneas es la cardinalidad esperada, no una inconsistencia.

});

describe('adaptAuxiliarForProjection', () => {
  function cobranza(): CobranzaRecord {
    return { cia: '00042', noFactura: 'RI-77', noCliente: 5538846, nombreCliente: 'Cliente X' } as unknown as CobranzaRecord;
  }
  function cxp(): CXPRecord {
    return { cia: '00042', noFactura: 'F-9', noProveedor: 'P-1' } as unknown as CXPRecord;
  }

  it('derives cobradaBancoKeys from confirmed ingreso facturas', () => {
    const res = reconcileAuxiliar([glLine({ noFactura: 'RI-77' })], [statement([bankLine()])]);
    const bridge = adaptAuxiliarForProjection(res, [], [cobranza()]);
    expect(bridge.cobradaBancoKeys.has('00042::RI-77')).toBe(true);
  });

  it('derives paidCxpKeys from confirmed egreso facturas', () => {
    const res = reconcileAuxiliar(
      [glLine({ importe: -500, tipoDocto: 'PK', noFactura: 'F-9' })],
      [statement([bankLine({ tipoMovimiento: 'CARGO', importe: 500 })])],
    );
    const bridge = adaptAuxiliarForProjection(res, [cxp()], []);
    expect(bridge.paidCxpKeys.has('00042::F-9::P-1')).toBe(true);
  });

  it('builds a cargo enrichment for a matched egreso line', () => {
    const res = reconcileAuxiliar(
      [glLine({ importe: -500, tipoDocto: 'PK', nombre: 'Proveedor Z' })],
      [statement([bankLine({ tipoMovimiento: 'CARGO', importe: 500 })])],
    );
    const bridge = adaptAuxiliarForProjection(res, [], []);
    expect(bridge.cargoEnrichments.size).toBe(1);
    const [enr] = [...bridge.cargoEnrichments.values()];
    expect(enr.status).toBe('MATCHED');
    expect(enr.payments?.[0].nombreProveedor).toBe('Proveedor Z');
  });
});

describe('reconcileAuxiliar — traspasos internos económicos (cuadre con verdad bancaria)', () => {
  // Segunda cuenta propia del grupo (misma cía) para los pares CARGO↔ABONO.
  const ACCT2 = '11122233344';
  /** Cuenta RESERVA real del catálogo de bancos (flow=neutro). */
  const NEUTRAL_ACCT = '70144758151';

  function statementFor(cuenta: string, movimientos: BankStatementLine[]): BankAccountStatement {
    return {
      cia: '00042',
      banco: 'BANAMEX',
      cuenta,
      moneda: 'MXN',
      fechaEstadoCuenta: '2026-04-30',
      movimientos,
    };
  }

  it('buckets a GL line matched to a pair-matched transfer leg as interno (not cruzada)', () => {
    // Traspaso interno: CARGO 5000 en cuenta A compensado con ABONO 5000 en
    // cuenta B el mismo día (pair-matched). La pata GL asentada en B debe
    // emparejar con el ABONO pero clasificarse `interno` — la verdad bancaria
    // (buildHistoricalMonths) descarta ambos movimientos, así que contarla
    // como ingreso cruzado descuadraba Dashboard vs Planeación.
    const statements = [
      statementFor(ACCT, [bankLine({ cuenta: ACCT, tipoMovimiento: 'CARGO', importe: 5000, referencia: 'T-OUT' })]),
      statementFor(ACCT2, [bankLine({ cuenta: ACCT2, tipoMovimiento: 'ABONO', importe: 5000, referencia: 'T-IN' })]),
    ];
    const res = reconcileAuxiliar(
      [glLine({ importe: 5000, cuentaBanco: ACCT2 })],
      statements,
    );
    expect(res.lines[0].matchTier).toBe('interno');
    expect(res.lines[0].bankMovementKey).toBeTruthy();
    expect(res.summary.internoLineas).toBe(1);
    expect(res.summary.ingresoMontoCruzado).toBe(0);
    expect(res.reconciledByCompanyMonth.size).toBe(0);
    // La pata CARGO sin línea GL tampoco es un faltante real → no orphan.
    expect(res.bankOrphans).toHaveLength(0);
  });

  it('buckets a GL line on a catalog-neutral account (RESERVA) as interno pre-match', () => {
    const res = reconcileAuxiliar(
      [glLine({ importe: 800, cuentaBanco: NEUTRAL_ACCT })],
      [statementFor(NEUTRAL_ACCT, [bankLine({ cuenta: NEUTRAL_ACCT, importe: 800 })])],
    );
    expect(res.lines[0].matchTier).toBe('interno');
    expect(res.reconciledByCompanyMonth.size).toBe(0);
    // El movimiento de la cuenta neutra no aparece como orphan.
    expect(res.bankOrphans).toHaveLength(0);
  });

  it('does not emit enrichments for interno-matched lines through the bridge', () => {
    const statements = [
      statementFor(ACCT, [bankLine({ cuenta: ACCT, tipoMovimiento: 'CARGO', importe: 5000, referencia: 'T-OUT' })]),
      statementFor(ACCT2, [bankLine({ cuenta: ACCT2, tipoMovimiento: 'ABONO', importe: 5000, referencia: 'T-IN' })]),
    ];
    const res = reconcileAuxiliar(
      [glLine({ importe: 5000, cuentaBanco: ACCT2, noFactura: 'RI-99' })],
      statements,
    );
    const bridge = adaptAuxiliarForProjection(res, [], []);
    expect(bridge.abonoEnrichments).toHaveLength(0);
    expect(bridge.cargoEnrichments.size).toBe(0);
    // Tampoco confirma la factura: el ABONO era un traspaso, no un cobro.
    expect(bridge.cobradaBancoKeys.has('00042::RI-99')).toBe(false);
  });

  it('reconciledByCompanyMonth equals buildHistoricalMonths economic truth when GL fully covers real flow', () => {
    // El invariante de cuadre entre módulos: con las líneas GL cubriendo todo
    // el flujo real, los totales reconciliados por mes deben igualar el
    // ingreso/egreso económico del banco (que excluye traspasos pareados y
    // cuentas neutras del catálogo).
    const statements = [
      statementFor(ACCT, [
        bankLine({ cuenta: ACCT, importe: 1000, referencia: 'R-REAL-IN' }),
        bankLine({ cuenta: ACCT, tipoMovimiento: 'CARGO', importe: 500, referencia: 'R-REAL-OUT', fechaOperacion: '2026-04-20' }),
        bankLine({ cuenta: ACCT, tipoMovimiento: 'CARGO', importe: 5000, referencia: 'T-OUT' }),
      ]),
      statementFor(ACCT2, [
        bankLine({ cuenta: ACCT2, tipoMovimiento: 'ABONO', importe: 5000, referencia: 'T-IN' }),
      ]),
      statementFor(NEUTRAL_ACCT, [
        bankLine({ cuenta: NEUTRAL_ACCT, importe: 800, referencia: 'N-IN' }),
      ]),
    ];
    const res = reconcileAuxiliar(
      [
        glLine({ importe: 1000 }),
        glLine({ importe: -500, tipoDocto: 'PK', idCuenta: '0165', fechaContable: '2026-04-20' }),
        // Pata GL del traspaso — debe quedar interno, no inflar el cruce.
        glLine({ importe: 5000, idCuenta: '0166', cuentaBanco: ACCT2 }),
      ],
      statements,
    );
    const bank = buildHistoricalMonths(statements).find((m) => m.yearMonth === '2026-04');
    expect(bank).toBeTruthy();
    let ingreso = 0;
    let egreso = 0;
    for (const t of res.reconciledByCompanyMonth.values()) {
      ingreso += t.ingresoCruzado;
      egreso += t.egresoCruzado;
    }
    expect(ingreso).toBe(bank!.income);
    expect(egreso).toBe(bank!.expense);
    expect(ingreso).toBe(1000);
    expect(egreso).toBe(500);
  });

  it('marks every bank orphan as out-of-window when there are no GL 1020 lines (no aux window)', () => {
    const res = reconcileAuxiliar([], [statement([bankLine({ concepto: 'comision' })])]);
    expect(res.bankOrphans).toHaveLength(1);
    expect(res.bankOrphans[0].outOfWindow).toBe(true);
    expect(res.summary.bankOrphanLineas).toBe(0);
    expect(res.summary.bankOrphanOutOfWindowLineas).toBe(1);
  });
});

describe('reconciledByCompanyMonth (MOTOR 1)', () => {
  it('aggregates crossed ingreso/egreso per (cia, month) keyed by bankDate', () => {
    const res = reconcileAuxiliar(
      [
        glLine({ importe: 1000, fechaContable: '2026-04-13' }),
        glLine({ importe: -500, tipoDocto: 'PK', idCuenta: '0165', fechaContable: '2026-04-20' }),
      ],
      [statement([
        bankLine({ importe: 1000, fechaOperacion: '2026-04-13' }),
        bankLine({ tipoMovimiento: 'CARGO', importe: 500, fechaOperacion: '2026-04-20', referencia: 'R2' }),
      ])],
    );
    const totals = res.reconciledByCompanyMonth.get('00042::2026-04');
    expect(totals).toBeTruthy();
    expect(totals!.ingresoCruzado).toBe(1000);
    expect(totals!.egresoCruzado).toBe(500);
  });

  it('Σ per month equals summary.ingresoMontoCruzado / egresoMontoCruzado', () => {
    const res = reconcileAuxiliar(
      [
        glLine({ importe: 1000, fechaContable: '2026-04-13' }),
        glLine({ importe: 700, idCuenta: '0166', fechaContable: '2026-05-09' }),
        glLine({ importe: -500, tipoDocto: 'PK', idCuenta: '0167', fechaContable: '2026-05-09' }),
      ],
      [statement([
        bankLine({ importe: 1000, fechaOperacion: '2026-04-13' }),
        bankLine({ importe: 700, fechaOperacion: '2026-05-09', referencia: 'R3' }),
        bankLine({ tipoMovimiento: 'CARGO', importe: 500, fechaOperacion: '2026-05-09', referencia: 'R4' }),
      ])],
    );
    let ingreso = 0;
    let egreso = 0;
    for (const t of res.reconciledByCompanyMonth.values()) {
      ingreso += t.ingresoCruzado;
      egreso += t.egresoCruzado;
    }
    expect(ingreso).toBe(res.summary.ingresoMontoCruzado);
    expect(egreso).toBe(res.summary.egresoMontoCruzado);
  });

  it('surfaces the per-month totals through the projection bridge', () => {
    const res = reconcileAuxiliar([glLine()], [statement([bankLine()])]);
    const bridge = adaptAuxiliarForProjection(res, [], []);
    expect(bridge.reconciledByCompanyMonth.get('00042::2026-04')?.ingresoCruzado).toBe(1000);
  });

  it('empty result has an empty reconciledByCompanyMonth map', () => {
    expect(emptyAuxiliarReconResult().reconciledByCompanyMonth.size).toBe(0);
  });
});

describe('matchTierBreakdown — telemetría por tier (sin cambiar el matching)', () => {
  // Auditoría BD 2026-07-22: la marca nativa 'R' de JDE cubre ~1.1% del
  // histórico 1010-1020 (0.13% jun-2026) — casi todo lo concilia Midas. El
  // desglose mide cuánto aporta cada tier para la decisión con Contabilidad.
  it("separa las líneas 'R' de los tiers propios de Midas con % sobre el cruce", () => {
    const res = reconcileAuxiliar(
      [
        // 'R' de JDE, sin contraparte bancaria → jde-reconciled por promoción.
        glLine({ estatusConciliado: 'R', noDocto: 1, importe: 500 }),
        // Cruce propio de Midas (exact).
        glLine({ noDocto: 2, importe: 1000 }),
        // Sin contraparte y sin 'R' → no cruza (no cuenta en el % del cruce).
        glLine({ noDocto: 3, importe: 77.77, fechaContable: '2026-04-20' }),
      ],
      [statement([bankLine({ importe: 1000 })])],
    );

    const byTier = new Map(res.summary.matchTierBreakdown.map((t) => [t.tier, t]));
    const r = byTier.get('jde-reconciled')!;
    expect(r.lineas).toBe(1);
    expect(r.monto).toBe(500);
    expect(r.cruzada).toBe(true);
    expect(r.pctDeCruzadas).toBeCloseTo(50);

    const exact = byTier.get('exact')!;
    expect(exact.lineas).toBe(1);
    expect(exact.cruzada).toBe(true);
    expect(exact.pctDeCruzadas).toBeCloseTo(50);

    // Los tiers no-cruce aparecen en el desglose pero sin % del cruce.
    const noCruce = res.summary.matchTierBreakdown.filter((t) => !t.cruzada);
    expect(noCruce.length).toBeGreaterThan(0);
    for (const t of noCruce) expect(t.pctDeCruzadas).toBeNull();

    // El desglose cubre TODAS las líneas (se acumula antes de los continue).
    const totalLineas = res.summary.matchTierBreakdown.reduce((s, t) => s + t.lineas, 0);
    expect(totalLineas).toBe(res.summary.totalLineas);

    // Cruzados primero, ordenados por volumen.
    const crossedFirst = res.summary.matchTierBreakdown.map((t) => t.cruzada);
    expect(crossedFirst.slice(0, crossedFirst.filter(Boolean).length).every(Boolean)).toBe(true);
  });

  it('cero cambios de comportamiento: los conteos previos del summary no se mueven', () => {
    const res = reconcileAuxiliar(
      [glLine({ estatusConciliado: 'R', importe: 500 }), glLine({ noDocto: 2, importe: 1000 })],
      [statement([bankLine({ importe: 1000 })])],
    );
    // Mismos campos que ya cubrían los tests previos — el breakdown es aditivo.
    expect(res.summary.conciliadasJde).toBe(1);
    expect(res.summary.ingresoCruzadas).toBe(2);
  });

  it('resultado vacío trae matchTierBreakdown: []', () => {
    expect(emptyAuxiliarReconResult().summary.matchTierBreakdown).toEqual([]);
  });
});
