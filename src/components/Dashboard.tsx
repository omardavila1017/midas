import React, { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from 'recharts';
import {
  TrendingUp, TrendingDown, Wallet, AlertTriangle, LineChart as LineChartIcon,
} from 'lucide-react';
import type { Proposal } from '../types';
import { fmtCompact, fmtCurrency } from '../formatters';
import {
  buildHistoricalMonths,
  buildFutureExpenses,
  projectFutureIncome,
  buildExpenseProjector,
  projectMonthlyExpense,
  toYearMonth,
  addMonths,
  compareYearMonth,
  monthsBetween,
  evaluateCashFlow,
} from '../domain/cashFlowEngine';
import type { CashFlowMonth } from '../types';
import {
  fetchAgedBalances,
  type BankAccountStatement,
  type AgedBalanceRecord,
} from '../services/jde';

interface DashboardProps {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  proposals: Proposal[];
  onOpenFlow: () => void;
}

const Dashboard: React.FC<DashboardProps> = ({ companyCode, bankStatements, proposals, onOpenFlow }) => {
  const [aged, setAged] = useState<AgedBalanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!companyCode || companyCode === 'all') {
      setAged([]);
      return;
    }
    setLoading(true);
    setError(null);
    fetchAgedBalances({ cia: companyCode })
      .then((d) => { if (!cancelled) setAged(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyCode]);

  const base = useMemo(
    () => computeBaseCashFlow(bankStatements, aged, companyCode),
    [bankStatements, aged, companyCode],
  );
  const evaluated = useMemo(() => evaluateCashFlow(base, proposals), [base, proposals]);

  const currentYear = new Date().getFullYear();
  const currentYm = toYearMonth(new Date().toISOString().slice(0, 10));
  const monthsThisYear = evaluated.months.filter((m) => m.yearMonth.startsWith(String(currentYear)));

  const ingresosYtd = monthsThisYear
    .filter((m) => m.isHistorical)
    .reduce((s, m) => s + m.baseIncome, 0);
  const egresosYtd = monthsThisYear
    .filter((m) => m.isHistorical)
    .reduce((s, m) => s + m.baseExpense, 0);
  const cajaActual = (() => {
    const currentMonth = evaluated.months.find((m) => m.yearMonth === currentYm);
    if (currentMonth) return currentMonth.baseClosingCash;
    const lastHist = [...evaluated.months].reverse().find((m) => m.isHistorical);
    return lastHist?.baseClosingCash ?? 0;
  })();

  const chartData = evaluated.months.map((m) => ({
    yearMonth: m.yearMonth,
    histIncome: m.isHistorical ? m.baseIncome : null,
    histExpense: m.isHistorical ? m.baseExpense : null,
    projIncome: !m.isHistorical ? m.forecastIncome : null,
    projExpense: !m.isHistorical ? m.forecastExpense : null,
    cashBase: m.baseClosingCash,
  }));

  const hasRealData = bankStatements.length > 0;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
            Dashboard
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
            Flujo real desde JDE · {companyCode === 'all' ? 'todas las compañías' : `compañía ${companyCode}`}
          </p>
        </div>
        <button
          onClick={onOpenFlow}
          className="flex items-center gap-2 h-10 px-4 rounded-xl bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary-hover)]"
        >
          <LineChartIcon className="w-4 h-4" />
          Abrir Simulación
        </button>
      </div>

      {!hasRealData && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-[var(--warning-muted)]">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
          <p className="text-[12px]" style={{ color: 'var(--gray-700)' }}>
            No hay estados de cuenta cargados. Ve a Flujo Neto y haz refresh para traer datos reales desde JDE.
          </p>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-[var(--danger)]/10">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--danger)' }} />
          <p className="text-[12px]" style={{ color: 'var(--gray-700)' }}>
            Error al cargar Antigüedad de Saldos: {error}
          </p>
        </div>
      )}
      {loading && (
        <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>Cargando saldos comprometidos…</p>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <KpiCard
          label={`Ingresos YTD ${currentYear}`}
          value={ingresosYtd}
          icon={<TrendingUp className="w-4 h-4" />}
          color="var(--success)"
        />
        <KpiCard
          label={`Egresos YTD ${currentYear}`}
          value={egresosYtd}
          icon={<TrendingDown className="w-4 h-4" />}
          color="var(--danger)"
        />
        <KpiCard
          label="Caja Actual"
          value={cajaActual}
          icon={<Wallet className="w-4 h-4" />}
          color="var(--gray-950)"
        />
      </div>

      {/* Cash chart */}
      <div className="rounded-2xl border border-[var(--gray-200)] bg-white p-5">
        <h2 className="text-[15px] font-semibold tracking-tight mb-1" style={{ color: 'var(--gray-950)' }}>
          Flujo mensual
        </h2>
        <p className="text-[11px] mb-4" style={{ color: 'var(--gray-400)' }}>
          Ingresos, egresos y caja final — histórico desde /Bancos, proyección desde /AntiguedadSaldos + promedio móvil.
        </p>
        <div style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="yearMonth" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => fmtCompact(v)} tick={{ fontSize: 11 }} width={70} />
              <Tooltip
                formatter={(v: number | string) => (typeof v === 'number' ? fmtCurrency(v) : v)}
                contentStyle={{ borderRadius: 8, borderColor: '#e5e7eb' }}
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
              <ReferenceLine y={0} stroke="#cbd5e1" />
              <Bar dataKey="histIncome" fill="#cbd5e1" name="Ingresos (histórico)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="histExpense" fill="#475569" name="Egresos (histórico)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="projIncome" fill="#10b981" fillOpacity={0.85} name="Ingresos (proy.)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="projExpense" fill="#ef4444" fillOpacity={0.85} name="Egresos (proy.)" radius={[4, 4, 0, 0]} />
              <Line type="monotone" dataKey="cashBase" stroke="#2563eb" strokeWidth={2.5} dot={{ r: 2 }} name="Caja Final" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};

const KpiCard: React.FC<{ label: string; value: number; icon: React.ReactNode; color: string }> = ({ label, value, icon, color }) => (
  <div className="rounded-xl border border-[var(--gray-200)] bg-white p-4">
    <div className="flex items-center justify-between mb-2">
      <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--gray-400)' }}>
        {label}
      </p>
      <span style={{ color }}>{icon}</span>
    </div>
    <p className="text-[20px] font-semibold tabular-nums" style={{ color }}>
      {fmtCurrency(value)}
    </p>
  </div>
);

function computeBaseCashFlow(
  bankStatements: BankAccountStatement[],
  agedBalances: AgedBalanceRecord[],
  companyCode: string,
): CashFlowMonth[] {
  const filtered = companyCode === 'all' || !companyCode
    ? bankStatements
    : bankStatements.filter((s) => s.cia === companyCode);

  const historical = buildHistoricalMonths(filtered);
  const futureExpenses = buildFutureExpenses(agedBalances);
  const avgIncome = projectFutureIncome(historical, 6);
  const expenseProjector = buildExpenseProjector(historical);

  const today = new Date().toISOString().slice(0, 10);
  const todayYm = toYearMonth(today);
  const horizonMonths = 12;
  const lastHistoricalYm = historical.length > 0
    ? historical[historical.length - 1].yearMonth
    : todayYm;
  const firstFutureYm = addMonths(
    compareYearMonth(lastHistoricalYm, todayYm) > 0 ? lastHistoricalYm : todayYm,
    1,
  );
  const lastFutureYm = addMonths(todayYm, horizonMonths);

  const months: CashFlowMonth[] = [...historical];
  let running = historical.length > 0 ? historical[historical.length - 1].closingCash : 0;
  let cursor = firstFutureYm;
  while (compareYearMonth(cursor, lastFutureYm) <= 0) {
    const offset = Math.max(1, monthsBetween(lastHistoricalYm, cursor));
    const committed = futureExpenses.get(cursor) ?? 0;
    const expense = projectMonthlyExpense(offset, committed, expenseProjector);
    const income = avgIncome;
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
  return months;
}

export default Dashboard;
