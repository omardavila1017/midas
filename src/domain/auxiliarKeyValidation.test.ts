import { describe, it, expect } from 'vitest';
import {
  validateAuxiliarBankKeys,
  formatReport,
  BANK_TIPO_BATCH,
} from './auxiliarKeyValidation';
import type {
  AuxiliarContableRecord,
  BankAccountStatement,
  BankStatementLine,
} from '../services/jdeTypes';

const ACCT = '70140350840';

function rec(patch: Partial<AuxiliarContableRecord> = {}): AuxiliarContableRecord {
  return {
    cia: '00042',
    cuentaContable: '42.1020.0010409',
    idCuenta: '1640819',
    cuentaObjeto: '1020',
    nombreCuenta: 'BANAMEX',
    cuentaBanco: ACCT,
    tipoDocto: 'JT',
    noDocto: 1,
    noFactura: '',
    noOrdenCompra: '',
    fechaContable: '2026-04-13',
    tipoLibro: 'AA',
    noBatch: 100,
    tipoBatch: '+',
    estatusConciliado: 'R',
    importe: 1000,
    moneda: 'MXP',
    tipoCambio: 0,
    posteo: 'P',
    reversa: '',
    concepto: 'deposito',
    explicacion: '',
    nombre: '',
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
    gsaid: '1640819',
    ...patch,
  };
}

function stmt(movs: BankStatementLine[], patch: Partial<BankAccountStatement> = {}): BankAccountStatement {
  return {
    cia: '00042',
    banco: 'BANAMEX',
    cuenta: ACCT,
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-04-30',
    movimientos: movs,
    ...patch,
  };
}

describe('validateAuxiliarBankKeys — primary key (gsaid ↔ idCuenta)', () => {
  it('perfect 1:1 match — verdict proceed-with-move-1', () => {
    const r = validateAuxiliarBankKeys({
      records: [
        rec({ idCuenta: '111', importe: 500 }),
        rec({ idCuenta: '222', importe: -300, tipoDocto: 'PV' }),
      ],
      bankStatements: [
        stmt([
          bankLine({ gsaid: '111', importe: 500, tipoMovimiento: 'ABONO' }),
          bankLine({ gsaid: '222', importe: 300, tipoMovimiento: 'CARGO' }),
        ]),
      ],
      cia: '00042',
    });

    expect(r.primaryKey.matchRatePct).toBe(100);
    expect(r.primaryKey.matchedCount).toBe(2);
    expect(r.primaryKey.auxiliarCollisions).toBe(0);
    expect(r.primaryKey.bankCollisions).toBe(0);
    expect(r.verdict.primaryKeyViable).toBe(true);
    expect(r.verdict.deriveFlujoBySignViable).toBe(true);
    expect(r.verdict.recommendation).toBe('proceed-with-move-1');
  });

  it('insufficient-data when gsaid and idCuenta are empty', () => {
    const r = validateAuxiliarBankKeys({
      records: [rec({ idCuenta: '' })],
      bankStatements: [stmt([bankLine({ gsaid: '' })])],
    });
    expect(r.verdict.recommendation).toBe('insufficient-data');
    expect(r.primaryKey.matchedCount).toBe(0);
  });

  it('fix-derive-flujo-first when all importes ≥ 0', () => {
    const r = validateAuxiliarBankKeys({
      records: [
        rec({ idCuenta: '111', importe: 500 }),
        rec({ idCuenta: '222', importe: 300, tipoDocto: 'PV' }),
      ],
      bankStatements: [
        stmt([
          bankLine({ gsaid: '111', importe: 500 }),
          bankLine({ gsaid: '222', importe: 300, tipoMovimiento: 'CARGO' }),
        ]),
      ],
    });
    expect(r.flujoSignAudit.allNonNegative).toBe(true);
    expect(r.verdict.deriveFlujoBySignViable).toBe(false);
    expect(r.verdict.recommendation).toBe('fix-derive-flujo-first');
  });

  it('cuenta divergence is flagged in samples even with a perfect key match', () => {
    const r = validateAuxiliarBankKeys({
      records: [rec({ idCuenta: '111', cuentaBanco: '70140350840', importe: -500 })],
      bankStatements: [
        stmt([
          bankLine({
            gsaid: '111',
            cuenta: '99999999999',
            cuentaBancos: '99999999999',
            importe: 500,
            tipoMovimiento: 'CARGO',
          }),
        ]),
      ],
    });
    expect(r.primaryKey.matchedCount).toBe(1);
    expect(r.primaryKey.cuentaConcordancePct).toBe(0);
    expect(r.primaryKey.mismatchSamples.length).toBe(1);
    expect(r.primaryKey.mismatchSamples[0].reasons).toContain('cuenta');
  });

  it('detects collisions when same gsaid appears twice on bank side', () => {
    const r = validateAuxiliarBankKeys({
      records: [rec({ idCuenta: '111', importe: -500 })],
      bankStatements: [
        stmt([
          bankLine({ gsaid: '111', importe: 500, tipoMovimiento: 'CARGO' }),
          bankLine({ gsaid: '111', importe: 500, tipoMovimiento: 'CARGO', referencia: 'R2' }),
        ]),
      ],
    });
    expect(r.primaryKey.bankCollisions).toBe(1);
    expect(r.verdict.primaryKeyViable).toBe(false);
  });

  it('match rate below 95% → switch-to-fallback-key', () => {
    // 10 records, only 4 share gsaid with bank → 40% match.
    const records: AuxiliarContableRecord[] = [];
    const movs: BankStatementLine[] = [];
    for (let i = 0; i < 10; i++) {
      records.push(rec({ idCuenta: `id-${i}`, importe: -100 * (i + 1), noBatch: 1000 + i }));
    }
    for (let i = 0; i < 4; i++) {
      movs.push(bankLine({ gsaid: `id-${i}`, importe: 100 * (i + 1), tipoMovimiento: 'CARGO' }));
    }
    for (let i = 4; i < 10; i++) {
      movs.push(bankLine({ gsaid: `other-${i}`, importe: 100 * (i + 1), tipoMovimiento: 'CARGO' }));
    }

    const r = validateAuxiliarBankKeys({ records, bankStatements: [stmt(movs)] });
    expect(r.primaryKey.matchRatePct).toBeLessThan(95);
    expect(r.verdict.primaryKeyViable).toBe(false);
    expect(r.verdict.recommendation).toBe('switch-to-fallback-key');
  });
});

describe('validateAuxiliarBankKeys — filters', () => {
  it('Tipo_Batch filter drops records with batch outside BANK_TIPO_BATCH', () => {
    const r = validateAuxiliarBankKeys({
      records: [
        rec({ idCuenta: '111', tipoBatch: '+' }), // kept
        rec({ idCuenta: '222', tipoBatch: 'N' }), // dropped — not in BANK_TIPO_BATCH
        rec({ idCuenta: '333', tipoBatch: 'K' }), // kept
      ],
      bankStatements: [
        stmt([
          bankLine({ gsaid: '111' }),
          bankLine({ gsaid: '222' }),
          bankLine({ gsaid: '333' }),
        ]),
      ],
    });
    expect(r.coverage.recordsAfterFilter).toBe(2);
    expect(r.tipoBatchAudit.histogram.find((h) => h.tipoBatch === 'N')?.keptByFilter).toBe(false);
    expect(r.tipoBatchAudit.histogram.find((h) => h.tipoBatch === '+')?.keptByFilter).toBe(true);
  });

  it('non-1020 records are dropped from the bank-key cross', () => {
    const r = validateAuxiliarBankKeys({
      records: [
        rec({ idCuenta: '111', cuentaObjeto: '1020' }),
        rec({ idCuenta: '222', cuentaObjeto: '1010' }), // caja — drop
      ],
      bankStatements: [stmt([bankLine({ gsaid: '111' }), bankLine({ gsaid: '222' })])],
    });
    expect(r.coverage.recordsAfterFilter).toBe(1);
  });

  it('non-AA libro records are dropped', () => {
    const r = validateAuxiliarBankKeys({
      records: [
        rec({ idCuenta: '111', tipoLibro: 'AA' }),
        rec({ idCuenta: '222', tipoLibro: 'BU' }), // budget book — drop
      ],
      bankStatements: [stmt([bankLine({ gsaid: '111' }), bankLine({ gsaid: '222' })])],
    });
    expect(r.coverage.recordsAfterFilter).toBe(1);
  });

  it('cia filter narrows both sides', () => {
    const r = validateAuxiliarBankKeys({
      records: [
        rec({ cia: '00042', idCuenta: '111' }),
        rec({ cia: '00099', idCuenta: '222' }),
      ],
      bankStatements: [
        stmt([bankLine({ cia: '00042', gsaid: '111' })], { cia: '00042' }),
        stmt([bankLine({ cia: '00099', gsaid: '222' })], { cia: '00099' }),
      ],
      cia: '00042',
    });
    expect(r.cia).toBe('00042');
    expect(r.primaryKey.matchedCount).toBe(1);
    expect(r.primaryKey.recordsWithKey).toBe(1);
  });
});

describe('validateAuxiliarBankKeys — fallback keys', () => {
  it('reports noBatch ↔ noRecibo as a fallback candidate', () => {
    const r = validateAuxiliarBankKeys({
      records: [rec({ idCuenta: '', noBatch: 12345, importe: -500 })],
      bankStatements: [
        stmt([bankLine({ gsaid: '', noRecibo: '12345', importe: 500, tipoMovimiento: 'CARGO' })]),
      ],
    });
    const noBatchFb = r.fallbackKeys.find((k) => k.keyName.startsWith('noBatch'));
    expect(noBatchFb?.matchedCount).toBe(1);
    expect(noBatchFb?.matchRatePct).toBe(100);
  });

  it('reports documentoOriginal ↔ noRecibo as a fallback candidate', () => {
    const r = validateAuxiliarBankKeys({
      records: [rec({ idCuenta: '', documentoOriginal: 'DOC-9', importe: -500 })],
      bankStatements: [
        stmt([bankLine({ gsaid: '', noRecibo: 'DOC-9', importe: 500, tipoMovimiento: 'CARGO' })]),
      ],
    });
    const docFb = r.fallbackKeys.find((k) => k.keyName.startsWith('documentoOriginal'));
    expect(docFb?.matchedCount).toBe(1);
    expect(docFb?.matchRatePct).toBe(100);
  });
});

describe('validateAuxiliarBankKeys — flujoSignAudit', () => {
  it('histograms positive/negative by Tipo_Docto', () => {
    const r = validateAuxiliarBankKeys({
      records: [
        rec({ idCuenta: 'a', importe: 100, tipoDocto: 'JT' }),
        rec({ idCuenta: 'b', importe: 200, tipoDocto: 'JT' }),
        rec({ idCuenta: 'c', importe: -50, tipoDocto: 'PV' }),
      ],
      bankStatements: [
        stmt([
          bankLine({ gsaid: 'a', importe: 100 }),
          bankLine({ gsaid: 'b', importe: 200 }),
          bankLine({ gsaid: 'c', importe: 50, tipoMovimiento: 'CARGO' }),
        ]),
      ],
    });
    const jt = r.flujoSignAudit.byTipoDocto.find((b) => b.tipoDocto === 'JT');
    const pv = r.flujoSignAudit.byTipoDocto.find((b) => b.tipoDocto === 'PV');
    expect(jt?.positives).toBe(2);
    expect(jt?.negatives).toBe(0);
    expect(pv?.negatives).toBe(1);
    expect(r.flujoSignAudit.allNonNegative).toBe(false);
  });
});

describe('formatReport', () => {
  it('produces a readable string with the verdict', () => {
    const r = validateAuxiliarBankKeys({
      records: [rec({ idCuenta: '111', importe: -500 })],
      bankStatements: [
        stmt([bankLine({ gsaid: '111', importe: 500, tipoMovimiento: 'CARGO' })]),
      ],
    });
    const text = formatReport(r);
    expect(text).toContain('Auxiliar ↔ Bancos');
    expect(text).toContain('proceed-with-move-1');
    expect(text).toContain('Primary key');
  });
});

describe('validateAuxiliarBankKeys — key granularity classifier', () => {
  it('classifies as line-level when auxRecordsPerKey ≈ 1', () => {
    const r = validateAuxiliarBankKeys({
      records: [
        rec({ idCuenta: '111', importe: -100 }),
        rec({ idCuenta: '222', importe: -200 }),
        rec({ idCuenta: '333', importe: -300 }),
      ],
      bankStatements: [
        stmt([
          bankLine({ gsaid: '111', importe: 100, tipoMovimiento: 'CARGO' }),
          bankLine({ gsaid: '222', importe: 200, tipoMovimiento: 'CARGO' }),
          bankLine({ gsaid: '333', importe: 300, tipoMovimiento: 'CARGO' }),
        ]),
      ],
    });
    expect(r.primaryKey.granularity).toBe('line-level');
    expect(r.primaryKey.auxRecordsPerKey).toBeLessThanOrEqual(1.5);
  });

  it('classifies as account-level when many records share key with same cuenta', () => {
    // 8 records all sharing idCuenta='ACCT1' and same cuentaBanco → account-level.
    const records: AuxiliarContableRecord[] = [];
    for (let i = 0; i < 8; i++) {
      records.push(
        rec({ idCuenta: 'ACCT1', cuentaBanco: '70140350840', importe: -(i + 1) * 50 }),
      );
    }
    const r = validateAuxiliarBankKeys({
      records,
      bankStatements: [
        stmt([
          bankLine({ gsaid: 'ACCT1', importe: 50, tipoMovimiento: 'CARGO' }),
          bankLine({ gsaid: 'ACCT1', importe: 100, tipoMovimiento: 'CARGO' }),
          bankLine({ gsaid: 'ACCT1', importe: 150, tipoMovimiento: 'CARGO' }),
          bankLine({ gsaid: 'ACCT1', importe: 200, tipoMovimiento: 'CARGO' }),
        ]),
      ],
    });
    expect(r.primaryKey.granularity).toBe('account-level');
    expect(r.primaryKey.auxRecordsPerKey).toBeGreaterThan(3);
    expect(r.primaryKey.sameCuentaWithinKeyPct).toBe(100);
    expect(r.verdict.primaryKeyViable).toBe(false);
    expect(r.verdict.notes.some((n) => n.includes('account-level'))).toBe(true);
  });

  it('inconclusive when no records carry the key', () => {
    const r = validateAuxiliarBankKeys({
      records: [rec({ idCuenta: '' })],
      bankStatements: [stmt([bankLine({ gsaid: '' })])],
    });
    expect(r.primaryKey.granularity).toBe('inconclusive');
  });
});

describe('BANK_TIPO_BATCH', () => {
  it('contains the documented bank batch types', () => {
    expect(BANK_TIPO_BATCH.has('+')).toBe(true);
    expect(BANK_TIPO_BATCH.has('+B')).toBe(true);
    expect(BANK_TIPO_BATCH.has('G')).toBe(true);
    expect(BANK_TIPO_BATCH.has('K')).toBe(true);
    expect(BANK_TIPO_BATCH.has('&')).toBe(true);
    expect(BANK_TIPO_BATCH.has('V')).toBe(true);
    expect(BANK_TIPO_BATCH.has('RB')).toBe(true);
    expect(BANK_TIPO_BATCH.has('N')).toBe(false);
  });
});
