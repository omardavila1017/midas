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

  it('detecta sigla corta TRCC como beneficiario interno', () => {
    // Concepto completo es "TRCC" (código empresa del grupo).
    const m = mov({ concepto: 'TRCC', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('beneficiary');
    expect(isInternalTransfer(m)).toBe(true);
  });

  it('detecta sigla corta TRTT como beneficiario interno', () => {
    const m = mov({ concepto: 'PAGO TRTT', referencia: '' });
    const c = classifyMovement(m);
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('beneficiary');
    expect(isInternalTransfer(m)).toBe(true);
  });

  it('word boundary: NO matchea substrings accidentales con TRCC/TRTT', () => {
    // Si apareciera una palabra que contiene "TRCC" sin ser la sigla, no
    // debe clasificarse como interno. Ejemplo sintético.
    const m1 = mov({ concepto: 'SUBATTRCCX SA DE CV', referencia: '' });
    expect(classifyMovement(m1).kind).toBe('real');
    expect(isInternalTransfer(m1)).toBe(false);

    const m2 = mov({ concepto: 'ATTRTTX PROVEEDOR', referencia: '' });
    expect(classifyMovement(m2).kind).toBe('real');
    expect(isInternalTransfer(m2)).toBe(false);
  });

  it('NO clasifica ORDEN DE ABONO como interno (cobro legítimo)', () => {
    // El ejemplo real que antes se nos coló: una cuenta Concentradora no
    // convierte un cobro legítimo en traspaso interno.
    const m = mov({ concepto: 'ORDEN DE ABONO', referencia: '', importe: 113123.76 });
    const c = classifyMovement(m);
    expect(c.kind).toBe('real');
    expect(isInternalTransfer(m)).toBe(false);
  });

  it('NO clasifica pagos normales "BANORTE · Pagadora" como internos por sí solos', () => {
    // Una cuenta Pagadora normal — el concepto sí indicaría si es interno;
    // en este caso el concepto es genérico, así que debe ser real.
    const m = mov({ concepto: 'PAGO PROVEEDOR X', referencia: '' });
    expect(classifyMovement(m).kind).toBe('real');
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

  it('PAIRS across different cias when amount/day match (traspaso entre empresas del grupo)', () => {
    // Todas las cuentas en `statements` pertenecen al grupo, así que un
    // traspaso entre dos cias del mismo grupo es interno aunque las cias
    // sean distintas.
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000 }),
      ]),
      acc('00022', '0190000002', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000 }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(2);
  });

  it('PAIRS N-a-N cuando hay K CARGOs y K ABONOs del mismo monto/día en cuentas distintas', () => {
    // Mismo día y mismo monto pero dos traspasos legítimos: 2 CARGOs en
    // cuentas distintas + 2 ABONOs en cuentas distintas, sin solapamiento
    // entre lados. Antes este caso se descartaba (cardinalidad != 2);
    // ahora se marcan los 4.
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R1' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R2' }),
      ]),
      acc('00011', '0190000003', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, referencia: 'R3' }),
      ]),
      acc('00011', '0190000004', [
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, referencia: 'R4' }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(4);
  });

  it('parea greedy a través de cuentas distintas cuando ambos lados aparecen en las mismas cuentas', () => {
    // Cuenta A tiene CARGO+ABONO y cuenta B tiene CARGO+ABONO del mismo
    // monto/día. Greedy aparea cargo01↔abono02 y cargo02↔abono01 — los 4
    // se marcan como pair-matched (cada par cruza cuentas distintas).
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R1' }),
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, referencia: 'R2' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R3' }),
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, referencia: 'R4' }),
      ]),
    ];
    expect(buildPairMatchedKeys(stmts).size).toBe(4);
  });

  it('parea min(K,N) en buckets asimétricos (2 CARGOs + 1 ABONO → marca 1 par)', () => {
    // Asimetría permitida: parea min(K,N)=1 par cruzando cuentas distintas.
    // El CARGO sobrante queda como real.
    const stmts: BankAccountStatement[] = [
      acc('00011', '0190000001', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R1' }),
      ]),
      acc('00011', '0190000002', [
        mov({ tipoMovimiento: 'CARGO', importe: 3_000_000, referencia: 'R2' }),
        mov({ tipoMovimiento: 'ABONO', importe: 3_000_000, referencia: 'R3' }),
      ]),
    ];
    // Sólo se marcan 2 keys (el par) — el otro CARGO queda real.
    expect(buildPairMatchedKeys(stmts).size).toBe(2);
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
