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

export type PaymentDayPattern =
  /** Fires on one or more specific days of the week (e.g. Friday; Wed+Thu). */
  | { kind: 'DOW'; days: DayOfWeek[] }
  /** Fires on a specific day-of-month (e.g. day 16). */
  | { kind: 'DOM'; day: number } // 1..31
  /** Fires on the Nth weekday of the month (e.g. 1st Friday). */
  | { kind: 'NTH_DOW'; nth: 1 | 2 | 3 | 4 | -1; day: DayOfWeek }
  /** Fires on multiple day-of-month values (e.g. 10 and 25). */
  | { kind: 'DOM_LIST'; days: number[] };

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
  /** Monthly billing baseline. Engine divides by frequency to get per-event amount. */
  monthlyBilling: number;
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
export type ProviderType =
  | 'Servicio'
  | 'Insumo'
  | 'Renta'
  | 'Nómina externa'
  | 'CAPEX'
  | 'Otro';

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
