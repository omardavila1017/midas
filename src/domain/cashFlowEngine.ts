// ─────────────────────────────────────────────────────────────────────────
// cashFlowEngine — construye el flujo base mensual desde JDE real.
//
// APIs reales usadas:
//   - /Bancos (históricos por mes): ABONOs = ingresos, CARGOs = egresos,
//     último saldoFinal del mes = caja final real.
//   - /AntiguedadSaldos (egresos futuros comprometidos): se suman
//     importePendientePesos por mes de fechaProgramacionPago.
//   - Ingresos futuros: no hay API de cobranza todavía. Se proyecta con un
//     promedio móvil simple de los últimos 6 meses históricos (placeholder).
//
// El módulo de Planeación Financiera vive sobre `FinancialMovement`/
// `ForecastRun` y consume de aquí únicamente las utilidades de fecha y la
// construcción del flujo base. Toda la lógica de propuestas/escenarios fue
// eliminada al borrar el módulo de Simulación.
// ─────────────────────────────────────────────────────────────────────────

import {
  fetchAgedBalances,
  fetchBankStatementsRange,
  type BankAccountStatement,
  type AgedBalanceRecord,
} from '../services/jde';
import {
  buildOwnAccountsIndex,
  buildOwnAccountDetector,
  buildPairMatchedKeys,
  classifyMovement,
  type ClassificationContext,
} from './netCashFlowEngine';
import { CashFlowMonth } from '../types';

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

  // Detector de traspasos entre cuentas propias del grupo. Si un ABONO en una
  // cuenta se compensa con un CARGO en otra del mismo grupo, sumarlos infla
  // ambos lados del flujo sin reflejar un ingreso/egreso económico real.
  //
  // Usamos `classifyMovement` (no `isInternalTransfer`) para que la detección
  // coincida exactamente con la que aplica la pantalla de Bancos: incluye
  // también el detector pair-matched (CARGO en una cuenta compensado con
  // ABONO simétrico el mismo día en otra cuenta del mismo grupo, mismo
  // importe). Antes el Dashboard contaba esos pares como ingresos/egresos
  // reales mientras Bancos los mostraba en gris — y la gráfica no reflejaba
  // el filtro de transferencias internas.
  const ctx: ClassificationContext = {
    ownAccountDetector: buildOwnAccountDetector(buildOwnAccountsIndex(statements)),
    pairedKeys: buildPairMatchedKeys(statements),
  };

  const byMonth = new Map<string, { income: number; expense: number }>();

  for (const acc of statements) {
    for (const mov of acc.movimientos) {
      const ym = toYearMonth(mov.fechaOperacion);
      if (!ym) continue;
      if (classifyMovement(mov, ctx, acc.cia, acc.cuenta).kind === 'internal') continue;
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

// ── 3.b Proyección de egresos futuros ────────────────────────────────────

/**
 * Proyector de egresos basado en el promedio de los últimos N meses
 * históricos. Antes se usaba regresión lineal, pero producía extrapolaciones
 * irreales: si el mes en curso venía parcial (menos días = menos egresos) la
 * pendiente quedaba negativa y los egresos proyectados caían a ~0 para meses
 * lejanos (p.ej. diciembre), inflando artificialmente la caja final. Con un
 * promedio móvil el baseline se mantiene estable y los picos comprometidos
 * desde /AntiguedadSaldos siguen pesando vía `projectMonthlyExpense`.
 */
export function buildExpenseProjector(
  historical: CashFlowMonth[],
  windowSize = 6,
): (offset: number) => number {
  if (historical.length === 0) return () => 0;
  const recent = historical.slice(-windowSize);
  const avg = recent.reduce((s, m) => s + m.expense, 0) / recent.length;
  const baseline = Math.max(0, avg);
  return () => baseline;
}

/**
 * Proyecta egresos para un mes futuro combinando el baseline histórico con
 * los egresos ya comprometidos en /AntiguedadSaldos: toma el máximo para no
 * subestimar pagos ya programados y para asegurar que, aunque un mes lejano
 * aún no tenga facturas programadas, se preserve el nivel típico de gasto.
 */
export function projectMonthlyExpense(
  offsetFromLastHistorical: number,
  committed: number,
  expenseProjector: (offset: number) => number,
): number {
  const projected = expenseProjector(offsetFromLastHistorical);
  return Math.max(committed, projected);
}

/**
 * Devuelve los meses históricos estrictamente anteriores al mes de `today`.
 * El mes en curso suele venir parcial (solo los días transcurridos) y, si se
 * incluye en promedios o regresiones, sesga los proyectados hacia abajo.
 */
export function filterCompleteHistorical(
  historical: CashFlowMonth[],
  today: string,
): CashFlowMonth[] {
  const currentYm = toYearMonth(today);
  return historical.filter((m) => compareYearMonth(m.yearMonth, currentYm) < 0);
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
  // Para los promedios que alimentan la proyección excluimos el mes en curso
  // (parcial). De otro modo ingresos y egresos proyectados salen subestimados.
  const completeHistorical = filterCompleteHistorical(historical, today);
  const avgIncome = projectFutureIncome(completeHistorical, incomeProjectionWindow);
  const expenseProjector = buildExpenseProjector(completeHistorical);

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
