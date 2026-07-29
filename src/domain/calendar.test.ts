import { describe, expect, it } from 'vitest';
import type { PaymentDayPattern } from './types';
import {
  MAX_SCAN_DAYS,
  advanceOneCycle,
  eventsPerMonth,
  isoWeek,
  resolveRealPaymentDate,
  toISODate,
} from './calendar';

/** UTC calendar date builder (month is 1-based for readability). */
function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function resolveIso(theoretical: Date, pattern: PaymentDayPattern): string {
  return toISODate(resolveRealPaymentDate(theoretical, pattern, 'Mensual'));
}

describe('resolveRealPaymentDate', () => {
  it('ANY on a business day stays on the theoretical date', () => {
    // 2026-01-14 is a Wednesday.
    expect(resolveIso(utc(2026, 1, 14), { kind: 'ANY' })).toBe('2026-01-14');
  });

  it('ANY on a weekend shifts forward to the next business day', () => {
    // Sat 2026-01-10 → Mon 2026-01-12.
    expect(resolveIso(utc(2026, 1, 10), { kind: 'ANY' })).toBe('2026-01-12');
    // Sun 2026-01-11 → Mon 2026-01-12.
    expect(resolveIso(utc(2026, 1, 11), { kind: 'ANY' })).toBe('2026-01-12');
  });

  it('DOW: theoretical Saturday jumps to the NEXT cycle day, not next business day', () => {
    // Client pays Fridays. Sat 2026-01-10 → following Friday 2026-01-16.
    expect(resolveIso(utc(2026, 1, 10), { kind: 'DOW', days: [5] })).toBe('2026-01-16');
  });

  it('DOW already on the pattern day stays put', () => {
    // Fri 2026-01-16.
    expect(resolveIso(utc(2026, 1, 16), { kind: 'DOW', days: [5] })).toBe('2026-01-16');
  });

  it('DOW landing on a bank holiday slides to the next business day (Ley de Transparencia)', () => {
    // 2026-05-01 is a Friday AND Día del Trabajo → Mon 2026-05-04.
    expect(resolveIso(utc(2026, 5, 1), { kind: 'DOW', days: [5] })).toBe('2026-05-04');
  });

  it('DOW with multiple days picks whichever comes first', () => {
    // Wed+Thu pattern; Mon 2026-01-12 → Wed 2026-01-14.
    expect(resolveIso(utc(2026, 1, 12), { kind: 'DOW', days: [3, 4] })).toBe('2026-01-14');
  });

  it('DOM past in the current month rolls to the same day NEXT month', () => {
    // Day-16 client, theoretical May 20 → June 16 (a Tuesday).
    expect(resolveIso(utc(2026, 5, 20), { kind: 'DOM', day: 16 })).toBe('2026-06-16');
  });

  it('DOM 29 skips a 28-day February entirely', () => {
    // 2026 is not a leap year: from Feb 1 the next day-29 is Mar 29 (Sunday) → Mon Mar 30.
    expect(resolveIso(utc(2026, 2, 1), { kind: 'DOM', day: 29 })).toBe('2026-03-30');
  });

  it('DOM_LIST picks the nearest upcoming day of the list', () => {
    // Pays on the 10th and 25th; Mar 12 → Mar 25 (Wednesday).
    expect(resolveIso(utc(2026, 3, 12), { kind: 'DOM_LIST', days: [10, 25] })).toBe('2026-03-25');
    // Mar 26 → Apr 10 (Friday).
    expect(resolveIso(utc(2026, 3, 26), { kind: 'DOM_LIST', days: [10, 25] })).toBe('2026-04-10');
  });

  it('NTH_DOW: first Friday already past → first Friday of next month', () => {
    // First Friday of June 2026 is Jun 5; from Jun 10 → first Friday of July = Jul 3.
    expect(resolveIso(utc(2026, 6, 10), { kind: 'NTH_DOW', nth: 1, day: 5 })).toBe('2026-07-03');
  });

  it('NTH_DOW: nth = -1 resolves the LAST weekday occurrence of the month', () => {
    // Last Friday of June 2026 = Jun 26.
    expect(resolveIso(utc(2026, 6, 1), { kind: 'NTH_DOW', nth: -1, day: 5 })).toBe('2026-06-26');
  });

  it('NTH_DOW_SET matches any of the listed ordinals', () => {
    // 2nd + 4th Thursday of June 2026: Jun 11 and Jun 25.
    const pattern: PaymentDayPattern = { kind: 'NTH_DOW_SET', nths: [2, 4], day: 4 };
    expect(resolveIso(utc(2026, 6, 1), pattern)).toBe('2026-06-11');
    expect(resolveIso(utc(2026, 6, 12), pattern)).toBe('2026-06-25');
  });

  it('WOM: week 1 window is days 1-7', () => {
    // From Jun 10 the next week-1 day is Jul 1 (Wednesday).
    expect(resolveIso(utc(2026, 6, 10), { kind: 'WOM', weeks: [1] })).toBe('2026-07-01');
    // Jun 1 (Monday) is already inside week 1.
    expect(resolveIso(utc(2026, 6, 1), { kind: 'WOM', weeks: [1] })).toBe('2026-06-01');
  });

  it('WOM: week -1 is the last 7 days of the month', () => {
    // June 2026 has 30 days → last window starts on the 24th (Wednesday).
    expect(resolveIso(utc(2026, 6, 20), { kind: 'WOM', weeks: [-1] })).toBe('2026-06-24');
  });

  it('falls back to the theoretical date when no match is found within MAX_SCAN_DAYS', () => {
    // Day 32 never exists; the scan gives up and returns the theoretical date
    // untouched (even if it is a Saturday).
    expect(resolveIso(utc(2026, 1, 10), { kind: 'DOM', day: 32 })).toBe('2026-01-10');
  });

  it('normalizes any time-of-day component to a pure UTC date', () => {
    const withTime = new Date(Date.UTC(2026, 0, 14, 17, 45, 12));
    expect(resolveIso(withTime, { kind: 'ANY' })).toBe('2026-01-14');
  });

  it('exports a scan bound wide enough for monthly patterns', () => {
    expect(MAX_SCAN_DAYS).toBeGreaterThanOrEqual(62);
  });
});

describe('eventsPerMonth', () => {
  it('maps each frequency to its conventional event count', () => {
    expect(eventsPerMonth('Semanal')).toBe(4);
    expect(eventsPerMonth('Quincenal')).toBe(2);
    expect(eventsPerMonth('Mensual')).toBe(1);
    expect(eventsPerMonth('Contado')).toBe(1);
  });
});

describe('advanceOneCycle', () => {
  it('advances 7 days for Semanal and 14 for Quincenal', () => {
    expect(toISODate(advanceOneCycle(utc(2026, 1, 10), 'Semanal'))).toBe('2026-01-17');
    expect(toISODate(advanceOneCycle(utc(2026, 1, 10), 'Quincenal'))).toBe('2026-01-24');
  });

  it('advances one calendar month for Mensual and Contado', () => {
    expect(toISODate(advanceOneCycle(utc(2026, 1, 15), 'Mensual'))).toBe('2026-02-15');
    expect(toISODate(advanceOneCycle(utc(2026, 4, 30), 'Contado'))).toBe('2026-05-30');
  });

  it('Mensual from Jan 31 overflows into March (JS setUTCMonth rollover — observed behavior)', () => {
    // Feb 2026 has 28 days, so Jan 31 + 1 month lands on Mar 3.
    expect(toISODate(advanceOneCycle(utc(2026, 1, 31), 'Mensual'))).toBe('2026-03-03');
  });

  it('does not mutate the input date', () => {
    const d = utc(2026, 1, 10);
    advanceOneCycle(d, 'Semanal');
    advanceOneCycle(d, 'Mensual');
    expect(toISODate(d)).toBe('2026-01-10');
  });
});

describe('isoWeek', () => {
  it('Jan 1 2026 (Thursday) is ISO week 1', () => {
    expect(isoWeek(utc(2026, 1, 1))).toBe(1);
  });

  it('Dec 29 2025 (Monday) belongs to ISO week 1 of 2026', () => {
    expect(isoWeek(utc(2025, 12, 29))).toBe(1);
  });

  it('mid-year date resolves correctly', () => {
    // 2026-07-01 is a Wednesday in ISO week 27.
    expect(isoWeek(utc(2026, 7, 1))).toBe(27);
  });

  it('2026 is a 53-week ISO year', () => {
    expect(isoWeek(utc(2026, 12, 31))).toBe(53);
  });
});

describe('toISODate', () => {
  it('formats a UTC date as yyyy-mm-dd', () => {
    expect(toISODate(utc(2026, 3, 5))).toBe('2026-03-05');
  });

  it('drops any time-of-day component', () => {
    expect(toISODate(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)))).toBe('2026-12-31');
  });
});
