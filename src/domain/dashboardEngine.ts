import type { Client, Provider, CashFlowAssumptions } from './types';
import type { CXPRecord } from './persistence';
import type { Budget } from './budget';
import {
  buildHistoricalMonths,
  toYearMonth,
  addMonths,
  compareYearMonth,
} from './cashFlowEngine';
import {
  buildMonthlyProjection,
  type ProjectionOverrides,
  type MonthlyProjection,
} from './projectionEngine';
import type { CashFlowMonth } from '../types';
import type {
  BankAccountStatement,
  AgedBalanceRecord,
} from '../services/jde';

// Pure cash-flow engine extracted from Dashboard.tsx so that callers in the
// projection / planning pipeline can import it without pulling Recharts,
// lucide-react, and the full Dashboard component tree into the main bundle.
// Dashboard.tsx re-exports these for backward compatibility.

export interface ComputeInputs {
  bankStatements: BankAccountStatement[];
  aged: AgedBalanceRecord[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  companyCode: string;
  today: string;
  overrides: ProjectionOverrides;
  budget: Budget | null;
  startingBalance?: number;
}

export interface ComputeOutput {
  base: CashFlowMonth[];
  baseline: { avgIncome: number; avgExpense: number };
  projection: MonthlyProjection;
}

export function computeBankStartingBalance(statements: BankAccountStatement[]): number {
  return statements.reduce((s, acc) => s + (acc.saldoInicial ?? 0), 0);
}

export function computeBaseCashFlow(inputs: ComputeInputs): ComputeOutput {
  const { bankStatements, aged, clients, providers, cxpRecords, assumptions, companyCode, today, overrides, startingBalance } = inputs;
  const filtered = companyCode === 'all' || !companyCode
    ? bankStatements
    : bankStatements.filter((s) => s.cia === companyCode);
  const filteredCxp = companyCode === 'all' || !companyCode
    ? cxpRecords
    : cxpRecords.filter((r) => r.cia === companyCode);
  const combinedAged: AgedBalanceRecord[] = aged.length > 0
    ? aged
    : filteredCxp as unknown as AgedBalanceRecord[];

  const historical = buildHistoricalMonths(filtered);
  const todayYm = toYearMonth(today);
  const todayYear = Number(todayYm.slice(0, 4));
  const endOfYearYm = `${todayYear}-12`;
  const lastHistoricalYm = historical.length > 0
    ? historical[historical.length - 1].yearMonth
    : todayYm;
  const firstFutureYm = addMonths(
    compareYearMonth(lastHistoricalYm, todayYm) > 0 ? lastHistoricalYm : todayYm,
    1,
  );
  const lastFutureYm = compareYearMonth(endOfYearYm, firstFutureYm) >= 0
    ? endOfYearYm
    : null;

  const projection = buildMonthlyProjection({
    fromYm: todayYm,
    toYm: lastFutureYm ?? todayYm,
    clients,
    providers,
    aged: combinedAged,
    bankStatements: filtered,
    baselineIncome: 0,
    baselineExpense: 0,
    assumptions,
    today,
    budget: null,
  });
  const projectionByYm = new Map(projection.months.map((m) => [m.yearMonth, m]));
  const baseline = { avgIncome: 0, avgExpense: 0 };

  const baseStart = typeof startingBalance === 'number'
    ? startingBalance
    : computeBankStartingBalance(filtered);
  const historicalChained: CashFlowMonth[] = [];
  let runningHist = baseStart;
  for (const m of historical) {
    runningHist = runningHist + m.income - m.expense;
    historicalChained.push({ ...m, closingCash: runningHist });
  }

  const months: CashFlowMonth[] = [...historicalChained];
  let running = historicalChained.length > 0
    ? historicalChained[historicalChained.length - 1].closingCash
    : baseStart;
  if (lastFutureYm !== null) {
    let cursor = firstFutureYm;
    while (compareYearMonth(cursor, lastFutureYm) <= 0) {
      const ov = overrides[cursor];
      const projected = projectionByYm.get(cursor);
      const income = ov?.income ?? projected?.income.total ?? 0;
      const expense = ov?.expense ?? projected?.expense.total ?? 0;
      running = running + income - expense;
      months.push({
        yearMonth: cursor,
        isHistorical: false,
        income,
        expense,
        closingCash: running,
      });
      cursor = addMonths(cursor, 1);
    }
  }
  return { base: months, baseline, projection };
}
