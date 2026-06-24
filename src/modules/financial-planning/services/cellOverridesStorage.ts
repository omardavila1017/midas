import type { CellOverride, CellOverrideMode, FinancialMovementType, ProjectionGranularity } from '../../shared-finance/types';
import { pushPlanningDoc } from './planningRemoteSync';
import { PLANNING_CELL_OVERRIDES_KEY as STORAGE_KEY } from './planningStorageKeys';

export function loadCellOverrides(fallback: CellOverride[] = []): CellOverride[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const normalized = parsed
      .map((value, index) => normalizeCellOverride(value, index))
      .filter((value): value is CellOverride => value !== null);
    return normalized;
  } catch {
    return fallback;
  }
}

export function saveCellOverrides(overrides: CellOverride[]): void {
  try {
    if (overrides.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    /* ignore quota errors */
  }
  pushPlanningDoc('cellOverrides', overrides);
}

export function normalizeCellOverride(value: unknown, index: number): CellOverride | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const scenarioId = readString(raw.scenarioId);
  const conceptKey = readString(raw.conceptKey);
  const bucketKey = readString(raw.bucketKey);
  const granularity = readGranularity(raw.granularity);
  const type = readType(raw.type);
  const numericValue = readFiniteNumber(raw.value);
  if (!scenarioId || !conceptKey || !bucketKey || !granularity || !type || numericValue === null) return null;

  const now = new Date().toISOString();
  return {
    id: readString(raw.id) ?? `cell-override-${Date.now()}-${index}`,
    scenarioId,
    conceptKey,
    granularity,
    bucketKey,
    type,
    mode: readMode(raw.mode) ?? 'REPLACE',
    value: Math.max(0, numericValue),
    previousAggregatedValue: readFiniteNumber(raw.previousAggregatedValue) ?? undefined,
    note: readString(raw.note) ?? undefined,
    createdBy: readString(raw.createdBy) ?? 'tesoreria@senda.local',
    createdAt: readString(raw.createdAt) ?? now,
    updatedAt: readString(raw.updatedAt) ?? now,
  };
}

export function buildCellOverrideId(scenarioId: string, conceptKey: string, bucketKey: string, granularity: ProjectionGranularity): string {
  return `co::${scenarioId}::${granularity}::${conceptKey}::${bucketKey}`;
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

function readGranularity(value: unknown): ProjectionGranularity | null {
  return value === 'daily' || value === 'weekly' || value === 'monthly' ? value : null;
}

function readType(value: unknown): FinancialMovementType | null {
  return value === 'INFLOW' || value === 'OUTFLOW' ? value : null;
}

function readMode(value: unknown): CellOverrideMode | null {
  return value === 'REPLACE' || value === 'DELTA' ? value : null;
}
