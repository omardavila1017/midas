// ─────────────────────────────────────────────────────────────────────────
// forecastEngine — motor de proyección mensual alimentado por:
//
//   · /Bancos histórico (ingreso/egreso real por mes, filtrando traspasos
//     internos vía netCashFlowEngine.isInternalTransfer).
//   · Catálogo de clientes + reglas de cobranza (collectionEngine.projectYear)
//     → estimación de ingresos futuros por mes con estacionalidad real.
//   · /AntiguedadSaldos → egresos ya programados por mes.
//   · Baseline de egresos por media móvil + factor de calibración vs histórico.
//   · Overrides del usuario (tabla editable de flujo) — siempre ganan.
//
// A diferencia de una media móvil plana, este motor produce una cifra
// distinta por mes futuro cuando hay info real que respalde la variación.
// ─────────────────────────────────────────────────────────────────────────

import type { BankAccountStatement, AgedBalanceRecord } from '../services/jde';
import type {
  CashFlowMonth,
  CashFlowOverrides,
} from '../types';
import type { Client, CashFlowAssumptions } from './types';
import { projectYear, bucketByMonth } from './collectionEngine';
import {
  buildHistoricalMonths,
  buildFutureExpenses,
  projectFutureIncome,
  buildExpenseProjector,
  filterCompleteHistorical,
  toYearMonth,
  addMonths,
  compareYearMonth,
} from './cashFlowEngine';

export type IncomeSource = 'historical' | 'clients' | 'baseline' | 'override';
export type ExpenseSource = 'historical' | 'committed' | 'baseline' | 'override';

export interface ForecastMonth extends CashFlowMonth {
  incomeSource: IncomeSource;
  expenseSource: ExpenseSource;
  incomeOverridden: boolean;
  expenseOverridden: boolean;
  incomeFromClientsRaw: number;      // antes de calibración (0 si catálogo vacío)
  incomeFromClientsCalibrated: number; // después de calibración
  incomeBaseline: number;             // media móvil
  expenseCommitted: number;           // desde AntiguedadSaldos
  expenseBaseline: number;            // media móvil
  incomeCalibrationFactor: number;
  expenseCalibrationFactor: number;
}

export interface ForecastInputs {
  today: string;                      // "YYYY-MM-DD"
  horizonMonths: number;              // p.ej. 12
  bankStatements: BankAccountStatement[];
  agedBalances: AgedBalanceRecord[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  overrides: CashFlowOverrides;
  companyCode: string;                // 'all' = sin filtro
}

export interface ForecastResult {
  months: ForecastMonth[];
  incomeCalibrationFactor: number;
  expenseCalibrationFactor: number;
  clientsCoverageMonths: number;      // cuántos meses del histórico se usaron para calibrar
  avgIncomeBaseline: number;
  avgExpenseBaseline: number;
  hasClientsCatalog: boolean;
}

/**
 * Proyecta flujo mes a mes combinando histórico real + cobranza proyectada
 * + egresos programados + baselines. Aplica overrides del usuario al final.
 */
export function forecastCashFlow(inputs: ForecastInputs): ForecastResult {
  const {
    today, horizonMonths, bankStatements, agedBalances,
    clients, assumptions, overrides, companyCode,
  } = inputs;

  // 1) Filtrado por compañía.
  const bank = companyCode === 'all' || !companyCode
    ? bankStatements
    : bankStatements.filter((s) => s.cia === companyCode);
  const aged = companyCode === 'all' || !companyCode
    ? agedBalances
    : agedBalances.filter((r) => r.cia === companyCode);

  // 2) Histórico real (ya excluye traspasos internos).
  const historical = buildHistoricalMonths(bank);

  // 3) Egresos programados por mes.
  const committedByMonth = buildFutureExpenses(aged);

  // 4) Proyección de cobranza por mes (multi-año).
  const todayYear = Number(today.slice(0, 4));
  const hasClientsCatalog = clients.length > 0;
  const clientsByYm = hasClientsCatalog
    ? buildClientsByYm(clients, assumptions, todayYear - 1, 3)
    : new Map<string, number>();

  // 5) Baselines y factores de calibración — usando sólo meses completos.
  const completeHistorical = filterCompleteHistorical(historical, today);
  const avgIncomeBaseline = projectFutureIncome(completeHistorical, 6);
  const avgExpenseBaseline = buildExpenseProjector(completeHistorical)(1);

  // El factor de calibración ajusta la proyección de clientes al histórico
  // real. Si los clientes del catálogo sólo representan ~60% de los ingresos
  // reales históricos, escalamos la proyección por 1/0.6 ≈ 1.67 para que el
  // total esperado matchee realidad. Acotado a [0.5, 3] para evitar
  // distorsiones por catálogos incompletos o meses atípicos.
  const { factor: incomeCalibrationFactor, coverageMonths: clientsCoverageMonths } =
    computeCalibrationFactor(completeHistorical, clientsByYm, 3, (m) => m.income);
  const { factor: expenseCalibrationFactor } =
    computeCalibrationFactor(completeHistorical, committedByMonth, 3, (m) => m.expense);

  // 6) Construcción mes a mes.
  const todayYm = toYearMonth(today);
  const months: ForecastMonth[] = [];

  // Históricos: se usan tal cual (con override opcional).
  for (const h of historical) {
    const ov = overrides[h.yearMonth] ?? {};
    const isHistorical = true;
    const income = ov.income ?? h.income;
    const expense = ov.expense ?? h.expense;
    months.push({
      yearMonth: h.yearMonth,
      isHistorical,
      income,
      expense,
      closingCash: h.closingCash,
      incomeSource: ov.income != null ? 'override' : 'historical',
      expenseSource: ov.expense != null ? 'override' : 'historical',
      incomeOverridden: ov.income != null,
      expenseOverridden: ov.expense != null,
      incomeFromClientsRaw: clientsByYm.get(h.yearMonth) ?? 0,
      incomeFromClientsCalibrated: (clientsByYm.get(h.yearMonth) ?? 0) * incomeCalibrationFactor,
      incomeBaseline: avgIncomeBaseline,
      expenseCommitted: committedByMonth.get(h.yearMonth) ?? 0,
      expenseBaseline: avgExpenseBaseline,
      incomeCalibrationFactor,
      expenseCalibrationFactor,
    });
  }

  // Futuros: desde el mes siguiente al último histórico (o al actual).
  const lastHistoricalYm = historical.length > 0
    ? historical[historical.length - 1].yearMonth
    : todayYm;
  const firstFutureYm = addMonths(
    compareYearMonth(lastHistoricalYm, todayYm) > 0 ? lastHistoricalYm : todayYm,
    1,
  );
  const lastFutureYm = addMonths(todayYm, horizonMonths);

  let cursor = firstFutureYm;
  while (compareYearMonth(cursor, lastFutureYm) <= 0) {
    const ov = overrides[cursor] ?? {};
    const projectedClientsRaw = clientsByYm.get(cursor) ?? 0;
    const projectedClientsCalib = projectedClientsRaw * incomeCalibrationFactor;
    const committed = committedByMonth.get(cursor) ?? 0;

    // Ingreso del mes: override > clientes (si catálogo útil) > baseline.
    let income: number;
    let incomeSource: IncomeSource;
    if (ov.income != null) {
      income = ov.income;
      incomeSource = 'override';
    } else if (hasClientsCatalog && projectedClientsCalib > 0) {
      income = projectedClientsCalib;
      incomeSource = 'clients';
    } else {
      income = avgIncomeBaseline;
      incomeSource = 'baseline';
    }

    // Egreso del mes: override > max(comprometido escalado, baseline).
    let expense: number;
    let expenseSource: ExpenseSource;
    if (ov.expense != null) {
      expense = ov.expense;
      expenseSource = 'override';
    } else {
      const scaledCommitted = committed * expenseCalibrationFactor;
      if (scaledCommitted >= avgExpenseBaseline) {
        expense = scaledCommitted;
        expenseSource = 'committed';
      } else {
        expense = avgExpenseBaseline;
        expenseSource = 'baseline';
      }
    }

    months.push({
      yearMonth: cursor,
      isHistorical: false,
      income,
      expense,
      closingCash: 0, // se rellena en el chaining
      incomeSource,
      expenseSource,
      incomeOverridden: ov.income != null,
      expenseOverridden: ov.expense != null,
      incomeFromClientsRaw: projectedClientsRaw,
      incomeFromClientsCalibrated: projectedClientsCalib,
      incomeBaseline: avgIncomeBaseline,
      expenseCommitted: committed,
      expenseBaseline: avgExpenseBaseline,
      incomeCalibrationFactor,
      expenseCalibrationFactor,
    });
    cursor = addMonths(cursor, 1);
  }

  // 7) Chaining de caja: históricos ya traen su closingCash (real desde bancos).
  //    Para futuros se arranca desde la última caja histórica y se acumula.
  const lastHistClosing = historical.length > 0
    ? historical[historical.length - 1].closingCash
    : 0;
  let running = lastHistClosing;
  for (const m of months) {
    if (m.isHistorical) continue;
    running = running + m.income - m.expense;
    m.closingCash = running;
  }

  return {
    months,
    incomeCalibrationFactor,
    expenseCalibrationFactor,
    clientsCoverageMonths,
    avgIncomeBaseline,
    avgExpenseBaseline,
    hasClientsCatalog,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Proyecta cobranza para varios años (lookback + lookahead) y la vuelca en
 * un Map<yearMonth, amount>. Sólo contiene meses en los que la cobranza
 * proyectada es > 0.
 */
function buildClientsByYm(
  clients: Client[],
  baseAssumptions: CashFlowAssumptions,
  startYear: number,
  yearsAhead: number,
): Map<string, number> {
  const result = new Map<string, number>();
  for (let y = startYear; y <= startYear + yearsAhead; y++) {
    const assumptions: CashFlowAssumptions = { ...baseAssumptions, year: y };
    const events = projectYear(clients, assumptions);
    const byMonth = bucketByMonth(events);
    for (let m = 0; m < 12; m++) {
      if (byMonth[m] <= 0) continue;
      const ym = `${y}-${String(m + 1).padStart(2, '0')}`;
      result.set(ym, byMonth[m]);
    }
  }
  return result;
}

/**
 * Factor de calibración = real histórico / proyección para los mismos meses.
 * Compara los últimos N meses completos. Acotado a [0.5, 3] para no extrapolar
 * catálogos manifiestamente incompletos o meses atípicos.
 */
function computeCalibrationFactor(
  completeHistorical: CashFlowMonth[],
  projectedByYm: Map<string, number>,
  windowMonths: number,
  accessor: (m: CashFlowMonth) => number,
): { factor: number; coverageMonths: number } {
  if (completeHistorical.length === 0 || projectedByYm.size === 0) {
    return { factor: 1, coverageMonths: 0 };
  }
  const recent = completeHistorical.slice(-windowMonths);
  let realSum = 0;
  let projectedSum = 0;
  let matched = 0;
  for (const m of recent) {
    const proj = projectedByYm.get(m.yearMonth) ?? 0;
    if (proj <= 0) continue;
    realSum += accessor(m);
    projectedSum += proj;
    matched += 1;
  }
  if (projectedSum <= 0 || matched === 0) {
    return { factor: 1, coverageMonths: 0 };
  }
  const raw = realSum / projectedSum;
  const clamped = Math.min(3, Math.max(0.5, raw));
  return { factor: clamped, coverageMonths: matched };
}
