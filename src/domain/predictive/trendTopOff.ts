// ─────────────────────────────────────────────────────────────────────────
// trendTopOff — convierte la tendencia histórica (Holt-Winters) en
// movimientos sintéticos de "top-off" para la Proyección de caja.
//
// La rama `no-long-term-projection` dejó la Proyección con sólo flujo real de
// corto plazo (CXC, CXP, compras, nómina) + obligaciones contractuales. El
// motor predictivo (`buildPredictiveForecast`) ya calcula la trayectoria
// mensual de ingresos/egresos extrapolada del histórico bancario, pero ese
// resultado no se reflejaba en la gráfica ni en los KPIs (que se arman desde
// `movements`, no desde la trayectoria mensual canónica).
//
// Este builder cierra el hueco: para cada mes futuro emite el GAP entre lo que
// la tendencia espera y lo que el escenario ya tiene comprometido, sin
// duplicar ni reducir lo real:
//
//   topOff[ym] = max(0, predicho[ym] - yaComprometido[ym])
//
//   - `max(0, …)`  → lo real/conocido nunca se reduce ("se mantienen así").
//   - mes en curso → el predicho ya es real-a-la-fecha + remanente (isPartial),
//     así que el gap es sólo lo que falta del mes.
//
// Sólo se invoca para escenarios NO base (igual que convenio/impuestos). El
// prefijo `forecast:trend:` queda fuera de `isRealShortTermApiMovement`, así
// que el Escenario Base lo ignora automáticamente — invariante respetado.
// ─────────────────────────────────────────────────────────────────────────
import type { FinancialMovement, FinancialMovementType } from '../../modules/shared-finance/types';
import {
  calculateConfidenceBand,
  effectiveAmount,
  effectiveMovementDate,
} from '../../modules/shared-finance/calculation-engine/financialProjectionEngine';
import { toYearMonth, compareYearMonth, lastDayOfMonth } from '../cashFlowEngine';
import type { PredictionPoint } from './types';

export interface TrendTopOffArgs {
  /** Serie mensual de ingresos del motor predictivo (Holt-Winters). */
  incomeMonthly: PredictionPoint[];
  /** Serie mensual de egresos del motor predictivo. */
  expenseMonthly: PredictionPoint[];
  /**
   * Movimientos ya presentes en el escenario (real + CXC/CXP/nómina/impuestos/
   * convenio/fideicomiso). Sirven de baseline "ya comprometido" por mes.
   */
  existingMovements: FinancialMovement[];
  scenarioId: string;
  /** Ventana de proyección (inclusiva). */
  startDate: string;
  endDate: string;
  /** Fecha de corte: no se inyecta flujo sintético en días ya transcurridos. */
  asOfDate: string;
}

// Anclas semanales dentro del mes para repartir el monto mensual y evitar un
// pico único en las vistas semanal/diaria.
const WEEKLY_ANCHOR_DAYS = [7, 14, 21, 28];

/**
 * Devuelve las fechas-ancla (YYYY-MM-DD) de un mes que caen dentro de la
 * ventana de proyección y son estrictamente posteriores a `asOfDate`.
 * Si ninguna ancla sobrevive pero el fin de mes sí está en ventana y es
 * futuro, devuelve el último día del mes como ancla única.
 */
function anchorsForMonth(
  ym: string,
  startDate: string,
  endDate: string,
  asOfDate: string,
): string[] {
  const monthEnd = lastDayOfMonth(ym);
  const lastDay = Number(monthEnd.slice(8, 10));
  const anchors: string[] = [];
  for (const day of WEEKLY_ANCHOR_DAYS) {
    const clampedDay = Math.min(day, lastDay);
    const iso = `${ym}-${String(clampedDay).padStart(2, '0')}`;
    if (iso > asOfDate && iso >= startDate && iso <= endDate) anchors.push(iso);
  }
  if (anchors.length === 0 && monthEnd > asOfDate && monthEnd >= startDate && monthEnd <= endDate) {
    anchors.push(monthEnd);
  }
  return anchors;
}

/**
 * Suma `effectiveAmount` por mes y tipo de los movimientos existentes.
 */
function commitmentsByMonth(
  movements: FinancialMovement[],
): { income: Map<string, number>; expense: Map<string, number> } {
  const income = new Map<string, number>();
  const expense = new Map<string, number>();
  for (const m of movements) {
    if (m.status === 'CANCELLED') continue;
    const ym = toYearMonth(effectiveMovementDate(m));
    const amount = effectiveAmount(m);
    const bucket = m.type === 'INFLOW' ? income : expense;
    bucket.set(ym, (bucket.get(ym) ?? 0) + amount);
  }
  return { income, expense };
}

function buildTopOffMovementsForDirection(params: {
  monthly: PredictionPoint[];
  committed: Map<string, number>;
  type: FinancialMovementType;
  scenarioId: string;
  startDate: string;
  endDate: string;
  asOfDate: string;
}): FinancialMovement[] {
  const { monthly, committed, type, scenarioId, startDate, endDate, asOfDate } = params;
  const currentYm = toYearMonth(asOfDate);
  const isIncome = type === 'INFLOW';
  const out: FinancialMovement[] = [];

  for (const point of monthly) {
    const ym = point.date.slice(0, 7);
    // Sólo mes en curso + futuros: los meses pasados son 100% reales.
    if (compareYearMonth(ym, currentYm) < 0) continue;
    if (point.date > endDate) continue;

    const predicted = Math.max(0, point.expected);
    const already = committed.get(ym) ?? 0;
    const topOff = predicted - already;
    if (topOff <= 0.5) continue; // sub-peso → ruido; no inyectar

    const anchors = anchorsForMonth(ym, startDate, endDate, asOfDate);
    if (anchors.length === 0) continue;
    const perAnchor = topOff / anchors.length;

    anchors.forEach((date, idx) => {
      const confidence = 45; // banda LOW — extrapolación estadística
      out.push({
        id: `forecast:trend:${isIncome ? 'income' : 'expense'}:${scenarioId}:${ym}:${idx}`,
        sourceSystem: 'FORECAST',
        type,
        category: isIncome ? 'AR_COLLECTION' : 'OPEX',
        subcategory: 'Tendencia histórica',
        concept: `Tendencia histórica · ${isIncome ? 'ingresos' : 'egresos'} ${ym}`,
        currency: 'MXN',
        originalAmount: perAnchor,
        baseAmount: perAnchor,
        projectedAmount: perAnchor,
        projectedDate: date,
        confidenceScore: confidence,
        confidenceBand: calculateConfidenceBand(confidence),
        forecastMethod: 'STATISTICAL',
        ruleApplied: `Top-off de tendencia: max(0, ${Math.round(predicted)} predicho − ${Math.round(already)} comprometido) repartido en ${anchors.length} anclas`,
        status: 'PROJECTED_BASE',
        lockState: 'UNLOCKED',
        createdAt: `${asOfDate}T00:00:00.000Z`,
        updatedAt: `${asOfDate}T00:00:00.000Z`,
      });
    });
  }
  return out;
}

/**
 * Construye los movimientos sintéticos de top-off de tendencia para ingresos
 * y egresos. Vacío si no hay series predictivas.
 */
export function buildTrendTopOffMovements(args: TrendTopOffArgs): FinancialMovement[] {
  if (args.incomeMonthly.length === 0 && args.expenseMonthly.length === 0) return [];
  const committed = commitmentsByMonth(args.existingMovements);
  return [
    ...buildTopOffMovementsForDirection({
      monthly: args.incomeMonthly,
      committed: committed.income,
      type: 'INFLOW',
      scenarioId: args.scenarioId,
      startDate: args.startDate,
      endDate: args.endDate,
      asOfDate: args.asOfDate,
    }),
    ...buildTopOffMovementsForDirection({
      monthly: args.expenseMonthly,
      committed: committed.expense,
      type: 'OUTFLOW',
      scenarioId: args.scenarioId,
      startDate: args.startDate,
      endDate: args.endDate,
      asOfDate: args.asOfDate,
    }),
  ];
}
