import type { ProjectionGranularity } from '../../shared-finance/types';

export function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Granularity-aware projection window. Monthly = natural year (Jan 1 →
 * today+364, ~24 monthly buckets — default landing view). Weekly/daily over
 * that full span = ~365-730 buckets × scenarios × full pipeline → renderer
 * OOM on the month→week→day flip ("Aw Snap code 5"). Sub-month views are
 * bound to a near window so bucket count stays small and bounded.
 *
 * Daily spec (producto): el usuario solo ve "lo que lleva el mes actual"
 * (month-to-date, desde el día 1 del mes actual) + "dos meses adelante"
 * (hasta el último día del mes actual+2). No más: la vista día es de caja
 * cercana, no del año. Span máximo ≈ 92 días (mes de 31 + 2 meses de 31) —
 * sigue lejísimos de la explosión de ~365-730 que causaba el OOM.
 *
 * Invariant (regression-guarded by projectionWindow.test.ts): para cualquier
 * `today`, daily span ≤ 95 días y weekly span ≤ 27 semanas.
 */
export function projectionWindowFor(
  today: string,
  granularity: ProjectionGranularity,
): { yearStart: string; yearEnd: string } {
  const y = today.slice(0, 4);
  if (granularity === 'monthly') {
    return { yearStart: `${y}-01-01`, yearEnd: addUtcDays(today, 364) };
  }
  if (granularity === 'weekly') {
    const shift = (days: number) => addUtcDays(today, days);
    return { yearStart: shift(-42), yearEnd: shift(140) }; // ≈ 26 weekly buckets
  }
  // daily: día 1 del mes actual → último día del mes (actual + 2).
  const monthStart = `${today.slice(0, 7)}-01`;
  const end = new Date(`${monthStart}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 3); // primer día de (mes actual + 3)
  end.setUTCDate(0); // retrocede 1 → último día de (mes actual + 2)
  return { yearStart: monthStart, yearEnd: end.toISOString().slice(0, 10) };
}
