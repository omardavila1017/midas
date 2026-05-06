import { describe, expect, it } from 'vitest';
import type { BankAccountStatement } from '../../../services/jde';
import { calculateCurrentBankCash, calculateInitialCash } from './financialProjectionService';

describe('financialProjectionService cash helpers', () => {
  it('uses fixed starting balance for annual projection cash', () => {
    expect(calculateInitialCash([statement({ saldoInicial: 999_000, saldoFinal: 111_000 })], 76_300_000)).toBe(76_300_000);
  });

  it('calculates current bank cash from the latest saldoFinal by account and company', () => {
    const statements: BankAccountStatement[] = [
      statement({ cia: '00001', cuenta: 'CTA-1', fechaEstadoCuenta: '2026-05-01', saldoInicial: 1_000_000, saldoFinal: 250_000 }),
      statement({ cia: '00001', cuenta: 'CTA-1', fechaEstadoCuenta: '2026-05-05', saldoInicial: 9_000_000, saldoFinal: 400_000 }),
      statement({ cia: '00001', cuenta: 'CTA-2', fechaEstadoCuenta: '2026-05-05', saldoInicial: 8_000_000, saldoFinal: 600_000 }),
      statement({ cia: '00002', cuenta: 'CTA-3', fechaEstadoCuenta: '2026-05-05', saldoInicial: 7_000_000, saldoFinal: 900_000 }),
    ];

    expect(calculateCurrentBankCash(statements, '00001', 76_300_000)).toBe(1_000_000);
  });
});

function statement(patch: Partial<BankAccountStatement> = {}): BankAccountStatement {
  return {
    cia: patch.cia ?? '00001',
    banco: patch.banco ?? 'BANK',
    cuenta: patch.cuenta ?? 'CTA-1',
    moneda: patch.moneda ?? 'MXN',
    fechaEstadoCuenta: patch.fechaEstadoCuenta ?? '2026-05-05',
    saldoInicial: patch.saldoInicial,
    saldoFinal: patch.saldoFinal,
    movimientos: patch.movimientos ?? [],
  };
}
