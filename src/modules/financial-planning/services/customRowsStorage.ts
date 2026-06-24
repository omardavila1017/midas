import type { FinancialMovementCategory, FinancialMovementType, PlanningCustomRow } from '../../shared-finance/types';
import { pushPlanningDoc } from './planningRemoteSync';
import { PLANNING_CUSTOM_ROWS_KEY as STORAGE_KEY } from './planningStorageKeys';

const VALID_CATEGORIES: FinancialMovementCategory[] = [
  'AR_COLLECTION',
  'AP_PAYMENT',
  'PAYROLL',
  'TAX',
  'DEBT',
  'CAPEX',
  'OPEX',
  'TRANSFER',
  'MANUAL',
];

export function loadCustomRows(fallback: PlanningCustomRow[] = []): PlanningCustomRow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const normalized = parsed
      .map((value, index) => normalizeCustomRow(value, index))
      .filter((value): value is PlanningCustomRow => value !== null);
    return normalized;
  } catch {
    return fallback;
  }
}

export function saveCustomRows(rows: PlanningCustomRow[]): void {
  try {
    if (rows.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
    }
  } catch {
    /* ignore quota errors */
  }
  pushPlanningDoc('customRows', rows);
}

export function normalizeCustomRow(value: unknown, index: number): PlanningCustomRow | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const scenarioId = readString(raw.scenarioId);
  const label = readString(raw.label);
  const type = raw.type === 'INFLOW' || raw.type === 'OUTFLOW' ? (raw.type as FinancialMovementType) : null;
  const category = VALID_CATEGORIES.includes(raw.category as FinancialMovementCategory)
    ? (raw.category as FinancialMovementCategory)
    : null;
  if (!scenarioId || !label || !type || !category) return null;

  const id = readString(raw.id) ?? `custom-row-${Date.now()}-${index}`;
  const conceptKey = readString(raw.conceptKey) ?? buildCustomConceptKey(type, label, id);
  const now = new Date().toISOString();
  return {
    id,
    scenarioId,
    conceptKey,
    label,
    type,
    category,
    note: readString(raw.note) ?? undefined,
    createdBy: readString(raw.createdBy) ?? 'tesoreria@senda.local',
    createdAt: readString(raw.createdAt) ?? now,
    updatedAt: readString(raw.updatedAt) ?? now,
  };
}

export function buildCustomConceptKey(type: FinancialMovementType, label: string, idTail: string): string {
  return `custom:${type}:${slug(label)}:${idTail.slice(-6)}`;
}

export function slug(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'general';
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
