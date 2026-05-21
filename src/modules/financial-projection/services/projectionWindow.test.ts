import { describe, expect, it } from 'vitest';
import { addUtcDays, projectionWindowFor } from './projectionWindow';

function spanDays(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );
}

// Regression guard for the "mes→semana→día → renderer OOM (Aw Snap code 5)"
// crash: the projection window MUST stay bounded for weekly/daily so the
// bucket count can never explode to ~365-730 × scenarios again.
describe('projectionWindowFor — bounded sub-month window', () => {
  const days = ['2026-01-01', '2026-05-18', '2026-12-31', '2027-02-28'];

  for (const today of days) {
    it(`daily window = month-to-date + 2 months fwd, bounded @ ${today}`, () => {
      const { yearStart, yearEnd } = projectionWindowFor(today, 'daily');
      // Spec: arranca el día 1 del mes actual …
      expect(yearStart).toBe(`${today.slice(0, 7)}-01`);
      // … termina el último día de (mes actual + 2): el día siguiente cae en
      // un mes nuevo, y +3 meses desde el inicio ya es otro mes.
      const endNext = addUtcDays(yearEnd, 1);
      expect(endNext.slice(8, 10)).toBe('01');
      // Bounded: nunca la explosión de ~365-730 que causaba el OOM.
      expect(spanDays(yearStart, yearEnd)).toBeLessThanOrEqual(95);
    });

    it(`weekly window ≤ 190 days (27 weeks) @ ${today}`, () => {
      const { yearStart, yearEnd } = projectionWindowFor(today, 'weekly');
      expect(spanDays(yearStart, yearEnd)).toBeLessThanOrEqual(190);
    });

    it(`monthly = natural year start @ ${today}`, () => {
      const { yearStart, yearEnd } = projectionWindowFor(today, 'monthly');
      expect(yearStart).toBe(`${today.slice(0, 4)}-01-01`);
      // ~24 monthly buckets max — safe; never the daily explosion.
      expect(spanDays(yearStart, yearEnd)).toBeLessThanOrEqual(366 + 364);
    });
  }

  it('addUtcDays is UTC-stable across month/year/leap boundaries', () => {
    expect(addUtcDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addUtcDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addUtcDays('2028-02-28', 1)).toBe('2028-02-29'); // leap
    expect(addUtcDays('2026-05-18', -14)).toBe('2026-05-04');
  });
});
