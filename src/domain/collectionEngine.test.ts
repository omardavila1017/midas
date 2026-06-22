import { describe, it, expect } from 'vitest';
import { projectClientMonth } from './collectionEngine';
import { Client, CashFlowAssumptions } from './types';

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: 'c1',
    name: 'Cliente Prueba',
    paymentDay: { kind: 'ANY' },
    frequency: 'Quincenal', // eventsPerMonth = 2
    creditDays: 0,
    monthlyBilling: new Array(12).fill(1000),
    complianceRate: 1,
    ...overrides,
  };
}

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

describe('projectClientMonth invoice dating', () => {
  it('defaults to the 1st of the month + one cycle per event (unchanged behavior)', () => {
    const events = projectClientMonth(makeClient(), 2026, 0 /* January */, assumptions);
    expect(events).toHaveLength(2);
    // First invoice on day 1, second advanced one quincenal cycle (+14d).
    expect(events[0].invoiceDate).toBe('2026-01-01');
    expect(events[1].invoiceDate).toBe('2026-01-15');
    // creditDays = 0 → theoretical date equals invoice date.
    expect(events[0].theoreticalDate).toBe('2026-01-01');
    expect(events[1].theoreticalDate).toBe('2026-01-15');
  });

  it('accepts explicit per-event invoice dates', () => {
    const events = projectClientMonth(makeClient(), 2026, 0, assumptions, {
      invoiceDates: ['2026-01-10', '2026-01-20'],
    });
    expect(events.map((e) => e.invoiceDate)).toEqual(['2026-01-10', '2026-01-20']);
    expect(events.map((e) => e.theoreticalDate)).toEqual(['2026-01-10', '2026-01-20']);
  });

  it('falls back to the cadence date for missing/invalid override entries', () => {
    const events = projectClientMonth(makeClient(), 2026, 0, assumptions, {
      // Only the first event is overridden; the rest follow the normal cycle.
      invoiceDates: ['2026-01-05'],
    });
    expect(events[0].invoiceDate).toBe('2026-01-05');
    expect(events[1].invoiceDate).toBe('2026-01-15');
  });

  it('ignores unparseable override strings and uses the cadence date', () => {
    const events = projectClientMonth(makeClient(), 2026, 0, assumptions, {
      invoiceDates: ['not-a-date', ''],
    });
    expect(events[0].invoiceDate).toBe('2026-01-01');
    expect(events[1].invoiceDate).toBe('2026-01-15');
  });
});
