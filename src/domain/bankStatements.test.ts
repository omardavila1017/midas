import { describe, expect, it } from 'vitest';
import {
  attachImportedStatementsToKnownCompanies,
  bankStatementBalance,
  canonicalBankAccountNumber,
  currentBankStatements,
  latestStatementDate,
  mergeBankStatements,
  sumBankStatementBalances,
  summarizeBalancesByRole,
} from './bankStatements';
import type { BankAccountStatement } from '../services/jdeTypes';

describe('canonicalBankAccountNumber', () => {
  it('canoniza la cuenta etiquetada del API a solo dígitos', () => {
    expect(canonicalBankAccountNumber('BANAMEX 7014 4758151')).toBe('70144758151');
    expect(canonicalBankAccountNumber('BANAMEX - 7013 8708851')).toBe('70138708851');
    expect(canonicalBankAccountNumber('BANAMEX 7013 8805164 (expresso escolar)')).toBe('70138805164');
    expect(canonicalBankAccountNumber('BANAMEX - 7014 26369')).toBe('701426369');
    expect(canonicalBankAccountNumber('0577 117543')).toBe('0577117543');
  });

  it('preserva centinelas/sin-dígitos y vacío', () => {
    expect(canonicalBankAccountNumber('BANBAJIO')).toBe('BANBAJIO');
    expect(canonicalBankAccountNumber('SIN CUENTA')).toBe('SIN CUENTA');
    expect(canonicalBankAccountNumber('')).toBe('');
    expect(canonicalBankAccountNumber(null)).toBe('');
  });
});

function makeStatement(partial: Partial<BankAccountStatement> & Pick<BankAccountStatement, 'cia' | 'banco' | 'cuenta' | 'moneda' | 'fechaEstadoCuenta' | 'movimientos'>): BankAccountStatement {
  return {
    nombreBanco: partial.banco,
    saldoInicial: partial.saldoInicial,
    saldoFinal: partial.saldoFinal,
    ...partial,
  };
}

describe('mergeBankStatements', () => {
  it('keeps jde accounts and appends uploaded accounts without dropping existing ones', () => {
    const jde = makeStatement({
      cia: '00011',
      banco: 'BANAMEX',
      cuenta: '123',
      moneda: 'MXN',
      fechaEstadoCuenta: '2026-04-23',
      saldoInicial: 100,
      saldoFinal: 150,
      movimientos: [{
        cia: '00011',
        banco: 'BANAMEX',
        cuenta: '123',
        moneda: 'MXN',
        fechaOperacion: '2026-04-23',
        referencia: 'A1',
        concepto: 'JDE',
        tipoMovimiento: 'ABONO',
        importe: 50,
        saldo: 150,
      }],
    });
    const uploaded = makeStatement({
      cia: '00038',
      banco: 'SANTANDER',
      cuenta: '999',
      moneda: 'MXN',
      fechaEstadoCuenta: '2026-04-22',
      saldoInicial: 10,
      saldoFinal: 20,
      movimientos: [{
        cia: '00038',
        banco: 'SANTANDER',
        cuenta: '999',
        moneda: 'MXN',
        fechaOperacion: '2026-04-22',
        referencia: 'B1',
        concepto: 'TXT',
        tipoMovimiento: 'ABONO',
        importe: 10,
        saldo: 20,
      }],
    });

    const merged = mergeBankStatements([jde], [uploaded]);

    expect(merged).toHaveLength(2);
    expect(merged.map((statement) => statement.cuenta).sort()).toEqual(['123', '999']);
  });
});

describe('attachImportedStatementsToKnownCompanies', () => {
  it('fills missing cia from an existing account match', () => {
    const existing: BankAccountStatement[] = [makeStatement({
      cia: '00011',
      banco: 'SANTANDER',
      cuenta: '65502559449',
      moneda: 'MXN',
      fechaEstadoCuenta: '2026-04-23',
      movimientos: [],
    })];
    const imported: BankAccountStatement[] = [makeStatement({
      cia: '',
      banco: 'SANTANDER',
      cuenta: '65502559449',
      moneda: 'MXN',
      fechaEstadoCuenta: '2026-04-22',
      movimientos: [{
        cia: '',
        banco: 'SANTANDER',
        cuenta: '65502559449',
        moneda: 'MXN',
        fechaOperacion: '2026-04-22',
        referencia: '1',
        concepto: 'TXT',
        tipoMovimiento: 'ABONO',
        importe: 10,
        saldo: 10,
      }],
    })];

    const [aligned] = attachImportedStatementsToKnownCompanies(imported, existing);

    expect(aligned.cia).toBe('00011');
    expect(aligned.movimientos[0].cia).toBe('00011');
  });
});

describe('current bank balance helpers', () => {
  it('uses only statements from the latest statement date for current cash', () => {
    const statements: BankAccountStatement[] = [
      makeStatement({
        cia: '00011',
        banco: 'BANAMEX',
        cuenta: 'OLD',
        moneda: 'MXN',
        fechaEstadoCuenta: '2026-05-01',
        saldoFinal: 280_000_000,
        movimientos: [],
      }),
      makeStatement({
        cia: '00011',
        banco: 'BANAMEX',
        cuenta: 'A',
        moneda: 'MXN',
        fechaEstadoCuenta: '2026-05-06',
        saldoFinal: 45_000_000,
        movimientos: [],
      }),
      makeStatement({
        cia: '00038',
        banco: 'BBVA',
        cuenta: 'B',
        moneda: 'MXN',
        fechaEstadoCuenta: '2026-05-06',
        saldoFinal: 25_000_000,
        movimientos: [],
      }),
    ];

    const latest = latestStatementDate(statements);
    const current = currentBankStatements(statements, latest);

    expect(latest).toBe('2026-05-06');
    expect(current.map(statement => statement.cuenta).sort()).toEqual(['A', 'B']);
    expect(sumBankStatementBalances(current)).toBe(70_000_000);
  });
});

describe('summarizeBalancesByRole — caja disponible (concentradoras)', () => {
  it('separa concentradoras (caja disponible) de pagadoras (comprometido) y otras', () => {
    const statements: BankAccountStatement[] = [
      makeStatement({ cia: '00011', banco: 'BANAMEX', cuenta: 'CONC-1', moneda: 'MXN', fechaEstadoCuenta: '2026-06-15', saldoFinal: 60_000_000, movimientos: [] }),
      makeStatement({ cia: '00011', banco: 'BANAMEX', cuenta: 'CONC-2', moneda: 'MXN', fechaEstadoCuenta: '2026-06-15', saldoFinal: 30_000_000, movimientos: [] }),
      makeStatement({ cia: '00011', banco: 'BANAMEX', cuenta: 'PAGA-1', moneda: 'MXN', fechaEstadoCuenta: '2026-06-15', saldoFinal: 20_000_000, movimientos: [] }),
      makeStatement({ cia: '00011', banco: 'BANAMEX', cuenta: 'RES-1', moneda: 'MXN', fechaEstadoCuenta: '2026-06-15', saldoFinal: 5_000_000, movimientos: [] }),
    ];
    const roleByCuenta: Record<string, string> = {
      'CONC-1': 'concentradora',
      'CONC-2': 'concentradora',
      'PAGA-1': 'pagadora',
      'RES-1': 'reserva',
    };

    const summary = summarizeBalancesByRole(statements, (s) => roleByCuenta[s.cuenta]);

    expect(summary.concentradoras).toBe(90_000_000); // caja disponible
    expect(summary.cuentasConcentradora).toBe(2);
    expect(summary.pagadoras).toBe(20_000_000); // comprometido, NO disponible
    expect(summary.otras).toBe(5_000_000); // reserva
    expect(summary.total).toBe(115_000_000);
  });

  it('cuentas sin rol de catálogo caen en "otras" (no inflan la caja disponible)', () => {
    const statements: BankAccountStatement[] = [
      makeStatement({ cia: '00011', banco: 'X', cuenta: 'UNK', moneda: 'MXN', fechaEstadoCuenta: '2026-06-15', saldoFinal: 1_000, movimientos: [] }),
    ];
    const summary = summarizeBalancesByRole(statements, () => undefined);
    expect(summary.concentradoras).toBe(0);
    expect(summary.otras).toBe(1_000);
  });
});

describe('bankStatementBalance', () => {
  it('uses saldoFinal when defined and non-zero', () => {
    const stmt = makeStatement({
      cia: '00011', banco: 'BANAMEX', cuenta: 'A', moneda: 'MXN',
      fechaEstadoCuenta: '2026-05-12',
      saldoInicial: 100, saldoFinal: 150,
      movimientos: [],
    });
    expect(bankStatementBalance(stmt)).toBe(150);
  });

  it('derives balance from saldoInicial + Σ movimientos when saldoFinal === 0 but movimientos exist', () => {
    // Repro real: SANTANDER cuenta con Saldo_Final null en JDE → almacenado
    // como 0. saldoInicial + abonos - cargos da el balance verdadero.
    const stmt = makeStatement({
      cia: '00011', banco: 'SANTANDER', cuenta: 'X', moneda: 'MXN',
      fechaEstadoCuenta: '2026-04-22',
      saldoInicial: 4_028_462.95,
      saldoFinal: 0,
      movimientos: [
        { cia: '00011', banco: 'SANTANDER', cuenta: 'X', moneda: 'MXN',
          fechaOperacion: '2026-04-10', referencia: 'A', concepto: 'in',
          tipoMovimiento: 'ABONO', importe: 1_000_000 },
        { cia: '00011', banco: 'SANTANDER', cuenta: 'X', moneda: 'MXN',
          fechaOperacion: '2026-04-15', referencia: 'B', concepto: 'out',
          tipoMovimiento: 'CARGO', importe: 500_000 },
      ],
    });
    expect(bankStatementBalance(stmt)).toBeCloseTo(4_528_462.95, 2);
  });

  it('derives balance when saldoFinal undefined but saldoInicial + movimientos defined', () => {
    const stmt = makeStatement({
      cia: '00011', banco: 'BANAMEX', cuenta: 'B', moneda: 'MXN',
      fechaEstadoCuenta: '2026-05-12',
      saldoInicial: 100,
      saldoFinal: undefined,
      movimientos: [
        { cia: '00011', banco: 'BANAMEX', cuenta: 'B', moneda: 'MXN',
          fechaOperacion: '2026-05-12', referencia: 'A', concepto: 'in',
          tipoMovimiento: 'ABONO', importe: 50 },
      ],
    });
    expect(bankStatementBalance(stmt)).toBe(150);
  });

  it('returns 0 for empty account with no saldo info', () => {
    const stmt = makeStatement({
      cia: '00011', banco: 'BANAMEX', cuenta: 'C', moneda: 'MXN',
      fechaEstadoCuenta: '2026-05-12',
      movimientos: [],
    });
    expect(bankStatementBalance(stmt)).toBe(0);
  });

  it('keeps saldoFinal === 0 when account is truly empty (no movimientos)', () => {
    const stmt = makeStatement({
      cia: '00011', banco: 'BANAMEX', cuenta: 'D', moneda: 'MXN',
      fechaEstadoCuenta: '2026-05-12',
      saldoInicial: 0, saldoFinal: 0,
      movimientos: [],
    });
    expect(bankStatementBalance(stmt)).toBe(0);
  });
});
