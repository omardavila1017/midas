import type { ManualExpenseEvent } from './operatingProjectionModule';

export type OperatingTaxType = 'ISR' | 'IVA' | 'IMSS' | 'ISN' | 'Convenio' | 'Otro';
export type OperatingTaxPriority = 'baja' | 'media' | 'alta' | 'critica';
export type OperatingTaxLegalRisk = 'bajo' | 'medio' | 'alto';

export interface OperatingTaxPlannedPayment {
  id?: string;
  date: string;
  amount: number;
  note?: string;
  suggested?: boolean;
}

export interface OperatingTaxDebt {
  id: string;
  fiscalYear: number;
  taxType: OperatingTaxType;
  label: string;
  originalAmount: number;
  paidAmount: number;
  outstandingAmount: number;
  dueDate: string;
  priority: OperatingTaxPriority;
  legalRisk: OperatingTaxLegalRisk;
  authority?: string;
  fiscalPeriod?: string;
  legalStatus?: string;
  surchargeAmount?: number;
  agreementId?: string;
  comments?: string;
  plannedPayments: OperatingTaxPlannedPayment[];
}

export interface OperatingTaxDebtSummary {
  totalDebt: number;
  total2025: number;
  total2026: number;
  paid: number;
  outstanding: number;
  scheduledThisMonth: number;
  overdue: number;
  unscheduled: number;
}

const TAX_TYPES: OperatingTaxType[] = ['ISR', 'IVA', 'IMSS', 'ISN', 'Convenio', 'Otro'];
const PRIORITIES: OperatingTaxPriority[] = ['baja', 'media', 'alta', 'critica'];
const LEGAL_RISKS: OperatingTaxLegalRisk[] = ['bajo', 'medio', 'alto'];

export function createOperatingTaxDebt(seed: Partial<OperatingTaxDebt> = {}): OperatingTaxDebt {
  const originalAmount = finiteNonNegative(seed.originalAmount);
  const paidAmount = finiteNonNegative(seed.paidAmount);
  const outstandingAmount = seed.outstandingAmount != null
    ? finiteNonNegative(seed.outstandingAmount)
    : Math.max(0, originalAmount - paidAmount);
  return {
    id: seed.id ?? `tax-debt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fiscalYear: normalizeFiscalYear(seed.fiscalYear) ?? new Date().getFullYear(),
    taxType: normalizeTaxType(seed.taxType) ?? 'ISR',
    label: seed.label?.trim() || 'Adeudo fiscal',
    originalAmount,
    paidAmount,
    outstandingAmount,
    dueDate: isIsoDate(seed.dueDate) ? seed.dueDate : new Date().toISOString().slice(0, 10),
    priority: normalizePriority(seed.priority) ?? 'media',
    legalRisk: normalizeLegalRisk(seed.legalRisk) ?? 'medio',
    authority: seed.authority?.trim() || undefined,
    fiscalPeriod: seed.fiscalPeriod?.trim() || undefined,
    legalStatus: seed.legalStatus?.trim() || undefined,
    surchargeAmount: finiteNonNegative(seed.surchargeAmount),
    agreementId: seed.agreementId?.trim() || undefined,
    comments: seed.comments?.trim() || undefined,
    plannedPayments: normalizePlannedPayments(seed.plannedPayments ?? []),
  };
}

export function normalizeOperatingTaxDebt(value: unknown, index = 0): OperatingTaxDebt | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const fiscalYear = normalizeFiscalYear(raw.fiscalYear);
  const taxType = normalizeTaxType(raw.taxType);
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : null;
  const dueDate = typeof raw.dueDate === 'string' && isIsoDate(raw.dueDate) ? raw.dueDate : null;
  if (!fiscalYear || !taxType || !label || !dueDate) return null;

  const originalAmount = readAmount(raw.originalAmount);
  const paidAmount = readAmount(raw.paidAmount);
  const outstandingAmount = raw.outstandingAmount == null
    ? Math.max(0, originalAmount - paidAmount)
    : readAmount(raw.outstandingAmount);
  if (!Number.isFinite(originalAmount) || !Number.isFinite(paidAmount) || !Number.isFinite(outstandingAmount)) return null;

  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim()
    : `tax-debt-${index}-${fiscalYear}`;
  return {
    id,
    fiscalYear,
    taxType,
    label,
    originalAmount: Math.max(0, originalAmount),
    paidAmount: Math.max(0, paidAmount),
    outstandingAmount: Math.max(0, outstandingAmount),
    dueDate,
    priority: normalizePriority(raw.priority) ?? 'media',
    legalRisk: normalizeLegalRisk(raw.legalRisk) ?? 'medio',
    authority: typeof raw.authority === 'string' && raw.authority.trim() ? raw.authority.trim() : undefined,
    fiscalPeriod: typeof raw.fiscalPeriod === 'string' && raw.fiscalPeriod.trim() ? raw.fiscalPeriod.trim() : undefined,
    legalStatus: typeof raw.legalStatus === 'string' && raw.legalStatus.trim() ? raw.legalStatus.trim() : undefined,
    surchargeAmount: finiteNonNegative(raw.surchargeAmount),
    agreementId: typeof raw.agreementId === 'string' && raw.agreementId.trim() ? raw.agreementId.trim() : undefined,
    comments: typeof raw.comments === 'string' && raw.comments.trim() ? raw.comments.trim() : undefined,
    plannedPayments: Array.isArray(raw.plannedPayments)
      ? normalizePlannedPayments(raw.plannedPayments)
      : [],
  };
}

export function taxDebtsToManualExpenseEvents(debts: OperatingTaxDebt[]): ManualExpenseEvent[] {
  return debts.flatMap((debt) => debt.plannedPayments.map((payment, index) => ({
    id: payment.id ?? `tax-payment:${debt.id}:${payment.date}:${index}`,
    concept: 'Impuestos',
    date: payment.date,
    amount: payment.amount,
    label: `${debt.fiscalYear} · ${debt.taxType} · ${debt.label}`,
    allowPartial: true,
  })));
}

export function summarizeOperatingTaxDebts(
  debts: OperatingTaxDebt[],
  selectedMonth: string,
  today: string,
): OperatingTaxDebtSummary {
  return debts.reduce<OperatingTaxDebtSummary>((summary, debt) => {
    const outstanding = effectiveOutstanding(debt);
    const planned = plannedTotal(debt);
    summary.totalDebt += debt.originalAmount + (debt.surchargeAmount ?? 0);
    summary.paid += debt.paidAmount;
    summary.outstanding += outstanding;
    if (debt.fiscalYear === 2025) summary.total2025 += outstanding;
    if (debt.fiscalYear === 2026) summary.total2026 += outstanding;
    if (debt.dueDate < today && outstanding > 0) summary.overdue += outstanding;
    summary.scheduledThisMonth += debt.plannedPayments
      .filter((payment) => payment.date.startsWith(selectedMonth))
      .reduce((sum, payment) => sum + payment.amount, 0);
    summary.unscheduled += Math.max(0, outstanding - planned);
    return summary;
  }, {
    totalDebt: 0,
    total2025: 0,
    total2026: 0,
    paid: 0,
    outstanding: 0,
    scheduledThisMonth: 0,
    overdue: 0,
    unscheduled: 0,
  });
}

export function suggestOperatingTaxDebtPlan(
  debts: OperatingTaxDebt[],
  today: string,
): OperatingTaxDebt[] {
  return debts.map((debt) => ({
    ...debt,
    plannedPayments: buildWeeklyPayments(debt, today),
  }));
}

export function splitOperatingTaxDebtsWeekly(
  debts: OperatingTaxDebt[],
  today: string,
): OperatingTaxDebt[] {
  return suggestOperatingTaxDebtPlan(debts, today);
}

export function liquidateOperatingTaxDebtsByDueDate(debts: OperatingTaxDebt[]): OperatingTaxDebt[] {
  return debts.map((debt) => {
    const amount = effectiveOutstanding(debt);
    return {
      ...debt,
      plannedPayments: amount > 0
        ? [{
          id: `tax-liquidate:${debt.id}:${debt.dueDate}`,
          date: nextBusinessDate(debt.dueDate),
          amount,
          note: 'Liquidar antes de fecha límite',
          suggested: true,
        }]
        : [],
    };
  });
}

export function shiftOperatingTaxDebtPayments(debts: OperatingTaxDebt[], days: number): OperatingTaxDebt[] {
  return debts.map((debt) => ({
    ...debt,
    plannedPayments: debt.plannedPayments.map((payment) => ({
      ...payment,
      date: shiftBusinessDate(payment.date, days),
    })),
  }));
}

export function effectiveOutstanding(debt: OperatingTaxDebt): number {
  return Math.max(0, (debt.outstandingAmount || debt.originalAmount - debt.paidAmount) + (debt.surchargeAmount ?? 0));
}

export function plannedTotal(debt: OperatingTaxDebt): number {
  return debt.plannedPayments.reduce((sum, payment) => sum + payment.amount, 0);
}

function buildWeeklyPayments(debt: OperatingTaxDebt, today: string): OperatingTaxPlannedPayment[] {
  const amount = effectiveOutstanding(debt);
  if (amount <= 0) return [];
  const start = nextBusinessDate(today);
  const due = nextBusinessDate(debt.dueDate);
  const dates = weeklyBusinessDates(start, due);
  const usableDates = dates.length > 0 ? dates : weeklyBusinessDates(start, shiftBusinessDate(start, 77));
  const slice = amount / usableDates.length;
  return usableDates.map((date, index) => ({
    id: `tax-suggested:${debt.id}:${date}:${index}`,
    date,
    amount: index === usableDates.length - 1 ? amount - slice * index : slice,
    note: 'Plan sugerido',
    suggested: true,
  }));
}

function weeklyBusinessDates(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let cursor = startDate;
  while (cursor <= endDate && dates.length < 52) {
    dates.push(nextBusinessDate(cursor));
    cursor = shiftBusinessDate(cursor, 7);
  }
  return Array.from(new Set(dates));
}

function normalizePlannedPayments(values: unknown[]): OperatingTaxPlannedPayment[] {
  return values
    .map((value, index) => normalizePlannedPayment(value, index))
    .filter((value): value is OperatingTaxPlannedPayment => value !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function normalizePlannedPayment(value: unknown, index: number): OperatingTaxPlannedPayment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const date = typeof raw.date === 'string' && isIsoDate(raw.date) ? raw.date : null;
  const amount = readAmount(raw.amount);
  if (!date || !Number.isFinite(amount) || amount < 0) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `tax-payment-${index}-${date}`,
    date,
    amount,
    note: typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined,
    suggested: Boolean(raw.suggested),
  };
}

function normalizeFiscalYear(value: unknown): number | null {
  const year = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null;
}

function normalizeTaxType(value: unknown): OperatingTaxType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return TAX_TYPES.find((type) => type.toUpperCase() === normalized) ?? null;
}

function normalizePriority(value: unknown): OperatingTaxPriority | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeText(value);
  return PRIORITIES.find((priority) => normalizeText(priority) === normalized) ?? null;
}

function normalizeLegalRisk(value: unknown): OperatingTaxLegalRisk | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeText(value);
  return LEGAL_RISKS.find((risk) => normalizeText(risk) === normalized) ?? null;
}

function readAmount(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
}

function finiteNonNegative(value: unknown): number {
  const amount = readAmount(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function nextBusinessDate(date: string): string {
  const cursor = parseDate(date);
  while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return toIsoDate(cursor);
}

function shiftBusinessDate(date: string, days: number): string {
  const cursor = parseDate(date);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return toIsoDate(cursor);
}

function parseDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();
}
