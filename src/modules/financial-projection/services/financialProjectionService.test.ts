import { describe, expect, it } from 'vitest';
import type { BankAccountStatement, BankStatementLine } from '../../../services/jde';
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

  // `enablePredictive` cambia la salida (`canonical.predictive` = null cuando
  // está apagado), así que DEBE estar en la llave del memo. Sin esto, el build
  // sin predictivo de KpisObjectivesDashboard (hilo principal,
  // `enablePredictive:false`) le servía su resultado a Proyección/Planeación
  // — con SOURCE_CACHE_LIMIT=1 es la única entrada — y ahí `trendAvailable`
  // caía a false: el top-off de tendencia desaparecía de los escenarios no-Base
  // y los meses futuros salían más bajos según qué tab se abrió primero.
  it('no comparte entrada de cache entre builds con y sin predictivo', () => {
    __clearProjectionSourceCache();
    const common = {
      companyCode: 'all',
      bankStatements: [
        statement({
          fechaEstadoCuenta: '2026-03-31',
          movimientos: [
            line({ fechaOperacion: '2026-01-15', importe: 500_000 }),
            line({ fechaOperacion: '2026-02-15', importe: 520_000 }),
            line({ fechaOperacion: '2026-03-15', importe: 540_000 }),
          ],
        }),
      ],
      clients: [],
      providers: [],
      cxpRecords: [],
      assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
      budget: null,
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    };

    const withoutPredictive = buildFinancialProjectionSourceData({ ...common, enablePredictive: false });
    const withPredictive = buildFinancialProjectionSourceData({ ...common });

    // El segundo build NO puede recibir el resultado del primero.
    expect(withPredictive).not.toBe(withoutPredictive);
    expect(withoutPredictive.canonical.predictive).toBeFalsy();
    expect(withPredictive.canonical.predictive).toBeTruthy();
  });
});

function line(patch: Partial<BankStatementLine> = {}): BankStatementLine {
  return {
    cia: patch.cia ?? '00001',
    banco: patch.banco ?? 'BANK',
    cuenta: patch.cuenta ?? 'CTA-1',
    moneda: patch.moneda ?? 'MXN',
    fechaOperacion: patch.fechaOperacion ?? '2026-01-15',
    referencia: patch.referencia ?? 'REF',
    concepto: patch.concepto ?? 'DEPOSITO CLIENTE',
    tipoMovimiento: patch.tipoMovimiento ?? 'ABONO',
    importe: patch.importe ?? 100_000,
  };
}

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
