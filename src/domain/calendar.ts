/**
 * Collection calendar rules.
 *
 * CORE BUSINESS RULE (the one the user emphasized):
 *
 *   If a client's scheduled payment day falls on a date that is NOT a valid
 *   day on the client's own payment calendar, the payment is NOT moved to
 *   the next business day. It is moved to the NEXT OCCURRENCE in the client's
 *   own cycle.
 *
 *   Example: client pays weekly on Friday. Theoretical date (invoice + credit)
 *   lands on a Saturday → real date is the FOLLOWING Friday (+6 days),
 *   never the next Monday.
 *
 *   Example: client pays monthly on day 16. Theoretical date is May 20 →
 *   real date is June 16, not May 21 or the next business day.
 *
 * This file exposes one function: `resolveRealPaymentDate`.
 */

import { PaymentDayPattern, Frequency, DayOfWeek, NthOfMonth, WeekOfMonth } from './types';

// ---------------------------------------------------------------------------
// Date helpers (UTC-safe; all inputs treated as calendar dates, no TZ drift)
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;

function toUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function dow(d: Date): DayOfWeek {
  return d.getUTCDay() as DayOfWeek;
}

function nthWeekdayOfMonth(
  year: number,
  month: number, // 0..11
  nth: NthOfMonth,
  day: DayOfWeek,
): Date {
  if (nth === -1) {
    // Last occurrence of `day` in the month.
    const last = new Date(Date.UTC(year, month + 1, 0));
    const delta = (last.getUTCDay() - day + 7) % 7;
    return addDays(last, -delta);
  }
  const first = new Date(Date.UTC(year, month, 1));
  const delta = (day - first.getUTCDay() + 7) % 7;
  return addDays(first, delta + (nth - 1) * 7);
}

function matchesWeekOfMonth(date: Date, week: WeekOfMonth): boolean {
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  if (week === -1) return day >= Math.max(1, lastDay - 6);

  const start = (week - 1) * 7 + 1;
  const end = Math.min(lastDay, start + 6);
  return day >= start && day <= end;
}

// ---------------------------------------------------------------------------
// Matcher: does `date` satisfy the pattern?
// ---------------------------------------------------------------------------
function dateMatchesPattern(date: Date, pattern: PaymentDayPattern): boolean {
  switch (pattern.kind) {
    case 'ANY':
      return true;
    case 'DOW':
      return pattern.days.includes(dow(date));
    case 'DOM':
      return date.getUTCDate() === pattern.day;
    case 'DOM_LIST':
      return pattern.days.includes(date.getUTCDate());
    case 'NTH_DOW': {
      const target = nthWeekdayOfMonth(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        pattern.nth,
        pattern.day,
      );
      return target.getTime() === date.getTime();
    }
    case 'NTH_DOW_SET':
      return pattern.nths.some(nth => {
        const target = nthWeekdayOfMonth(
          date.getUTCFullYear(),
          date.getUTCMonth(),
          nth,
          pattern.day,
        );
        return target.getTime() === date.getTime();
      });
    case 'WOM':
      return pattern.weeks.some(week => matchesWeekOfMonth(date, week));
  }
}

// ---------------------------------------------------------------------------
// Forward-search bound: how many days ahead we scan before giving up.
// DOM/NTH_DOW patterns can be up to ~31 days away; weekly patterns at most 7.
// 62 days is a safe upper bound that also tolerates "Quincenal + Mensual" edge
// cases (e.g. second-half quincena after a month-end).
// ---------------------------------------------------------------------------
export const MAX_SCAN_DAYS = 93;

/**
 * Resolve the real cash-in date from the theoretical date using the
 * client's payment-day pattern and frequency.
 *
 * Algorithm:
 *   1. Start at `theoreticalDate`.
 *   2. If that date already matches the pattern → done.
 *   3. Otherwise step forward one day at a time until a matching date is
 *      found. This implements "next cycle occurrence" for every pattern:
 *        - DOW[Fri]       → next Friday
 *        - DOM[16]        → 16th of next month (if past in current)
 *        - NTH_DOW[1,Fri] → first Friday of next month
 *        - DOM_LIST[10,25]→ whichever of 10/25 comes next
 *
 * Note on `frequency`: the pattern already encodes the cycle geometry
 * (weekly = DOW, monthly = DOM/NTH_DOW). Frequency is kept on the Client for
 * the per-event amount split; it does not change the date search.
 * Quincenal weekly-day clients (e.g. "Jueves-Quincenal") are modeled as
 * DOW[Thu] + frequency=Quincenal; the engine divides billing by 2, and the
 * second event lands on the following eligible Thursday (+14 days) by
 * advancing theoreticalDate for event 2.
 */
export function resolveRealPaymentDate(
  theoreticalDate: Date,
  pattern: PaymentDayPattern,
  _frequency: Frequency, // reserved for future pattern variants
): Date {
  let cursor = toUTC(theoreticalDate);
  for (let i = 0; i <= MAX_SCAN_DAYS; i++) {
    if (dateMatchesPattern(cursor, pattern)) return cursor;
    cursor = addDays(cursor, 1);
  }
  // Defensive fallback: return theoretical if no match (should never happen
  // for well-formed patterns). Caller can treat large lag as a data-quality
  // signal.
  return toUTC(theoreticalDate);
}

/**
 * Number of collection events per month for a given frequency.
 * Used by the engine to split monthly billing.
 */
export function eventsPerMonth(f: Frequency): number {
  switch (f) {
    case 'Semanal':
      return 4; // conventional; real week count varies 4–5
    case 'Quincenal':
      return 2;
    case 'Mensual':
    case 'Contado':
      return 1;
  }
}

/**
 * Step the theoretical date forward by one frequency cycle.
 * Used to generate the 2nd, 3rd, ... event of the month.
 */
export function advanceOneCycle(d: Date, f: Frequency): Date {
  switch (f) {
    case 'Semanal':
      return addDays(d, 7);
    case 'Quincenal':
      return addDays(d, 14);
    case 'Mensual':
    case 'Contado': {
      const next = new Date(d.getTime());
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
    }
  }
}

/**
 * ISO 8601 week number for a date.
 */
export function isoWeek(d: Date): number {
  const t = toUTC(d);
  // Thursday in current week decides the year.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
}

/** Format a Date as ISO yyyy-mm-dd (UTC). */
export function toISODate(d: Date): string {
  return toUTC(d).toISOString().slice(0, 10);
}
