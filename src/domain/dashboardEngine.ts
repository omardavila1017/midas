import type { Client, Provider, CashFlowAssumptions } from './types';
import type { CXPRecord } from './persistence';
import type { Budget } from './budget';
import {
  buildHistoricalMonths,
  toYearMonth,
  addMonths,
  compareYearMonth,
} from './cashFlowEngine';
import {
  buildMonthlyProjection,
  type ProjectionOverrides,
  type ProjectionResult,
} from './projectionEngine';
import {
  buildPredictiveForecast,
  type BuildPredictiveResult,
} from './predictive';
import type { CashFlowMonth } from '../types';
import type {
  BankAccountStatement,
  AgedBalanceRecord,
} from '../services/jde';
import type { CobranzaRecord } from '../services/jdeTypes';
import type { PurchaseReceiptRecord } from '../modules/shared-finance/types';
import type { ReconciledMonthTotals } from './auxiliarReconciliationEngine';

// Pure cash-flow engine extracted from Dashboard.tsx so that callers in the
// projection / planning pipeline can import it without pulling Recharts,
// lucide-react, and the full Dashboard component tree into the main bundle.
// Dashboard.tsx re-exports these for backward compatibility.

export interface ComputeInputs {
  bankStatements: BankAccountStatement[];
  aged: AgedBalanceRecord[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  companyCode: string;
  today: string;
  overrides: ProjectionOverrides;
  budget: Budget | null;
  startingBalance?: number;
  /**
   * Inputs opcionales del motor predictivo. Si se proveen, los totales
   * mensuales futuros vienen del modelo Holt-Winters en lugar del MA6.
   * Si no, mantenemos la lógica vieja para no romper callers existentes.
   */
  purchaseReceipts?: PurchaseReceiptRecord[];
  cobranzaRecords?: CobranzaRecord[];
  /** Horizonte de predicción en meses (default 12). */
  predictiveHorizonMonths?: number;
  /** Si es false, no se ejecuta el predictor (para tests / callers viejos). */
  enablePredictive?: boolean;
  /**
   * Totales reconciliados Auxiliar Contable × Bancos por (cía, `yyyy-mm`)
   * (MOTOR 1). Si se proveen, los brutos REPORTADOS (`income`/`expense`) de los
   * meses históricos CERRADOS se re-sourcean a la verdad reconciliada. El
   * encadenado de caja (`closingCash`) SIGUE anclado al banco real
   * (Σ ABONO/CARGO) — nunca a los reconciliados. Ausente = comportamiento
   * byte-idéntico al previo (Dashboard no cambia salvo que su caller opte).
   */
  reconciledByCompanyMonth?: Map<string, ReconciledMonthTotals>;
}

export interface ComputeOutput {
  base: CashFlowMonth[];
  baseline: { avgIncome: number; avgExpense: number };
  /**
   * Resultado de `buildMonthlyProjection`: lleva `months[]` con el desglose
   * per-cliente/per-proveedor. Se llamaba `MonthlyProjection` por error
   * (apuntaba a un mes individual, no al resultado completo).
   */
  projection: ProjectionResult;
  /**
   * Resultado del motor predictivo con bandas. Null si no se habilitó o
   * si no hay datos suficientes. Planeación Financiera, Proyección y
   * Dashboard consumen las bandas desde aquí.
   */
  predictive: BuildPredictiveResult | null;
}

export function computeBankStartingBalance(statements: BankAccountStatement[]): number {
  return statements.reduce((s, acc) => s + (acc.saldoInicial ?? 0), 0);
}

export function computeBaseCashFlow(inputs: ComputeInputs): ComputeOutput {
  const {
    bankStatements,
    aged,
    clients,
    providers,
    cxpRecords,
    assumptions,
    companyCode,
    today,
    overrides,
    budget,
    startingBalance,
  } = inputs;
  const filtered = companyCode === 'all' || !companyCode
    ? bankStatements
    : bankStatements.filter((s) => s.cia === companyCode);
  // CXP ya filtrado por compañía — se suma al aged cuando hay records
  // cargados para el mismo rango. Nos da granularidad per-factura para la
  // proyección per-proveedor.
  const filteredCxp = companyCode === 'all' || !companyCode
    ? cxpRecords
    : cxpRecords.filter((r) => r.cia === companyCode);
  const combinedAged: AgedBalanceRecord[] = aged.length > 0
    ? aged
    : filteredCxp as unknown as AgedBalanceRecord[];

  const historical = buildHistoricalMonths(filtered);

  // MOTOR 1: pre-agregar el reconciliado Auxiliar×Bancos por mes dentro del
  // scope de cía. Vacío si el caller no lo pasó → override no-op (comportamiento
  // previo byte-idéntico).
  const allCia = companyCode === 'all' || !companyCode;
  const reconciledByYm = new Map<string, { income: number; expense: number }>();
  if (inputs.reconciledByCompanyMonth) {
    for (const t of inputs.reconciledByCompanyMonth.values()) {
      if (!allCia && t.cia !== companyCode) continue;
      const cur = reconciledByYm.get(t.yearMonth) ?? { income: 0, expense: 0 };
      cur.income += t.ingresoCruzado;
      cur.expense += t.egresoCruzado;
      reconciledByYm.set(t.yearMonth, cur);
    }
  }

  const todayYm = toYearMonth(today);

  // Horizonte operativo: 24 meses rodantes incluyendo el mes actual.
  // Antes era 11 meses (12 rodantes), pero la curva de caja se aplanaba
  // a los 12 meses justo donde más importa visualizar tendencia y runway.
  // 24 meses permite ver 2 años de proyección y un horizonte de runway
  // suficiente para decisiones de mediano plazo.
  const rollingEndYm = addMonths(todayYm, 23);
  const lastHistoricalYm = historical.length > 0
    ? historical[historical.length - 1].yearMonth
    : todayYm;
  const firstFutureYm = addMonths(
    compareYearMonth(lastHistoricalYm, todayYm) > 0 ? lastHistoricalYm : todayYm,
    1,
  );
  // Si el horizonte rolling ya quedó atrás del último histórico, no hay
  // proyección — sólo rendiremos el histórico.
  const lastFutureYm = compareYearMonth(rollingEndYm, firstFutureYm) >= 0
    ? rollingEndYm
    : null;

  // Baseline desde history bancaria — promedio de los 6 meses cerrados más
  // recientes (excluye mes en curso, suele estar incompleto). Sirve como
  // piso para que la proyección no caiga por debajo del realmente observado
  // cuando el catálogo de clientes/proveedores subestima. Sin esto, el
  // chart proyectaba "pura pérdida" porque el catálogo de clientes pesaba
  // mucho menos que la cobranza real.
  const closedHistorical = historical.filter((m) => m.yearMonth !== todayYm);
  const baselineWindow = closedHistorical.slice(-6);
  const baselineIncome = baselineWindow.length > 0
    ? baselineWindow.reduce((s, m) => s + m.income, 0) / baselineWindow.length
    : 0;
  const baselineExpense = baselineWindow.length > 0
    ? baselineWindow.reduce((s, m) => s + m.expense, 0) / baselineWindow.length
    : 0;

  // Proyección operativa per-cliente / per-proveedor. Esta es la fuente para
  // los meses futuros; las plantillas externas quedan fuera del runtime normal.
  const projection = buildMonthlyProjection({
    fromYm: todayYm,
    toYm: lastFutureYm ?? todayYm,
    clients,
    providers,
    aged: combinedAged,
    bankStatements: filtered,
    baselineIncome,
    baselineExpense,
    assumptions,
    today,
    budget,
  });
  const projectionByYm = new Map(projection.months.map((m) => [m.yearMonth, m]));

  // ── Motor predictivo (Holt-Winters tiered) ───────────────────────────
  // Si está habilitado y hay histórico suficiente, los totales mensuales
  // futuros pueden venir del modelo. Precedencia para cada mes futuro:
  //   1. override manual del usuario (siempre gana)
  //   2. MAX(predicción Holt-Winters, proyección operativa/budget)
  // El MAX preserva el budget-as-floor cuando supera la realidad histórica
  // y deja al modelo predictivo sobreescribir cuando la historia banca
  // dice más que el catálogo de proveedores/clientes alcanzó a cubrir.
  const predictiveEnabled = inputs.enablePredictive !== false;
  const predictive: BuildPredictiveResult | null = predictiveEnabled && filtered.length > 0
    ? buildPredictiveForecast({
        bankStatements: filtered,
        companyCode: companyCode || 'all',
        asOfDate: today,
        horizonMonths: inputs.predictiveHorizonMonths ?? 12,
        purchaseReceipts: inputs.purchaseReceipts,
        cobranzaRecords: inputs.cobranzaRecords,
      })
    : null;
  const predIncomeByYm = new Map<string, number>();
  const predExpenseByYm = new Map<string, number>();
  if (predictive) {
    // El loop de meses futuros (abajo) parte de firstFutureYm, que ya es
    // posterior al último histórico cerrado. Los buckets parciales del mes
    // en curso quedan en `historicalChained`, así que aquí sólo poblamos
    // los meses estrictamente futuros con la predicción.
    for (const p of predictive.income.monthly) {
      if (!p.isHistorical) predIncomeByYm.set(p.date.slice(0, 7), p.expected);
    }
    for (const p of predictive.expense.monthly) {
      if (!p.isHistorical) predExpenseByYm.set(p.date.slice(0, 7), p.expected);
    }
  }

  // Baseline queda expuesto como 0 — ya no se calcula linear regression.
  const baseline = { avgIncome: 0, avgExpense: 0 };

  // ── Encadenado de caja con fórmula simple y predecible ──────────────
  // caja_final[m] = caja_final[m-1] + ingresos[m] - egresos[m]
  //
  // Meses cerrados: ingresos/egresos reales del banco.
  // Mes actual: real acumulado + proyección restante, modelado como el máximo
  // entre el acumulado real, la proyección operativa y el override manual.
  const baseStart = typeof startingBalance === 'number'
    ? startingBalance
    : computeBankStartingBalance(filtered);
  const historicalChained: CashFlowMonth[] = [];
  let runningHist = baseStart;
  for (const m of historical) {
    const actualIncome = m.income;
    const actualExpense = m.expense;
    // `income`/`expense` ENCADENAN la caja: banco real (meses cerrados) o la
    // proyección del mes en curso. Nunca los brutos reconciliados — eso
    // desanclaría `closingCash` del saldo bancario real.
    let income = actualIncome;
    let expense = actualExpense;
    // Brutos REPORTADOS (lo que ve el chart/KPIs): banco por default; los
    // meses cerrados con cobertura reconciliada (MOTOR 1) reportan la verdad
    // Auxiliar Contable × Bancos.
    let reportedIncome = actualIncome;
    let reportedExpense = actualExpense;
    if (m.yearMonth === todayYm) {
      const ov = overrides[todayYm];
      const projected = projectionByYm.get(todayYm);
      income = ov?.income ?? Math.max(
        actualIncome,
        projected?.income.total ?? 0,
        predIncomeByYm.get(todayYm) ?? 0,
      );
      expense = ov?.expense ?? Math.max(
        actualExpense,
        projected?.expense.total ?? 0,
        predExpenseByYm.get(todayYm) ?? 0,
      );
      reportedIncome = income;
      reportedExpense = expense;
    } else {
      const rec = reconciledByYm.get(m.yearMonth);
      if (rec) {
        reportedIncome = rec.income;
        reportedExpense = rec.expense;
      }
    }
    runningHist = runningHist + income - expense;
    historicalChained.push({
      ...m,
      income: reportedIncome,
      expense: reportedExpense,
      actualIncome,
      actualExpense,
      closingCash: runningHist,
    });
  }

  const months: CashFlowMonth[] = [...historicalChained];
  let running = historicalChained.length > 0
    ? historicalChained[historicalChained.length - 1].closingCash
    : baseStart;
  if (lastFutureYm !== null) {
    let cursor = firstFutureYm;
    while (compareYearMonth(cursor, lastFutureYm) <= 0) {
      const ov = overrides[cursor];
      const projected = projectionByYm.get(cursor);
      const projectedIncome = projected?.income.total ?? 0;
      const projectedExpense = projected?.expense.total ?? 0;
      const predIncome = predIncomeByYm.get(cursor) ?? 0;
      const predExpense = predExpenseByYm.get(cursor) ?? 0;
      const income = ov?.income ?? Math.max(projectedIncome, predIncome);
      const expense = ov?.expense ?? Math.max(projectedExpense, predExpense);
      running = running + income - expense;
      months.push({
        yearMonth: cursor,
        isHistorical: false,
        income,
        expense,
        closingCash: running,
      });
      cursor = addMonths(cursor, 1);
    }
  }
  return { base: months, baseline, projection, predictive };
}
