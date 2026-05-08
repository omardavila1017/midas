import { describe, expect, it } from 'vitest';
import {
  estimatedPurchaseDueDate,
  normalizeCancelledAt,
  parsePurchaseTaxRate,
  purchaseTaxMeta,
} from './sourceRecords';

describe('sourceRecords', () => {
  it('treats blank, zero and time-only cancellation values as active', () => {
    expect(normalizeCancelledAt('')).toBeUndefined();
    expect(normalizeCancelledAt('0')).toBeUndefined();
    expect(normalizeCancelledAt('00:00:00')).toBeUndefined();
  });

  it('recognizes real cancellation dates', () => {
    expect(normalizeCancelledAt('2026-04-13 00:00:00')).toBe('2026-04-13');
  });

  it('parses fiscal tax rates from purchase report labels', () => {
    expect(parsePurchaseTaxRate('IVA16')).toBe(16);
    expect(parsePurchaseTaxRate('IVA8')).toBe(8);
    expect(parsePurchaseTaxRate('')).toBeUndefined();
  });

  it('calculates creditable IVA from gross purchase amount', () => {
    const meta = purchaseTaxMeta(1160, 16);
    expect(meta.taxTreatment).toBe('IVA_CREDITABLE');
    expect(meta.taxBaseAmount).toBeCloseTo(1000);
    expect(meta.taxAmount).toBeCloseTo(160);
    expect(purchaseTaxMeta(500, undefined)).toEqual({ taxTreatment: 'UNCLASSIFIED' });
  });

  it('estimates purchase due date from receipt date plus credit days', () => {
    expect(estimatedPurchaseDueDate({
      receiptDate: '2026-04-15',
      orderDate: '2026-04-01',
      creditDays: 15,
    })).toBe('2026-04-30');
  });
});
