import { beforeEach, describe, expect, it } from 'vitest';
import {
  cashFlowSummaryScopeKey,
  invalidateCashFlowSummary,
  loadCashFlowSummary,
  saveCashFlowSummary,
} from './cashFlowSummaryCache';

describe('cashFlowSummaryCache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a valid cash-flow summary by scope', () => {
    const scope = cashFlowSummaryScopeKey('all');
    saveCashFlowSummary(scope, {
      months: [
        { yearMonth: '2026-05', isHistorical: true, income: 100, expense: 40, closingCash: 60 },
      ],
      counts: {
        bankStatements: 1,
        bankMovements: 2,
        cxpRecords: 0,
        cobranzaRecords: 0,
        comprasRecords: 0,
        pagoProveedorRecords: 0,
        nominaRecords: 0,
        rolRecords: 0,
      },
    });

    const loaded = loadCashFlowSummary(scope);
    expect(loaded?.months[0]?.closingCash).toBe(60);
    expect(loaded?.counts.bankMovements).toBe(2);
  });

  it('ignores missing scopes and invalidated snapshots', () => {
    const scope = cashFlowSummaryScopeKey('00011');
    expect(loadCashFlowSummary(scope)).toBeNull();

    saveCashFlowSummary(scope, {
      months: [
        { yearMonth: '2026-05', isHistorical: true, income: 100, expense: 40, closingCash: 60 },
      ],
      counts: {
        bankStatements: 1,
        bankMovements: 2,
        cxpRecords: 0,
        cobranzaRecords: 0,
        comprasRecords: 0,
        pagoProveedorRecords: 0,
        nominaRecords: 0,
        rolRecords: 0,
      },
    });
    invalidateCashFlowSummary('test');

    expect(loadCashFlowSummary(scope)).toBeNull();
  });
});
