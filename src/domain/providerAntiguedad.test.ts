import { describe, it, expect } from 'vitest';
import { lastPaymentAgeInDays, enrichFromCatalog } from './providerCatalog';

const NOW = new Date('2026-05-18T00:00:00');

describe('providerCatalog — last payment aging', () => {
  it('parses ISO dates', () => {
    expect(lastPaymentAgeInDays('2026-05-08', NOW)).toBe(10);
  });

  it('parses DD/MM/YYYY dates', () => {
    expect(lastPaymentAgeInDays('08/05/2026', NOW)).toBe(10);
  });

  it('parses DD-MM-YYYY dates', () => {
    expect(lastPaymentAgeInDays('18-03-2026', NOW)).toBe(61);
  });

  it('returns null for missing/garbage input', () => {
    expect(lastPaymentAgeInDays(null, NOW)).toBeNull();
    expect(lastPaymentAgeInDays('', NOW)).toBeNull();
    expect(lastPaymentAgeInDays('not-a-date', NOW)).toBeNull();
  });

  it('clamps future dates to 0 (never negative)', () => {
    expect(lastPaymentAgeInDays('2027-01-01', NOW)).toBe(0);
  });

  it('enrichFromCatalog always returns the aging fields', () => {
    const r = enrichFromCatalog({ supplier: '___no_such_provider___', classification: '' });
    expect(r).toHaveProperty('lastPaymentAgeDays');
    expect(r).toHaveProperty('antiguedad');
    // no last payment → both null
    expect(r.lastPaymentAgeDays).toBeNull();
    expect(r.antiguedad).toBeNull();
  });
});
