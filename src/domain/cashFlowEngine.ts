// ─────────────────────────────────────────────────────────────────────────
// cashFlowEngine — construye el flujo base desde JDE real y evalúa propuestas.
//
// APIs reales usadas:
//   - /Bancos (históricos por mes): ABONOs = ingresos, CARGOs = egresos,
//     último saldoFinal del mes = caja final real.
//   - /AntiguedadSaldos (egresos futuros comprometidos): se suman
//     importePendientePesos por mes de fechaProgramacionPago.
//   - Ingresos futuros: no hay API de cobranza todavía. Se proyecta con un
//     promedio móvil simple de los últimos 6 meses históricos (placeholder).
//     Regresión lineal y upload de presupuesto quedan en backlog.
// ─────────────────────────────────────────────────────────────────────────

import {
  fetchAgedBalances,
  fetchBankStatementsRange,
  type BankAccountStatement,
  type AgedBalanceRecord,
} from '../services/jde';
import {
  CashFlowMonth,
  EvaluatedCashFlow,
  EvaluatedMonth,
  Proposal,
  ProposalDelta,
} from '../types';

// ── Helpers de fecha ─────────────────────────────────────────────────────

/** "YYYY-MM-DD" → "YYYY-MM" */
export function toYearMonth(dateIso: string): string {
  return dateIso.slice(0, 7);
}

/** "YYYY-MM" + n → "YYYY-MM" */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const date = new Date(Date.UTC(y, (m - 1) + n, 1));
  const ny = date.getUTCFullYear();
  const nm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${ny}-${nm}`;
}

/** Compara dos "YYYY-MM" lexicográficamente (funciona por formato ISO). */
export function compareYearMonth(a: string, b: string): number {
  return a.localeCompare(b);
}

/** Meses entre a (inclusive) y b (inclusive). Devuelve >= 0 si b >= a. */
export function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

/** Último día del mes en "YYYY-MM-DD". */
export function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const date = new Date(Date.UTC(y, m, 0)); // día 0 del mes siguiente = último día
  return date.toISOString().slice(0, 10);
}

// ── 1. Históricos desde /Bancos ──────────────────────────────────────────

/**
 * Agrupa movimientos bancarios por mes. Para cada mes:
 *   - income  = suma de ABONOs
 *   - expense = suma de CARGOs
 *   - closingCash = suma del último saldoFinal registrado por (cia, cuenta)
 *                   hasta el último día del mes.
 *
 * Nota: saldoFinal viene a nivel de cuenta por día. Para la caja final del
 * mes sumamos el saldoFinal más reciente de cada cuenta dentro del mes. Si
 * una cuenta no tuvo movimientos en el mes, arrastramos el saldoFinal del
 * mes anterior.
 */
export function buildHistoricalMonths(
  statements: BankAccountStatement[],
): CashFlowMonth[] {
  if (statements.length === 0) return [];

  const byMonth = new Map<string, { income: number; expense: number }>();

  for (const acc of statements) {
    for (const mov of acc.movimientos) {
      const ym = toYearMonth(mov.fechaOperacion);
      if (!ym) continue;
      const bucket = byMonth.get(ym) ?? { income: 0, expense: 0 };
      if (mov.tipoMovimiento === 'ABONO') bucket.income += mov.importe;
      else if (mov.tipoMovimiento === 'CARGO') bucket.expense += mov.importe;
      byMonth.set(ym, bucket);
    }
  }

  // Caja final por mes: sumamos, por cada cuenta, su último saldoFinal
  // conocido en ese mes (arrastrando del anterior si no hubo movimientos).
  // Como /Bancos devuelve saldoFinal a nivel (cuenta, día), reconstruimos
  // el saldoFinal de cada cuenta al último movimiento del mes.
  // Estrategia simple: para cada cuenta, tomar el último fechaEstadoCuenta
  // y asumir que ése es el saldoFinal al cierre del mes más reciente.
  // Para meses intermedios aproximamos con: caja_inicial_cuenta + acumulado
  // de movimientos hasta fin de mes.

  // 1) Snapshot saldos iniciales por cuenta
  const initialBalanceByAccount = new Map<string, number>();
  for (const acc of statements) {
    const key = `${acc.cia}::${acc.cuenta}::${acc.moneda}`;
    if (acc.saldoInicial !== undefined) {
      initialBalanceByAccount.set(key, acc.saldoInicial);
    }
  }

  // 2) Acumular por mes el saldo por cuenta
  const months = Array.from(byMonth.keys()).sort();
  if (months.length === 0) return [];

  // Acumulado de flujo neto por cuenta y mes
  const accountMonthlyNet = new Map<string, Map<string, number>>();
  for (const acc of statements) {
    const key = `${acc.cia}::${acc.cuenta}::${acc.moneda}`;
    const perMonth = new Map<string, number>();
    for (const mov of acc.movimientos) {
      const ym = toYearMonth(mov.fechaOperacion);
      if (!ym) continue;
      const sign = mov.tipoMovimiento === 'ABONO' ? 1 : -1;
      perMonth.set(ym, (perMonth.get(ym) ?? 0) + sign * mov.importe);
    }
    accountMonthlyNet.set(key, perMonth);
  }

  // 3) Reconstruir saldo final por cuenta y mes, arrastrando
  const accountMonthlyClosing = new Map<string, Map<string, number>>();
  for (const [key, perMonth] of accountMonthlyNet) {
    let running = initialBalanceByAccount.get(key) ?? 0;
    const closingMap = new Map<string, number>();
    for (const ym of months) {
      running += perMonth.get(ym) ?? 0;
      closingMap.set(ym, running);
    }
    accountMonthlyClosing.set(key, closingMap);
  }

  // 4) Sumar cajas por mes
  const result: CashFlowMonth[] = [];
  for (const ym of months) {
    const bucket = byMonth.get(ym) ?? { income: 0, expense: 0 };
    let closing = 0;
    for (const closingMap of accountMonthlyClosing.values()) {
      closing += closingMap.get(ym) ?? 0;
    }
    result.push({
      yearMonth: ym,
      isHistorical: true,
      income: bucket.income,
      expense: bucket.expense,
      closingCash: closing,
    });
  }

  return result;
}

// ── 2. Egresos futuros desde /AntiguedadSaldos ───────────────────────────

/**
 * Agrupa importePendientePesos por mes de fechaProgramacionPago. Las facturas
 * sin fecha de programación se ignoran.
 */
export function buildFutureExpenses(
  aged: AgedBalanceRecord[],
): Map<string, number> {
  const byMonth = new Map<string, number>();
  for (const r of aged) {
    const ym = toYearMonth(r.fechaProgramacionPago);
    if (!ym || ym.length !== 7) continue;
    byMonth.set(ym, (byMonth.get(ym) ?? 0) + r.importePendientePesos);
  }
  return byMonth;
}

// ── 3. Proyección de ingresos futuros ────────────────────────────────────

/**
 * Promedio móvil simple de los últimos N meses históricos.
 * Si no hay historia, devuelve 0.
 */
export function projectFutureIncome(
  historical: CashFlowMonth[],
  windowSize = 6,
): number {
  if (historical.length === 0) return 0;
  const recent = historical.slice(-windowSize);
  const total = recent.reduce((s, m) => s + m.income, 0);
  return total / recent.length;
}

// ── 3.b Proyección de egresos futuros (regresión lineal) ─────────────────

/**
 * Regresión lineal simple sobre un arreglo de valores históricos.
 * Devuelve una función que dado un offset >= 1 (meses después del último
 * histórico) regresa el valor proyectado, nunca negativo.
 *
 * Con menos de 2 puntos cae en promedio / constante / cero.
 */
function buildLinearProjector(values: number[]): (offset: number) => number {
  if (values.length === 0) return () => 0;
  if (values.length === 1) {
    const v = Math.max(0, values[0]);
    return () => v;
  }
  const n = values.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return (offset: number) => {
    const x = (n - 1) + offset; // offset=1 → siguiente punto después del último
    return Math.max(0, intercept + slope * x);
  };
}

/**
 * Proyector de egresos por regresión lineal sobre los últimos N meses
 * históricos. `offset` es la distancia en meses contra el último histórico
 * (1 = primer mes proyectado).
 */
export function buildExpenseProjector(
  historical: CashFlowMonth[],
  windowSize = 12,
): (offset: number) => number {
  if (historical.length === 0) return () => 0;
  const recent = historical.slice(-windowSize);
  return buildLinearProjector(recent.map((m) => m.expense));
}

/**
 * Proyecta egresos para un mes futuro combinando la regresión lineal con los
 * egresos ya comprometidos en /AntiguedadSaldos: toma el máximo para no
 * subestimar pagos ya programados cuando la tendencia histórica es menor.
 */
export function projectMonthlyExpense(
  offsetFromLastHistorical: number,
  committed: number,
  expenseProjector: (offset: number) => number,
): number {
  const projected = expenseProjector(offsetFromLastHistorical);
  return Math.max(committed, projected);
}

// ── 4. Orquestación: base cash flow completo ─────────────────────────────

export interface BuildBaseCashFlowOptions {
  companyCode: string;            // 'all' significa sin filtro por cia
  historicalStart: string;        // "YYYY-MM-DD"
  today: string;                  // "YYYY-MM-DD"
  horizonMonths: number;          // cuántos meses futuros proyectar
  bankStatements?: BankAccountStatement[]; // opcional: usar caché en vez de fetch
  agedBalances?: AgedBalanceRecord[];      // opcional
  incomeProjectionWindow?: number;
}

/**
 * Construye la caja base mes a mes, desde historicalStart hasta
 * today + horizonMonths. Usa datos de JDE real; si se pasan bankStatements /
 * agedBalances precargados, los usa directamente (evita hacer fetch).
 */
export async function buildBaseCashFlow(
  options: BuildBaseCashFlowOptions,
): Promise<CashFlowMonth[]> {
  const {
    companyCode,
    historicalStart,
    today,
    horizonMonths,
    bankStatements: providedBank,
    agedBalances: providedAged,
    incomeProjectionWindow = 6,
  } = options;

  // 1) Cargar históricos (si no vienen ya)
  let statements = providedBank;
  if (!statements) {
    statements = await fetchBankStatementsRange(
      historicalStart,
      today,
      'SWIFT',
      { concurrency: 6 },
    );
  }

  // Filtrar por cia si aplica (companyCode='all' = no filtrar)
  const filteredStatements =
    companyCode === 'all' || !companyCode
      ? statements
      : statements.filter((s) => s.cia === companyCode);

  // 2) Cargar egresos futuros
  let aged: AgedBalanceRecord[] = providedAged ?? [];
  if (!providedAged) {
    if (companyCode === 'all' || !companyCode) {
      // Sin una cia específica, AntiguedadSaldos no tiene request válida —
      // omitimos los egresos comprometidos. La UI puede avisar al usuario.
      aged = [];
    } else {
      aged = await fetchAgedBalances({ cia: companyCode });
    }
  }

  // 3) Construir históricos
  const historical = buildHistoricalMonths(filteredStatements);
  const futureExpenses = buildFutureExpenses(aged);
  const avgIncome = projectFutureIncome(historical, incomeProjectionWindow);
  const expenseProjector = buildExpenseProjector(historical);

  // 4) Determinar rango final
  const lastHistoricalYm = historical.length > 0
    ? historical[historical.length - 1].yearMonth
    : toYearMonth(today);
  const todayYm = toYearMonth(today);
  // Empezar futuros el mes siguiente al último histórico (o al mes actual)
  const firstFutureYm = addMonths(
    compareYearMonth(lastHistoricalYm, todayYm) > 0 ? lastHistoricalYm : todayYm,
    1,
  );
  const lastFutureYm = addMonths(todayYm, horizonMonths);

  // 5) Construir proyección futura encadenando la caja
  const months: CashFlowMonth[] = [...historical];
  let runningCash = historical.length > 0
    ? historical[historical.length - 1].closingCash
    : 0;

  let cursor = firstFutureYm;
  while (compareYearMonth(cursor, lastFutureYm) <= 0) {
    const offset = Math.max(1, monthsBetween(lastHistoricalYm, cursor));
    const committed = futureExpenses.get(cursor) ?? 0;
    const expense = projectMonthlyExpense(offset, committed, expenseProjector);
    const income = avgIncome;
    runningCash = runningCash + income - expense;
    months.push({
      yearMonth: cursor,
      isHistorical: false,
      income,
      expense,
      closingCash: runningCash,
    });
    cursor = addMonths(cursor, 1);
  }

  return months;
}

// ── 5. Aplicar propuestas ────────────────────────────────────────────────

/**
 * Devuelve el impacto de una propuesta en un mes específico según su
 * frecuencia y fecha de inicio. Una propuesta deshabilitada no aporta nada.
 *
 *   - one_time: aplica sólo en startYearMonth
 *   - monthly: aplica todos los meses desde startYearMonth
 *   - quarterly: cada 3 meses desde startYearMonth
 *   - semiannual: cada 6 meses desde startYearMonth
 *
 * Un ahorro (expense_saving) reduce egresos → deltaExpense negativo.
 * Un incremento de ingresos (income_increase) suma ingresos → deltaIncome positivo.
 */
export function applyProposalToMonth(
  proposal: Proposal,
  yearMonth: string,
): { deltaIncome: number; deltaExpense: number } {
  if (!proposal.enabled) return { deltaIncome: 0, deltaExpense: 0 };
  const diff = monthsBetween(proposal.startYearMonth, yearMonth);
  if (diff < 0) return { deltaIncome: 0, deltaExpense: 0 };

  let hits = false;
  switch (proposal.frequency) {
    case 'one_time':
      hits = diff === 0;
      break;
    case 'monthly':
      hits = true;
      break;
    case 'quarterly':
      hits = diff % 3 === 0;
      break;
    case 'semiannual':
      hits = diff % 6 === 0;
      break;
  }
  if (!hits) return { deltaIncome: 0, deltaExpense: 0 };

  if (proposal.kind === 'income_increase') {
    return { deltaIncome: proposal.amount, deltaExpense: 0 };
  }
  // expense_saving: ahorro reduce egresos (delta negativo)
  return { deltaIncome: 0, deltaExpense: -proposal.amount };
}

// ── 6. Evaluación completa ───────────────────────────────────────────────

/**
 * Evalúa el flujo con las propuestas habilitadas aplicadas. Devuelve meses
 * con caja base, caja pronosticada y contribuciones por propuesta. La caja
 * se recalcula encadenadamente:
 *   closing[m] = closing[m-1] + income[m] + deltaIncome[m] - (expense[m] + deltaExpense[m])
 */
export function evaluateCashFlow(
  base: CashFlowMonth[],
  proposals: Proposal[],
): EvaluatedCashFlow {
  const months: EvaluatedMonth[] = [];
  let runningBase = 0;
  let runningForecast = 0;

  for (let i = 0; i < base.length; i++) {
    const m = base[i];
    const deltas: ProposalDelta[] = [];
    let deltaIncomeSum = 0;
    let deltaExpenseSum = 0;

    for (const p of proposals) {
      const { deltaIncome, deltaExpense } = applyProposalToMonth(p, m.yearMonth);
      if (deltaIncome === 0 && deltaExpense === 0) continue;
      deltas.push({
        proposalId: p.id,
        proposalName: p.name,
        deltaIncome,
        deltaExpense,
      });
      deltaIncomeSum += deltaIncome;
      deltaExpenseSum += deltaExpense;
    }

    // Los históricos no se "ajustan" por propuestas (ya pasaron). Sólo los
    // meses futuros reciben el impacto.
    const applyDeltas = !m.isHistorical;

    if (i === 0) {
      runningBase = m.closingCash;
      runningForecast = applyDeltas
        ? m.closingCash + deltaIncomeSum - deltaExpenseSum
        : m.closingCash;
    } else {
      runningBase = m.closingCash;
      if (applyDeltas) {
        // Caja forecast encadenada: parte del forecast del mes anterior y
        // suma el flujo neto del mes con deltas.
        const netBase = m.income - m.expense;
        const netForecast = netBase + deltaIncomeSum - deltaExpenseSum;
        runningForecast = runningForecast + netForecast;
      } else {
        runningForecast = m.closingCash;
      }
    }

    months.push({
      yearMonth: m.yearMonth,
      isHistorical: m.isHistorical,
      baseIncome: m.income,
      baseExpense: m.expense,
      baseClosingCash: runningBase,
      forecastIncome: m.income + (applyDeltas ? deltaIncomeSum : 0),
      forecastExpense: m.expense + (applyDeltas ? deltaExpenseSum : 0),
      forecastClosingCash: runningForecast,
      proposalDeltas: deltas,
    });
  }

  return {
    months,
    proposals,
    totalBaseClosingCash: months.length > 0
      ? months[months.length - 1].baseClosingCash
      : 0,
    totalForecastClosingCash: months.length > 0
      ? months[months.length - 1].forecastClosingCash
      : 0,
  };
}

// ── 7. Granularidad semanal / diaria ─────────────────────────────────────
//
// Se derivan del mensual repartiendo lineal. Se podría mejorar con calendario
// de días hábiles MX; queda como TODO.

export interface PeriodPoint {
  periodStart: string;   // "YYYY-MM-DD"
  periodEnd: string;     // "YYYY-MM-DD"
  periodLabel: string;
  isHistorical: boolean;
  baseIncome: number;
  baseExpense: number;
  baseClosingCash: number;
  forecastIncome: number;
  forecastExpense: number;
  forecastClosingCash: number;
}

function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function weeksInMonth(ym: string): number {
  // Número de lunes que caen en el mes + 1 (aproximación simple: 4-5 semanas)
  const days = daysInMonth(ym);
  return Math.ceil(days / 7);
}

/**
 * Reparte cada mes evaluado en N semanas de 7 días (última semana puede ser
 * más corta). El saldo closingCash se interpola linealmente dentro del mes.
 */
export function projectWeekly(evaluated: EvaluatedCashFlow): PeriodPoint[] {
  const out: PeriodPoint[] = [];
  let prevBase = 0;
  let prevForecast = 0;
  for (let i = 0; i < evaluated.months.length; i++) {
    const m = evaluated.months[i];
    const weeks = weeksInMonth(m.yearMonth);
    const weekIncomeBase = m.baseIncome / weeks;
    const weekExpenseBase = m.baseExpense / weeks;
    const weekIncomeFore = m.forecastIncome / weeks;
    const weekExpenseFore = m.forecastExpense / weeks;
    const [y, mo] = m.yearMonth.split('-').map(Number);
    const totalDays = daysInMonth(m.yearMonth);
    const baseStart = i === 0 ? m.baseClosingCash - (m.baseIncome - m.baseExpense) : prevBase;
    const foreStart = i === 0 ? m.forecastClosingCash - (m.forecastIncome - m.forecastExpense) : prevForecast;

    let runningBase = baseStart;
    let runningFore = foreStart;

    for (let w = 0; w < weeks; w++) {
      const dayFrom = w * 7 + 1;
      const dayTo = Math.min((w + 1) * 7, totalDays);
      const periodStart = `${y}-${String(mo).padStart(2, '0')}-${String(dayFrom).padStart(2, '0')}`;
      const periodEnd = `${y}-${String(mo).padStart(2, '0')}-${String(dayTo).padStart(2, '0')}`;
      runningBase += weekIncomeBase - weekExpenseBase;
      runningFore += weekIncomeFore - weekExpenseFore;
      out.push({
        periodStart,
        periodEnd,
        periodLabel: `${m.yearMonth} S${w + 1}`,
        isHistorical: m.isHistorical,
        baseIncome: weekIncomeBase,
        baseExpense: weekExpenseBase,
        baseClosingCash: runningBase,
        forecastIncome: weekIncomeFore,
        forecastExpense: weekExpenseFore,
        forecastClosingCash: runningFore,
      });
    }
    prevBase = m.baseClosingCash;
    prevForecast = m.forecastClosingCash;
  }
  return out;
}

/**
 * Reparte cada mes evaluado en días calendario (1..N). Versión simple:
 * reparto lineal del flujo del mes. TODO: respetar días hábiles MX.
 */
export function projectDaily(evaluated: EvaluatedCashFlow): PeriodPoint[] {
  const out: PeriodPoint[] = [];
  let prevBase = 0;
  let prevForecast = 0;
  for (let i = 0; i < evaluated.months.length; i++) {
    const m = evaluated.months[i];
    const days = daysInMonth(m.yearMonth);
    const dayIncomeBase = m.baseIncome / days;
    const dayExpenseBase = m.baseExpense / days;
    const dayIncomeFore = m.forecastIncome / days;
    const dayExpenseFore = m.forecastExpense / days;
    const [y, mo] = m.yearMonth.split('-').map(Number);
    const baseStart = i === 0 ? m.baseClosingCash - (m.baseIncome - m.baseExpense) : prevBase;
    const foreStart = i === 0 ? m.forecastClosingCash - (m.forecastIncome - m.forecastExpense) : prevForecast;
    let runningBase = baseStart;
    let runningFore = foreStart;
    for (let d = 1; d <= days; d++) {
      const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      runningBase += dayIncomeBase - dayExpenseBase;
      runningFore += dayIncomeFore - dayExpenseFore;
      out.push({
        periodStart: iso,
        periodEnd: iso,
        periodLabel: iso,
        isHistorical: m.isHistorical,
        baseIncome: dayIncomeBase,
        baseExpense: dayExpenseBase,
        baseClosingCash: runningBase,
        forecastIncome: dayIncomeFore,
        forecastExpense: dayExpenseFore,
        forecastClosingCash: runningFore,
      });
    }
    prevBase = m.baseClosingCash;
    prevForecast = m.forecastClosingCash;
  }
  return out;
}
