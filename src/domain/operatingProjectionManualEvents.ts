import type { ManualExpenseEvent } from './operatingProjectionModule';

const STORAGE_KEY = 'midas.operating.manualExpenseEvents.v1';

export const OPERATING_MANUAL_EVENT_CONCEPTS = [
  'Impuestos',
  'Finiquitos',
  'CAPEX',
  'Pasivos Financieros',
] as const;

type OperatingManualEventConcept = typeof OPERATING_MANUAL_EVENT_CONCEPTS[number];

const CONCEPT_BY_NORMALIZED = new Map<string, OperatingManualEventConcept>(
  OPERATING_MANUAL_EVENT_CONCEPTS.map(concept => [normalizeConcept(concept), concept]),
);

export function loadOperatingManualExpenseEvents(): ManualExpenseEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value, index) => normalizeManualExpenseEvent(value, index))
      .filter((value): value is ManualExpenseEvent => value !== null)
      .sort(sortManualExpenseEvent);
  } catch {
    return [];
  }
}

export function saveOperatingManualExpenseEvents(events: ManualExpenseEvent[]): void {
  try {
    if (events.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // quota o serialization — ignoramos, la app sigue viva.
  }
}

export function sortManualExpenseEvent(a: ManualExpenseEvent, b: ManualExpenseEvent): number {
  const dateDelta = a.date.localeCompare(b.date);
  if (dateDelta !== 0) return dateDelta;
  const conceptDelta = a.concept.localeCompare(b.concept);
  if (conceptDelta !== 0) return conceptDelta;
  return (a.label ?? '').localeCompare(b.label ?? '');
}

function normalizeManualExpenseEvent(
  value: unknown,
  index: number,
): ManualExpenseEvent | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const concept = canonicalConcept(raw.concept);
  if (!concept) return null;

  const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date)
    ? raw.date
    : null;
  if (!date) return null;

  const amount = typeof raw.amount === 'number'
    ? raw.amount
    : typeof raw.amount === 'string'
      ? Number(raw.amount)
      : NaN;
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (amount === 0 && concept !== 'Impuestos') return null;

  const id = typeof raw.id === 'string' && raw.id.trim().length > 0
    ? raw.id.trim()
    : `manual-expense-${index}-${date}`;

  return {
    id,
    concept,
    date,
    amount,
    label: typeof raw.label === 'string' && raw.label.trim().length > 0 ? raw.label.trim() : undefined,
    allowPartial: Boolean(raw.allowPartial),
  };
}

function canonicalConcept(value: unknown): OperatingManualEventConcept | null {
  if (typeof value !== 'string') return null;
  return CONCEPT_BY_NORMALIZED.get(normalizeConcept(value)) ?? null;
}

function normalizeConcept(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}
