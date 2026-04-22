import { describe, it, expect } from 'vitest';
import {
  isInternalTransfer,
  classifyMovement,
  buildOwnAccountDetector,
  buildOwnAccountsIndex,
  buildPairMatchedKeys,
  movementHashKey,
  computeBankOnlyCashFlow,
} from './netCashFlowEngine';
import type { BankAccountStatement, BankStatementLine } from '../services/jdeTypes';

function mov(partial: Partial<BankStatementLine>): BankStatementLine {
  return {
    cia: partial.cia ?? '00011',
    banco: partial.banco ?? '002',
    cuenta: partial.cuenta ?? '0190047839',
    moneda: partial.moneda ?? 'MXN',
    fechaOperacion: partial.fechaOperacion ?? '2026-04-22',
    referencia: partial.referencia ?? 'REF1',
    concepto: partial.concepto ?? 'Concepto genérico',
    tipoMovimiento: partial.tipoMovimiento ?? 'CARGO',
    importe: partial.importe ?? 1000,
    fechaValor: partial.fechaValor,
    saldo: partial.saldo,
  };
}

function acc(cia: string, cuenta: string, mvs: BankStatementLine[]): BankAccountStatement {
  return {
    cia,
    banco: '002',
    cuenta,
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-04-22',
    movimientos: mvs.map(m => ({ ...m, cia, cuenta })),
  };
}

describe('classifyMovement — backwards compatible with isInternalTransfer', () => {
  it('returns "real" for unrelated bank movements', () => {
    const m = mov({ concepto: 'PAGO PROVEEDOR ACME', referencia: 'F-001' });
    expect(classifyMovement(m).kind).toBe('real');
    expect(isInternalTransfer(m)).toBe(false);
  });

  it('detects "TRASPASO REF" legend', () => {
    const m = mov({ concepto: 'TRASPASO REF 123', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('legend');
  });

  it('detects own-RFC inside concepto', () => {
    const m = mov({ concepto: 'TRCC AL R.F.C. TTA4906038F4', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('rfc');
  });

  it('detects own-beneficiary inside concepto', () => {
    const m = mov({ concepto: 'BCO 002 BENEF TRANSPORTES TAMAULIP', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('beneficiary');
  });

  it('detects another own-account number in concepto via own-account detector', () => {
    const ownAccounts = new Set(['0190047839', '0190099999']);
    const detector = buildOwnAccountDetector(ownAccounts);
    // CARGO en cuenta A que menciona la cuenta B (ambas del grupo).
    const m = mov({ cuenta: '0190047839', concepto: 'PAGO A CTA 0190099999', referencia: '' });
    const c = classifyMovement(m, { ownAccountDetector: detector });
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('own-account');
  });
});

describe('buildPairMatchedKeys', () => {
  it('marks a clean 1-to-1 pair (CARGO+ABONO same day, same amount, same cia, different cuentas)', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, concepto: 'salida' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, concepto: 'entrada' }),
      ]),
    ];
    const keys = buildPairMatchedKeys(stmts);
    expect(keys.size).toBe(2);
    const cargoKey = movementHashKey('00011', '0190000001', stmts[0].movimientos[0]);
    const abonoKey = movementHashKey('00011', '0190000002', stmts[1].movimientos[0]);
    expect(keys.has(cargoKey)).toBe(true);
    expect(keys.has(abonoKey)).toBe(true);
  });

  it('does NOT pair when amounts match but cuenta is the same (could be misclassification)', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000 }),
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000 }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(0);
  });

  it('does NOT pair across different cias even if amount/day match', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000 }),
      ]),
      acc('00022', '0190000002', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000 }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(0);
  });

  it('does NOT pair when bucket is ambiguous (e.g. 2 CARGOs + 1 ABONO of the same amount)', () => {
    // Si hay más de 2 movimientos del mismo monto/día/cia, evitamos parear
    // para no confundir un ingreso real con un traspaso.
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R1' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R2' }),
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, referencia: 'R3' }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(0);
  });

  it('does NOT pair when both movements are CARGO (no symmetry)', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000 }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000 }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(0);
  });

  it('classifyMovement reports "pair-matched" when key is in pairedKeys', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, concepto: 'pago genérico' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, concepto: 'depósito genérico' }),
      ]),
    ];
    const pairedKeys = buildPairMatchedKeys(stmts);
    const cargo = stmts[0].movimientos[0];
    const c = classifyMovement(cargo, { pairedKeys }, '00011', '0190000001');
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('pair-matched');
  });

  it('priority: legend wins over pair-matched even if both apply', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, concepto: 'TRASPASO REF 999' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, concepto: 'TRASPASO REF 999' }),
      ]),
    ];
    const pairedKeys = buildPairMatchedKeys(stmts);
    const cargo = stmts[0].movimientos[0];
    const c = classifyMovement(cargo, { pairedKeys }, '00011', '0190000001');
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('legend');
  });
});

describe('computeBankOnlyCashFlow exposes internal buckets and excludes them from totals', () => {
  it('returns internalAbonos/internalCargos buckets, and net excludes them', () => {
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        // Real outflow
        mov({ tipoMovimiento: 'CARGO', importe: 100, concepto: 'pago real' }),
        // Pair-matched outflow
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, concepto: 'mov interno A' }),
      ]),
      acc('00011', '0190000002', [
        // Pair-matched inflow
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, concepto: 'mov interno B' }),
        // Real inflow
        mov({ tipoMovimiento: 'ABONO', importe: 500, concepto: 'cobro real' }),
      ]),
    ];
    const result = computeBankOnlyCashFlow(stmts, 2026, 0);
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0].inflows).toBe(500);
    expect(result.daily[0].outflows).toBe(100);
    expect(result.daily[0].net).toBe(400);

    expect(result.internalAbonosByDate.get('2026-04-22')?.length).toBe(1);
    expect(result.internalCargosByDate.get('2026-04-22')?.length).toBe(1);
    const internalAb = result.internalAbonosByDate.get('2026-04-22')![0];
    expect(internalAb.kind).toBe('internal');
    expect(internalAb.internalReason).toBe('pair-matched');
  });
});

describe('buildOwnAccountsIndex (sanity)', () => {
  it('only indexes accounts with length >= 6 chars', () => {
    const idx = buildOwnAccountsIndex([
      acc('00011', '12345', []),       // muy corta — descartada
      acc('00011', '019004780', []),   // ok
    ]);
    expect(idx.has('019004780')).toBe(true);
    expect(idx.has('12345')).toBe(false);
  });
});
