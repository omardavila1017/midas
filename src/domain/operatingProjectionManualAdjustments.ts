import type { OperatingAdjustment } from './operatingProjectionModule';

const STORAGE_KEY = 'midas.operating.manualAdjustments.v1';

export function loadOperatingAdjustments(): OperatingAdjustment[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value, index) => normalizeOperatingAdjustment(value, index))
      .filter((value): value is OperatingAdjustment => value !== null)
      .sort(sortOperatingAdjustment);
  } catch {
    return [];
  }
}

export function saveOperatingAdjustments(adjustments: OperatingAdjustment[]): void {
  try {
    if (adjustments.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(adjustments));
  } catch {
    // quota o serialization — ignoramos, la app sigue viva.
  }
}

export function sortOperatingAdjustment(a: OperatingAdjustment, b: OperatingAdjustment): number {
  const dateDelta = a.date.localeCompare(b.date);
  if (dateDelta !== 0) return dateDelta;
  const directionDelta = a.direction.localeCompare(b.direction);
  if (directionDelta !== 0) return directionDelta;
  return a.label.localeCompare(b.label);
}

function normalizeOperatingAdjustment(value: unknown, index: number): OperatingAdjustment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;

  const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)
    ? raw.date
    : null;
  if (!date) return null;

  const direction = raw.direction === 'inflow' || raw.direction === 'outflow'
    ? raw.direction
    : null;
  if (!direction) return null;

  const amount = typeof raw.amount === 'number'
    ? raw.amount
    : typeof raw.amount === 'string'
      ? Number(raw.amount)
      : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const label = typeof raw.label === 'string' && raw.label.trim().length > 0
    ? raw.label.trim()
    : null;
  if (!label) return null;

  const id = typeof raw.id === 'string' && raw.id.trim().length > 0
    ? raw.id.trim()
    : `operating-adjustment-${index}-${date}`;

  return {
    id,
    date,
    label,
    amount,
    direction,
    affectsCash: raw.affectsCash !== false,
    category: typeof raw.category === 'string' && raw.category.trim().length > 0
      ? raw.category.trim()
      : direction === 'inflow' ? 'Entrada manual' : 'Salida manual',
  };
}
