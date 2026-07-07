import { afterEach, describe, expect, it, vi } from 'vitest';
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

    it('renders bare YYYY-MM-DD strings on the stated day (not a day early in UTC-negative zones)', () => {
      // Bare ISO strings parse as UTC midnight; without local-noon anchoring,
      // America/Mexico_City (UTC-6) rendered "16 Jun 2026" for '2026-06-17'.
      expect(fmtDate('2026-06-17')).toBe('17 Jun 2026');
      expect(fmtDate('2026-01-01')).toBe('1 Ene 2026');
      expect(fmtDate('2026-12-31')).toBe('31 Dic 2026');
    });

    it('returns "" for malformed/empty date strings instead of "NaN undefined NaN"', () => {
      expect(fmtDate('')).toBe('');
      expect(fmtDate('invalid-date-string')).toBe('');
      expect(fmtDate(new Date('nope'))).toBe('');
    });
  });

  describe('fmtRelative', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('degrades to "" for invalid dates (falls through to fmtDate guard)', () => {
      expect(fmtRelative('invalid-date-string')).toBe('');
    });

    it('reports same-day as "Hoy"', () => {
      expect(fmtRelative(new Date())).toBe('Hoy');
    });

    it('anchors bare YYYY-MM-DD to local noon like fmtDate ("Hoy", not "Ayer", in the evening)', () => {
      // 20:00 in America/Mexico_City (UTC-6) on 2026-06-17. Without the
      // noon anchor the bare string parses as UTC midnight, diff >= 24h,
      // and today's date rendered as "Ayer".
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-18T02:00:00Z'));
      expect(fmtRelative('2026-06-17')).toBe('Hoy');
      expect(fmtRelative('2026-06-16')).toBe('Ayer');
    });

    it('renders a future date as the absolute date, not "Hace -N días"', () => {
      const future = new Date(Date.now() + 3 * 86_400_000);
      const out = fmtRelative(future);
      expect(out).not.toContain('-');
      expect(out).not.toContain('Hace');
      expect(out).toBe(fmtDate(future));
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
