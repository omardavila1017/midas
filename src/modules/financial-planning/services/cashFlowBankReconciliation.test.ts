/**
 * Bank cross-validation suite for Planeación Financiera (meses históricos).
 *
 * Goal: prove end-to-end that the Base scenario of Planning, for closed
 * historical months (not the current month), reflects EXCLUSIVELY real bank
 * data and that:
 *   1. caja final de Planeación == saldo final bancario real (al peso).
 *   2. ingresos/egresos de Planeación == ABONO/CARGO reales del banco
 *      (excluyendo traspasos internos), 100% trazables.
 *
 * Pipeline real: bank statements → buildCanonicalProjection → buildScenario
 * ForecastRun (Base) → reconcilePlanningAgainstBank. Un cambio que rompa el
 * cruce caja↔banco se cacha aquí aunque los unit tests pasen.
 */
import { describe, expect, it } from 'vitest';

import type { CashFlowAssumptions } from '../../../domain/types';
import type {
  BankAccountStatement,
  BankStatementLine,
} from '../../../services/jdeTypes';
import { buildCanonicalProjection } from '../../shared-finance/calculation-engine/canonicalProjection';
import { calculateInitialCash } from '../../financial-projection/services/financialProjectionService';
import { defaultTaxStore } from '../../taxes/services/taxModuleService';
import { buildScenarioForecastRun } from './scenarioForecastRun';
import { reconcilePlanningAgainstBank } from './cashFlowBankReconciliation';

const ASSUMPTIONS: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

const CIA = '00001';
const TODAY = '2026-03-15';
const WINDOW_START = '2026-01-01';
const WINDOW_END = '2026-12-31';

function line(patch: Partial<BankStatementLine>): BankStatementLine {
  return {
    cia: patch.cia ?? CIA,
    banco: patch.banco ?? 'BANAMEX',
    nombreBanco: patch.nombreBanco ?? 'BANAMEX',
    cuenta: patch.cuenta ?? 'CTA-A',
    moneda: patch.moneda ?? 'MXN',
    fechaOperacion: patch.fechaOperacion ?? '2026-01-15',
    referencia: patch.referencia ?? 'REF',
    concepto: patch.concepto ?? 'MOVIMIENTO',
    tipoMovimiento: patch.tipoMovimiento ?? 'ABONO',
    importe: patch.importe ?? 100,
    ...patch,
  };
}

function statement(
  cuenta: string,
  saldoInicial: number,
  movimientos: BankStatementLine[],
): BankAccountStatement {
  return {
    cia: CIA,
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    cuenta,
    moneda: 'MXN',
    fechaEstadoCuenta: TODAY,
    saldoInicial,
    movimientos: movimientos.map((m) => ({ ...m, cuenta })),
  };
}

/**
 * Dos cuentas, dos meses históricos cerrados (Ene, Feb), con flujos reales y
 * traspasos internos de dos tipos:
 *   • par simétrico CARGO/ABONO (neto 0) — detectado por pair-matching.
 *   • CARGO interno por leyenda "TRASPASO REF" sin pareja (residuo −150) —
 *     verifica que el plug INTERNAL_RECON ancla la caja sin inflar los brutos.
 */
function buildBankStatements(): BankAccountStatement[] {
  const ctaA = statement('CTA-A', 1000, [
    line({ fechaOperacion: '2026-01-10', tipoMovimiento: 'ABONO', importe: 800, concepto: 'PAGO CLIENTE ACME SA' }),
    line({ fechaOperacion: '2026-01-12', tipoMovimiento: 'CARGO', importe: 300, concepto: 'PAGO PROVEEDOR XYZ' }),
    // Par interno (con ABONO 250 en CTA-B el mismo día) → pair-matched, neto 0.
    line({ fechaOperacion: '2026-01-20', tipoMovimiento: 'CARGO', importe: 250, concepto: 'TRANSFERENCIA A CTA B' }),
    // Interno por leyenda, sin pareja → residuo −150 en el plug.
    line({ fechaOperacion: '2026-01-25', tipoMovimiento: 'CARGO', importe: 150, concepto: 'TRASPASO REF 99001' }),
    // Febrero
    line({ fechaOperacion: '2026-02-08', tipoMovimiento: 'ABONO', importe: 1000, concepto: 'PAGO CLIENTE BETA SA' }),
    line({ fechaOperacion: '2026-02-18', tipoMovimiento: 'CARGO', importe: 400, concepto: 'PAGO PROVEEDOR QRS' }),
  ]);

  const ctaB = statement('CTA-B', 500, [
    // Pareja del CARGO 250 de CTA-A → pair-matched, neto 0.
    line({ fechaOperacion: '2026-01-20', tipoMovimiento: 'ABONO', importe: 250, concepto: 'TRANSFERENCIA DE CTA A' }),
  ]);

  return [ctaA, ctaB];
}

describe('Planning ↔ Banco · histórico cerrado cuadra al peso', () => {
  it('caja final de Base == saldo final bancario, e ingresos/egresos == ABONO/CARGO reales', () => {
    const bankStatements = buildBankStatements();

    const canonical = buildCanonicalProjection({
      companyCode: CIA,
      bankStatements,
      clients: [],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [],
      assumptions: ASSUMPTIONS,
      budget: null,
      startingBalance: undefined,
      asOfDate: TODAY,
      enablePredictive: false,
    });

    const initialCash = calculateInitialCash(bankStatements, undefined, { companyCode: CIA });
    expect(initialCash).toBe(1500); // Σ saldoInicial = 1000 + 500

    const baseRun = buildScenarioForecastRun({
      scenarioId: 'base',
      scenarioName: 'Base',
      scenarioKind: 'BASE',
      sourceMovements: canonical.movements,
      adjustments: [],
      manualEntries: [],
      customRows: [],
      overrides: [],
      clients: [],
      providers: [],
      assumptions: ASSUMPTIONS,
      cxpRecords: [],
      budget: null,
      companyCode: CIA,
      taxStore: defaultTaxStore(),
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      today: TODAY,
      initialCash,
      supplierInitialCash: initialCash,
      minimumCash: 0,
      granularity: 'monthly',
    });

    const report = reconcilePlanningAgainstBank({
      movements: baseRun.movements,
      initialCash,
      bankStatements,
      companyCode: CIA,
      today: TODAY,
    });

    // Dos meses históricos cerrados (Ene, Feb), ambos cuadrados.
    const byMonth = new Map(report.months.map((m) => [m.yearMonth, m]));
    expect([...byMonth.keys()].sort()).toEqual(['2026-01', '2026-02']);
    expect(report.reconciled).toBe(true);
    expect(report.divergentMonths).toEqual([]);
    expect(report.maxClosingCashDiff).toBeLessThanOrEqual(1);

    const ene = byMonth.get('2026-01')!;
    // Ingreso real Ene = ABONO 800 (el ABONO 250 de CTA-B es interno).
    expect(ene.bankIncome).toBe(800);
    expect(ene.planningIncome).toBe(800);
    // Egreso real Ene = CARGO 300 (250 y 150 son internos).
    expect(ene.bankExpense).toBe(300);
    expect(ene.planningExpense).toBe(300);
    // Caja final Ene = 1500 + (800 − 300 − 150 interno) = 1850.
    expect(ene.bankClosingCash).toBe(1850);
    expect(ene.planningClosingCash).toBe(1850);

    const feb = byMonth.get('2026-02')!;
    expect(feb.bankIncome).toBe(1000);
    expect(feb.planningIncome).toBe(1000);
    expect(feb.bankExpense).toBe(400);
    expect(feb.planningExpense).toBe(400);
    // Caja final Feb = 1850 + (1000 − 400) = 2450.
    expect(feb.bankClosingCash).toBe(2450);
    expect(feb.planningClosingCash).toBe(2450);
  });

  it('el mes en curso (parcial) NO se reconcilia como histórico cerrado', () => {
    const bankStatements = buildBankStatements();
    // Añade un movimiento en el mes en curso (marzo) en CTA-A.
    bankStatements[0].movimientos.push(
      line({ cuenta: 'CTA-A', fechaOperacion: '2026-03-05', tipoMovimiento: 'ABONO', importe: 9999, concepto: 'PAGO CLIENTE MARZO' }),
    );

    const canonical = buildCanonicalProjection({
      companyCode: CIA,
      bankStatements,
      clients: [],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [],
      assumptions: ASSUMPTIONS,
      budget: null,
      startingBalance: undefined,
      asOfDate: TODAY,
      enablePredictive: false,
    });

    const initialCash = calculateInitialCash(bankStatements, undefined, { companyCode: CIA });
    const baseRun = buildScenarioForecastRun({
      scenarioId: 'base',
      scenarioName: 'Base',
      scenarioKind: 'BASE',
      sourceMovements: canonical.movements,
      adjustments: [],
      manualEntries: [],
      customRows: [],
      overrides: [],
      clients: [],
      providers: [],
      assumptions: ASSUMPTIONS,
      cxpRecords: [],
      budget: null,
      companyCode: CIA,
      taxStore: defaultTaxStore(),
      startDate: WINDOW_START,
      endDate: WINDOW_END,
      today: TODAY,
      initialCash,
      supplierInitialCash: initialCash,
      minimumCash: 0,
      granularity: 'monthly',
    });

    const report = reconcilePlanningAgainstBank({
      movements: baseRun.movements,
      initialCash,
      bankStatements,
      companyCode: CIA,
      today: TODAY,
    });

    // Marzo (mes en curso) queda fuera del reporte; los cerrados cuadran.
    expect(report.months.every((m) => m.yearMonth < '2026-03')).toBe(true);
    expect(report.reconciled).toBe(true);
  });
});
