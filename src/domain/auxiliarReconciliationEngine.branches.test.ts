/**
 * Cobertura de RAMAS del motor de conciliación Auxiliar Contable ↔ Bancos.
 *
 * Complemento de `auxiliarReconciliationEngine.test.ts`: aquel pinea el cuadre
 * económico y los tiers principales; éste ejercita los caminos defensivos y
 * los buckets estructurales que no se alcanzaban (moneda alterna, cuenta
 * centinela, fechas ilegibles, `ciaFilter`, competencia por un mismo
 * movimiento, cross-account, derivación de documento fuente). Todas las
 * aserciones describen el comportamiento REAL observado — no se tocó el motor.
 *
 * Ramas documentadas como INALCANZABLES desde `reconcileAuxiliar` (no se
 * testean a propósito):
 *   • `sourceConfirmation` (`rec ? sourceKeysFor(rec) : []`): toda línea se
 *     registra en `recByGlKey` antes, así que `rec` nunca es undefined.
 *   • `buildSummary` rama `matchTier === 'gl-orphan'`: el paso 5c reclasifica
 *     TODO gl-orphan a `pendiente-revision` antes de construir el summary.
 *   • `buildSummary` `agg.lineas > 0 ? … : 0`: una entrada de `ciaAgg` sólo
 *     existe tras incrementar `lineas`.
 *   • `buildSummary` `totalCruzadasLineas > 0 ? … : 0` para un tier cruzado:
 *     toda línea cruzada incrementa `ingresoCruzadas`/`egresoCruzadas`.
 */
import { describe, it, expect } from 'vitest';
import { reconcileAuxiliar } from './auxiliarReconciliationEngine';
import type { AuxiliarContableRecord, BankAccountStatement, BankStatementLine } from '../services/jdeTypes';

const ACCT = '99988877766';
const ACCT2 = '11122233344';

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

function statementFor(cuenta: string, movimientos: BankStatementLine[], cia = '00042'): BankAccountStatement {
  return {
    cia,
    banco: 'BANAMEX',
    cuenta,
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-04-30',
    movimientos,
  };
}

function statement(movimientos: BankStatementLine[]): BankAccountStatement {
  return statementFor(ACCT, movimientos);
}

// ── Normalización de moneda y de cuenta ────────────────────────────────────

describe('reconcileAuxiliar — normalización de moneda', () => {
  it("colapsa 'DOLARES' del auxiliar al mismo pool que 'USD' del banco", () => {
    const res = reconcileAuxiliar(
      [glLine({ moneda: 'DOLARES' })],
      [statement([bankLine({ moneda: 'USD' })])],
    );
    expect(res.lines[0].matchTier).toBe('exact');
  });

  it('trata la moneda ausente como MXN en ambos lados', () => {
    const gl = { ...glLine(), moneda: undefined } as unknown as AuxiliarContableRecord;
    const bank = { ...bankLine(), moneda: undefined } as unknown as BankStatementLine;
    const res = reconcileAuxiliar([gl], [statement([bank])]);
    expect(res.lines[0].matchTier).toBe('exact');
  });
});

describe('reconcileAuxiliar — llave de cuenta', () => {
  it('cruza por la cuenta centinela del catálogo (BANBAJIO, sin dígitos)', () => {
    const res = reconcileAuxiliar(
      [glLine({ cuentaBanco: 'BANBAJIO' })],
      [statementFor('BANBAJIO', [bankLine({ cuenta: 'BANBAJIO' })])],
    );
    expect(res.lines[0].matchTier).toBe('exact');
    expect(res.bankOrphans).toHaveLength(0);
  });

  it('bucketea como sin-cuenta-aux una cuentaBanco sin dígitos ni centinela', () => {
    const res = reconcileAuxiliar(
      [glLine({ cuentaBanco: 'N/A' })],
      [statement([bankLine()])],
    );
    expect(res.lines[0].matchTier).toBe('sin-cuenta-aux');
    expect(res.summary.sinCuentaAuxLineas).toBe(1);
    expect(res.summary.sinCuentaAuxMonto).toBe(1000);
  });

  it('bucketea como sin-cuenta-aux la cuentaBanco vacía o en blanco', () => {
    const res = reconcileAuxiliar(
      [glLine({ noDocto: 1, cuentaBanco: '' }), glLine({ noDocto: 2, idCuenta: '0165', cuentaBanco: '   ' })],
      [statement([bankLine()])],
    );
    expect(res.lines.map((l) => l.matchTier)).toEqual(['sin-cuenta-aux', 'sin-cuenta-aux']);
    expect(res.summary.sinCuentaAuxLineas).toBe(2);
  });

  it('usa cuentaBancos del movimiento cuando cuenta viene vacía', () => {
    const res = reconcileAuxiliar(
      [glLine()],
      [statement([bankLine({ cuenta: '', cuentaBancos: ACCT })])],
    );
    expect(res.lines[0].matchTier).toBe('exact');
  });

  it('deja fuera del pool un movimiento cuya cuenta no produce llave', () => {
    const huerfano = { ...bankLine(), cuenta: '', cuentaBancos: undefined } as BankStatementLine;
    const res = reconcileAuxiliar([glLine()], [statement([huerfano])]);
    // La cuenta aux existe pero /bancos no expone movimientos para ella.
    expect(res.lines[0].matchTier).toBe('cuenta-no-en-banco');
    expect(res.bankOrphans).toHaveLength(1);
  });

  it('deja fuera del pool un movimiento clasificado como traspaso interno', () => {
    const res = reconcileAuxiliar(
      [glLine()],
      [statement([bankLine({ concepto: 'TRASPASO REF 456' })])],
    );
    expect(res.lines[0].matchTier).toBe('cuenta-no-en-banco');
    // Un traspaso sin pata GL no es un faltante contable real.
    expect(res.bankOrphans).toHaveLength(0);
  });
});

// ── Fechas degradadas ──────────────────────────────────────────────────────

describe('reconcileAuxiliar — fechas degradadas', () => {
  it('una línea sin fecha contable no cruza y queda fuera del agregado por mes', () => {
    const res = reconcileAuxiliar(
      [glLine({ fechaContable: '' })],
      [statement([bankLine()])],
    );
    expect(res.lines[0].matchTier).toBe('pendiente-revision');
    expect(res.summary.auxWindow).toEqual({ min: null, max: null });
    expect(res.reconciledByCompanyMonth.size).toBe(0);
  });

  it('una fecha contable ilegible impide el cruce (delta de días infinito)', () => {
    const res = reconcileAuxiliar(
      [glLine({ fechaContable: '0000-99-99' })],
      [statement([bankLine()])],
    );
    expect(res.lines[0].matchTier).toBe('pendiente-revision');
    expect(res.lines[0].bankMovementKey).toBeUndefined();
  });

  it('descarta un movimiento bancario fuera de la ventana de 45 días', () => {
    const res = reconcileAuxiliar(
      [glLine({ fechaContable: '2026-04-13' })],
      [statement([
        bankLine({ fechaOperacion: '2026-01-01', referencia: 'LEJOS' }),
        bankLine({ fechaOperacion: '2026-04-14', referencia: 'CERCA' }),
      ])],
    );
    expect(res.lines[0].matchTier).toBe('tolerance');
    expect(res.lines[0].bankDate).toBe('2026-04-14');
  });
});

// ── Filtro de compañía ─────────────────────────────────────────────────────

describe('reconcileAuxiliar — ciaFilter', () => {
  it('descarta líneas, estados de cuenta y ventana aux de las cías fuera del filtro', () => {
    const res = reconcileAuxiliar(
      [
        glLine({ cia: '00042', fechaContable: '2026-04-13' }),
        glLine({ cia: '00099', idCuenta: '0165', fechaContable: '2026-01-05' }),
      ],
      [
        statement([bankLine()]),
        statementFor(ACCT2, [bankLine({ cia: '00099', cuenta: ACCT2 })], '00099'),
      ],
      { ciaFilter: new Set(['00042']) },
    );
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0].cia).toBe('00042');
    expect(res.lines[0].matchTier).toBe('exact');
    expect(res.summary.auxWindow).toEqual({ min: '2026-04-13', max: '2026-04-13' });
    // El movimiento de la cía excluida no entra ni como orphan.
    expect(res.bankOrphans).toHaveLength(0);
  });
});

// ── Buckets estructurales ──────────────────────────────────────────────────

describe('reconcileAuxiliar — buckets estructurales', () => {
  it('bucketea como sin-banco cuando no hay ningún estado de cuenta cargado', () => {
    const res = reconcileAuxiliar([glLine()], []);
    expect(res.lines[0].matchTier).toBe('sin-banco');
    expect(res.summary.sinBancoLineas).toBe(1);
    expect(res.summary.sinBancoMonto).toBe(1000);
    expect(res.summary.ingresoLineas).toBe(0);
  });

  it('bucketea tipoDocto=VI como asiento-interno', () => {
    const res = reconcileAuxiliar(
      [glLine({ tipoDocto: 'VI' })],
      [statement([bankLine()])],
    );
    expect(res.lines[0].matchTier).toBe('asiento-interno');
    expect(res.summary.asientoInternoLineas).toBe(1);
    expect(res.summary.asientoInternoMonto).toBe(1000);
  });

  it('bucketea como interno una línea aux con narrativa de traspaso', () => {
    const res = reconcileAuxiliar(
      [glLine({ concepto: 'TRASPASO REF 789', explicacion: 'TRASPASO REF 789' })],
      [statement([bankLine()])],
    );
    expect(res.lines[0].matchTier).toBe('interno');
    expect(res.summary.internoLineas).toBe(1);
  });

  it('deja como pendiente-revision un orphan con tipoDocto vacío o ausente', () => {
    const sinTipo = { ...glLine({ noDocto: 2, idCuenta: '0165' }), tipoDocto: undefined } as unknown as AuxiliarContableRecord;
    const res = reconcileAuxiliar(
      [glLine({ tipoDocto: '' }), sinTipo],
      [statement([bankLine({ importe: 99999 })])],
      { tipoBatchFilter: null },
    );
    expect(res.lines.map((l) => l.matchTier)).toEqual(['pendiente-revision', 'pendiente-revision']);
    expect(res.summary.pendienteRevisionLineas).toBe(2);
  });

  it('reclasifica a asiento-contable las provisiones de finiquito (tipoBatch=G + tipoDocto=PF)', () => {
    const res = reconcileAuxiliar(
      [glLine({ tipoDocto: 'PF', tipoBatch: 'G' })],
      [statement([bankLine({ importe: 99999 })])],
      { tipoBatchFilter: null },
    );
    expect(res.lines[0].matchTier).toBe('asiento-contable');
    expect(res.summary.asientoContableLineas).toBe(1);
  });

  it('NO reclasifica PF cuando el tipoBatch no es G', () => {
    const res = reconcileAuxiliar(
      [glLine({ tipoDocto: 'PF', tipoBatch: 'K' })],
      [statement([bankLine({ importe: 99999 })])],
      { tipoBatchFilter: null },
    );
    expect(res.lines[0].matchTier).toBe('pendiente-revision');
  });
});

// ── Auditoría de Tipo_Batch ────────────────────────────────────────────────

describe('reconcileAuxiliar — auditoría de Tipo_Batch', () => {
  it("reporta '(empty)' cuando Tipo_Batch viene vacío o ausente", () => {
    const sinBatch = { ...glLine({ noDocto: 2, idCuenta: '0165' }), tipoBatch: undefined } as unknown as AuxiliarContableRecord;
    const res = reconcileAuxiliar(
      [glLine({ tipoBatch: '' }), sinBatch],
      [statement([bankLine()])],
    );
    expect(res.summary.inconsistencyCounts['non-bank-batch-in-1020']).toBe(2);
    expect(res.inconsistencies.every((i) => i.detail.includes('(empty)'))).toBe(true);
  });
});

// ── Competencia por un mismo movimiento bancario ───────────────────────────

describe('reconcileAuxiliar — asignación 1:1 de movimientos', () => {
  it('un movimiento bancario sólo puede cubrir UNA línea GL', () => {
    const res = reconcileAuxiliar(
      [glLine({ noDocto: 1 }), glLine({ noDocto: 2, idCuenta: '0165' })],
      [statement([bankLine()])],
    );
    const tiers = res.lines.map((l) => l.matchTier).sort();
    expect(tiers).toEqual(['exact', 'pendiente-revision']);
  });

  it('una línea GL sólo consume UN movimiento aunque haya varios candidatos', () => {
    const res = reconcileAuxiliar(
      [glLine({ importe: 1000 })],
      [statement([
        bankLine({ importe: 1000, referencia: 'EXACTO' }),
        bankLine({ importe: 1005, referencia: 'TOLERANCIA' }),
      ])],
    );
    expect(res.lines[0].matchTier).toBe('exact');
    // El segundo movimiento queda libre → orphan dentro de la ventana aux.
    expect(res.bankOrphans).toHaveLength(1);
    expect(res.bankOrphans[0].referencia).toBe('TOLERANCIA');
    expect(res.bankOrphans[0].outOfWindow).toBe(false);
  });
});

// ── Cross-account ──────────────────────────────────────────────────────────

describe('reconcileAuxiliar — capa cross-account', () => {
  it('cruza contra una cuenta hermana de la misma cía saltando la cuenta propia', () => {
    const res = reconcileAuxiliar(
      [glLine({ importe: 1000, cuentaBanco: ACCT })],
      [
        statementFor(ACCT, [bankLine({ cuenta: ACCT, importe: 9999, referencia: 'NO-CUADRA' })]),
        statementFor(ACCT2, [bankLine({ cuenta: ACCT2, importe: 1000, referencia: 'HERMANA' })]),
      ],
    );
    expect(res.lines[0].matchTier).toBe('cross-account');
    expect(res.lines[0].bankMovementKey).toBeTruthy();
    expect(res.summary.ingresoCruzadas).toBe(1);
  });

  it('cruza una línea de importe 0 contra la cuenta hermana usando la tolerancia absoluta', () => {
    const res = reconcileAuxiliar(
      [glLine({ importe: 0, cuentaBanco: ACCT })],
      [
        statementFor(ACCT, [bankLine({ cuenta: ACCT, importe: 5000, referencia: 'NO-CUADRA' })]),
        statementFor(ACCT2, [bankLine({ cuenta: ACCT2, importe: 0.5, referencia: 'HERMANA' })]),
      ],
    );
    expect(res.lines[0].matchTier).toBe('cross-account');
    expect(res.lines[0].bankAmount).toBe(0.5);
  });

  it('descarta candidatos hermanos por fecha fuera de ventana y por importe fuera de tolerancia', () => {
    const res = reconcileAuxiliar(
      [glLine({ importe: 1000, cuentaBanco: ACCT })],
      [
        statementFor(ACCT, [bankLine({ cuenta: ACCT, importe: 9999, referencia: 'PROPIA' })]),
        statementFor(ACCT2, [bankLine({ cuenta: ACCT2, importe: 1000, fechaOperacion: '2026-01-01', referencia: 'LEJOS' })]),
        statementFor('55566677788', [bankLine({ cuenta: '55566677788', importe: 8888, referencia: 'OTRO-IMPORTE' })]),
        statementFor('44455566677', [bankLine({ cuenta: '44455566677', importe: 1000, fechaOperacion: '2026-04-14', referencia: 'BUENA' })]),
      ],
    );
    expect(res.lines[0].matchTier).toBe('cross-account');
    expect(res.lines[0].bankDate).toBe('2026-04-14');
  });

  it('un movimiento hermano sólo cubre UNA línea GL', () => {
    const res = reconcileAuxiliar(
      [
        glLine({ noDocto: 1, importe: 1000, cuentaBanco: ACCT }),
        glLine({ noDocto: 2, idCuenta: '0165', importe: 1000, cuentaBanco: ACCT }),
      ],
      [
        statementFor(ACCT, [bankLine({ cuenta: ACCT, importe: 9999, referencia: 'PROPIA' })]),
        statementFor(ACCT2, [bankLine({ cuenta: ACCT2, importe: 1000, referencia: 'HERMANA' })]),
      ],
    );
    const tiers = res.lines.map((l) => l.matchTier).sort();
    expect(tiers).toEqual(['cross-account', 'pendiente-revision']);
  });

  it('una línea GL sólo consume UN movimiento hermano aunque haya varios candidatos', () => {
    const res = reconcileAuxiliar(
      [glLine({ importe: 1000, cuentaBanco: ACCT })],
      [
        statementFor(ACCT, [bankLine({ cuenta: ACCT, importe: 9999, referencia: 'PROPIA' })]),
        statementFor(ACCT2, [
          bankLine({ cuenta: ACCT2, importe: 1000, referencia: 'H1' }),
          bankLine({ cuenta: ACCT2, importe: 1002, referencia: 'H2' }),
        ]),
      ],
    );
    expect(res.lines[0].matchTier).toBe('cross-account');
    expect(res.lines[0].bankAmount).toBe(1000);
    // El otro candidato hermano queda libre → orphan dentro de la ventana.
    expect(res.bankOrphans.map((o) => o.referencia).sort()).toEqual(['H2', 'PROPIA']);
  });

  it('un cruce cross-account contra una cuenta neutra del catálogo se bucketea interno', () => {
    // 70144758151 = cuenta RESERVA del catálogo (flow=neutro).
    const res = reconcileAuxiliar(
      [glLine({ importe: 1000, cuentaBanco: ACCT })],
      [
        statementFor(ACCT, [bankLine({ cuenta: ACCT, importe: 9999, referencia: 'PROPIA' })]),
        statementFor('70144758151', [bankLine({ cuenta: '70144758151', importe: 1000, referencia: 'NEUTRA' })]),
      ],
    );
    expect(res.lines[0].matchTier).toBe('interno');
    expect(res.lines[0].bankMovementKey).toBeTruthy();
    expect(res.summary.ingresoMontoCruzado).toBe(0);
  });

  it('cruza exacto una línea de importe 0 contra un movimiento de importe 0', () => {
    const res = reconcileAuxiliar(
      [glLine({ importe: 0 })],
      [statement([bankLine({ importe: 0 })])],
    );
    expect(res.lines[0].matchTier).toBe('exact');
    expect(res.lines[0].flujo).toBe('ingreso');
  });
});

// ── Documento fuente ───────────────────────────────────────────────────────

describe('reconcileAuxiliar — derivación del documento fuente', () => {
  it('deriva kind=oc cuando sólo hay orden de compra', () => {
    const res = reconcileAuxiliar(
      [glLine({ noOrdenCompra: 'OC-55' })],
      [statement([bankLine()])],
    );
    expect(res.lines[0].source).toMatchObject({ kind: 'oc', ref: 'OC-55' });
    expect(res.sourceConfirmation.get('oc:00042::OC-55')?.confirmed).toBe(true);
  });

  it('deriva kind=pago en un INGRESO con tipoPago/noPago y sin factura ni OC', () => {
    const res = reconcileAuxiliar(
      [glLine({ tipoPago: 'PT', noPago: '900' })],
      [statement([bankLine()])],
    );
    expect(res.lines[0].source).toMatchObject({ kind: 'pago', ref: 'PT900' });
    expect(res.sourceConfirmation.get('pago:00042::PT900')?.confirmed).toBe(true);
  });

  it('cae a kind=otro usando explicación y, si falta, el número de documento', () => {
    const res = reconcileAuxiliar(
      [
        glLine({ noDocto: 11, concepto: '', explicacion: 'ajuste manual' }),
        glLine({ noDocto: 22, idCuenta: '0165', concepto: '', explicacion: '' }),
      ],
      [statement([bankLine()])],
    );
    expect(res.lines[0].source).toMatchObject({ kind: 'otro', ref: 'ajuste manual' });
    expect(res.lines[1].source).toMatchObject({ kind: 'otro', ref: '22' });
  });

  it('usa el nombre de la cuenta como contraparte cuando no hay nombre, y ninguno si ambos faltan', () => {
    const res = reconcileAuxiliar(
      [
        glLine({ noDocto: 11, nombre: '' }),
        glLine({ noDocto: 22, idCuenta: '0165', nombre: '', nombreCuenta: '' }),
      ],
      [statement([bankLine()])],
    );
    expect(res.lines[0].source.contraparte).toBe('BANAMEX - 7013');
    expect(res.lines[1].source.contraparte).toBeUndefined();
  });

  it('un documento confirma en cuanto CUALQUIERA de sus líneas cruza a banco', () => {
    const res = reconcileAuxiliar(
      [
        glLine({ noDocto: 1, importe: 5000, noFactura: 'F-1' }),
        glLine({ noDocto: 2, idCuenta: '0165', importe: 1000, noFactura: 'F-1' }),
        glLine({ noDocto: 3, idCuenta: '0166', importe: 7000, noFactura: 'F-1' }),
      ],
      [statement([bankLine({ importe: 1000 })])],
    );
    const conf = res.sourceConfirmation.get('factura:00042::F-1');
    expect(conf?.confirmed).toBe(true);
    expect(conf?.importe).toBe(1000);
  });
});
