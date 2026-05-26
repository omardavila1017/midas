import { describe, it, expect } from 'vitest';
import { reconcileAuxiliar, deriveFlujo, emptyAuxiliarReconResult } from './auxiliarReconciliationEngine';
import { adaptAuxiliarForProjection } from './auxiliarProjectionAdapter';
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

  it('leaves a GL line with no bank counterpart as gl-orphan', () => {
    const res = reconcileAuxiliar([glLine()], [statement([])]);
    expect(res.lines[0].matchTier).toBe('gl-orphan');
    expect(res.summary.glOrphanLineas).toBe(1);
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
    const res = reconcileAuxiliar(
      [glLine({ importe: 1000 })],
      [statement([bankLine({ tipoMovimiento: 'CARGO', importe: 1000 })])],
    );
    expect(res.lines[0].matchTier).toBe('gl-orphan');
  });

  it('records source confirmation keyed by factura', () => {
    const res = reconcileAuxiliar([glLine({ noFactura: 'RI-77' })], [statement([bankLine()])]);
    const conf = res.sourceConfirmation.get('factura:00042::RI-77');
    expect(conf?.confirmed).toBe(true);
    expect(conf?.flujo).toBe('ingreso');
  });

  it('empty result has zeroed summary', () => {
    const empty = emptyAuxiliarReconResult();
    expect(empty.lines).toHaveLength(0);
    expect(empty.summary.totalLineas).toBe(0);
    expect(empty.inconsistencies).toEqual([]);
    expect(empty.summary.inconsistencyCounts['jde-not-marked-reconciled']).toBe(0);
  });
});

describe('reconcileAuxiliar — inconsistencies', () => {
  it('flags non-bank-batch-in-1020 when Tipo_Batch is outside BANK_TIPO_BATCH', () => {
    const res = reconcileAuxiliar(
      [glLine({ tipoBatch: 'RB', cuentaObjeto: '1020' })],
      [statement([])],
    );
    expect(res.summary.inconsistencyCounts['non-bank-batch-in-1020']).toBe(1);
    expect(
      res.inconsistencies.some(
        (i) => i.kind === 'non-bank-batch-in-1020' && i.detail.includes('RB'),
      ),
    ).toBe(true);
  });

  it('does NOT flag non-bank-batch for objeto 1010 (caja)', () => {
    const res = reconcileAuxiliar(
      [glLine({ tipoBatch: 'RB', cuentaObjeto: '1010' })],
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

  it('flags jde-not-marked-reconciled when matched but estatus is not R', () => {
    const res = reconcileAuxiliar(
      [glLine({ estatusConciliado: '' })],
      [statement([bankLine()])],
    );
    expect(res.lines[0].matchTier).toBe('exact');
    expect(res.summary.inconsistencyCounts['jde-not-marked-reconciled']).toBe(1);
  });

  it('does NOT flag jde-not-marked-reconciled when estatus is R', () => {
    const res = reconcileAuxiliar(
      [glLine({ estatusConciliado: 'R' })],
      [statement([bankLine()])],
    );
    expect(res.lines[0].matchTier).toBe('jde-reconciled');
    expect(res.summary.inconsistencyCounts['jde-not-marked-reconciled']).toBe(0);
  });

  it('flags duplicate-gsaid-on-bank when same gsaid appears on >1 bank line', () => {
    const res = reconcileAuxiliar(
      [],
      [
        statement([
          bankLine({ gsaid: '01640819', referencia: 'A' }),
          bankLine({ gsaid: '01640819', referencia: 'B' }),
        ]),
      ],
    );
    expect(res.summary.inconsistencyCounts['duplicate-gsaid-on-bank']).toBe(1);
  });

  it('flags idcuenta-collision-on-aux when same idCuenta repeats in 1020', () => {
    const res = reconcileAuxiliar(
      [glLine({ idCuenta: 'ACCT1', noDocto: 1 }), glLine({ idCuenta: 'ACCT1', noDocto: 2 })],
      [statement([])],
    );
    expect(res.summary.inconsistencyCounts['idcuenta-collision-on-aux']).toBe(1);
  });
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
