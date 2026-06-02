/**
 * Cruce Planeación ↔ Banco para meses históricos cerrados.
 *
 * Objetivo: hacer verificable y trazable el invariante de negocio de que la
 * Planeación Financiera, en los meses históricos (no el mes en curso), refleja
 * EXCLUSIVAMENTE lo real y que su caja final cuadra al peso con el saldo final
 * bancario, con ingresos/egresos 100% cruzados con el banco.
 *
 * Verdad bancaria — `buildHistoricalMonths` (cashFlowEngine) reconstruye por mes:
 *   • income      = Σ ABONO real      (excluye traspasos internos + cuentas neutras)
 *   • expense     = Σ CARGO real       (idem)
 *   • closingCash = Σ saldoInicial + neto encadenado de TODOS los movimientos
 *                   (incluye el residuo interno → es el saldo bancario real).
 *
 * Lado Planeación — los movimientos del run Base. La caja final encadena
 * `initialCash` (= Σ saldoInicial cuando no hay override) + el neto de TODOS los
 * movimientos, incluido el plug sintético `INTERNAL_RECON` que ancla la caja al
 * banco (ver canonicalProjection.ts). Los brutos económicos excluyen
 * `INTERNAL_RECON` porque no es un flujo económico real (es la reconciliación
 * neta de traspasos), de modo que ingreso/egreso quedan 100% trazables a
 * ABONO/CARGO reales — exactamente el mismo corte (interno + neutro) que aplica
 * el banco.
 *
 * Sólo se reconcilian meses con cobertura bancaria (existe estado de cuenta).
 * Sin estado de cuenta no hay verdad bancaria contra la cual cruzar; esos meses
 * quedan fuera del reporte (no se inventan).
 */
import {
  buildHistoricalMonths,
  compareYearMonth,
  toYearMonth,
} from '../../../domain/cashFlowEngine';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { BankAccountStatement } from '../../../services/jdeTypes';
import type { FinancialMovement } from '../../shared-finance/types';

export interface MonthBankReconciliation {
  yearMonth: string;
  /** Ingreso económico de Planeación (Σ INFLOW, excluye INTERNAL_RECON). */
  planningIncome: number;
  /** Σ ABONO real del banco (excluye traspasos internos y cuentas neutras). */
  bankIncome: number;
  incomeDiff: number;
  /** Egreso económico de Planeación (Σ OUTFLOW, excluye INTERNAL_RECON). */
  planningExpense: number;
  /** Σ CARGO real del banco (excluye traspasos internos y cuentas neutras). */
  bankExpense: number;
  expenseDiff: number;
  /** Caja final encadenada de Planeación (incluye el plug INTERNAL_RECON). */
  planningClosingCash: number;
  /** Saldo final bancario real del mes. */
  bankClosingCash: number;
  closingCashDiff: number;
  /** true si los tres diffs caen dentro de la tolerancia. */
  reconciled: boolean;
}

export interface BankReconciliationReport {
  /** Una fila por mes histórico cerrado con cobertura bancaria. */
  months: MonthBankReconciliation[];
  /** true si todos los meses cuadran dentro de la tolerancia. */
  reconciled: boolean;
  /** Mayor |diferencia| de caja final entre Planeación y banco. */
  maxClosingCashDiff: number;
  /** Meses (YYYY-MM) que NO cuadraron. */
  divergentMonths: string[];
}

/** Tolerancia de ruido de punto flotante, en pesos. */
const DEFAULT_TOLERANCE = 1;

interface MonthAggregate {
  /** Σ INFLOW económico (excluye INTERNAL_RECON). */
  income: number;
  /** Σ OUTFLOW económico (excluye INTERNAL_RECON). */
  expense: number;
  /** Neto que mueve la caja: incluye INTERNAL_RECON (ancla al banco). */
  net: number;
}

export interface ReconcilePlanningAgainstBankArgs {
  /** Movimientos del run Base (real corto plazo + bancario REAL + plug). */
  movements: FinancialMovement[];
  /** Caja inicial usada por el run (= Σ saldoInicial cuando no hay override). */
  initialCash: number;
  /** Estados de cuenta bancarios del rango. */
  bankStatements: BankAccountStatement[];
  /** Compañía activa; 'all'/undefined = todas. */
  companyCode?: string;
  /** Fecha de corte "hoy" (YYYY-MM-DD); el mes en curso y posteriores se omiten. */
  today: string;
  /** Tolerancia en pesos (default 1). */
  tolerance?: number;
}

/**
 * Reconcilia los movimientos del run Base de Planeación contra la verdad
 * bancaria, mes histórico cerrado por mes. Devuelve un reporte trazable: por
 * mes, el ingreso/egreso/caja de Planeación vs. los del banco y su diferencia.
 */
export function reconcilePlanningAgainstBank(
  args: ReconcilePlanningAgainstBankArgs,
): BankReconciliationReport {
  const tolerance = args.tolerance ?? DEFAULT_TOLERANCE;
  const { companyCode } = args;
  const scopedStatements = !companyCode || companyCode === 'all'
    ? args.bankStatements
    : args.bankStatements.filter((s) => s.cia === companyCode);

  const bankMonths = buildHistoricalMonths(scopedStatements);
  const currentYm = toYearMonth(args.today);

  // Agregados de Planeación por mes (sobre la fecha efectiva del movimiento).
  const planningByYm = new Map<string, MonthAggregate>();
  for (const movement of args.movements) {
    const ym = toYearMonth(effectiveMovementDate(movement));
    if (ym.length !== 7) continue;
    const agg = planningByYm.get(ym) ?? { income: 0, expense: 0, net: 0 };
    const amount = effectiveAmount(movement);
    const isInternalRecon = movement.category === 'INTERNAL_RECON';
    if (movement.type === 'INFLOW') {
      if (!isInternalRecon) agg.income += amount;
      agg.net += amount;
    } else {
      if (!isInternalRecon) agg.expense += amount;
      agg.net -= amount;
    }
    planningByYm.set(ym, agg);
  }

  // Encadena la caja de Planeación sobre la MISMA secuencia de meses que el
  // banco (verdad histórica), partiendo de initialCash (= Σ saldoInicial). Así
  // la caja final por mes se compara contra el saldo final bancario del mismo
  // mes. Sólo se emite fila para meses históricos cerrados (< mes en curso),
  // pero el encadenado avanza por todos para que la caja acumulada sea correcta.
  const sortedBankMonths = [...bankMonths].sort((a, b) =>
    compareYearMonth(a.yearMonth, b.yearMonth),
  );
  let running = args.initialCash;
  const months: MonthBankReconciliation[] = [];
  for (const bank of sortedBankMonths) {
    const ym = bank.yearMonth;
    const agg = planningByYm.get(ym) ?? { income: 0, expense: 0, net: 0 };
    running += agg.net;
    if (compareYearMonth(ym, currentYm) >= 0) continue;
    const incomeDiff = agg.income - bank.income;
    const expenseDiff = agg.expense - bank.expense;
    const closingCashDiff = running - bank.closingCash;
    const reconciled =
      Math.abs(incomeDiff) <= tolerance &&
      Math.abs(expenseDiff) <= tolerance &&
      Math.abs(closingCashDiff) <= tolerance;
    months.push({
      yearMonth: ym,
      planningIncome: agg.income,
      bankIncome: bank.income,
      incomeDiff,
      planningExpense: agg.expense,
      bankExpense: bank.expense,
      expenseDiff,
      planningClosingCash: running,
      bankClosingCash: bank.closingCash,
      closingCashDiff,
      reconciled,
    });
  }

  const divergentMonths = months
    .filter((month) => !month.reconciled)
    .map((month) => month.yearMonth);
  const maxClosingCashDiff = months.reduce(
    (max, month) => Math.max(max, Math.abs(month.closingCashDiff)),
    0,
  );

  return {
    months,
    reconciled: divergentMonths.length === 0,
    maxClosingCashDiff,
    divergentMonths,
  };
}
