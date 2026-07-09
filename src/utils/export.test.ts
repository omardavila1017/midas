import { describe, expect, it } from 'vitest';
import { csvDate, toCSV } from './export';

describe('csvDate — dd/mm/aaaa for CSV export (B3.8)', () => {
  it('formats a plain ISO date', () => {
    expect(csvDate('2026-03-10')).toBe('10/03/2026');
  });

  it('formats an ISO datetime by dropping the time', () => {
    expect(csvDate('2026-12-01T13:40:00')).toBe('01/12/2026');
  });

  it('is tolerant of empty / nullish values', () => {
    expect(csvDate('')).toBe('');
    expect(csvDate(null)).toBe('');
    expect(csvDate(undefined)).toBe('');
  });

  it('passes through non-ISO strings unchanged (already-formatted or garbage)', () => {
    expect(csvDate('10/03/2026')).toBe('10/03/2026');
    expect(csvDate('N/A')).toBe('N/A');
    expect(csvDate('Ene 2026')).toBe('Ene 2026');
  });

  it('coerces numeric input to string (passthrough — not an ISO date)', () => {
    expect(csvDate(20260310)).toBe('20260310');
  });
});

describe('toCSV', () => {
  it('escapes commas, quotes and newlines', () => {
    const csv = toCSV([{ a: 'x,y', b: 'he said "hi"' }]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('a,b');
    expect(lines[1]).toBe('"x,y","he said ""hi"""');
  });

  it('returns empty string for no rows', () => {
    expect(toCSV([])).toBe('');
  });
});
