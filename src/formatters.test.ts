import { describe, expect, it } from 'vitest';
import {
  fmtDate,
  fmtRelative,
  fmtYearMonthShort,
  fmtYearMonthLong,
  fmtPctInt,
  signClass,
} from './formatters';

describe('formatters', () => {
  describe('fmtDate', () => {
    it('formats a valid date as "D Mmm YYYY"', () => {
      expect(fmtDate(new Date(2026, 3, 20))).toBe('20 Abr 2026');
      expect(fmtDate('2026-04-20T12:00:00')).toBe('20 Abr 2026');
    });

    it('returns "" for malformed/empty date strings instead of "NaN undefined NaN"', () => {
      expect(fmtDate('')).toBe('');
      expect(fmtDate('invalid-date-string')).toBe('');
      expect(fmtDate(new Date('nope'))).toBe('');
    });
  });

  describe('fmtRelative', () => {
    it('degrades to "" for invalid dates (falls through to fmtDate guard)', () => {
      expect(fmtRelative('invalid-date-string')).toBe('');
    });

    it('reports same-day as "Hoy"', () => {
      expect(fmtRelative(new Date())).toBe('Hoy');
    });
  });

  describe('fmtYearMonth*', () => {
    it('formats valid "YYYY-MM"', () => {
      expect(fmtYearMonthShort('2026-08')).toBe('Ago 26');
      expect(fmtYearMonthLong('2026-08')).toBe('Agosto 2026');
    });

    it('returns the raw string for out-of-range or malformed input', () => {
      expect(fmtYearMonthShort('2026-13')).toBe('2026-13');
      expect(fmtYearMonthLong('garbage')).toBe('garbage');
    });
  });

  describe('numeric helpers', () => {
    it('fmtPctInt scales an integer percent', () => {
      expect(fmtPctInt(85)).toBe('85.0%');
    });

    it('signClass classifies sign', () => {
      expect(signClass(5)).toBe('positive');
      expect(signClass(-5)).toBe('negative');
      expect(signClass(0)).toBe('neutral');
    });
  });
});
