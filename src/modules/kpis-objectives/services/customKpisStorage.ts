import type { CustomKpi, KpiUnit } from '../types';

const STORAGE_KEY = 'midas.kpisObjectives.customKpis.v1';

export function loadCustomKpis(fallback: CustomKpi[] = []): CustomKpi[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const normalized = parsed
      .map((value, index) => normalizeCustomKpi(value, index))
      .filter((value): value is CustomKpi => value !== null);
    return normalized;
  } catch {
    return fallback;
  }
}

export function saveCustomKpis(items: CustomKpi[]): void {
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

function normalizeCustomKpi(value: unknown, index: number): CustomKpi | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const name = readString(raw.name);
  if (!name) return null;
  const unit = readUnit(raw.unit) ?? 'MXN';
  const now = new Date().toISOString();
  return {
    id: readString(raw.id) ?? `custom-kpi-${Date.now()}-${index}`,
    name,
    description: readString(raw.description) ?? undefined,
    unit,
    manualValue: readFiniteNumber(raw.manualValue) ?? undefined,
    manualValueDate: readString(raw.manualValueDate) ?? undefined,
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

function readUnit(value: unknown): KpiUnit | null {
  return value === 'MXN' || value === 'count' || value === 'pct' || value === 'days' || value === 'ratio'
    ? value
    : null;
}
