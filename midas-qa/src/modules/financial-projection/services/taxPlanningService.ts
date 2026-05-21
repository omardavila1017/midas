import type { ForecastRun, FinancialMovement, FinancialTaxTreatment } from '../../shared-finance/types';
import { effectiveAmount, effectiveMovementDate } from '../../shared-finance/calculation-engine/financialProjectionEngine';

const STORAGE_KEY = 'midas.financialProjection.taxAdjustments.v1';
const IVA_RATE = 0.16;

export type TaxAdjustmentKind = 'IVA_CAUSED' | 'IVA_CREDITABLE' | 'IVA_PAID' | 'IVA_PAYABLE';

export interface TaxAdjustmentEntry {
  id: string;
  period: string;
  kind: TaxAdjustmentKind;
  amount: number;
  note?: string;
  createdAt: string;
}

export interface TaxPeriodRow {
  period: string;
  dueDate: string;
  taxableInflows: number;
  creditableOutflows: number;
  unclassifiedInflows: number;
  unclassifiedOutflows: number;
  ivaCaused: number;
  ivaCreditable: number;
  ivaPaid: number;
  manualPayable: number;
  netIva: number;
  payable: number;
  balanceInFavor: number;
  suggestedDate?: string;
  suggestedReason?: string;
}

export function createTaxAdjustmentEntry(input: {
  period: string;
  kind: TaxAdjustmentKind;
  amount: number;
  note?: string;
}): TaxAdjustmentEntry {
  if (!/^\d{4}-\d{2}$/.test(input.period)) throw new Error('Periodo fiscal inválido.');
  if (!Number.isFinite(input.amount) || input.amount < 0) throw new Error('Monto fiscal inválido.');
  return {
    id: `tax-adjustment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    period: input.period,
    kind: input.kind,
    amount: input.amount,
    note: input.note?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
}

export function loadTaxAdjustmentEntries(fallback: TaxAdjustmentEntry[] = []): TaxAdjustmentEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const valid = parsed
      .map((value, index) => normalizeTaxAdjustment(value, index))
      .filter((value): value is TaxAdjustmentEntry => value !== null);
    return valid.length > 0 ? valid : fallback;
  } catch {
    return fallback;
  }
}

export function saveTaxAdjustmentEntries(entries: TaxAdjustmentEntry[]): void {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* ignore localStorage quota errors */
  }
}

export function buildTaxPeriodRows(
  projection: ForecastRun,
  adjustments: TaxAdjustmentEntry[],
): TaxPeriodRow[] {
  const byPeriod = new Map<string, TaxPeriodRow>();
  for (const movement of projection.movements) {
    const date = effectiveMovementDate(movement);
    if (date < projection.startDate || date > projection.endDate) continue;
    const period = date.slice(0, 7);
    const row = ensureRow(byPeriod, period);
    const amount = effectiveAmount(movement);
    const treatment = inferTaxTreatment(movement);

    if (movement.category === 'TAX' && movement.type === 'OUTFLOW') {
      row.ivaPaid += amount;
      continue;
    }
    if (movement.type === 'INFLOW' && treatment === 'IVA_CAUSED') row.taxableInflows += amount;
    else if (movement.type === 'OUTFLOW' && treatment === 'IVA_CREDITABLE') row.creditableOutflows += amount;
    else if (movement.type === 'INFLOW' && treatment === 'UNCLASSIFIED') row.unclassifiedInflows += amount;
    else if (movement.type === 'OUTFLOW' && treatment === 'UNCLASSIFIED') row.unclassifiedOutflows += amount;
  }

  for (const adjustment of adjustments) {
    const row = ensureRow(byPeriod, adjustment.period);
    if (adjustment.kind === 'IVA_CAUSED') row.ivaCaused += adjustment.amount;
    if (adjustment.kind === 'IVA_CREDITABLE') row.ivaCreditable += adjustment.amount;
    if (adjustment.kind === 'IVA_PAID') row.ivaPaid += adjustment.amount;
    if (adjustment.kind === 'IVA_PAYABLE') row.manualPayable += adjustment.amount;
  }

  const rows = Array.from(byPeriod.values())
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((row) => finalizeRow(row, projection));
  return rows;
}

export function inferTaxTreatment(movement: FinancialMovement): FinancialTaxTreatment {
  if (movement.taxTreatment) return movement.taxTreatment;
  if (movement.category === 'AR_COLLECTION') return 'IVA_CAUSED';
  if (movement.category === 'AP_PAYMENT' || movement.category === 'OPEX' || movement.category === 'CAPEX') {
    return 'IVA_CREDITABLE';
  }
  if (movement.category === 'PAYROLL' || movement.category === 'DEBT' || movement.category === 'TAX' || movement.category === 'TRANSFER') {
    return 'IVA_EXEMPT';
  }
  return 'UNCLASSIFIED';
}

function ensureRow(map: Map<string, TaxPeriodRow>, period: string): TaxPeriodRow {
  const current = map.get(period);
  if (current) return current;
  const row: TaxPeriodRow = {
    period,
    dueDate: ivaDueDate(period),
    taxableInflows: 0,
    creditableOutflows: 0,
    unclassifiedInflows: 0,
    unclassifiedOutflows: 0,
    ivaCaused: 0,
    ivaCreditable: 0,
    ivaPaid: 0,
    manualPayable: 0,
    netIva: 0,
    payable: 0,
    balanceInFavor: 0,
  };
  map.set(period, row);
  return row;
}

function finalizeRow(row: TaxPeriodRow, projection: ForecastRun): TaxPeriodRow {
  const caused = row.ivaCaused + row.taxableInflows * IVA_RATE;
  const creditable = row.ivaCreditable + row.creditableOutflows * IVA_RATE;
  const netIva = caused - creditable;
  const payableBeforePaid = netIva + row.manualPayable;
  const payable = Math.max(0, payableBeforePaid - row.ivaPaid);
  const balanceInFavor = Math.max(0, row.ivaPaid - payableBeforePaid);
  const suggestion = payable > 0 ? suggestPaymentDate(projection, row.dueDate, payable) : undefined;
  return {
    ...row,
    ivaCaused: caused,
    ivaCreditable: creditable,
    netIva,
    payable,
    balanceInFavor,
    suggestedDate: suggestion?.date,
    suggestedReason: suggestion?.reason,
  };
}

function suggestPaymentDate(
  projection: ForecastRun,
  dueDate: string,
  amount: number,
): { date: string; reason: string } | undefined {
  const dueBucket = projection.buckets.find((bucket) => bucket.date >= dueDate);
  if (dueBucket && dueBucket.closingCash - dueBucket.minimumCash >= amount) {
    return { date: dueDate, reason: 'La caja proyectada cubre el IVA en la fecha objetivo.' };
  }
  const candidate = projection.buckets.find((bucket) =>
    bucket.date >= dueDate && bucket.closingCash - bucket.minimumCash >= amount,
  );
  if (candidate) {
    return { date: candidate.date, reason: 'Primera fecha futura con caja libre suficiente.' };
  }
  const last = projection.buckets[projection.buckets.length - 1];
  if (!last) return undefined;
  return { date: last.date, reason: 'No hay caja suficiente en el horizonte; se sugiere revisar al cierre visible.' };
}

function ivaDueDate(period: string): string {
  const [year, month] = period.split('-').map(Number);
  const next = new Date(Date.UTC(year, month, 17));
  return next.toISOString().slice(0, 10);
}

function normalizeTaxAdjustment(value: unknown, index: number): TaxAdjustmentEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const period = typeof raw.period === 'string' && /^\d{4}-\d{2}$/.test(raw.period) ? raw.period : null;
  const kind = normalizeKind(raw.kind);
  const amount = typeof raw.amount === 'number' ? raw.amount : typeof raw.amount === 'string' ? Number(raw.amount) : NaN;
  if (!period || !kind || !Number.isFinite(amount) || amount < 0) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `tax-adjustment-${index}`,
    period,
    kind,
    amount,
    note: typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

function normalizeKind(value: unknown): TaxAdjustmentKind | null {
  if (
    value === 'IVA_CAUSED'
    || value === 'IVA_CREDITABLE'
    || value === 'IVA_PAID'
    || value === 'IVA_PAYABLE'
  ) return value;
  return null;
}
