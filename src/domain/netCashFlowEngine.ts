/**
 * Net Cash Flow Engine — unified view of CXC (collections) and CXP (payments)
 *
 * Core value proposition: daily, weekly, and monthly net cash position
 * across both inflows (collections) and outflows (payments).
 *
 * Integrates:
 *   - CollectionEvent[] from collectionEngine.ts (CXC)
 *   - CXPRecord[] from CSV upload (CXP)
 *   - ConfirmedPayment[] for real vs projected tracking
 */

import { CollectionEvent, ConfirmedPayment, CashFlowAssumptions, eventKey } from './types';
import { CXPRecord } from './persistence';

// ─────────────────────────────────────────────────────────────────────────
// Domain Types
// ─────────────────────────────────────────────────────────────────────────

/**
 * A single day's cash flow position.
 * Includes both confirmed and projected inflows for visibility into confidence.
 */
export interface DailyFlow {
  /** ISO 8601 date string (YYYY-MM-DD) */
  date: string;
  /** Total CXC collections landing on this day (projected) */
  inflows: number;
  /** Total CXP payments due on this day */
  outflows: number;
  /** Inflows minus outflows */
  net: number;
  /** Running cumulative from start of period */
  cumulative: number;
  /** Portion of inflows already confirmed by user */
  confirmedIn: number;
  /** Portion of inflows still projected */
  projectedIn: number;
}

/**
 * Weekly aggregation of cash flow.
 * Groups daily flows by ISO week (Monday..Sunday).
 */
export interface WeeklyFlow {
  /** ISO date of week start (Monday, YYYY-MM-DD) */
  weekStart: string;
  /** ISO week number (1–53) */
  weekNumber: number;
  /** Total weekly inflows */
  inflows: number;
  /** Total weekly outflows */
  outflows: number;
  /** Inflows minus outflows */
  net: number;
  /** Running cumulative from start of period */
  cumulative: number;
}

/**
 * Monthly aggregation of cash flow.
 * Groups daily flows by calendar month.
 */
export interface MonthlyFlow {
  /** Month index (0 = January, 11 = December) */
  month: number;
  /** Month display name (English) */
  monthName: string;
  /** Total monthly inflows */
  inflows: number;
  /** Total monthly outflows */
  outflows: number;
  /** Inflows minus outflows */
  net: number;
  /** Running cumulative from start of period */
  cumulative: number;
  /** Portion of inflows already confirmed */
  confirmedIn: number;
  /** Portion of inflows still projected */
  projectedIn: number;
}

/**
 * Summary KPIs for the entire period.
 * Provides at-a-glance metrics for reporting and alerting.
 */
export interface FlowSummary {
  /** Total inflows across entire period */
  totalInflows: number;
  /** Total outflows across entire period */
  totalOutflows: number;
  /** Net flow (inflows - outflows) */
  netFlow: number;
  /** Average daily net flow */
  avgDailyNet: number;
  /** Worst week by net flow (or null if no weeks) */
  worstWeek: { weekStart: string; net: number } | null;
  /** Best week by net flow (or null if no weeks) */
  bestWeek: { weekStart: string; net: number } | null;
  /** 0-based month indices where net < 0 (negative cash flow) */
  monthsNegative: number[];
  /** Collection efficiency: confirmed / total inflows for dates <= today (0–1) */
  collectionEfficiency: number;
}

/**
 * Payment event — normalized from CXPRecord for flow computations.
 * Simpler shape than CXPRecord, focused on timing and amount.
 */
export interface PaymentEvent {
  /** ISO 8601 date string of due date (YYYY-MM-DD) */
  date: string;
  /** Amount in local currency (importePendientePesos) */
  amount: number;
  /** Supplier name */
  supplier: string;
  /** Supplier classification (from clasificacionProveedor) */
  classification: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Utility Functions — Date Handling
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse a date string in DD/MM/YYYY or YYYY-MM-DD format to ISO 8601.
 *
 * @param dateStr Raw date string from CSV
 * @returns ISO date string (YYYY-MM-DD), or null if parsing fails
 */
function parseDate(dateStr: string | null | undefined): string | null {
  if (!dateStr || typeof dateStr !== 'string') {
    return null;
  }

  const trimmed = dateStr.trim();
  if (!trimmed) return null;

  // Try YYYY-MM-DD format first
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const date = new Date(trimmed + 'T00:00:00Z');
    if (!isNaN(date.getTime())) {
      return trimmed;
    }
  }

  // Try DD/MM/YYYY format
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed)) {
    const parts = trimmed.split('/');
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    const year = parseInt(parts[2], 10);

    const date = new Date(Date.UTC(year, month - 1, day));
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  return null;
}

/**
 * Get the ISO week number (1–53) for a given ISO date string.
 *
 * @param dateStr ISO date string (YYYY-MM-DD)
 * @returns Week number (1–53)
 */
function getISOWeekNumber(dateStr: string): number {
  const date = new Date(dateStr + 'T00:00:00Z');
  const jan4 = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const dayDiff = date.getTime() - jan4.getTime();
  const weekNumber = Math.floor(dayDiff / (7 * 24 * 60 * 60 * 1000)) + 1;
  return Math.max(1, Math.min(53, weekNumber));
}

/**
 * Get the Monday (start) date of the ISO week containing the given date.
 *
 * @param dateStr ISO date string (YYYY-MM-DD)
 * @returns ISO date string of the Monday (YYYY-MM-DD)
 */
function getWeekStartDate(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00Z');
  const dayOfWeek = date.getUTCDay();
  const diff = date.getUTCDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), diff));
  return monday.toISOString().split('T')[0];
}

/**
 * Get month name in English.
 *
 * @param monthIndex 0-based month index (0 = Jan, 11 = Dec)
 * @returns Month name
 */
function getMonthName(monthIndex: number): string {
  const months = [
    'Enero',
    'Febrero',
    'Marzo',
    'Abril',
    'Mayo',
    'Junio',
    'Julio',
    'Agosto',
    'Septiembre',
    'Octubre',
    'Noviembre',
    'Diciembre',
  ];
  return months[monthIndex] || '';
}

/**
 * Check if a date is today or earlier (for collection efficiency cutoff).
 *
 * @param dateStr ISO date string (YYYY-MM-DD)
 * @returns true if date is <= today
 */
function isDateInPastOrToday(dateStr: string): boolean {
  const date = new Date(dateStr + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return date <= today;
}

// ─────────────────────────────────────────────────────────────────────────
// Public Functions — Domain Logic
// ─────────────────────────────────────────────────────────────────────────

/**
 * Extract payment events from CXP records.
 *
 * Converts CXPRecord array to PaymentEvent array for unified cash flow engine.
 * Uses `fechaProgramacionPago` if available, falls back to `fechaVence`.
 * Skips records with zero or negative pending amounts.
 *
 * @param cxpRecords Array of CXP records from CSV upload
 * @returns Array of payment events, sorted by date
 */
export function extractPaymentEvents(cxpRecords: CXPRecord[]): PaymentEvent[] {
  const events: PaymentEvent[] = [];

  for (const record of cxpRecords) {
    // Skip invalid amounts
    if (record.importePendientePesos <= 0) {
      continue;
    }

    // Try programmed payment date first, fall back to due date
    const dateStr = parseDate(record.fechaProgramacionPago) || parseDate(record.fechaVence);

    if (!dateStr) {
      continue;
    }

    events.push({
      date: dateStr,
      amount: record.importePendientePesos,
      supplier: record.nombre || 'Unknown',
      classification: record.clasificacionProveedor || 'Uncategorized',
    });
  }

  // Sort by date for efficient grouping
  events.sort((a, b) => a.date.localeCompare(b.date));

  return events;
}

/**
 * Compute daily cash flow for each day in the period.
 *
 * Aggregates collections (CXC) and payments (CXP) by day, tracking both
 * confirmed and projected inflows. Skips days with no activity.
 *
 * @param collections Array of collection events from collectionEngine
 * @param payments Array of payment events from extractPaymentEvents()
 * @param confirmedPayments Array of confirmed payment records
 * @param year Year to process (filters collections to this year)
 * @param startingBalance Starting cash balance (default 0)
 * @returns Array of daily flows with activity, sorted by date
 */
export function computeDailyFlow(
  collections: CollectionEvent[],
  payments: PaymentEvent[],
  confirmedPayments: ConfirmedPayment[],
  year: number,
  startingBalance: number = 0
): DailyFlow[] {
  // Build a map of confirmed payments for O(1) lookup
  const confirmedMap = new Map<string, ConfirmedPayment>();
  for (const cp of confirmedPayments) {
    confirmedMap.set(cp.key, cp);
  }

  // Group collections by date
  const collectionsByDate = new Map<string, CollectionEvent[]>();
  for (const collection of collections) {
    // Filter to the target year
    const date = collection.realDate;
    if (!date.startsWith(year.toString())) {
      continue;
    }

    if (!collectionsByDate.has(date)) {
      collectionsByDate.set(date, []);
    }
    collectionsByDate.get(date)!.push(collection);
  }

  // Group payments by date
  const paymentsByDate = new Map<string, PaymentEvent[]>();
  for (const payment of payments) {
    // Filter to the target year
    if (!payment.date.startsWith(year.toString())) {
      continue;
    }

    if (!paymentsByDate.has(payment.date)) {
      paymentsByDate.set(payment.date, []);
    }
    paymentsByDate.get(payment.date)!.push(payment);
  }

  // Collect all active dates
  const activeDates = new Set<string>();
  collectionsByDate.forEach((_, date) => activeDates.add(date));
  paymentsByDate.forEach((_, date) => activeDates.add(date));

  // Sort dates chronologically
  const sortedDates = Array.from(activeDates).sort();

  // Compute daily flows
  const dailyFlows: DailyFlow[] = [];
  let cumulative = startingBalance;

  for (const date of sortedDates) {
    let inflows = 0;
    let confirmedIn = 0;
    let projectedIn = 0;

    // Sum inflows for this date
    const dayCollections = collectionsByDate.get(date) || [];
    for (const collection of dayCollections) {
      const key = eventKey(collection);
      const confirmed = confirmedMap.get(key);

      if (confirmed) {
        confirmedIn += confirmed.amount;
      } else {
        projectedIn += collection.amount;
      }

      inflows += collection.amount;
    }

    // Sum outflows for this date
    let outflows = 0;
    const dayPayments = paymentsByDate.get(date) || [];
    for (const payment of dayPayments) {
      outflows += payment.amount;
    }

    // Compute net and cumulative
    const net = inflows - outflows;
    cumulative += net;

    dailyFlows.push({
      date,
      inflows,
      outflows,
      net,
      cumulative,
      confirmedIn,
      projectedIn,
    });
  }

  return dailyFlows;
}

/**
 * Aggregate daily flows into weekly groups.
 *
 * Groups by ISO week (Monday–Sunday) and sums all flows within each week.
 *
 * @param daily Array of daily flows
 * @returns Array of weekly flows, one per week, sorted by date
 */
export function aggregateWeekly(daily: DailyFlow[]): WeeklyFlow[] {
  const weeklyMap = new Map<string, WeeklyFlow>();

  for (const day of daily) {
    const weekStart = getWeekStartDate(day.date);
    const weekNumber = getISOWeekNumber(day.date);

    if (!weeklyMap.has(weekStart)) {
      weeklyMap.set(weekStart, {
        weekStart,
        weekNumber,
        inflows: 0,
        outflows: 0,
        net: 0,
        cumulative: 0,
      });
    }

    const week = weeklyMap.get(weekStart)!;
    week.inflows += day.inflows;
    week.outflows += day.outflows;
    week.net += day.net;
    week.cumulative = day.cumulative; // Use last day's cumulative
  }

  // Sort by week start date
  const weeks = Array.from(weeklyMap.values());
  weeks.sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  return weeks;
}

/**
 * Aggregate daily flows into monthly groups.
 *
 * Groups by calendar month and sums all flows within each month,
 * tracking both confirmed and projected inflows.
 *
 * @param daily Array of daily flows
 * @param startingBalance Starting cash balance for cumulative calculation (default 0)
 * @returns Array of monthly flows, one per month, sorted by date
 */
export function aggregateMonthly(
  daily: DailyFlow[],
  startingBalance: number = 0
): MonthlyFlow[] {
  const monthlyMap = new Map<number, MonthlyFlow>();

  for (const day of daily) {
    const date = new Date(day.date + 'T00:00:00Z');
    const monthIndex = date.getUTCMonth();

    if (!monthlyMap.has(monthIndex)) {
      monthlyMap.set(monthIndex, {
        month: monthIndex,
        monthName: getMonthName(monthIndex),
        inflows: 0,
        outflows: 0,
        net: 0,
        cumulative: 0,
        confirmedIn: 0,
        projectedIn: 0,
      });
    }

    const month = monthlyMap.get(monthIndex)!;
    month.inflows += day.inflows;
    month.outflows += day.outflows;
    month.net += day.net;
    month.confirmedIn += day.confirmedIn;
    month.projectedIn += day.projectedIn;
    month.cumulative = day.cumulative; // Use last day's cumulative
  }

  // Build result array in calendar order
  const months: MonthlyFlow[] = [];
  for (let i = 0; i < 12; i++) {
    if (monthlyMap.has(i)) {
      months.push(monthlyMap.get(i)!);
    }
  }

  return months;
}

/**
 * Compute summary KPIs for the entire period.
 *
 * Calculates key metrics including worst/best weeks, negative months,
 * and collection efficiency for reporting and alerting.
 *
 * @param monthly Array of monthly flows
 * @param collections Array of collection events (all years)
 * @param confirmedPayments Array of confirmed payment records
 * @returns Summary KPIs for the period
 */
export function computeSummary(
  monthly: MonthlyFlow[],
  collections: CollectionEvent[],
  confirmedPayments: ConfirmedPayment[]
): FlowSummary {
  // Sum totals from monthly data
  let totalInflows = 0;
  let totalOutflows = 0;
  const monthsNegative: number[] = [];

  for (const m of monthly) {
    totalInflows += m.inflows;
    totalOutflows += m.outflows;
    if (m.net < 0) {
      monthsNegative.push(m.month);
    }
  }

  const netFlow = totalInflows - totalOutflows;
  const avgDailyNet = monthly.length > 0 ? netFlow / (monthly.length * 30) : 0; // Rough average

  // Collection efficiency: confirmed / total for dates <= today
  let confirmedTotal = 0;
  let projectedTotal = 0;

  for (const collection of collections) {
    if (!isDateInPastOrToday(collection.realDate)) {
      continue;
    }

    const key = eventKey(collection);
    const isConfirmed = confirmedPayments.some((cp) => cp.key === key);

    if (isConfirmed) {
      confirmedTotal += collection.amount;
    } else {
      projectedTotal += collection.amount;
    }
  }

  const collectionEfficiency =
    confirmedTotal + projectedTotal > 0
      ? confirmedTotal / (confirmedTotal + projectedTotal)
      : 0;

  // Worst and best weeks (computed separately since we don't store weeks here)
  // For now, return null — caller can compute from weekly aggregation if needed
  const worstWeek: { weekStart: string; net: number } | null = null;
  const bestWeek: { weekStart: string; net: number } | null = null;

  return {
    totalInflows,
    totalOutflows,
    netFlow,
    avgDailyNet,
    worstWeek,
    bestWeek,
    monthsNegative,
    collectionEfficiency,
  };
}

/**
 * Compute worst and best weeks from weekly aggregation.
 *
 * Helper function to find extreme weeks for KPI reporting.
 * Returns null if the weekly array is empty.
 *
 * @param weekly Array of weekly flows
 * @returns Object with worstWeek and bestWeek, or null for either if empty
 */
export function findExtremeWeeks(weekly: WeeklyFlow[]): {
  worstWeek: { weekStart: string; net: number } | null;
  bestWeek: { weekStart: string; net: number } | null;
} {
  if (weekly.length === 0) {
    return { worstWeek: null, bestWeek: null };
  }

  let worst = weekly[0];
  let best = weekly[0];

  for (const week of weekly) {
    if (week.net < worst.net) {
      worst = week;
    }
    if (week.net > best.net) {
      best = week;
    }
  }

  return {
    worstWeek: { weekStart: worst.weekStart, net: worst.net },
    bestWeek: { weekStart: best.weekStart, net: best.net },
  };
}
