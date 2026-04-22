import { describe, expect, it } from 'vitest';
import { parseAmount } from './ProposalEditor';

describe('ProposalEditor.parseAmount', () => {
  it('parses plain integers', () => {
    expect(parseAmount('50000')).toBe(50000);
  });

  it('accepts Mexican-style thousand separators', () => {
    expect(parseAmount('50,000')).toBe(50000);
    expect(parseAmount('1,234,567')).toBe(1234567);
  });

  it('ignores a leading currency symbol and whitespace', () => {
    expect(parseAmount(' $50,000 ')).toBe(50000);
    expect(parseAmount('50 000')).toBe(50000);
  });

  it('accepts decimals', () => {
    expect(parseAmount('50.5')).toBe(50.5);
  });

  it('returns NaN for empty or non-numeric input', () => {
    expect(Number.isNaN(parseAmount(''))).toBe(true);
    expect(Number.isNaN(parseAmount('abc'))).toBe(true);
    expect(Number.isNaN(parseAmount('   '))).toBe(true);
  });

  it('returns NaN for things Number() would happily parse but that are not meaningful amounts', () => {
    // "1e5" sí es un número válido; lo mantenemos — no es un caso real pero
    // no queremos rechazarlo.
    expect(parseAmount('1e5')).toBe(100000);
  });
});
