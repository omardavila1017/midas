/**
 * Domain types for the cash flow framework.
 *
 * Architecture layers (see ARCHITECTURE.md):
 *   1. Assumptions & Rules  — editable parameters
 *   2. Catalogs (Masters)   — Clients, Providers, Accounts
 *   3. Calculation engine   — Collections, Payments, Daily flow
 *   4. Results & Views      — Read-only summaries
 *
 * This file lives at the boundary of layers 1–2: it defines the shapes that
 * the engine (layer 3) consumes and the views (layer 4) render.
 */

// ---------------------------------------------------------------------------
// Payment-day pattern
// ---------------------------------------------------------------------------
// Column C in the source Excel is free text ("Viernes", "dia 16",
// "Primer Viernes de mes", "Miercoles y Jueves", "Factoraje-Viernes").
// We normalize it into a structured pattern so the engine can compute
// deterministic dates.

export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sun, 5 = Fri
export type NthOfMonth = 1 | 2 | 3 | 4 | -1;
export type WeekOfMonth = 1 | 2 | 3 | 4 | -1;

export type PaymentDayPattern =
  /** No date restriction; cash can land on the theoretical date. */
  | { kind: 'ANY' }
  /** Fires on one or more specific days of the week (e.g. Friday; Wed+Thu). */
  | { kind: 'DOW'; days: DayOfWeek[] }
  /** Fires on a specific day-of-month (e.g. day 16). */
  | { kind: 'DOM'; day: number } // 1..31
  /** Fires on the Nth weekday of the month (e.g. 1st Friday). */
  | { kind: 'NTH_DOW'; nth: NthOfMonth; day: DayOfWeek }
  /** Fires on multiple weekday ordinals in the month (e.g. 2nd + 4th Thursday). */
  | { kind: 'NTH_DOW_SET'; nths: NthOfMonth[]; day: DayOfWeek }
  /** Fires on multiple day-of-month values (e.g. 10 and 25). */
  | { kind: 'DOM_LIST'; days: number[] }
  /** Fires during one or more week windows of the month (e.g. 1st + 3rd week). */
  | { kind: 'WOM'; weeks: WeekOfMonth[] };

// ---------------------------------------------------------------------------
// Payment frequency
// ---------------------------------------------------------------------------
export type Frequency =
  | 'Semanal'
  | 'Quincenal'
  | 'Mensual'
  | 'Contado';

// ---------------------------------------------------------------------------
// Client catalog
// ---------------------------------------------------------------------------
export interface Client {
  id: string;
  name: string;
  /** Raw Column C text as captured from the source file — kept for audit. */
  paymentDayRaw?: string;
  /** Structured, computable version of paymentDayRaw. */
  paymentDay: PaymentDayPattern;
  frequency: Frequency;
  /** Days of credit granted from invoice date. */
  creditDays: number;
  /** Monthly billing — one value per calendar month (Jan..Dec).
   *  Captures seasonality from historical data. Engine divides each month's
   *  value by `eventsPerMonth(frequency)` to get the per-event amount. */
  monthlyBilling: number[]; // length 12
  /** If true, invoice is discounted via factoraje: pays ~2–3 days after invoice
   * regardless of the payment-day rule. */
  factoraje?: boolean;
  /** Expected compliance rate (0..1). 1 means "always pays on day". */
  complianceRate?: number;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Provider catalog — exactly three fields, as requested
// ---------------------------------------------------------------------------
/** Free-form to fit real catalogs (DIESEL, Filiales, Servicios, Bancario…).
 *  UI suggests common values but the user can type anything. */
export type ProviderType = string;

export type ProviderRisk = 'Alto' | 'Medio' | 'Bajo';

export type ProviderPaymentPeriod =
  | 'Contado'
  | '15 días'
  | '30 días'
  | '45 días'
  | '60 días'
  | '90 días';

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  risk: ProviderRisk;
  paymentPeriod: ProviderPaymentPeriod;
}

// ---------------------------------------------------------------------------
// Collection events (output of the engine)
// ---------------------------------------------------------------------------
export interface CollectionEvent {
  clientId: string;
  /** When the invoice would be due by contract (invoice + credit days). */
  theoreticalDate: string; // ISO date
  /** When the cash actually lands, after applying payment-day + frequency rules. */
  realDate: string; // ISO date
  amount: number;
  /** Days of lag between theoretical and real date — key KPI. */
  lagDays: number;
  /** ISO week number of the real date (1..53). */
  isoWeek: number;
}

// ---------------------------------------------------------------------------
// Scenario assumptions (layer 1)
// ---------------------------------------------------------------------------
export interface CashFlowAssumptions {
  /** Year the projection covers. */
  year: number;
  /** Global compliance override (0..1). Per-client value takes precedence. */
  globalCompliance: number;
  /** Days from invoice to cash when factoraje applies. */
  factorajeDays: number;
}
