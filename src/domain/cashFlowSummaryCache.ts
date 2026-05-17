import type { CashFlowMonth } from '../types';

const STORAGE_KEY = 'midas.cashFlowSummary.v1';
const VERSION = 1;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CashFlowSummarySnapshot {
  version: number;
  scopeKey: string;
  createdAt: string;
  months: CashFlowMonth[];
  counts: {
    bankStatements: number;
    bankMovements: number;
    cxpRecords: number;
    cobranzaRecords: number;
    comprasRecords: number;
    pagoProveedorRecords: number;
    nominaRecords: number;
    rolRecords: number;
  };
}

type CachePayload = Record<string, CashFlowSummarySnapshot>;

function readPayload(): CachePayload {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as CachePayload : {};
  } catch {
    return {};
  }
}

function isValidSnapshot(value: CashFlowSummarySnapshot | undefined, scopeKey: string): value is CashFlowSummarySnapshot {
  if (!value || value.version !== VERSION || value.scopeKey !== scopeKey) return false;
  if (!Array.isArray(value.months) || value.months.length === 0) return false;
  const createdAt = new Date(value.createdAt).getTime();
  return Number.isFinite(createdAt) && Date.now() - createdAt <= MAX_AGE_MS;
}

export function cashFlowSummaryScopeKey(companyCode: string | undefined): string {
  return `company:${companyCode || 'all'}`;
}

export function loadCashFlowSummary(scopeKey: string): CashFlowSummarySnapshot | null {
  const payload = readPayload();
  const snapshot = payload[scopeKey];
  return isValidSnapshot(snapshot, scopeKey) ? snapshot : null;
}

export function saveCashFlowSummary(
  scopeKey: string,
  snapshot: Omit<CashFlowSummarySnapshot, 'version' | 'scopeKey' | 'createdAt'>,
): void {
  try {
    const payload = readPayload();
    payload[scopeKey] = {
      ...snapshot,
      version: VERSION,
      scopeKey,
      createdAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Cache is best-effort.
  }
}

export function invalidateCashFlowSummary(_reason?: string): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
