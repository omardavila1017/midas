import type {
  Comparison,
  NumericConcept,
  Objective,
  ObjectiveKind,
  ObjectiveStatus,
} from '../types';

const STORAGE_KEY = 'midas.kpisObjectives.objectives.v1';

export function loadObjectives(fallback: Objective[] = []): Objective[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    return parsed
      .map((value, index) => normalizeObjective(value, index))
      .filter((value): value is Objective => value !== null);
  } catch {
    return fallback;
  }
}

export function saveObjectives(items: Objective[]): void {
  try {
    if (items.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* ignore quota errors */
  }
}

function normalizeObjective(value: unknown, index: number): Objective | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const name = readString(raw.name);
  const kind = readKind(raw.kind);
  if (!name || !kind) return null;

  const now = new Date().toISOString();
  return {
    id: readString(raw.id) ?? `objective-${Date.now()}-${index}`,
    name,
    description: readString(raw.description) ?? undefined,
    kind,
    numericConcept: readConcept(raw.numericConcept) ?? undefined,
    targetYearMonth: readYearMonth(raw.targetYearMonth) ?? undefined,
    targetAmount: readFiniteNumber(raw.targetAmount) ?? undefined,
    comparison: readComparison(raw.comparison) ?? undefined,
    linkedKpiKey: readString(raw.linkedKpiKey) ?? undefined,
    threshold: readFiniteNumber(raw.threshold) ?? undefined,
    dueDate: readString(raw.dueDate) ?? undefined,
    manualStatus: readStatus(raw.manualStatus) ?? undefined,
    notes: readString(raw.notes) ?? undefined,
    createdAt: readString(raw.createdAt) ?? now,
    updatedAt: readString(raw.updatedAt) ?? now,
  };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function readYearMonth(value: unknown): string | null {
  const s = readString(value);
  return s && /^\d{4}-\d{2}$/.test(s) ? s : null;
}

function readKind(value: unknown): ObjectiveKind | null {
  return value === 'NUMERIC_MONTHLY' || value === 'KPI_THRESHOLD' || value === 'QUALITATIVE'
    ? value
    : null;
}

function readConcept(value: unknown): NumericConcept | null {
  return value === 'INFLOW' || value === 'OUTFLOW' || value === 'CASH_CLOSE' ? value : null;
}

function readComparison(value: unknown): Comparison | null {
  return value === 'GTE' || value === 'LTE' || value === 'EQ' ? value : null;
}

function readStatus(value: unknown): ObjectiveStatus | null {
  return value === 'IN_PROGRESS' || value === 'MET' || value === 'MISSED' ? value : null;
}
