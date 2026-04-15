/**
 * Collection projection engine.
 *
 * Input : Client catalog + invoice month (or a full-year series of invoices).
 * Output: CollectionEvent[] — one row per cash-in, with theoretical date,
 *         real date, ISO week, and lag days.
 *
 * Assumes:
 *   - The first invoice of each billing month is issued on day 1.
 *   - Additional invoices in the same month follow the billing cycle cadence
 *     (weekly = +7d, quincenal = +14d, mensual = next month).
 *   - Monthly billing is split evenly across `eventsPerMonth(frequency)`
 *     events.
 *
 * The engine does NOT know about business-day calendars, holidays, or
 * bank-wire cutoffs — by design, per the user's business rule.
 */

import { Client, CollectionEvent, CashFlowAssumptions } from './types';
import {
  MAX_SCAN_DAYS,
  resolveRealPaymentDate,
  advanceOneCycle,
  eventsPerMonth,
  isoWeek,
  toISODate,
} from './calendar';

const DAY_MS = 86_400_000;
const AVG_DAYS_PER_MONTH = 30;

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

function seasonalityMonthIndex(invoiceMonth: number): number {
  return ((invoiceMonth % 12) + 12) % 12;
}

function isoYear(isoDate: string): number {
  return Number(isoDate.slice(0, 4));
}

function lookbackMonths(clients: Client[]): number {
  const maxCreditDays = clients.reduce((max, client) => Math.max(max, client.creditDays), 0);
  return Math.max(1, Math.ceil((maxCreditDays + MAX_SCAN_DAYS) / AVG_DAYS_PER_MONTH));
}

/**
 * Project one client's collections for a given invoice month.
 *
 * @param client           The client catalog row.
 * @param invoiceYear      Year the invoice is issued.
 * @param invoiceMonth     0-based month index (0 = January).
 * @param assumptions      Scenario-wide assumptions.
 */
export function projectClientMonth(
  client: Client,
  invoiceYear: number,
  invoiceMonth: number,
  assumptions: CashFlowAssumptions,
): CollectionEvent[] {
  const events: CollectionEvent[] = [];
  const splits = eventsPerMonth(client.frequency);
  const monthBilling = client.monthlyBilling[seasonalityMonthIndex(invoiceMonth)] ?? 0;
  const perEvent = monthBilling / splits;

  // Compliance shrinks the amount; does NOT change dates. Rationale: the
  // engine projects cash; uncollected portion shows up as shrinkage, not as
  // a rescheduled date (which would need an A/R aging model we don't have
  // yet — flagged as a follow-up recommendation).
  const compliance = client.complianceRate ?? assumptions.globalCompliance;
  const amount = perEvent * compliance;

  // Invoice date: 1st of the month. (TODO: accept per-event invoice dates.)
  let invoiceDate = new Date(Date.UTC(invoiceYear, invoiceMonth, 1));

  for (let i = 0; i < splits; i++) {
    // Theoretical cash date = invoice + credit days.
    const theoretical = new Date(invoiceDate.getTime() + client.creditDays * DAY_MS);

    // Factoraje uses its own term from invoice date and ignores payment-day.
    const real = client.factoraje
      ? new Date(invoiceDate.getTime() + assumptions.factorajeDays * DAY_MS)
      : resolveRealPaymentDate(theoretical, client.paymentDay, client.frequency);

    events.push({
      clientId: client.id,
      invoiceDate: toISODate(invoiceDate),
      theoreticalDate: toISODate(theoretical),
      realDate: toISODate(real),
      amount,
      lagDays: daysBetween(theoretical, real),
      isoWeek: isoWeek(real),
    });

    // Next event in the same month → advance one cycle on both dates.
    invoiceDate = advanceOneCycle(invoiceDate, client.frequency);
  }

  return events;
}

/**
 * Project cash-in events whose REAL collection date falls inside the
 * assumption year.
 *
 * To avoid dropping January cash that comes from invoices issued in prior
 * months, the engine looks back far enough to cover max credit days plus the
 * maximum payment-pattern lag, then filters by `realDate` year.
 */
export function projectYear(
  clients: Client[],
  assumptions: CashFlowAssumptions,
): CollectionEvent[] {
  const all: CollectionEvent[] = [];
  const startOffset = -lookbackMonths(clients);
  for (const c of clients) {
    for (let m = startOffset; m < 12; m++) {
      all.push(...projectClientMonth(c, assumptions.year, m, assumptions));
    }
  }
  return all.filter(event => isoYear(event.realDate) === assumptions.year);
}

/**
 * Bucket events into 53 ISO weeks. Returns an array of length 53 where
 * index 0 is unused (ISO weeks are 1-based) — drop or shift as the view
 * requires.
 */
export function bucketByWeek(events: CollectionEvent[]): number[] {
  const weeks = new Array(54).fill(0);
  for (const e of events) weeks[e.isoWeek] += e.amount;
  return weeks;
}

/**
 * Bucket events into 12 months by real cash-in date.
 */
export function bucketByMonth(events: CollectionEvent[]): number[] {
  const months = new Array(12).fill(0);
  for (const e of events) {
    const m = Number(e.realDate.slice(5, 7)) - 1;
    if (m >= 0 && m < 12) months[m] += e.amount;
  }
  return months;
}
