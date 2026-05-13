import { describe, expect, it } from 'vitest';
import type { BankAccountStatement } from '../../../services/jde';
import type { Budget } from '../../../domain/budget';
import {
  __clearProjectionSourceCache,
  buildFinancialProjectionSourceData,
  calculateCurrentBankCash,
  calculateInitialCash,
} from './financialProjectionService';

describe('financialProjectionService cash helpers', () => {
  it('uses fixed starting balance for annual projection cash', () => {
    expect(calculateInitialCash([statement({ saldoInicial: 999_000, saldoFinal: 111_000 })], 76_300_000)).toBe(76_300_000);
  });

  it('calculates current bank cash from the latest cut date by company', () => {
    const statements: BankAccountStatement[] = [
      statement({ cia: '00001', cuenta: 'CTA-1', fechaEstadoCuenta: '2026-05-01', saldoInicial: 1_000_000, saldoFinal: 250_000 }),
      statement({ cia: '00001', cuenta: 'CTA-1', fechaEstadoCuenta: '2026-05-05', saldoInicial: 9_000_000, saldoFinal: 400_000 }),
      statement({ cia: '00001', cuenta: 'CTA-2', fechaEstadoCuenta: '2026-05-05', saldoInicial: 8_000_000, saldoFinal: 600_000 }),
      statement({ cia: '00001', cuenta: 'STALE', fechaEstadoCuenta: '2026-05-02', saldoInicial: 99_000_000, saldoFinal: 99_000_000 }),
      statement({ cia: '00002', cuenta: 'CTA-3', fechaEstadoCuenta: '2026-05-05', saldoInicial: 7_000_000, saldoFinal: 900_000 }),
    ];

    expect(calculateCurrentBankCash(statements, '00001', 76_300_000)).toBe(1_000_000);
  });

  it('invalidates the source cache when the budget reference changes', () => {
    __clearProjectionSourceCache();
    const common = {
      companyCode: 'all',
      bankStatements: [] as BankAccountStatement[],
      clients: [],
      providers: [],
      cxpRecords: [],
      assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    };

    const first = buildFinancialProjectionSourceData({
      ...common,
      budget: budget(100),
    });
    const second = buildFinancialProjectionSourceData({
      ...common,
      budget: budget(200),
    });

    expect(first).not.toBe(second);
    expect(first.canonical.monthly.find((month) => month.yearMonth === '2026-05')?.expense).toBe(100);
    expect(second.canonical.monthly.find((month) => month.yearMonth === '2026-05')?.expense).toBe(200);
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

function budget(expenseMay: number): Budget {
  const expenseTotal = Array.from({ length: 12 }, () => 0);
  expenseTotal[4] = expenseMay;
  return {
    year: 2026,
    scale: 'pesos',
    incomeTotal: Array.from({ length: 12 }, () => 0),
    incomeByConcept: [],
    expenseTotal,
    expenseByConcept: [],
    uploadedAt: '2026-04-22T00:00:00.000Z',
  };
}
