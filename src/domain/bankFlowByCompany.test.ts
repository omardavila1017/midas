import { describe, expect, it } from 'vitest';
import { sumBankFlowByCompany, displayCia } from './bankFlowByCompany';
import type { EnrichedBankMovement } from './netCashFlowEngine';

function mov(cia: string, amount: number): EnrichedBankMovement {
  return { cia, amount } as unknown as EnrichedBankMovement;
}

describe('sumBankFlowByCompany (B2.5)', () => {
  const abonos = new Map<string, EnrichedBankMovement[]>([
    ['2026-01-10', [mov('00011', 1000), mov('00038', 3000)]],
    ['2026-02-05', [mov('00011', 500)]],
  ]);
  const cargos = new Map<string, EnrichedBankMovement[]>([
    ['2026-01-15', [mov('00011', 400), mov('00038', 2000)]],
  ]);

  it('groups inflows/outflows by cia and computes net, sorted by net desc', () => {
    const rows = sumBankFlowByCompany(abonos, cargos);
    expect(rows.map(r => r.cia)).toEqual(['00011', '00038']);
    const c11 = rows.find(r => r.cia === '00011')!;
    expect(c11.inflows).toBe(1500);
    expect(c11.outflows).toBe(400);
    expect(c11.net).toBe(1100);
    const c38 = rows.find(r => r.cia === '00038')!;
    expect(c38.net).toBe(1000); // 3000 - 2000
  });

  it('respects the month filter', () => {
    const rows = sumBankFlowByCompany(abonos, cargos, { month: 1 }); // febrero
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cia: '00011', inflows: 500, outflows: 0, net: 500 });
  });

  it('buckets movements without a cia under "—"', () => {
    const rows = sumBankFlowByCompany(
      new Map([['2026-01-01', [mov('', 100)]]]),
      new Map(),
    );
    expect(rows[0].cia).toBe('—');
    expect(rows[0].inflows).toBe(100);
  });
});

describe('displayCia', () => {
  it('strips the 5-digit padding for display', () => {
    expect(displayCia('00033')).toBe('33');
    expect(displayCia('00001')).toBe('1');
    expect(displayCia('11')).toBe('11');
  });

  it('keeps non-numeric codes as-is and maps unknown/empty to "—"', () => {
    expect(displayCia('—')).toBe('—');
    expect(displayCia('')).toBe('—');
    expect(displayCia('MULTI')).toBe('MULTI');
  });
});
