import type { ScenarioChangeKind, ScenarioChangeLogEntry } from '../../shared-finance/types';
import { pushPlanningDoc } from './planningRemoteSync';
import { PLANNING_CHANGE_LOG_KEY as STORAGE_KEY } from './planningStorageKeys';

const MAX_ENTRIES_PER_SCENARIO = 500;

const VALID_KINDS: ScenarioChangeKind[] = [
  'ADD_ROW',
  'REMOVE_ROW',
  'RENAME_ROW',
  'EDIT_CELL',
  'CLEAR_CELL',
  'CREATE_DRAFT',
  'DUPLICATE_DRAFT',
  'MERGE_TO_APPROVED',
];

export function loadChangeLog(fallback: ScenarioChangeLogEntry[] = []): ScenarioChangeLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const normalized = parsed
      .map((value, index) => normalizeEntry(value, index))
      .filter((value): value is ScenarioChangeLogEntry => value !== null);
    return normalized;
  } catch {
    return fallback;
  }
}

export function saveChangeLog(entries: ScenarioChangeLogEntry[]): void {
  const trimmed = capPerScenario(entries, MAX_ENTRIES_PER_SCENARIO);
  try {
    if (trimmed.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    }
  } catch {
    /* ignore quota errors */
  }
  // Push the trimmed list so the shared store matches the local mirror.
  pushPlanningDoc('changeLog', trimmed);
}

export function appendChangeLogEntry(
  current: ScenarioChangeLogEntry[],
  entry: ScenarioChangeLogEntry,
): ScenarioChangeLogEntry[] {
  return capPerScenario([entry, ...current], MAX_ENTRIES_PER_SCENARIO);
}

function capPerScenario(entries: ScenarioChangeLogEntry[], cap: number): ScenarioChangeLogEntry[] {
  const counts = new Map<string, number>();
  const out: ScenarioChangeLogEntry[] = [];
  for (const entry of entries) {
    const count = counts.get(entry.scenarioId) ?? 0;
    if (count >= cap) continue;
    counts.set(entry.scenarioId, count + 1);
    out.push(entry);
  }
  return out;
}

function normalizeEntry(value: unknown, index: number): ScenarioChangeLogEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const scenarioId = readString(raw.scenarioId);
  const kind = VALID_KINDS.includes(raw.kind as ScenarioChangeKind) ? (raw.kind as ScenarioChangeKind) : null;
  const autoDescription = readString(raw.autoDescription);
  if (!scenarioId || !kind || !autoDescription) return null;
  return {
    id: readString(raw.id) ?? `change-log-${Date.now()}-${index}`,
    scenarioId,
    kind,
    payload: raw.payload && typeof raw.payload === 'object' ? (raw.payload as Record<string, unknown>) : {},
    autoDescription,
    userNote: readString(raw.userNote) ?? undefined,
    createdBy: readString(raw.createdBy) ?? 'tesoreria@senda.local',
    createdAt: readString(raw.createdAt) ?? new Date().toISOString(),
  };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
