// ─────────────────────────────────────────────────────────────────────────
// projectionEngine — proyección de ingresos y egresos por mes a partir de
// datos reales en lugar de un simple promedio móvil.
//
// Ingresos:
//   - Si hay catálogo de clientes, usamos collectionEngine.projectClientMonth
//     para estimar cobranza por cliente → agregamos por yearMonth. Esto
//     captura estacionalidad, días de crédito, patrones de pago y factoraje.
//   - Fallback: promedio móvil de 6 meses históricos (baseline).
//
// Egresos:
//   - /AntiguedadSaldos da los importes pendientes ya programados por mes.
//   - Los CARGOs bancarios de los últimos 6 meses nos dicen cuánto solemos
//     pagar por proveedor (recurrentes como nómina, renta, seguros). Para
//     cada proveedor con historial estable estimamos un promedio mensual y
//     lo proyectamos hacia adelante.
//   - Por mes combinamos: max(programado, recurrente) para no subestimar.
//   - Fallback: promedio móvil de 6 meses históricos.
//
// El engine devuelve para cada mes proyectado el desglose por fuente, para
// que la UI pueda explicar al usuario de dónde sale cada número.
// ─────────────────────────────────────────────────────────────────────────

import type { Client, Provider, CashFlowAssumptions } from './types';
import type { AgedBalanceRecord, BankAccountStatement } from '../services/jdeTypes';
import { projectClientMonth } from './collectionEngine';
import {
  addMonths,
  compareYearMonth,
  toYearMonth,
  monthsBetween,
} from './cashFlowEngine';
import { isNoisyBankExpenseConcept, projectExpenseByProvider, type ProviderMonthLine } from './expensePerProvider';
import {
  isInternalTransfer,
  buildOwnAccountsIndex,
  buildOwnAccountDetector,
} from './netCashFlowEngine';
import type { Budget } from './budget';

// ── Income ───────────────────────────────────────────────────────────────

export interface IncomeProjectionBreakdown {
  /** Suma proyectada por el catálogo de clientes (collectionEngine). */
  fromClients: number;
  /** Baseline (MA6) si no hay cobranza de clientes ese mes. */
  fromBaseline: number;
  /** Total declarado por el presupuesto cargado para ese mes. */
  fromBudget: number;
  /** Total efectivo usado en el mes. */
  total: number;
  /** Fuente dominante: clients / baseline / mixed / budget. */
  source: 'clients' | 'baseline' | 'mixed' | 'budget';
}

/**
 * Proyecta cobranza por yearMonth usando el catálogo de clientes. Itera
 * por cada (year, monthIndex) invocando projectClientMonth para obtener
 * eventos de cobro con `realDate` y agrupa por yearMonth.
 *
 * Barremos desde un año antes del fromYm para capturar cobros de facturas
 * emitidas antes del horizonte.
 */
export function projectClientIncomeByMonth(
  clients: Client[],
  assumptions: CashFlowAssumptions,
  fromYm: string,
  toYm: string,
): Map<string, number> {
  const result = new Map<string, number>();
  if (clients.length === 0) return result;

  const [fromY] = fromYm.split('-').map(Number);
  const [toY] = toYm.split('-').map(Number);
  const startY = fromY - 1;
  const endY = toY + 1;

  for (let y = startY; y <= endY; y++) {
    for (let m = 0; m < 12; m++) {
      for (const client of clients) {
        const events = projectClientMonth(client, y, m, { ...assumptions, year: y });
        for (const e of events) {
          const ym = e.realDate.slice(0, 7);
          if (compareYearMonth(ym, fromYm) < 0 || compareYearMonth(ym, toYm) > 0) continue;
          result.set(ym, (result.get(ym) ?? 0) + e.amount);
        }
      }
    }
  }
  return result;
}

/**
 * Combina cobranza de clientes con baseline. Si el catálogo cubre al menos
 * `coverageThreshold` del baseline para ese mes, usamos el valor de
 * clientes. Si no, usamos baseline (evita subestimar cuando el catálogo
 * está incompleto).
 */
export function resolveIncomeForMonth(
  clientTotal: number,
  baselineAvg: number,
  budgetValue: number | null,
  coverageThreshold = 0.6,
): IncomeProjectionBreakdown {
  // Presupuesto cargado → manda. Es el compromiso financiero del año.
  if (budgetValue !== null) {
    return {
      fromClients: clientTotal,
      fromBaseline: 0,
      fromBudget: budgetValue,
      total: budgetValue,
      source: 'budget',
    };
  }
  if (clientTotal === 0 && baselineAvg === 0) {
    return { fromClients: 0, fromBaseline: 0, fromBudget: 0, total: 0, source: 'baseline' };
  }
  if (clientTotal === 0) {
    return { fromClients: 0, fromBaseline: baselineAvg, fromBudget: 0, total: baselineAvg, source: 'baseline' };
  }
  if (baselineAvg === 0 || clientTotal >= baselineAvg * coverageThreshold) {
    return { fromClients: clientTotal, fromBaseline: 0, fromBudget: 0, total: clientTotal, source: 'clients' };
  }
  // Catálogo insuficiente: completamos con baseline hasta llegar al promedio.
  const gap = Math.max(0, baselineAvg - clientTotal);
  return {
    fromClients: clientTotal,
    fromBaseline: gap,
    fromBudget: 0,
    total: clientTotal + gap,
    source: 'mixed',
  };
}

// ── Expense ──────────────────────────────────────────────────────────────

export interface ExpenseProjectionBreakdown {
  /** Suma programada en /AntiguedadSaldos para ese mes. */
  scheduled: number;
  /** Estimado recurrente desde CARGOs históricos (nómina, renta, etc.). */
  recurring: number;
  /** Baseline (MA6) de egresos históricos. */
  baseline: number;
  /** Total declarado por el presupuesto cargado para ese mes. */
  fromBudget: number;
  /** Total efectivo (máximo de las fuentes). */
  total: number;
  /** Fuente dominante: scheduled / recurring / baseline / budget. */
  source: 'scheduled' | 'recurring' | 'baseline' | 'budget';
  /** Top providers recurrentes detectados, útil para desglose. */
  topRecurring: Array<{ label: string; monthlyAvg: number; monthsActive: number }>;
  /**
   * Desglose per-proveedor para el mes, cuando el catálogo de proveedores
   * está disponible. Incluye flexibility + paymentPeriod de cada uno.
   */
  providerLines: ProviderMonthLine[];
  /**
   * Desglose por rubro del presupuesto (Nómina, Diésel, etc.) cuando hay
   * budget cargado. Pesos ya normalizados.
   */
  budgetLines: Array<{ concept: string; amount: number }>;
}

/**
 * Agrupa /AntiguedadSaldos por yearMonth de fechaProgramacionPago.
 */
export function buildScheduledExpenseMap(
  aged: AgedBalanceRecord[],
): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const r of aged) {
    const ym = (r.fechaProgramacionPago ?? '').slice(0, 7);
    if (ym.length !== 7) continue;
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + (r.importePendientePesos ?? 0));
  }
  return byMonth;
}

/**
 * Detecta pagos recurrentes en CARGOs bancarios históricos. Para cada
 * concepto (normalizado a mayúsculas, primeros 40 chars), calcula:
 *   - meses activos en el historial
 *   - promedio mensual (sobre meses activos)
 *
 * Un concepto califica como "recurrente" si apareció en ≥ 50% de los meses
 * completos recientes del horizonte analizado. La suma de promedios
 * mensuales de todos los recurrentes es el `recurringBase`.
 *
 * Se excluye el mes en curso para no sesgar por datos parciales.
 */
export function detectRecurringExpenses(
  bankStatements: BankAccountStatement[],
  today: string,
  lookbackMonths = 6,
): { base: number; top: Array<{ label: string; monthlyAvg: number; monthsActive: number }> } {
  if (bankStatements.length === 0) return { base: 0, top: [] };
  const currentYm = toYearMonth(today);

  // Traspasos internos entre cuentas propias no son egresos reales del
  // negocio — excluirlos evita que aparezcan como "recurrentes" y luego se
  // re-proyecten como egresos futuros.
  const ownAccountDetector = buildOwnAccountDetector(
    buildOwnAccountsIndex(bankStatements),
  );

  // concepto → yearMonth → total
  const perConcept = new Map<string, Map<string, number>>();
  for (const acc of bankStatements) {
    for (const mov of acc.movimientos) {
      if (mov.tipoMovimiento !== 'CARGO') continue;
      if (isInternalTransfer(mov, ownAccountDetector)) continue;
      if (isNoisyBankExpenseConcept(mov.concepto ?? '')) continue;
      const ym = (mov.fechaOperacion ?? '').slice(0, 7);
      if (ym.length !== 7) continue;
      if (compareYearMonth(ym, currentYm) >= 0) continue;
      const rawLabel = (mov.concepto ?? '').trim().toUpperCase();
      const label = rawLabel ? rawLabel.slice(0, 40) : `CUENTA ${acc.cuenta}`;
      if (!perConcept.has(label)) perConcept.set(label, new Map());
      const m = perConcept.get(label)!;
      m.set(ym, (m.get(ym) ?? 0) + Math.abs(mov.importe ?? 0));
    }
  }

  // Tomamos los últimos `lookbackMonths` meses COMPLETOS reales (con data)
  const allMonths = new Set<string>();
  for (const perMonth of perConcept.values()) {
    for (const ym of perMonth.keys()) allMonths.add(ym);
  }
  const recentMonths = Array.from(allMonths).sort().slice(-lookbackMonths);
  if (recentMonths.length === 0) return { base: 0, top: [] };

  let base = 0;
  const top: Array<{ label: string; monthlyAvg: number; monthsActive: number }> = [];
  for (const [label, perMonth] of perConcept) {
    const activeMonths = recentMonths.filter((ym) => (perMonth.get(ym) ?? 0) > 0);
    if (activeMonths.length / recentMonths.length < 0.5) continue;
    const total = activeMonths.reduce((s, ym) => s + (perMonth.get(ym) ?? 0), 0);
    const avg = total / activeMonths.length;
    base += avg;
    top.push({ label, monthlyAvg: avg, monthsActive: activeMonths.length });
  }
  top.sort((a, b) => b.monthlyAvg - a.monthlyAvg);
  return { base, top: top.slice(0, 8) };
}

/**
 * Resuelve el egreso proyectado para un mes combinando las tres fuentes.
 *   - scheduled: lo ya programado en /AntiguedadSaldos (verdad operativa).
 *   - recurring: lo que típicamente pagamos cada mes según el banco.
 *   - baseline: MA6 del histórico, como piso.
 * Tomamos el máximo para no subestimar.
 */
export function resolveExpenseForMonth(
  scheduled: number,
  recurring: number,
  baseline: number,
  topRecurring: Array<{ label: string; monthlyAvg: number; monthsActive: number }>,
  providerLines: ProviderMonthLine[] = [],
  budgetValue: number | null = null,
  budgetLines: Array<{ concept: string; amount: number }> = [],
): ExpenseProjectionBreakdown {
  if (budgetValue !== null) {
    return {
      scheduled, recurring, baseline,
      fromBudget: budgetValue,
      total: budgetValue,
      source: 'budget',
      topRecurring, providerLines, budgetLines,
    };
  }
  const total = Math.max(scheduled, recurring, baseline);
  const source = total === scheduled && scheduled > 0 ? 'scheduled'
    : total === recurring && recurring > 0 ? 'recurring'
    : 'baseline';
  return {
    scheduled, recurring, baseline,
    fromBudget: 0,
    total,
    source,
    topRecurring, providerLines, budgetLines,
  };
}

// ── Orquestación ─────────────────────────────────────────────────────────

export interface MonthlyProjection {
  yearMonth: string;
  income: IncomeProjectionBreakdown;
  expense: ExpenseProjectionBreakdown;
}

export interface ProjectionOverride {
  income?: number;
  expense?: number;
}

export type ProjectionOverrides = Record<string, ProjectionOverride>;

export interface ProjectionInputs {
  /** Primer yearMonth futuro a proyectar (inclusivo). */
  fromYm: string;
  /** Último yearMonth futuro a proyectar (inclusivo). */
  toYm: string;
  /** Catálogo de clientes; si está vacío caemos a baseline. */
  clients: Client[];
  /** Catálogo de proveedores; si está vacío caemos a detección por concepto. */
  providers?: Provider[];
  /** Antigüedad de saldos ya cargada. */
  aged: AgedBalanceRecord[];
  /** Histórico bancario ya cargado (para recurrentes). */
  bankStatements: BankAccountStatement[];
  /** Baseline MA6 de ingresos mensuales. */
  baselineIncome: number;
  /** Baseline MA6 de egresos mensuales. */
  baselineExpense: number;
  /** Supuestos de cobranza. */
  assumptions: CashFlowAssumptions;
  /** Fecha de "hoy" para recortar meses parciales. */
  today: string;
  /**
   * Presupuesto cargado por el usuario. Si existe y cubre el mes, los
   * totales de ingreso y egreso vienen de ahí (es el compromiso del año).
   * Sigue conviviendo con la proyección per-proveedor para el desglose.
   */
  budget?: Budget | null;
}

export interface ProjectionResult {
  months: MonthlyProjection[];
  recurringTop: Array<{ label: string; monthlyAvg: number; monthsActive: number }>;
  recurringBase: number;
}

/**
 * Proyecta ingresos y egresos por mes sobre el rango [fromYm, toYm] usando
 * todas las fuentes disponibles. No aplica overrides — eso lo hace la UI
 * después para poder mostrarle al usuario el "antes" vs. "después".
 */
export function buildMonthlyProjection(inputs: ProjectionInputs): ProjectionResult {
  const {
    fromYm, toYm, clients, providers, aged, bankStatements,
    baselineIncome, baselineExpense, assumptions, today, budget,
  } = inputs;

  const incomeByMonth = projectClientIncomeByMonth(clients, assumptions, fromYm, toYm);

  // Path A (con catálogo de proveedores): proyección per-proveedor que
  // matchea CARGOs + CXP al catálogo, respeta flexibility y paymentPeriod.
  // Path B (sin catálogo): detección por concepto bancario como antes.
  const usePerProvider = !!providers && providers.length > 0;
  const perProviderMonths = usePerProvider
    ? projectExpenseByProvider({
        providers: providers!, aged, bankStatements, today, fromYm, toYm,
      })
    : [];
  const perProviderByYm = new Map(perProviderMonths.map((m) => [m.yearMonth, m]));

  const scheduledByMonth = buildScheduledExpenseMap(aged);
  const { base: recurringBase, top: recurringTop } = usePerProvider
    ? { base: 0, top: [] as Array<{ label: string; monthlyAvg: number; monthsActive: number }> }
    : detectRecurringExpenses(bankStatements, today);

  const months: MonthlyProjection[] = [];
  let cursor = fromYm;
  while (compareYearMonth(cursor, toYm) <= 0) {
    const clientIncome = incomeByMonth.get(cursor) ?? 0;
    const [y, m] = cursor.split('-').map(Number);
    const monthIdx = m - 1;
    const budgetApplies = budget && budget.year === y;
    const budgetIncome = budgetApplies ? (budget!.incomeTotal[monthIdx] ?? null) : null;
    const budgetExpense = budgetApplies ? (budget!.expenseTotal[monthIdx] ?? null) : null;
    const budgetExpenseLines = budgetApplies
      ? budget!.expenseByConcept.map((r) => ({ concept: r.concept, amount: r.monthly[monthIdx] ?? 0 }))
      : [];

    const income = resolveIncomeForMonth(clientIncome, baselineIncome, budgetIncome);

    let expense: ExpenseProjectionBreakdown;
    if (usePerProvider) {
      const perProv = perProviderByYm.get(cursor);
      const scheduled = perProv?.scheduledTotal ?? 0;
      const recurring = perProv?.recurringTotal ?? 0;
      if (budgetExpense !== null) {
        expense = {
          scheduled,
          recurring,
          baseline: baselineExpense,
          fromBudget: budgetExpense,
          total: budgetExpense,
          source: 'budget',
          topRecurring: [],
          providerLines: perProv?.lines ?? [],
          budgetLines: budgetExpenseLines,
        };
      } else {
        const total = Math.max(perProv?.total ?? 0, baselineExpense);
        expense = {
          scheduled,
          recurring,
          baseline: baselineExpense,
          fromBudget: 0,
          total,
          source: total === scheduled ? 'scheduled' : total === recurring ? 'recurring' : 'baseline',
          topRecurring: [],
          providerLines: perProv?.lines ?? [],
          budgetLines: [],
        };
      }
    } else {
      const scheduled = scheduledByMonth.get(cursor) ?? 0;
      expense = resolveExpenseForMonth(
        scheduled, recurringBase, baselineExpense, recurringTop, [],
        budgetExpense, budgetExpenseLines,
      );
    }

    months.push({ yearMonth: cursor, income, expense });
    cursor = addMonths(cursor, 1);
  }
  return { months, recurringTop, recurringBase };
}

/**
 * Aplica overrides manuales (ingreso/egreso por mes) sobre una proyección
 * base. Devuelve un Map listo para encadenar la caja.
 */
export function applyProjectionOverrides(
  projection: MonthlyProjection[],
  overrides: ProjectionOverrides,
): Array<{ yearMonth: string; income: number; expense: number; override: ProjectionOverride | null }> {
  return projection.map((m) => {
    const o = overrides[m.yearMonth] ?? {};
    return {
      yearMonth: m.yearMonth,
      income: typeof o.income === 'number' ? o.income : m.income.total,
      expense: typeof o.expense === 'number' ? o.expense : m.expense.total,
      override: o.income !== undefined || o.expense !== undefined ? o : null,
    };
  });
}

/**
 * Helper: diferencia en meses entre dos yearMonth, devuelve siempre >= 0.
 * Útil para horizonte.
 */
export function monthsInRange(fromYm: string, toYm: string): number {
  return Math.max(0, monthsBetween(fromYm, toYm)) + 1;
}
