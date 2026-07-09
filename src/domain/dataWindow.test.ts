import { describe, it, expect } from 'vitest';
import {
  defaultWindowFloor,
  defaultWindowMonths,
  previousIsoDay,
  isYearWithinFloor,
  yearStartISO,
  yearEndISO,
} from './dataWindow';

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe('defaultWindowFloor', () => {
  it('mid-year: min(year-start, 12 months back) = 12 months back', () => {
    // 2026-07-09 → min(2026-01-01, 2025-07-01) = 2025-07-01
    expect(defaultWindowFloor(at('2026-07-09'))).toBe('2025-07-01');
  });

  it('late-year: 12 months back is still older than year-start', () => {
    // 2026-12-15 → min(2026-01-01, 2025-12-01) = 2025-12-01
    expect(defaultWindowFloor(at('2026-12-15'))).toBe('2025-12-01');
  });

  it('january: 12 months back = previous January (== year-start floor)', () => {
    // 2026-01-20 → min(2026-01-01, 2025-01-01) = 2025-01-01
    expect(defaultWindowFloor(at('2026-01-20'))).toBe('2025-01-01');
  });

  it('always includes all of the current calendar year', () => {
    for (const month of ['02', '05', '08', '11']) {
      const floor = defaultWindowFloor(at(`2026-${month}-10`));
      expect(floor <= '2026-01-01').toBe(true);
    }
  });

  it('always covers at least 12 months back from the current month', () => {
    const floor = defaultWindowFloor(at('2026-07-09'));
    // The month 12 months back (2025-07) must be included.
    expect(floor <= '2025-07-01').toBe(true);
  });
});

describe('defaultWindowMonths', () => {
  it('mid-year counts 13 inclusive months (2025-07..2026-07)', () => {
    expect(defaultWindowMonths(at('2026-07-09'))).toBe(13);
  });

  it('january counts 13 inclusive months (2025-01..2026-01)', () => {
    expect(defaultWindowMonths(at('2026-01-20'))).toBe(13);
  });

  it('december counts 13 inclusive months (2025-12..2026-12)', () => {
    expect(defaultWindowMonths(at('2026-12-15'))).toBe(13);
  });
});

describe('previousIsoDay', () => {
  it('subtracts one calendar day', () => {
    expect(previousIsoDay('2025-07-01')).toBe('2025-06-30');
    expect(previousIsoDay('2026-01-01')).toBe('2025-12-31');
    expect(previousIsoDay('2026-03-01')).toBe('2026-02-28');
  });
});

describe('isYearWithinFloor', () => {
  it('year at/after the floor year is covered', () => {
    expect(isYearWithinFloor(2026, '2025-07-01')).toBe(true);
    expect(isYearWithinFloor(2027, '2025-07-01')).toBe(true);
  });

  it('a year whose January precedes the floor is NOT covered', () => {
    // 2025-01-01 < 2025-07-01 → the pre-floor half of 2025 needs backfill
    expect(isYearWithinFloor(2025, '2025-07-01')).toBe(false);
    expect(isYearWithinFloor(2024, '2025-07-01')).toBe(false);
  });
});

describe('yearStartISO / yearEndISO', () => {
  it('formats calendar-year bounds', () => {
    expect(yearStartISO(2024)).toBe('2024-01-01');
    expect(yearEndISO(2024)).toBe('2024-12-31');
  });
});
