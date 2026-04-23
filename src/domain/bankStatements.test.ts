import { describe, expect, it } from 'vitest';
import { attachImportedStatementsToKnownCompanies, mergeBankStatements } from './bankStatements';
import type { BankAccountStatement } from '../services/jdeTypes';

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
