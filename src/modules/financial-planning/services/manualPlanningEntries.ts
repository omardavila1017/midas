import type {
  FinancialMovement,
  FinancialMovementCategory,
  FinancialTaxTreatment,
  ManualPlanningCategory,
  ManualPlanningEntry,
  ManualPlanningRecurrence,
} from '../../shared-finance/types';
import { calculateConfidenceBand } from '../../shared-finance/calculation-engine/financialProjectionEngine';
import { pushPlanningDoc } from './planningRemoteSync';
import { PLANNING_MANUAL_ENTRIES_KEY as STORAGE_KEY } from './planningStorageKeys';

export interface ManualPlanningEntryInput {
  scenarioIds: string[];
  type: ManualPlanningEntry['type'];
  category: ManualPlanningCategory;
  name: string;
  amount: number;
  startDate: string;
  endDate?: string;
  recurrence: ManualPlanningRecurrence;
  companyId?: string;
  businessUnitId?: string;
  counterpartyName?: string;
  description?: string;
  taxTreatment?: FinancialTaxTreatment;
  taxRate?: ManualPlanningEntry['taxRate'];
  taxBaseAmount?: number;
  taxAmount?: number;
  status?: ManualPlanningEntry['status'];
  createdBy?: string;
}

export interface ExpandManualPlanningEntriesOptions {
  scenarioId: string;
  startDate: string;
  endDate: string;
  asOfDate: string;
}

export const MANUAL_PLANNING_CATEGORY_LABELS: Record<ManualPlanningCategory, string> = {
  MANUAL_INFLOW: 'Ingreso manual',
  MANUAL_OUTFLOW: 'Pago manual',
  SUPPLIER_PAYMENT: 'Proveedor',
  TAX_PAYMENT: 'Impuesto',
  PAYROLL: 'Nómina',
  CAPEX: 'CAPEX',
  OPEX: 'OPEX',
  OTHER: 'Otro',
};

export const MANUAL_PLANNING_RECURRENCE_LABELS: Record<ManualPlanningRecurrence, string> = {
  ONE_TIME: 'Una vez',
  WEEKLY: 'Semanal',
  BIWEEKLY: 'Quincenal',
  MONTHLY: 'Mensual',
  QUARTERLY: 'Trimestral',
};

export function createManualPlanningEntry(input: ManualPlanningEntryInput): ManualPlanningEntry {
  if (!input.name.trim()) throw new Error('El nombre es obligatorio.');
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('El monto debe ser mayor a cero.');
  if (!isIsoDate(input.startDate)) throw new Error('La fecha inicial no es válida.');
  if (input.endDate && (!isIsoDate(input.endDate) || input.endDate < input.startDate)) {
    throw new Error('La fecha final debe ser igual o posterior a la inicial.');
  }
  const now = new Date().toISOString();
  return {
    id: `manual-entry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scenarioIds: input.scenarioIds.length > 0 ? input.scenarioIds : ['custom'],
    type: input.type,
    category: input.category,
    name: input.name.trim(),
    amount: Math.abs(input.amount),
    startDate: input.startDate,
    endDate: input.endDate,
    recurrence: input.recurrence,
    companyId: input.companyId?.trim() || undefined,
    businessUnitId: input.businessUnitId?.trim() || undefined,
    counterpartyName: input.counterpartyName?.trim() || undefined,
    description: input.description?.trim() || undefined,
    taxTreatment: input.taxTreatment ?? defaultTaxTreatment(input.type, input.category),
    taxRate: input.taxRate,
    taxBaseAmount: input.taxBaseAmount,
    taxAmount: input.taxAmount,
    status: input.status ?? 'DRAFT',
    createdBy: input.createdBy ?? 'tesoreria@senda.local',
    createdAt: now,
    updatedAt: now,
  };
}

export function loadManualPlanningEntries(fallback: ManualPlanningEntry[] = []): ManualPlanningEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const normalized = parsed
      .map((value, index) => normalizeManualPlanningEntry(value, index))
      .filter((value): value is ManualPlanningEntry => value !== null);
    return normalized.length > 0 ? normalized : fallback;
  } catch {
    return fallback;
  }
}

export function saveManualPlanningEntries(entries: ManualPlanningEntry[]): void {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
  } catch {
    /* localStorage quota errors do not affect the projection engine. */
  }
  pushPlanningDoc('manualEntries', entries);
}

export function expandManualPlanningEntriesToMovements(
  entries: ManualPlanningEntry[],
  options: ExpandManualPlanningEntriesOptions,
): FinancialMovement[] {
  return entries
    .filter((entry) => entry.scenarioIds.includes(options.scenarioId) && !entry.replacedAt)
    .flatMap((entry) => expandEntry(entry, options));
}

export function countManualEntryOccurrences(
  entry: Pick<ManualPlanningEntry, 'startDate' | 'endDate' | 'recurrence'>,
  rangeEnd: string,
): number {
  return enumerateDates(entry.startDate, entry.endDate ?? rangeEnd, entry.recurrence, entry.startDate, rangeEnd).length;
}

function expandEntry(
  entry: ManualPlanningEntry,
  options: ExpandManualPlanningEntriesOptions,
): FinancialMovement[] {
  const dates = enumerateDates(
    entry.startDate,
    entry.endDate ?? options.endDate,
    entry.recurrence,
    options.startDate,
    options.endDate,
  );
  const score = entry.status === 'APPROVED' ? 78 : 58;
  return dates.map((date, index) => ({
    id: `manual-entry:${entry.id}:${date}:${index + 1}`,
    sourceSystem: 'MANUAL',
    sourceObjectId: entry.id,
    type: entry.type,
    category: movementCategory(entry),
    counterpartyName: entry.counterpartyName,
    counterpartyType: counterpartyType(entry),
    companyId: entry.companyId,
    businessUnitId: entry.businessUnitId,
    concept: occurrenceConcept(entry, index, dates.length),
    currency: 'MXN',
    originalAmount: entry.amount,
    baseAmount: entry.amount,
    projectedAmount: entry.amount,
    adjustedAmount: entry.amount,
    issueDate: entry.startDate,
    dueDate: date,
    projectedDate: date,
    adjustedDate: date,
    confidenceScore: score,
    confidenceBand: calculateConfidenceBand(score),
    forecastMethod: 'MANUAL',
    ruleApplied: `Alta manual · ${MANUAL_PLANNING_RECURRENCE_LABELS[entry.recurrence]}`,
    taxTreatment: entry.taxTreatment,
    taxRate: entry.taxRate,
    taxBaseAmount: entry.taxBaseAmount,
    taxAmount: entry.taxAmount,
    status: entry.status === 'APPROVED' ? 'APPROVED' : 'ADJUSTED',
    lockState: entry.category === 'TAX_PAYMENT' ? 'RESTRICTED' : 'UNLOCKED',
    comments: [
      entry.description,
      `Escenario manual: ${entry.status === 'APPROVED' ? 'aprobado' : 'propuesta'}`,
    ].filter((value): value is string => Boolean(value)),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }));
}

function enumerateDates(
  startDate: string,
  endDate: string,
  recurrence: ManualPlanningRecurrence,
  rangeStart: string,
  rangeEnd: string,
): string[] {
  if (!isIsoDate(startDate) || !isIsoDate(endDate)) return [];
  const out: string[] = [];
  const anchor = parseIsoDate(startDate);
  let cursor = anchor;
  const limit = parseIsoDate(endDate < rangeEnd ? endDate : rangeEnd);
  const min = parseIsoDate(rangeStart);

  // Cada ocurrencia se calcula desde la fecha de INICIO, no desde la anterior.
  // Encadenar `cursor = next(cursor)` hace que el día se pierda para siempre en
  // cuanto un mes corto lo trunca: una entrada mensual del 31-ene daba
  // 31-ene · 28-feb · 28-mar · 28-abr… (o, con `addMonths` clamping, 31-ene ·
  // 28-feb · 28-mar), cuando lo correcto es volver al 31 en los meses que lo
  // tienen. Anclando al inicio, el truncamiento es local al mes corto.
  let step = 0;
  while (cursor <= limit && out.length < 260) {
    const iso = toIsoDate(cursor);
    if (cursor >= min && iso >= rangeStart && iso <= rangeEnd) out.push(iso);
    if (recurrence === 'ONE_TIME') break;
    step += 1;
    cursor = occurrenceAt(anchor, recurrence, step);
  }
  return out;
}

/** Ocurrencia número `step` contada desde `anchor` (nunca desde la anterior). */
function occurrenceAt(anchor: Date, recurrence: ManualPlanningRecurrence, step: number): Date {
  if (recurrence === 'WEEKLY') return addDays(anchor, 7 * step);
  if (recurrence === 'BIWEEKLY') return addDays(anchor, 14 * step);
  if (recurrence === 'MONTHLY') return addMonthsKeepingDay(anchor, step);
  if (recurrence === 'QUARTERLY') return addMonthsKeepingDay(anchor, 3 * step);
  return addDays(anchor, 9999);
}

function movementCategory(entry: ManualPlanningEntry): FinancialMovementCategory {
  if (entry.category === 'SUPPLIER_PAYMENT') return 'AP_PAYMENT';
  if (entry.category === 'TAX_PAYMENT') return 'TAX';
  if (entry.category === 'PAYROLL' || entry.category === 'CAPEX' || entry.category === 'OPEX') return entry.category;
  return 'MANUAL';
}

function counterpartyType(entry: ManualPlanningEntry): FinancialMovement['counterpartyType'] {
  if (entry.category === 'SUPPLIER_PAYMENT') return 'SUPPLIER';
  if (entry.category === 'TAX_PAYMENT') return 'TAX_AUTHORITY';
  if (entry.category === 'PAYROLL') return 'EMPLOYEE';
  if (entry.category === 'CAPEX' || entry.category === 'OPEX') return 'SUPPLIER';
  if (entry.type === 'INFLOW') return 'CUSTOMER';
  return 'INTERNAL';
}

function occurrenceConcept(entry: ManualPlanningEntry, index: number, total: number): string {
  if (total <= 1) return entry.name;
  return `${entry.name} (${index + 1}/${total})`;
}

function defaultTaxTreatment(
  type: ManualPlanningEntry['type'],
  category: ManualPlanningCategory,
): FinancialTaxTreatment {
  if (category === 'TAX_PAYMENT') return 'IVA_EXEMPT';
  if (category === 'PAYROLL') return 'IVA_EXEMPT';
  if (category === 'SUPPLIER_PAYMENT' || category === 'CAPEX' || category === 'OPEX') return 'IVA_CREDITABLE';
  if (type === 'INFLOW') return 'IVA_CAUSED';
  return 'UNCLASSIFIED';
}

function normalizeManualPlanningEntry(value: unknown, index: number): ManualPlanningEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const type = raw.type === 'INFLOW' || raw.type === 'OUTFLOW' ? raw.type : null;
  const category = normalizeCategory(raw.category);
  const recurrence = normalizeRecurrence(raw.recurrence);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
  const amount = readAmount(raw.amount);
  const startDate = typeof raw.startDate === 'string' && isIsoDate(raw.startDate) ? raw.startDate : null;
  const endDate = typeof raw.endDate === 'string' && isIsoDate(raw.endDate) ? raw.endDate : undefined;
  if (!type || !category || !recurrence || !name || !startDate || !Number.isFinite(amount) || amount <= 0) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `manual-entry-${index}`,
    scenarioIds: Array.isArray(raw.scenarioIds)
      ? raw.scenarioIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : ['custom'],
    type,
    category,
    name,
    amount: Math.abs(amount),
    startDate,
    endDate: endDate && endDate >= startDate ? endDate : undefined,
    recurrence,
    companyId: typeof raw.companyId === 'string' && raw.companyId.trim() ? raw.companyId.trim() : undefined,
    businessUnitId: typeof raw.businessUnitId === 'string' && raw.businessUnitId.trim() ? raw.businessUnitId.trim() : undefined,
    counterpartyName: typeof raw.counterpartyName === 'string' && raw.counterpartyName.trim()
      ? raw.counterpartyName.trim()
      : undefined,
    description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : undefined,
    taxTreatment: normalizeTaxTreatment(raw.taxTreatment) ?? defaultTaxTreatment(type, category),
    taxRate: normalizeTaxRate(raw.taxRate),
    taxBaseAmount: finiteOptional(raw.taxBaseAmount),
    taxAmount: finiteOptional(raw.taxAmount),
    status: raw.status === 'APPROVED' ? 'APPROVED' : 'DRAFT',
    replacedBySourceSystem: normalizeSourceSystem(raw.replacedBySourceSystem),
    replacedBySourceObjectId: typeof raw.replacedBySourceObjectId === 'string' && raw.replacedBySourceObjectId.trim()
      ? raw.replacedBySourceObjectId.trim()
      : undefined,
    replacedAt: typeof raw.replacedAt === 'string' && raw.replacedAt.trim() ? raw.replacedAt.trim() : undefined,
    replacementNote: typeof raw.replacementNote === 'string' && raw.replacementNote.trim() ? raw.replacementNote.trim() : undefined,
    createdBy: typeof raw.createdBy === 'string' && raw.createdBy.trim() ? raw.createdBy.trim() : 'tesoreria@senda.local',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

function normalizeCategory(value: unknown): ManualPlanningCategory | null {
  if (
    value === 'MANUAL_INFLOW'
    || value === 'MANUAL_OUTFLOW'
    || value === 'SUPPLIER_PAYMENT'
    || value === 'TAX_PAYMENT'
    || value === 'PAYROLL'
    || value === 'CAPEX'
    || value === 'OPEX'
    || value === 'OTHER'
  ) return value;
  return null;
}

function normalizeSourceSystem(value: unknown): ManualPlanningEntry['replacedBySourceSystem'] {
  if (
    value === 'JDE'
    || value === 'BANK'
    || value === 'EXCEL'
    || value === 'MANUAL'
    || value === 'FORECAST'
    || value === 'PAYROLL'
    || value === 'TAX'
  ) return value;
  return undefined;
}

function normalizeRecurrence(value: unknown): ManualPlanningRecurrence | null {
  if (
    value === 'ONE_TIME'
    || value === 'WEEKLY'
    || value === 'BIWEEKLY'
    || value === 'MONTHLY'
    || value === 'QUARTERLY'
  ) return value;
  return null;
}

function normalizeTaxTreatment(value: unknown): FinancialTaxTreatment | null {
  if (value === 'TAXABLE_IVA') return 'IVA_CAUSED';
  if (
    value === 'IVA_CAUSED'
    || value === 'IVA_CREDITABLE'
    || value === 'IVA_EXEMPT'
    || value === 'UNCLASSIFIED'
  ) return value;
  return null;
}

function normalizeTaxRate(value: unknown): ManualPlanningEntry['taxRate'] {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return n === 0 || n === 8 || n === 16 ? n : undefined;
}

function finiteOptional(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function readAmount(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseIsoDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function toIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonthsKeepingDay(value: Date, months: number): Date {
  const next = new Date(value.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}
