/**
 * operatingProjectionModule — standalone daily treasury planning engine.
 *
 * This module is intentionally isolated from the existing monthly projection
 * engines so it can be adopted or removed without dragging changes across the
 * rest of the app. It consumes the same domain entities (clients, providers,
 * banks, budget, CXP) and produces a daily operating plan.
 *
 * Core business rules encoded here:
 *   - group-level cash pool
 *   - cash may never go negative
 *   - collections use client payment rules and are moved to business days
 *   - no payments on weekends
 *   - diesel / gas only on Monday, Tuesday, Wednesday
 *   - supplier priority matrix by risk + flexibility
 *   - when credit limits exist, first reduce exposure to 80%
 *   - budget concepts with explicit fixed/manual rules stay separate
 *   - monthly budget falls back to business-day proration when no exact rule
 */

import type { Budget } from './budget';
import { projectYear } from './collectionEngine';
import { buildProviderIndex, matchAgedToProvider } from './expensePerProvider';
import { enrichFromCatalog } from './providerCatalog';
import type {
  CashFlowAssumptions,
  Client,
  CollectionEvent,
  Provider,
  ProviderFlexibility,
  ProviderRisk,
} from './types';
import type {
  AgedBalanceRecord,
  BankAccountStatement,
  BankStatementLine,
} from '../services/jdeTypes';
import { isNonOperatingDay } from './bankHolidays';

const DAY_MS = 86_400_000;
const DEFAULT_CREDIT_TARGET_RATIO = 0.8;

const DEFAULT_PAYROLL_SPLIT: PayrollSplitWeights = {
  weeklyNomina: 0.7,
  quincena: 0.25,
  fondoAhorro: 0.05,
};

export interface PayrollSplitWeights {
  weeklyNomina: number;
  quincena: number;
  fondoAhorro: number;
}

export interface OperatingFixedRule {
  id: string;
  label: string;
  concept: string;
  amount: number;
  /**
   * First theoretical occurrence. Future occurrences keep the same day-of-month
   * and repeat every `everyMonths`.
   */
  anchorDate: string;
  /** Undefined or 0 means one-time. 1 = monthly, 3 = quarterly. */
  everyMonths?: number;
  allowPartial?: boolean;
}

export interface ManualExpenseEvent {
  id?: string;
  concept: string;
  date: string;
  amount: number;
  label?: string;
  allowPartial?: boolean;
}

export interface OperatingAdjustment {
  id?: string;
  date: string;
  label: string;
  amount: number;
  direction: 'inflow' | 'outflow';
  affectsCash: boolean;
  category?: string;
}

export interface OperatingSupplierPaymentOverride {
  id?: string;
  invoiceKey: string;
  providerName?: string;
  supplierNumber?: string;
  invoiceNumber?: string;
  date: string;
  amount: number;
  note?: string;
}

export interface OperatingCollectionOverride {
  id?: string;
  sourceKey: string;
  date: string;
  amount: number;
  note?: string;
}

export interface OperatingScheduledOutflowOverride {
  id?: string;
  sourceKey: string;
  date: string;
  amount: number;
  note?: string;
}

export interface OperatingProjectionInput {
  startDate: string;
  endDate: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  agedBalances: AgedBalanceRecord[];
  budget?: Budget | null;
  assumptions: CashFlowAssumptions;
  manualExpenseEvents?: ManualExpenseEvent[];
  operatingAdjustments?: OperatingAdjustment[];
  supplierPaymentOverrides?: OperatingSupplierPaymentOverride[];
  collectionOverrides?: OperatingCollectionOverride[];
  scheduledOutflowOverrides?: OperatingScheduledOutflowOverride[];
  fixedRules?: OperatingFixedRule[];
  payrollSplit?: Partial<PayrollSplitWeights>;
  creditTargetRatio?: number;
}

export interface OperatingFlowLine {
  id: string;
  label: string;
  amount: number;
  category: string;
  source: 'collections' | 'budget' | 'manual' | 'fixed' | 'supplier' | 'adjustment';
  affectsCash: boolean;
  entityId?: string;
  sourceKey?: string;
  originalDate?: string;
  overrideNote?: string;
  detail?: string;
  invoiceDate?: string;
  theoreticalDate?: string;
  lagDays?: number;
  confidence?: 'Alta' | 'Media' | 'Baja';
}

export interface OperatingSupplierPayment extends OperatingFlowLine {
  source: 'supplier';
  providerId?: string;
  providerName: string;
  supplierNumber?: string;
  invoiceKey: string;
  invoiceNumber?: string;
  invoiceAmount: number;
  remainingAfterPayment: number;
  risk: ProviderRisk;
  flexibility: ProviderFlexibility;
  priorityBlock: number;
  /** Score 0-100 del proveedor (de la Plantilla de Alberto). */
  score?: number;
  /** Bucket derivado del score: CRITICO ≥80, ALTO 60-79, MEDIO 40-59, BAJO <40. */
  clasificacionAutomatica?: 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAJO';
  reason: 'credit_limit' | 'due' | 'manual';
  dueDate?: string;
  creditLimit?: number;
  paymentExplanation: string;
  priorityExplanation: string;
}

export interface OperatingSupplierQueueItem {
  providerId?: string;
  providerName: string;
  supplierNumber?: string;
  invoiceKey: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  invoiceAmount: number;
  paidAmount: number;
  remainingAmount: number;
  risk: ProviderRisk;
  flexibility: ProviderFlexibility;
  priorityBlock: number;
  /** Score 0-100 del proveedor para ponderación de pago. */
  score?: number;
  /** Bucket derivado del score (CRITICO siempre va primero). */
  clasificacionAutomatica?: 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAJO';
  status: 'suggested' | 'moved' | 'overdue' | 'partial' | 'unplanned';
  dueDate?: string;
  plannedDate?: string;
  plannedAmount?: number;
  creditLimit?: number;
  creditStatus: 'exceeded' | 'near_limit' | 'normal' | 'none';
  paymentExplanation: string;
  priorityExplanation: string;
}

export interface OperatingMandatoryReserveLine {
  id: string;
  label: string;
  category: string;
  source: 'budget' | 'manual' | 'fixed';
  dueDate: string;
  amount: number;
  reservedAmount: number;
  daysUntilDue: number;
}

export interface OperatingProjectionDay {
  date: string;
  openingCash: number;
  cashInflows: OperatingFlowLine[];
  nonCashFlows: OperatingFlowLine[];
  scheduledOutflows: OperatingFlowLine[];
  supplierPayments: OperatingSupplierPayment[];
  mandatoryReserve: number;
  mandatoryReserveRequired: number;
  mandatoryReserveShortfall: number;
  mandatoryReserveLines: OperatingMandatoryReserveLine[];
  freeCash: number;
  closingCash: number;
  unpaidScheduledAmount: number;
  unpaidScheduledCount: number;
  pendingSupplierAmount: number;
  pendingSupplierCount: number;
  alerts: string[];
}

export interface OperatingProjectionMonth {
  yearMonth: string;
  openingCash: number;
  totalCashInflows: number;
  totalScheduledOutflows: number;
  totalSupplierPayments: number;
  totalNonCashFlows: number;
  closingMandatoryReserve: number;
  closingFreeCash: number;
  peakMandatoryReserve: number;
  peakMandatoryReserveShortfall: number;
  closingCash: number;
  unpaidScheduledAmount: number;
  pendingSupplierAmount: number;
}

export interface OperatingProjectionSummary {
  startingCash: number;
  endingCash: number;
  totalCashInflows: number;
  totalScheduledOutflows: number;
  totalSupplierPayments: number;
  totalNonCashFlows: number;
  endingMandatoryReserve: number;
  endingFreeCash: number;
  peakMandatoryReserve: number;
  peakMandatoryReserveShortfall: number;
  unpaidScheduledAmount: number;
  unpaidScheduledCount: number;
  pendingSupplierAmount: number;
  pendingSupplierCount: number;
}

export interface OperatingProjectionResult {
  startDate: string;
  endDate: string;
  startingCash: number;
  days: OperatingProjectionDay[];
  months: OperatingProjectionMonth[];
  summary: OperatingProjectionSummary;
  supplierQueue: OperatingSupplierQueueItem[];
  alerts: string[];
}

interface ScheduledExpense {
  id: string;
  date: string;
  concept: string;
  label: string;
  amount: number;
  remaining: number;
  source: 'budget' | 'manual' | 'fixed';
  allowPartial: boolean;
  sourceKey?: string;
  originalDate?: string;
  overrideNote?: string;
}

interface SupplierInvoice {
  id: string;
  providerId?: string;
  providerKey: string;
  providerName: string;
  supplierNumber?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  risk: ProviderRisk;
  flexibility: ProviderFlexibility;
  creditLimit?: number;
  dueDate: string;
  amount: number;
  remaining: number;
  priorityBlock: number;
  onlyMonTueWed: boolean;
  /** Score 0-100 del proveedor (de la Plantilla de Alberto). Mayor = más crítico. */
  score?: number;
  /** Bucket derivado del score. CRITICO (≥80) siempre se paga primero. */
  clasificacionAutomatica?: 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAJO';
}

function cloneDate(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function toIsoDate(value: Date): string {
  return cloneDate(value).toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

function addMonthsKeepingDom(value: Date, months: number): Date {
  const next = cloneDate(value);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function compareIsoDate(a: string, b: string): number {
  return a.localeCompare(b);
}

function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function monthKey(value: Date | string): string {
  const iso = typeof value === 'string' ? value : toIsoDate(value);
  return iso.slice(0, 7);
}

function normText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function isBusinessDay(value: Date): boolean {
  return !isNonOperatingDay(value);
}

function nextBusinessDay(value: Date): Date {
  let cursor = cloneDate(value);
  while (!isBusinessDay(cursor)) cursor = addDays(cursor, 1);
  return cursor;
}

function businessDayOnOrAfter(year: number, month: number, day: number): Date {
  const base = new Date(Date.UTC(year, month, day));
  return nextBusinessDay(base);
}

function lastBusinessDayOfMonth(year: number, month: number): Date {
  let cursor = new Date(Date.UTC(year, month + 1, 0));
  while (!isBusinessDay(cursor)) cursor = addDays(cursor, -1);
  return cursor;
}

function businessDaysInMonth(
  year: number,
  month: number,
  predicate?: (date: Date) => boolean,
): Date[] {
  const out: Date[] = [];
  const cursor = new Date(Date.UTC(year, month, 1));
  while (cursor.getUTCMonth() === month) {
    if (isBusinessDay(cursor) && (!predicate || predicate(cursor))) out.push(cloneDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function monthEntriesBetween(startDate: string, endDate: string): Array<{ year: number; month: number }> {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  const out: Array<{ year: number; month: number }> = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const limit = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= limit) {
    out.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() });
    cursor = addMonthsKeepingDom(cursor, 1);
    cursor.setUTCDate(1);
  }
  return out;
}

function distributeAmountEvenly(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = total / count;
  const out = new Array<number>(count).fill(base);
  out[count - 1] = total - base * (count - 1);
  return out;
}

function splitPayroll(total: number, weights: PayrollSplitWeights): PayrollSplitWeights {
  const weeklyNomina = total * weights.weeklyNomina;
  const quincena = total * weights.quincena;
  return {
    weeklyNomina,
    quincena,
    fondoAhorro: total - weeklyNomina - quincena,
  };
}

function riskOrder(risk: ProviderRisk): number {
  switch (risk) {
    case 'Alto': return 0;
    case 'Medio': return 1;
    default: return 2;
  }
}

function flexibilityBlock(flexibility: ProviderFlexibility): 0 | 1 | 2 {
  switch (flexibility) {
    case 'inamovible': return 0;
    case 'flexible': return 2;
    case 'revisar':
    case 'unknown':
    default:
      return 1;
  }
}

function priorityBlock(risk: ProviderRisk, flexibility: ProviderFlexibility): number {
  return riskOrder(risk) * 3 + flexibilityBlock(flexibility);
}

export function priorityBlockLabel(block: number): string {
  const labels = [
    'Riesgo alto + inamovible',
    'Riesgo alto + medio',
    'Riesgo alto + bajo',
    'Riesgo medio + inamovible',
    'Riesgo medio + medio',
    'Riesgo medio + bajo',
    'Riesgo bajo + inamovible',
    'Riesgo bajo + medio',
    'Riesgo bajo + bajo',
  ];
  return labels[block] ?? `Bloque ${block + 1}`;
}

function riskFromFlexibility(flexibility: ProviderFlexibility): ProviderRisk {
  switch (flexibility) {
    case 'inamovible': return 'Alto';
    case 'flexible': return 'Bajo';
    case 'revisar':
    case 'unknown':
    default:
      return 'Medio';
  }
}

function providerAllowsOnlyMonTueWed(provider: Provider | null, record: AgedBalanceRecord): boolean {
  const haystack = normText([
    provider?.type,
    provider?.name,
    record.nombre,
    record.clasificacionProveedor,
    record.clasifica,
  ].filter(Boolean).join(' '));
  return /\b(DIESEL|DIESEL,|COMBUSTIBLE|COMBUSTIBLES|GAS)\b/.test(haystack);
}

function paymentAllowedForInvoice(invoice: SupplierInvoice, date: Date): boolean {
  if (!isBusinessDay(date)) return false;
  if (!invoice.onlyMonTueWed) return true;
  const dow = date.getUTCDay();
  return dow >= 1 && dow <= 3;
}

function latestStatementBalance(statement: BankAccountStatement): number {
  if (typeof statement.saldoFinal === 'number' && Number.isFinite(statement.saldoFinal)) return statement.saldoFinal;
  const lastMovementWithBalance = [...statement.movimientos]
    .reverse()
    .find((movement) => typeof movement.saldo === 'number' && Number.isFinite(movement.saldo));
  if (lastMovementWithBalance?.saldo != null) return lastMovementWithBalance.saldo;
  if (typeof statement.saldoInicial === 'number' && Number.isFinite(statement.saldoInicial)) {
    return statement.movimientos.reduce((running, movement) => {
      const amount = Math.abs(movement.importe ?? 0);
      return running + (movement.tipoMovimiento === 'ABONO' ? amount : -amount);
    }, statement.saldoInicial);
  }
  return 0;
}

function computeStartingCash(statements: BankAccountStatement[]): number {
  const latestByAccount = new Map<string, BankAccountStatement>();
  for (const statement of statements) {
    const key = `${statement.cia}|${statement.banco}|${statement.cuenta}|${statement.moneda}`;
    const prev = latestByAccount.get(key);
    if (!prev || compareIsoDate(prev.fechaEstadoCuenta, statement.fechaEstadoCuenta) < 0) {
      latestByAccount.set(key, statement);
    }
  }
  let total = 0;
  for (const statement of latestByAccount.values()) total += latestStatementBalance(statement);
  return total;
}

function buildFixedRuleEvents(
  startDate: string,
  endDate: string,
  rules: OperatingFixedRule[],
): ScheduledExpense[] {
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  const out: ScheduledExpense[] = [];
  for (const rule of rules) {
    let cursor = parseIsoDate(rule.anchorDate);
    while (cursor <= end) {
      if (cursor >= start) {
        const paymentDate = toIsoDate(nextBusinessDay(cursor));
        out.push({
          id: `fixed:${rule.id}:${paymentDate}`,
          date: paymentDate,
          concept: rule.concept,
          label: rule.label,
          amount: rule.amount,
          remaining: rule.amount,
          source: 'fixed',
          allowPartial: rule.allowPartial ?? false,
        });
      }
      if (!rule.everyMonths || rule.everyMonths <= 0) break;
      cursor = addMonthsKeepingDom(cursor, rule.everyMonths);
    }
  }
  return out;
}

function manualEventsForConceptMonth(
  manualEvents: ManualExpenseEvent[],
  concept: string,
  year: number,
  month: number,
): ManualExpenseEvent[] {
  const target = normText(concept);
  return manualEvents
    .filter((event) => normText(event.concept) === target)
    .filter((event) => {
      const date = parseIsoDate(event.date);
      return date.getUTCFullYear() === year && date.getUTCMonth() === month;
    })
    .sort((a, b) => compareIsoDate(a.date, b.date));
}

function scheduleProratedConcept(
  concept: string,
  label: string,
  amount: number,
  dates: Date[],
): ScheduledExpense[] {
  if (amount <= 0 || dates.length === 0) return [];
  const allocations = distributeAmountEvenly(amount, dates.length);
  return dates.map((date, index) => ({
    id: `budget:${normText(concept)}:${toIsoDate(date)}:${index}`,
    date: toIsoDate(date),
    concept,
    label,
    amount: allocations[index],
    remaining: allocations[index],
    source: 'budget',
    allowPartial: true,
  }));
}

function buildPayrollEvents(
  year: number,
  month: number,
  total: number,
  split: PayrollSplitWeights,
): ScheduledExpense[] {
  if (total <= 0) return [];
  const amounts = splitPayroll(total, split);
  const wednesdays = businessDaysInMonth(year, month, date => date.getUTCDay() === 3);
  const weekly = scheduleProratedConcept('Nómina', 'Nómina semanal', amounts.weeklyNomina, wednesdays);

  const quincenaDate = businessDayOnOrAfter(year, month, 14);
  const fondoDate = cloneDate(quincenaDate);

  const quincena: ScheduledExpense[] = amounts.quincena > 0 ? [{
    id: `budget:NOMINA-QUINCENA:${toIsoDate(quincenaDate)}`,
    date: toIsoDate(quincenaDate),
    concept: 'Nómina',
    label: 'Quincena',
    amount: amounts.quincena,
    remaining: amounts.quincena,
    source: 'budget',
    allowPartial: false,
  }] : [];

  const fondoAhorro: ScheduledExpense[] = amounts.fondoAhorro > 0 ? [{
    id: `budget:NOMINA-FONDO:${toIsoDate(fondoDate)}`,
    date: toIsoDate(fondoDate),
    concept: 'Nómina',
    label: 'Fondo de ahorro',
    amount: amounts.fondoAhorro,
    remaining: amounts.fondoAhorro,
    source: 'budget',
    allowPartial: false,
  }] : [];

  return [...weekly, ...quincena, ...fondoAhorro];
}

function buildBudgetExpenses(params: {
  budget?: Budget | null;
  startDate: string;
  endDate: string;
  manualEvents: ManualExpenseEvent[];
  fixedRules: OperatingFixedRule[];
  payrollSplit: PayrollSplitWeights;
}): { expenses: ScheduledExpense[]; alerts: string[] } {
  const { budget, startDate, endDate, manualEvents, fixedRules, payrollSplit } = params;
  const alerts: string[] = [];
  const start = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);
  const fixedRuleEvents = buildFixedRuleEvents(startDate, endDate, fixedRules);
  const fixedByMonth = new Map<string, ScheduledExpense[]>();
  for (const event of fixedRuleEvents) {
    const key = monthKey(event.date);
    const bucket = fixedByMonth.get(key) ?? [];
    bucket.push(event);
    fixedByMonth.set(key, bucket);
  }

  if (!budget) {
    return { expenses: fixedRuleEvents.sort((a, b) => compareIsoDate(a.date, b.date)), alerts };
  }

  const out: ScheduledExpense[] = [...fixedRuleEvents];
  const months = monthEntriesBetween(startDate, endDate);

  for (const { year, month } of months) {
    if (budget.year !== year) continue;

    const manualImpuestos = manualEventsForConceptMonth(manualEvents, 'Impuestos', year, month);
    const manualFiniquitos = manualEventsForConceptMonth(manualEvents, 'Finiquitos', year, month);
    const manualCapex = manualEventsForConceptMonth(manualEvents, 'CAPEX', year, month);
    const manualPasivos = manualEventsForConceptMonth(manualEvents, 'Pasivos Financieros', year, month);

    const monthFixed = fixedByMonth.get(`${year}-${String(month + 1).padStart(2, '0')}`) ?? [];

    for (const row of budget.expenseByConcept) {
      const total = row.monthly[month] ?? 0;
      if (total <= 0) continue;
      const concept = row.concept;
      const normalized = normText(concept);

      if (normalized === 'NOMINA') {
        out.push(...buildPayrollEvents(year, month, total, payrollSplit));
        continue;
      }

      if (normalized === 'DIESEL' || normalized === 'GAS') {
        const dates = businessDaysInMonth(year, month, date => {
          const dow = date.getUTCDay();
          return dow >= 1 && dow <= 3;
        });
        out.push(...scheduleProratedConcept(concept, concept, total, dates));
        continue;
      }

      if (normalized === 'LUBRICANTES Y OTROS' || normalized === 'GASTOS DE OPERACION') {
        const dates = businessDaysInMonth(year, month);
        out.push(...scheduleProratedConcept(concept, concept, total, dates));
        continue;
      }

      if (normalized === 'IMPUESTOS') {
        if (manualImpuestos.length > 0) {
          const manualTotal = manualImpuestos.reduce((sum, event) => sum + event.amount, 0);
          if (Math.abs(manualTotal - total) > 1) {
            alerts.push(`Impuestos ${year}-${String(month + 1).padStart(2, '0')}: manual ${manualTotal.toFixed(2)} vs presupuesto ${total.toFixed(2)}.`);
          }
          out.push(...manualImpuestos.map((event, index) => ({
            id: event.id ?? `manual:IMPUESTOS:${event.date}:${index}`,
            date: toIsoDate(nextBusinessDay(parseIsoDate(event.date))),
            concept,
            label: event.label ?? 'Impuestos',
            amount: event.amount,
            remaining: event.amount,
            source: 'manual' as const,
            allowPartial: event.allowPartial ?? false,
          })));
        } else {
          const date = toIsoDate(lastBusinessDayOfMonth(year, month));
          out.push({
            id: `fallback:IMPUESTOS:${date}`,
            date,
            concept,
            label: 'Impuestos',
            amount: total,
            remaining: total,
            source: 'budget',
            allowPartial: false,
          });
          alerts.push(`Impuestos ${year}-${String(month + 1).padStart(2, '0')}: sin carga manual, se uso el ultimo dia habil.`);
        }
        continue;
      }

      if (normalized === 'FINIQUITOS') {
        if (manualFiniquitos.length > 0) {
          out.push(...manualFiniquitos.map((event, index) => ({
            id: event.id ?? `manual:FINIQUITOS:${event.date}:${index}`,
            date: toIsoDate(nextBusinessDay(parseIsoDate(event.date))),
            concept,
            label: event.label ?? 'Finiquitos',
            amount: event.amount,
            remaining: event.amount,
            source: 'manual' as const,
            allowPartial: event.allowPartial ?? false,
          })));
        } else {
          const date = toIsoDate(lastBusinessDayOfMonth(year, month));
          out.push({
            id: `fallback:FINIQUITOS:${date}`,
            date,
            concept,
            label: 'Finiquitos',
            amount: total,
            remaining: total,
            source: 'budget',
            allowPartial: false,
          });
        }
        continue;
      }

      if (normalized === 'CAPEX') {
        if (manualCapex.length > 0) {
          out.push(...manualCapex.map((event, index) => ({
            id: event.id ?? `manual:CAPEX:${event.date}:${index}`,
            date: toIsoDate(nextBusinessDay(parseIsoDate(event.date))),
            concept,
            label: event.label ?? 'CAPEX',
            amount: event.amount,
            remaining: event.amount,
            source: 'manual' as const,
            allowPartial: event.allowPartial ?? false,
          })));
        } else {
          const date = toIsoDate(lastBusinessDayOfMonth(year, month));
          out.push({
            id: `fallback:CAPEX:${date}`,
            date,
            concept,
            label: 'CAPEX',
            amount: total,
            remaining: total,
            source: 'budget',
            allowPartial: false,
          });
        }
        continue;
      }

      if (normalized === 'PASIVOS FINANCIEROS') {
        const manualExpenses = manualPasivos.map((event, index) => ({
          id: event.id ?? `manual:PASIVOS:${event.date}:${index}`,
          date: toIsoDate(nextBusinessDay(parseIsoDate(event.date))),
          concept,
          label: event.label ?? 'Pasivos Financieros',
          amount: event.amount,
          remaining: event.amount,
          source: 'manual' as const,
          allowPartial: event.allowPartial ?? false,
        }));
        out.push(...manualExpenses);

        const scheduledTotal = monthFixed.reduce((sum, event) => sum + event.amount, 0)
          + manualExpenses.reduce((sum, event) => sum + event.amount, 0);
        const remainder = total - scheduledTotal;
        if (remainder > 1) {
          const date = toIsoDate(lastBusinessDayOfMonth(year, month));
          out.push({
            id: `fallback:PASIVOS:${date}`,
            date,
            concept,
            label: 'Pasivos Financieros remanente',
            amount: remainder,
            remaining: remainder,
            source: 'budget',
            allowPartial: false,
          });
        } else if (remainder < -1) {
          alerts.push(`Pasivos Financieros ${year}-${String(month + 1).padStart(2, '0')}: reglas exactas exceden el presupuesto por ${Math.abs(remainder).toFixed(2)}.`);
        }
        continue;
      }

      const dates = businessDaysInMonth(year, month);
      out.push(...scheduleProratedConcept(concept, concept, total, dates));
    }
  }

  return {
    expenses: out
      .filter((expense) => {
        const date = parseIsoDate(expense.date);
        return date >= start && date <= end;
      })
      .sort((a, b) => compareIsoDate(a.date, b.date)),
    alerts,
  };
}

function projectCollectionsForRange(
  clients: Client[],
  assumptions: CashFlowAssumptions,
  startDate: string,
  endDate: string,
): CollectionEvent[] {
  const startYear = Number(startDate.slice(0, 4));
  const endYear = Number(endDate.slice(0, 4));
  const out: CollectionEvent[] = [];
  for (let year = startYear; year <= endYear; year++) {
    const events = projectYear(clients, { ...assumptions, year });
    for (const event of events) {
      const adjustedDate = toIsoDate(nextBusinessDay(parseIsoDate(event.realDate)));
      if (compareIsoDate(adjustedDate, startDate) < 0 || compareIsoDate(adjustedDate, endDate) > 0) continue;
      out.push({ ...event, realDate: adjustedDate });
    }
  }
  return out.sort((a, b) => compareIsoDate(a.realDate, b.realDate));
}

function collectionConfidence(client: Client | undefined): 'Alta' | 'Media' | 'Baja' {
  if (!client) return 'Media';
  if (client.factoraje) return 'Alta';
  const compliance = client.complianceRate ?? 1;
  if (compliance >= 0.95) return 'Alta';
  if (compliance >= 0.8) return 'Media';
  return 'Baja';
}

function buildInvoices(
  agedBalances: AgedBalanceRecord[],
  providers: Provider[],
  startDate: string,
): SupplierInvoice[] {
  const providerIndex = buildProviderIndex(providers);
  return agedBalances
    .filter((record) => (record.importePendientePesos ?? 0) > 0)
    .map((record) => {
      const matched = matchAgedToProvider(record, providerIndex);
      const catalog = enrichFromCatalog({
        supplier: record.nombre,
        classification: record.clasificacionProveedor,
      });
      const flexibility = matched?.flexibility ?? catalog.flexibility;
      const risk = matched?.risk ?? riskFromFlexibility(flexibility);
      const dueDate = record.fechaProgramacionPago || record.fechaVence || record.fechaFactura;
      const providerKey = matched?.id ?? normText(record.noProveedor || record.nombre);
      const creditLimit = matched?.creditLimit ?? catalog.creditLimit ?? undefined;
      return {
        id: [
          providerKey,
          normText(record.noFactura),
          record.fechaFactura,
          Math.round((record.importePendientePesos ?? 0) * 100) / 100,
        ].join('|'),
        providerId: matched?.id,
        providerKey,
        providerName: matched?.name ?? (record.nombre.trim() || 'Proveedor s/n'),
        supplierNumber: record.noProveedor || catalog.providerNo || undefined,
        invoiceNumber: record.noFactura || undefined,
        invoiceDate: record.fechaFactura || undefined,
        risk,
        flexibility,
        creditLimit,
        dueDate: dueDate || startDate,
        amount: record.importePendientePesos,
        remaining: record.importePendientePesos,
        priorityBlock: priorityBlock(risk, flexibility),
        onlyMonTueWed: providerAllowsOnlyMonTueWed(matched ?? null, record),
        score: matched?.score,
        clasificacionAutomatica: matched?.clasificacionAutomatica,
      } satisfies SupplierInvoice;
    })
    .sort(supplierInvoiceComparator);
}

/**
 * Comparador maestro de facturas. Orden de prioridad:
 *   1. Proveedores Operativos (score ≥ 80) — siempre primero.
 *   2. priorityBlock (riesgo + flexibilidad)
 *   3. Score (mayor → más prioridad)
 *   4. Fecha de vencimiento (más antigua primero)
 *   5. Monto (menor primero, para liberar volumen de facturas)
 */
function supplierInvoiceComparator(a: SupplierInvoice, b: SupplierInvoice): number {
  const aCritico = a.clasificacionAutomatica === 'CRITICO' ? 0 : 1;
  const bCritico = b.clasificacionAutomatica === 'CRITICO' ? 0 : 1;
  if (aCritico !== bCritico) return aCritico - bCritico;
  if (a.priorityBlock !== b.priorityBlock) return a.priorityBlock - b.priorityBlock;
  const aScore = a.score ?? 0;
  const bScore = b.score ?? 0;
  if (aScore !== bScore) return bScore - aScore;
  const due = compareIsoDate(a.dueDate, b.dueDate);
  if (due !== 0) return due;
  return a.amount - b.amount;
}

function allocateProportionally(
  totalCash: number,
  items: Array<{ key: string; amount: number }>,
): Map<string, number> {
  const valid = items.filter((item) => item.amount > 0);
  const out = new Map<string, number>();
  if (totalCash <= 0 || valid.length === 0) return out;
  const totalAmount = valid.reduce((sum, item) => sum + item.amount, 0);
  if (totalAmount <= 0) return out;

  let assigned = 0;
  valid.forEach((item, index) => {
    const allocation = index === valid.length - 1
      ? Math.max(0, totalCash - assigned)
      : Math.min(item.amount, totalCash * (item.amount / totalAmount));
    out.set(item.key, allocation);
    assigned += allocation;
  });
  return out;
}

function supplierPaymentExplanation(
  invoice: SupplierInvoice,
  reason: OperatingSupplierPayment['reason'],
  creditTargetRatio: number,
  note?: string,
): string {
  if (reason === 'manual') {
    return note
      ? `Pago fijado manualmente en el escenario: ${note}.`
      : 'Pago fijado manualmente en el escenario; el motor recalcula el resto con la caja disponible.';
  }
  if (reason === 'credit_limit') {
    const target = invoice.creditLimit ? invoice.creditLimit * creditTargetRatio : 0;
    return invoice.creditLimit
      ? `Se paga para bajar exposición de crédito hacia ${Math.round(creditTargetRatio * 100)}% del límite (${target.toFixed(2)}).`
      : 'Se paga para reducir exposición de crédito del proveedor.';
  }
  return `Factura programada o vencida al ${invoice.dueDate}; se paga por prioridad de riesgo y flexibilidad.`;
}

function supplierPriorityExplanation(invoice: SupplierInvoice): string {
  const bucketLabel = invoice.clasificacionAutomatica === 'CRITICO'
    ? 'Operativo · NO PAUSAR'
    : invoice.clasificacionAutomatica === 'ALTO'
      ? 'Prioritario'
      : invoice.clasificacionAutomatica === 'MEDIO'
        ? 'Negociable'
        : invoice.clasificacionAutomatica === 'BAJO'
          ? 'Flexible'
          : null;
  const scoreLabel = invoice.score != null ? `score ${invoice.score.toFixed(0)}/100` : null;
  const flexLabel = invoice.flexibility === 'inamovible'
    ? 'no conviene mover fecha'
    : invoice.flexibility === 'flexible'
      ? 'puede negociarse si falta caja'
      : 'requiere revisión antes de mover fecha';
  const parts = [
    bucketLabel,
    scoreLabel,
    `${priorityBlockLabel(invoice.priorityBlock)}`,
    flexLabel,
  ].filter(Boolean);
  return parts.join(' · ');
}

function applyInvoiceAllocation(
  invoices: SupplierInvoice[],
  allocation: number,
  reason: OperatingSupplierPayment['reason'],
  creditTargetRatio: number,
  note?: string,
): { used: number; payments: OperatingSupplierPayment[] } {
  let remainingAllocation = allocation;
  const payments: OperatingSupplierPayment[] = [];
  for (const invoice of invoices) {
    if (remainingAllocation <= 0) break;
    if (invoice.remaining <= 0) continue;
    const paid = Math.min(invoice.remaining, remainingAllocation);
    if (paid <= 0) continue;
    invoice.remaining -= paid;
    remainingAllocation -= paid;
    payments.push({
      id: `supplier:${reason}:${invoice.id}:${payments.length}`,
      invoiceKey: invoice.id,
      label: invoice.providerName,
      amount: paid,
      category: reason === 'manual'
        ? 'Pago manual de escenario'
        : reason === 'credit_limit' ? 'Línea de crédito' : 'Pago a proveedor',
      source: 'supplier',
      affectsCash: true,
      providerId: invoice.providerId,
      providerName: invoice.providerName,
      supplierNumber: invoice.supplierNumber,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      invoiceAmount: invoice.amount,
      remainingAfterPayment: invoice.remaining,
      risk: invoice.risk,
      flexibility: invoice.flexibility,
      priorityBlock: invoice.priorityBlock,
      score: invoice.score,
      clasificacionAutomatica: invoice.clasificacionAutomatica,
      reason,
      dueDate: invoice.dueDate,
      creditLimit: invoice.creditLimit,
      paymentExplanation: supplierPaymentExplanation(invoice, reason, creditTargetRatio, note),
      priorityExplanation: supplierPriorityExplanation(invoice),
      detail: reason === 'manual'
        ? 'Ajuste manual de escenario'
        : reason === 'credit_limit'
        ? 'Reducir exposición de línea de crédito'
        : `Vencimiento ${invoice.dueDate}`,
    });
  }
  return { used: allocation - remainingAllocation, payments };
}

function planSupplierPaymentsForDay(
  date: string,
  invoices: SupplierInvoice[],
  providerExposure: Map<string, number>,
  cashAvailable: number,
  creditTargetRatio: number,
  manualLockedUntil: Map<string, string>,
): { used: number; payments: OperatingSupplierPayment[] } {
  if (cashAvailable <= 0) return { used: 0, payments: [] };
  const day = parseIsoDate(date);
  if (!isBusinessDay(day)) return { used: 0, payments: [] };

  let remainingCash = cashAvailable;
  const payments: OperatingSupplierPayment[] = [];

  const blockedInvoices = invoices.filter((invoice) => {
    if (invoice.remaining <= 0) return false;
    const lockedUntil = manualLockedUntil.get(invoice.id);
    if (lockedUntil && compareIsoDate(date, lockedUntil) <= 0) return false;
    return paymentAllowedForInvoice(invoice, day);
  });

  // Pass 1: credit-limit relief inside each priority block.
  for (let block = 0; block < 9 && remainingCash > 0; block++) {
    const providersInBlock = new Map<string, { pressure: number; invoices: SupplierInvoice[] }>();
    for (const invoice of blockedInvoices) {
      if (invoice.priorityBlock !== block) continue;
      const exposure = providerExposure.get(invoice.providerKey) ?? 0;
      const limit = invoice.creditLimit ?? 0;
      if (!(limit > 0)) continue;
      const pressure = Math.max(0, exposure - limit * creditTargetRatio);
      if (pressure <= 0) continue;
      const bucket = providersInBlock.get(invoice.providerKey) ?? { pressure, invoices: [] };
      bucket.pressure = Math.max(bucket.pressure, pressure);
      bucket.invoices.push(invoice);
      providersInBlock.set(invoice.providerKey, bucket);
    }

    const allocation = allocateProportionally(
      Math.min(
        remainingCash,
        Array.from(providersInBlock.values()).reduce((sum, entry) => sum + entry.pressure, 0),
      ),
      Array.from(providersInBlock.entries()).map(([key, entry]) => ({ key, amount: entry.pressure })),
    );

    for (const [providerKey, amount] of allocation) {
      if (amount <= 0) continue;
      const entry = providersInBlock.get(providerKey);
      if (!entry) continue;
      entry.invoices.sort((a, b) => compareIsoDate(a.dueDate, b.dueDate));
      const applied = applyInvoiceAllocation(entry.invoices, amount, 'credit_limit', creditTargetRatio);
      if (applied.used <= 0) continue;
      payments.push(...applied.payments);
      remainingCash -= applied.used;
      providerExposure.set(providerKey, Math.max(0, (providerExposure.get(providerKey) ?? 0) - applied.used));
    }
  }

  // Pass 2: due invoices by confirmed priority matrix.
  for (let block = 0; block < 9 && remainingCash > 0; block++) {
    const providersInBlock = new Map<string, { dueAmount: number; invoices: SupplierInvoice[]; oldestDue: string }>();
    for (const invoice of blockedInvoices) {
      if (invoice.priorityBlock !== block) continue;
      if (invoice.remaining <= 0) continue;
      if (compareIsoDate(invoice.dueDate, date) > 0) continue;
      const bucket = providersInBlock.get(invoice.providerKey) ?? {
        dueAmount: 0,
        invoices: [],
        oldestDue: invoice.dueDate,
      };
      bucket.dueAmount += invoice.remaining;
      bucket.invoices.push(invoice);
      if (compareIsoDate(invoice.dueDate, bucket.oldestDue) < 0) bucket.oldestDue = invoice.dueDate;
      providersInBlock.set(invoice.providerKey, bucket);
    }

    const blockProviders = Array.from(providersInBlock.entries())
      .sort((a, b) => {
        const dateCmp = compareIsoDate(a[1].oldestDue, b[1].oldestDue);
        if (dateCmp !== 0) return dateCmp;
        return b[1].dueAmount - a[1].dueAmount;
      });

    const blockTotal = blockProviders.reduce((sum, [, entry]) => sum + entry.dueAmount, 0);
    if (blockTotal <= 0) continue;

    if (remainingCash >= blockTotal) {
      for (const [, entry] of blockProviders) {
        entry.invoices.sort((a, b) => compareIsoDate(a.dueDate, b.dueDate));
        const applied = applyInvoiceAllocation(entry.invoices, entry.dueAmount, 'due', creditTargetRatio);
        if (applied.used <= 0) continue;
        payments.push(...applied.payments);
        remainingCash -= applied.used;
        const providerKey = entry.invoices[0]?.providerKey;
        if (providerKey) {
          providerExposure.set(providerKey, Math.max(0, (providerExposure.get(providerKey) ?? 0) - applied.used));
        }
      }
      continue;
    }

    const allocation = allocateProportionally(
      remainingCash,
      blockProviders.map(([key, entry]) => ({ key, amount: entry.dueAmount })),
    );
    for (const [providerKey, amount] of allocation) {
      if (amount <= 0) continue;
      const entry = providersInBlock.get(providerKey);
      if (!entry) continue;
      entry.invoices.sort((a, b) => compareIsoDate(a.dueDate, b.dueDate));
      const applied = applyInvoiceAllocation(entry.invoices, amount, 'due', creditTargetRatio);
      if (applied.used <= 0) continue;
      payments.push(...applied.payments);
      remainingCash -= applied.used;
      providerExposure.set(providerKey, Math.max(0, (providerExposure.get(providerKey) ?? 0) - applied.used));
      if (remainingCash <= 0) break;
    }
  }

  return { used: cashAvailable - remainingCash, payments };
}

function planManualSupplierPaymentsForDay(
  date: string,
  invoices: SupplierInvoice[],
  providerExposure: Map<string, number>,
  cashAvailable: number,
  creditTargetRatio: number,
  overrides: OperatingSupplierPaymentOverride[],
): { used: number; payments: OperatingSupplierPayment[]; alerts: string[] } {
  if (cashAvailable <= 0 || overrides.length === 0) return { used: 0, payments: [], alerts: [] };
  const day = parseIsoDate(date);
  if (!isBusinessDay(day)) return { used: 0, payments: [], alerts: [] };

  let remainingCash = cashAvailable;
  const payments: OperatingSupplierPayment[] = [];
  const alerts: string[] = [];

  for (const override of overrides) {
    if (remainingCash <= 0) break;
    if (override.amount <= 0) continue;
    const invoice = invoices.find((item) => item.id === override.invoiceKey);
    if (!invoice || invoice.remaining <= 0) continue;

    const requested = Math.min(override.amount, invoice.remaining);
    const applied = applyInvoiceAllocation([invoice], Math.min(requested, remainingCash), 'manual', creditTargetRatio, override.note);
    if (applied.used <= 0) continue;

    payments.push(...applied.payments.map((payment) => ({
      ...payment,
      id: `supplier:manual:${override.id ?? override.invoiceKey}:${date}`,
    })));
    remainingCash -= applied.used;
    providerExposure.set(invoice.providerKey, Math.max(0, (providerExposure.get(invoice.providerKey) ?? 0) - applied.used));

    if (applied.used + 0.005 < requested) {
      alerts.push(`Pago manual incompleto para ${invoice.providerName}: se pagaron ${applied.used.toFixed(2)} de ${requested.toFixed(2)} por falta de caja disponible.`);
    }
  }

  return { used: cashAvailable - remainingCash, payments, alerts };
}

function fixedExpenseSort(a: ScheduledExpense, b: ScheduledExpense): number {
  if (a.date !== b.date) return compareIsoDate(a.date, b.date);
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  return a.label.localeCompare(b.label);
}

function normalizedOverrideDate(date: string): string | null {
  if (!isIsoDateString(date)) return null;
  return toIsoDate(nextBusinessDay(parseIsoDate(date)));
}

function overrideDateInRange(date: string, startDate: string, endDate: string): boolean {
  return compareIsoDate(date, startDate) >= 0 && compareIsoDate(date, endDate) <= 0;
}

function buildCollectionOverrideMap(
  overrides: OperatingCollectionOverride[],
  startDate: string,
  endDate: string,
): Map<string, OperatingCollectionOverride & { date: string }> {
  const byKey = new Map<string, OperatingCollectionOverride & { date: string }>();
  for (const override of overrides) {
    if (!override.sourceKey || !Number.isFinite(override.amount) || override.amount < 0) continue;
    const date = normalizedOverrideDate(override.date);
    if (!date) continue;
    if (override.amount > 0 && !overrideDateInRange(date, startDate, endDate)) continue;
    byKey.set(override.sourceKey, { ...override, date });
  }
  return byKey;
}

function buildScheduledOutflowOverrideMap(
  overrides: OperatingScheduledOutflowOverride[],
  startDate: string,
  endDate: string,
): Map<string, OperatingScheduledOutflowOverride & { date: string }> {
  const byKey = new Map<string, OperatingScheduledOutflowOverride & { date: string }>();
  for (const override of overrides) {
    if (!override.sourceKey || !Number.isFinite(override.amount) || override.amount < 0) continue;
    const date = normalizedOverrideDate(override.date);
    if (!date) continue;
    if (override.amount > 0 && !overrideDateInRange(date, startDate, endDate)) continue;
    byKey.set(override.sourceKey, { ...override, date });
  }
  return byKey;
}

function applyScheduledOutflowOverrides(
  expenses: ScheduledExpense[],
  overrides: OperatingScheduledOutflowOverride[],
  startDate: string,
  endDate: string,
): ScheduledExpense[] {
  const byKey = buildScheduledOutflowOverrideMap(overrides, startDate, endDate);
  return expenses.flatMap((expense) => {
    const sourceKey = expense.sourceKey ?? expense.id;
    const originalDate = expense.originalDate ?? expense.date;
    const override = byKey.get(sourceKey);
    if (!override) return [{ ...expense, sourceKey, originalDate }];
    if (override.amount <= 0) return [];
    return [{
      ...expense,
      date: override.date,
      amount: override.amount,
      remaining: override.amount,
      sourceKey,
      originalDate,
      overrideNote: override.note,
    }];
  });
}

function addAmount(map: Map<string, number>, key: string, amount: number): void {
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.005) return;
  map.set(key, (map.get(key) ?? 0) + amount);
}

function daysBetween(startDate: string, endDate: string): number {
  return Math.round((parseIsoDate(endDate).getTime() - parseIsoDate(startDate).getTime()) / DAY_MS);
}

function mandatoryReserveRequirement(
  date: string,
  scheduledExpenses: ScheduledExpense[],
  futureCashByDate: Map<string, number>,
): number {
  const mandatoryExpenses = scheduledExpenses.filter((expense) => !expense.allowPartial && expense.remaining > 0);
  if (mandatoryExpenses.length === 0) return 0;

  const dueByDate = new Map<string, number>();
  const checkpointDates = new Set<string>([date]);
  let maxDueDate = date;

  for (const expense of mandatoryExpenses) {
    const dueDate = compareIsoDate(expense.date, date) <= 0 ? date : expense.date;
    addAmount(dueByDate, dueDate, expense.remaining);
    checkpointDates.add(dueDate);
    if (compareIsoDate(dueDate, maxDueDate) > 0) maxDueDate = dueDate;
  }

  for (const [cashDate, amount] of futureCashByDate) {
    if (compareIsoDate(cashDate, date) <= 0) continue;
    if (compareIsoDate(cashDate, maxDueDate) > 0) continue;
    if (Math.abs(amount) < 0.005) continue;
    checkpointDates.add(cashDate);
  }

  let cumulativeMandatory = 0;
  let cumulativeFutureCash = 0;
  let requiredReserve = 0;

  for (const checkpointDate of Array.from(checkpointDates).sort(compareIsoDate)) {
    if (compareIsoDate(checkpointDate, date) > 0) {
      cumulativeFutureCash += futureCashByDate.get(checkpointDate) ?? 0;
    }
    cumulativeMandatory += dueByDate.get(checkpointDate) ?? 0;
    requiredReserve = Math.max(requiredReserve, cumulativeMandatory - cumulativeFutureCash);
  }

  return Math.max(0, requiredReserve);
}

function buildMandatoryReserveLines(
  date: string,
  scheduledExpenses: ScheduledExpense[],
  reserveAmount: number,
): OperatingMandatoryReserveLine[] {
  const mandatoryExpenses = scheduledExpenses
    .filter((expense) => !expense.allowPartial && expense.remaining > 0)
    .sort(fixedExpenseSort);

  let remainingReserve = reserveAmount;
  return mandatoryExpenses.map((expense) => {
    const reservedAmount = Math.min(expense.remaining, Math.max(0, remainingReserve));
    remainingReserve -= reservedAmount;
    return {
      id: `reserve:${expense.id}`,
      label: expense.label,
      category: expense.concept,
      source: expense.source,
      dueDate: expense.date,
      amount: expense.remaining,
      reservedAmount,
      daysUntilDue: Math.max(0, daysBetween(date, expense.date)),
    };
  });
}

function mandatoryReserveSnapshot(
  date: string,
  scheduledExpenses: ScheduledExpense[],
  futureCashByDate: Map<string, number>,
  cash: number,
): Pick<
  OperatingProjectionDay,
  'mandatoryReserve'
  | 'mandatoryReserveRequired'
  | 'mandatoryReserveShortfall'
  | 'mandatoryReserveLines'
  | 'freeCash'
> {
  const required = mandatoryReserveRequirement(date, scheduledExpenses, futureCashByDate);
  const reserve = Math.min(Math.max(0, cash), required);
  return {
    mandatoryReserve: reserve,
    mandatoryReserveRequired: required,
    mandatoryReserveShortfall: Math.max(0, required - reserve),
    mandatoryReserveLines: buildMandatoryReserveLines(date, scheduledExpenses, reserve),
    freeCash: Math.max(0, cash - reserve),
  };
}

function buildMonthRollup(days: OperatingProjectionDay[]): OperatingProjectionMonth[] {
  const byMonth = new Map<string, OperatingProjectionMonth>();
  for (const day of days) {
    const ym = day.date.slice(0, 7);
    const current = byMonth.get(ym);
    const scheduledOutflows = day.scheduledOutflows.reduce((sum, line) => sum + line.amount, 0);
    const supplierPayments = day.supplierPayments.reduce((sum, line) => sum + line.amount, 0);
    const cashInflows = day.cashInflows.reduce((sum, line) => sum + line.amount, 0);
    const nonCashFlows = day.nonCashFlows.reduce((sum, line) => sum + line.amount, 0);
    if (!current) {
      byMonth.set(ym, {
        yearMonth: ym,
        openingCash: day.openingCash,
        totalCashInflows: cashInflows,
        totalScheduledOutflows: scheduledOutflows,
        totalSupplierPayments: supplierPayments,
        totalNonCashFlows: nonCashFlows,
        closingMandatoryReserve: day.mandatoryReserve,
        closingFreeCash: day.freeCash,
        peakMandatoryReserve: day.mandatoryReserve,
        peakMandatoryReserveShortfall: day.mandatoryReserveShortfall,
        closingCash: day.closingCash,
        unpaidScheduledAmount: day.unpaidScheduledAmount,
        pendingSupplierAmount: day.pendingSupplierAmount,
      });
      continue;
    }
    current.totalCashInflows += cashInflows;
    current.totalScheduledOutflows += scheduledOutflows;
    current.totalSupplierPayments += supplierPayments;
    current.totalNonCashFlows += nonCashFlows;
    current.closingMandatoryReserve = day.mandatoryReserve;
    current.closingFreeCash = day.freeCash;
    current.peakMandatoryReserve = Math.max(current.peakMandatoryReserve, day.mandatoryReserve);
    current.peakMandatoryReserveShortfall = Math.max(current.peakMandatoryReserveShortfall, day.mandatoryReserveShortfall);
    current.closingCash = day.closingCash;
    current.unpaidScheduledAmount = day.unpaidScheduledAmount;
    current.pendingSupplierAmount = day.pendingSupplierAmount;
  }
  return Array.from(byMonth.values()).sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
}

function buildSupplierQueue(
  invoices: SupplierInvoice[],
  days: OperatingProjectionDay[],
  startDate: string,
): OperatingSupplierQueueItem[] {
  const paymentsByInvoice = new Map<string, Array<{ date: string; payment: OperatingSupplierPayment }>>();
  for (const day of days) {
    for (const payment of day.supplierPayments) {
      const bucket = paymentsByInvoice.get(payment.invoiceKey) ?? [];
      bucket.push({ date: day.date, payment });
      paymentsByInvoice.set(payment.invoiceKey, bucket);
    }
  }

  const exposureByProvider = new Map<string, number>();
  for (const invoice of invoices) {
    exposureByProvider.set(invoice.providerKey, (exposureByProvider.get(invoice.providerKey) ?? 0) + invoice.amount);
  }

  return invoices.map((invoice) => {
    const payments = paymentsByInvoice.get(invoice.id) ?? [];
    const paidAmount = payments.reduce((sum, entry) => sum + entry.payment.amount, 0);
    const firstPayment = payments[0] ?? null;
    const manualPayment = payments.find((entry) => entry.payment.reason === 'manual') ?? null;
    const remainingAmount = invoice.remaining;
    const exposure = exposureByProvider.get(invoice.providerKey) ?? invoice.amount;
    const creditStatus = creditStatusForInvoice(invoice, exposure);
    const status: OperatingSupplierQueueItem['status'] = manualPayment
      ? 'moved'
      : paidAmount > 0 && remainingAmount > 0
        ? 'partial'
        : paidAmount > 0
          ? 'suggested'
          : compareIsoDate(invoice.dueDate, startDate) < 0
            ? 'overdue'
            : 'unplanned';

    return {
      providerId: invoice.providerId,
      providerName: invoice.providerName,
      supplierNumber: invoice.supplierNumber,
      invoiceKey: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      invoiceAmount: invoice.amount,
      paidAmount,
      remainingAmount,
      risk: invoice.risk,
      flexibility: invoice.flexibility,
      priorityBlock: invoice.priorityBlock,
      score: invoice.score,
      clasificacionAutomatica: invoice.clasificacionAutomatica,
      status,
      dueDate: invoice.dueDate,
      plannedDate: firstPayment?.date,
      plannedAmount: firstPayment?.payment.amount,
      creditLimit: invoice.creditLimit,
      creditStatus,
      paymentExplanation: firstPayment?.payment.paymentExplanation ?? supplierPaymentExplanation(invoice, 'due', DEFAULT_CREDIT_TARGET_RATIO),
      priorityExplanation: supplierPriorityExplanation(invoice),
    };
  }).sort((a, b) => {
    // Operativos (score ≥ 80) siempre primero
    const aCritico = a.clasificacionAutomatica === 'CRITICO' ? 0 : 1;
    const bCritico = b.clasificacionAutomatica === 'CRITICO' ? 0 : 1;
    if (aCritico !== bCritico) return aCritico - bCritico;
    // Luego por priorityBlock
    if (a.priorityBlock !== b.priorityBlock) return a.priorityBlock - b.priorityBlock;
    // Luego por score (mayor primero)
    const aScore = a.score ?? 0;
    const bScore = b.score ?? 0;
    if (aScore !== bScore) return bScore - aScore;
    const statusDelta = supplierQueueStatusOrder(a.status) - supplierQueueStatusOrder(b.status);
    if (statusDelta !== 0) return statusDelta;
    const dueDelta = (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
    if (dueDelta !== 0) return dueDelta;
    return b.remainingAmount - a.remainingAmount;
  });
}

function creditStatusForInvoice(
  invoice: SupplierInvoice,
  exposure: number,
): OperatingSupplierQueueItem['creditStatus'] {
  if (!invoice.creditLimit || invoice.creditLimit <= 0) return 'none';
  if (exposure > invoice.creditLimit) return 'exceeded';
  if (exposure >= invoice.creditLimit * DEFAULT_CREDIT_TARGET_RATIO) return 'near_limit';
  return 'normal';
}

function supplierQueueStatusOrder(status: OperatingSupplierQueueItem['status']): number {
  switch (status) {
    case 'overdue': return 0;
    case 'moved': return 1;
    case 'partial': return 2;
    case 'unplanned': return 3;
    case 'suggested': return 4;
  }
}

function defaultPayrollSplit(overrides?: Partial<PayrollSplitWeights>): PayrollSplitWeights {
  return {
    weeklyNomina: overrides?.weeklyNomina ?? DEFAULT_PAYROLL_SPLIT.weeklyNomina,
    quincena: overrides?.quincena ?? DEFAULT_PAYROLL_SPLIT.quincena,
    fondoAhorro: overrides?.fondoAhorro ?? DEFAULT_PAYROLL_SPLIT.fondoAhorro,
  };
}

export function defaultOperatingFixedRules(): OperatingFixedRule[] {
  return [
    {
      id: 'navistar',
      label: 'Navistar',
      concept: 'Pasivos Financieros',
      amount: 2_800_000,
      anchorDate: '2026-01-01',
      everyMonths: 1,
    },
    {
      id: 'banorte',
      label: 'Banorte',
      concept: 'Pasivos Financieros',
      amount: 1_700_000,
      anchorDate: '2026-01-20',
      everyMonths: 1,
    },
    {
      id: 'daimler',
      label: 'Daimler',
      concept: 'Pasivos Financieros',
      amount: 500_000,
      anchorDate: '2026-01-20',
      everyMonths: 1,
    },
    {
      id: 'monthly-fee',
      label: 'Fee mensual',
      concept: 'Pasivos Financieros',
      amount: 564_000,
      anchorDate: '2026-01-20',
      everyMonths: 1,
    },
    {
      id: 'concurso-mercantil',
      label: 'Concurso mercantil',
      concept: 'Pasivos Financieros',
      amount: 51_000_000,
      anchorDate: '2026-04-30',
      everyMonths: 3,
    },
  ];
}

export function buildDefaultOperatingProjectionWindow(
  today: string,
  budget?: Budget | null,
): { startDate: string; endDate: string } {
  if (budget) {
    return {
      startDate: today,
      endDate: `${budget.year}-12-31`,
    };
  }
  const start = parseIsoDate(today);
  const end = addDays(start, 364);
  return { startDate: today, endDate: toIsoDate(end) };
}

export function buildOperatingProjection(input: OperatingProjectionInput): OperatingProjectionResult {
  const startDate = input.startDate;
  const endDate = input.endDate;
  const manualEvents = input.manualExpenseEvents ?? [];
  const operatingAdjustments = input.operatingAdjustments ?? [];
  const supplierPaymentOverrides = input.supplierPaymentOverrides ?? [];
  const collectionOverrideMap = buildCollectionOverrideMap(input.collectionOverrides ?? [], startDate, endDate);
  const payrollSplit = defaultPayrollSplit(input.payrollSplit);
  const fixedRules = input.fixedRules ?? defaultOperatingFixedRules();
  const creditTargetRatio = input.creditTargetRatio ?? DEFAULT_CREDIT_TARGET_RATIO;

  const alerts: string[] = [];
  const startingCash = computeStartingCash(input.bankStatements);
  const clientsById = new Map(input.clients.map((client) => [client.id, client]));

  const collections = projectCollectionsForRange(input.clients, input.assumptions, startDate, endDate);
  const collectionsByDate = new Map<string, OperatingFlowLine[]>();
  for (const event of collections) {
    const sourceKey = `collection:${event.clientId}:${event.invoiceDate}:${event.realDate}`;
    const override = collectionOverrideMap.get(sourceKey);
    if (override?.amount === 0) continue;
    const effectiveDate = override?.date ?? event.realDate;
    const effectiveAmount = override ? override.amount : event.amount;
    const client = clientsById.get(event.clientId);
    const bucket = collectionsByDate.get(effectiveDate) ?? [];
    bucket.push({
      id: sourceKey,
      label: client?.name ?? event.clientId,
      amount: effectiveAmount,
      category: 'Cobranza',
      source: 'collections',
      affectsCash: true,
      entityId: event.clientId,
      sourceKey,
      originalDate: event.realDate,
      overrideNote: override?.note,
      detail: client
        ? `${client.frequency}${client.factoraje ? ' · factoraje' : ''}${client.paymentDayRaw ? ` · ${client.paymentDayRaw}` : ''}`
        : 'Cobranza proyectada',
      invoiceDate: event.invoiceDate,
      theoreticalDate: event.theoreticalDate,
      lagDays: event.lagDays,
      confidence: collectionConfidence(client),
    });
    collectionsByDate.set(effectiveDate, bucket);
  }

  const adjustmentByDate = new Map<string, OperatingFlowLine[]>();
  for (const adjustment of operatingAdjustments) {
    const date = toIsoDate(nextBusinessDay(parseIsoDate(adjustment.date)));
    const bucket = adjustmentByDate.get(date) ?? [];
    bucket.push({
      id: adjustment.id ?? `adj:${adjustment.direction}:${date}:${bucket.length}`,
      label: adjustment.label,
      amount: adjustment.direction === 'outflow' ? -Math.abs(adjustment.amount) : Math.abs(adjustment.amount),
      category: adjustment.category ?? 'Ajuste operativo',
      source: 'adjustment',
      affectsCash: adjustment.affectsCash,
    });
    adjustmentByDate.set(date, bucket);
  }

  const futureCashByDate = new Map<string, number>();
  for (const [date, lines] of collectionsByDate) {
    addAmount(futureCashByDate, date, lines.reduce((sum, line) => sum + line.amount, 0));
  }
  for (const [date, lines] of adjustmentByDate) {
    addAmount(
      futureCashByDate,
      date,
      lines
        .filter((line) => line.affectsCash)
        .reduce((sum, line) => sum + line.amount, 0),
    );
  }

  const budgetBuild = buildBudgetExpenses({
    budget: input.budget,
    startDate,
    endDate,
    manualEvents,
    fixedRules,
    payrollSplit,
  });
  alerts.push(...budgetBuild.alerts);
  const scheduledExpenses = applyScheduledOutflowOverrides(
    budgetBuild.expenses,
    input.scheduledOutflowOverrides ?? [],
    startDate,
    endDate,
  ).sort(fixedExpenseSort);

  const invoices = buildInvoices(input.agedBalances, input.providers, startDate);
  const providerExposure = new Map<string, number>();
  for (const invoice of invoices) {
    providerExposure.set(invoice.providerKey, (providerExposure.get(invoice.providerKey) ?? 0) + invoice.amount);
  }

  const invoiceKeys = new Set(invoices.map((invoice) => invoice.id));
  const supplierOverridesByDate = new Map<string, OperatingSupplierPaymentOverride[]>();
  const manualLockedUntil = new Map<string, string>();
  for (const override of supplierPaymentOverrides) {
    if (!invoiceKeys.has(override.invoiceKey)) {
      alerts.push(`Escenario ignora un pago manual porque la factura ya no existe: ${override.invoiceKey}.`);
      continue;
    }
    if (!Number.isFinite(override.amount) || override.amount < 0) continue;
    const date = toIsoDate(nextBusinessDay(parseIsoDate(override.date)));
    if (compareIsoDate(date, startDate) < 0 || compareIsoDate(date, endDate) > 0) continue;

    const normalized = { ...override, date };
    const bucket = supplierOverridesByDate.get(date) ?? [];
    bucket.push(normalized);
    supplierOverridesByDate.set(date, bucket);

    const currentLock = manualLockedUntil.get(override.invoiceKey);
    if (!currentLock || compareIsoDate(date, currentLock) > 0) {
      manualLockedUntil.set(override.invoiceKey, date);
    }
  }

  const scheduledByDate = new Map<string, ScheduledExpense[]>();
  for (const expense of scheduledExpenses) {
    const bucket = scheduledByDate.get(expense.date) ?? [];
    bucket.push(expense);
    scheduledByDate.set(expense.date, bucket);
  }

  const days: OperatingProjectionDay[] = [];
  const pendingScheduled: ScheduledExpense[] = [];
  let runningCash = startingCash;
  let cursor = parseIsoDate(startDate);
  const end = parseIsoDate(endDate);

  while (cursor <= end) {
    const date = toIsoDate(cursor);
    const openingCash = runningCash;
    const cashInflows: OperatingFlowLine[] = [];
    const nonCashFlows: OperatingFlowLine[] = [];
    const scheduledOutflows: OperatingFlowLine[] = [];
    const supplierPayments: OperatingSupplierPayment[] = [];
    const dayAlerts: string[] = [];
    let reserveState = mandatoryReserveSnapshot(date, scheduledExpenses, futureCashByDate, runningCash);

    for (const line of collectionsByDate.get(date) ?? []) {
      cashInflows.push(line);
      runningCash += line.amount;
    }

    for (const line of adjustmentByDate.get(date) ?? []) {
      if (line.affectsCash) {
        if (line.amount >= 0) {
          cashInflows.push(line);
          runningCash += line.amount;
        } else {
          const outflow = { ...line, amount: Math.abs(line.amount) };
          scheduledOutflows.push(outflow);
          runningCash = Math.max(0, runningCash - Math.abs(line.amount));
        }
      } else {
        nonCashFlows.push(line);
      }
    }
    reserveState = mandatoryReserveSnapshot(date, scheduledExpenses, futureCashByDate, runningCash);

    pendingScheduled.push(...(scheduledByDate.get(date) ?? []));
    pendingScheduled.sort(fixedExpenseSort);

    if (isBusinessDay(cursor)) {
      for (const expense of pendingScheduled) {
        if (expense.remaining <= 0) continue;
        if (compareIsoDate(expense.date, date) > 0) continue;
        if (expense.allowPartial) continue;
        const payable = runningCash >= expense.remaining ? expense.remaining : 0;
        if (payable > 0) {
          expense.remaining -= payable;
          runningCash -= payable;
          scheduledOutflows.push({
            id: `paid:${expense.id}:${date}`,
            label: expense.label,
            amount: payable,
            category: expense.concept,
            source: expense.source,
            affectsCash: true,
            sourceKey: expense.sourceKey ?? expense.id,
            originalDate: expense.originalDate ?? expense.date,
            overrideNote: expense.overrideNote,
            detail: `${expense.source === 'fixed' ? 'Regla fija' : expense.source === 'manual' ? 'Manual' : 'Presupuesto'} · programado ${expense.date}`,
          });
        }
      }

      reserveState = mandatoryReserveSnapshot(date, scheduledExpenses, futureCashByDate, runningCash);

      for (const expense of pendingScheduled) {
        if (expense.remaining <= 0) continue;
        if (!expense.allowPartial) continue;
        if (compareIsoDate(expense.date, date) > 0) continue;
        const freeCash = Math.max(0, runningCash - reserveState.mandatoryReserve);
        const payable = Math.min(expense.remaining, freeCash);
        if (payable > 0) {
          expense.remaining -= payable;
          runningCash -= payable;
          scheduledOutflows.push({
            id: `paid:${expense.id}:${date}`,
            label: expense.label,
            amount: payable,
            category: expense.concept,
            source: expense.source,
            affectsCash: true,
            sourceKey: expense.sourceKey ?? expense.id,
            originalDate: expense.originalDate ?? expense.date,
            overrideNote: expense.overrideNote,
            detail: `${expense.source === 'fixed' ? 'Regla fija' : expense.source === 'manual' ? 'Manual' : 'Presupuesto'} · programado ${expense.date}`,
          });
          reserveState = mandatoryReserveSnapshot(date, scheduledExpenses, futureCashByDate, runningCash);
        }
      }

      const manualSupplierPlan = planManualSupplierPaymentsForDay(
        date,
        invoices,
        providerExposure,
        reserveState.freeCash,
        creditTargetRatio,
        supplierOverridesByDate.get(date) ?? [],
      );
      if (manualSupplierPlan.used > 0) {
        runningCash -= manualSupplierPlan.used;
        supplierPayments.push(...manualSupplierPlan.payments);
        dayAlerts.push(...manualSupplierPlan.alerts);
        reserveState = mandatoryReserveSnapshot(date, scheduledExpenses, futureCashByDate, runningCash);
      }

      const supplierPlan = planSupplierPaymentsForDay(
        date,
        invoices,
        providerExposure,
        reserveState.freeCash,
        creditTargetRatio,
        manualLockedUntil,
      );
      if (supplierPlan.used > 0) {
        runningCash -= supplierPlan.used;
        supplierPayments.push(...supplierPlan.payments);
        reserveState = mandatoryReserveSnapshot(date, scheduledExpenses, futureCashByDate, runningCash);
      }
    }

    reserveState = mandatoryReserveSnapshot(date, scheduledExpenses, futureCashByDate, runningCash);

    const unpaidScheduled = pendingScheduled.filter((expense) => expense.remaining > 0 && compareIsoDate(expense.date, date) <= 0);
    const pendingSuppliers = invoices.filter((invoice) => invoice.remaining > 0);
    const dueSuppliers = pendingSuppliers.filter((invoice) => compareIsoDate(invoice.dueDate, date) <= 0);

    if (unpaidScheduled.length > 0) {
      dayAlerts.push(`${unpaidScheduled.length} obligaciones fijas siguen pendientes.`);
    }
    if (dueSuppliers.length > 0) {
      const criticalDue = dueSuppliers.filter((invoice) => invoice.priorityBlock === 0).length;
      if (criticalDue > 0) dayAlerts.push(`${criticalDue} facturas de riesgo alto e inamovibles siguen abiertas.`);
    }
    if (reserveState.mandatoryReserveShortfall > 0) {
      dayAlerts.push(`Reserva obligatoria incompleta: faltan ${reserveState.mandatoryReserveShortfall.toFixed(2)} para pagos forzosos.`);
    }
    if (runningCash <= 0) {
      dayAlerts.push('Caja operativa agotada; no se permiten pagos adicionales.');
    }

    days.push({
      date,
      openingCash,
      cashInflows,
      nonCashFlows,
      scheduledOutflows,
      supplierPayments,
      mandatoryReserve: reserveState.mandatoryReserve,
      mandatoryReserveRequired: reserveState.mandatoryReserveRequired,
      mandatoryReserveShortfall: reserveState.mandatoryReserveShortfall,
      mandatoryReserveLines: reserveState.mandatoryReserveLines,
      freeCash: reserveState.freeCash,
      closingCash: runningCash,
      unpaidScheduledAmount: unpaidScheduled.reduce((sum, expense) => sum + expense.remaining, 0),
      unpaidScheduledCount: unpaidScheduled.length,
      pendingSupplierAmount: pendingSuppliers.reduce((sum, invoice) => sum + invoice.remaining, 0),
      pendingSupplierCount: pendingSuppliers.length,
      alerts: dayAlerts,
    });

    cursor = addDays(cursor, 1);
  }

  const months = buildMonthRollup(days);
  const supplierQueue = buildSupplierQueue(invoices, days, startDate);
  const lastDay = days.length > 0 ? days[days.length - 1] : null;
  const summary: OperatingProjectionSummary = {
    startingCash,
    endingCash: lastDay ? lastDay.closingCash : startingCash,
    totalCashInflows: days.reduce((sum, day) => sum + day.cashInflows.reduce((acc, line) => acc + line.amount, 0), 0),
    totalScheduledOutflows: days.reduce((sum, day) => sum + day.scheduledOutflows.reduce((acc, line) => acc + line.amount, 0), 0),
    totalSupplierPayments: days.reduce((sum, day) => sum + day.supplierPayments.reduce((acc, line) => acc + line.amount, 0), 0),
    totalNonCashFlows: days.reduce((sum, day) => sum + day.nonCashFlows.reduce((acc, line) => acc + Math.abs(line.amount), 0), 0),
    endingMandatoryReserve: lastDay ? lastDay.mandatoryReserve : 0,
    endingFreeCash: lastDay ? lastDay.freeCash : startingCash,
    peakMandatoryReserve: days.reduce((max, day) => Math.max(max, day.mandatoryReserve), 0),
    peakMandatoryReserveShortfall: days.reduce((max, day) => Math.max(max, day.mandatoryReserveShortfall), 0),
    unpaidScheduledAmount: lastDay ? lastDay.unpaidScheduledAmount : 0,
    unpaidScheduledCount: lastDay ? lastDay.unpaidScheduledCount : 0,
    pendingSupplierAmount: lastDay ? lastDay.pendingSupplierAmount : 0,
    pendingSupplierCount: lastDay ? lastDay.pendingSupplierCount : 0,
  };

  return {
    startDate,
    endDate,
    startingCash,
    days,
    months,
    summary,
    supplierQueue,
    alerts,
  };
}

export function classifyBankMovementConcept(line: Pick<BankStatementLine, 'concepto'>): string {
  const concept = normText(line.concepto);
  if (concept.includes('NOMINA')) return 'Nómina';
  if (concept.includes('DIESEL') || concept.includes('COMBUSTIBLE')) return 'Diésel';
  if (/\bGAS\b/.test(concept)) return 'Gas';
  if (concept.includes('IMPUEST')) return 'Impuestos';
  if (concept.includes('CAPEX')) return 'CAPEX';
  if (concept.includes('NAVISTAR') || concept.includes('BANORTE') || concept.includes('DAIMLER')) return 'Pasivos Financieros';
  return 'Gastos de Operación';
}
