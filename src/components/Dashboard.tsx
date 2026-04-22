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
import { fmtCompact, fmtCurrency, fmtYearMonthShort, fmtYearMonthLong } from '../formatters';
import {
  buildHistoricalMonths,
  buildFutureExpenses,
  projectFutureIncome,
  buildExpenseProjector,
  projectMonthlyExpense,
  filterCompleteHistorical,
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
import MonthDrilldown from './MonthDrilldown';

interface DashboardProps {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  proposals: Proposal[];
  onOpenFlow: () => void;
}

const CHART_COLORS = {
  income: '#059669',       // emerald-600 (real income)
  incomePattern: '#10b981', // emerald-500 (projected stripes)
  incomeBg: '#ecfdf5',     // emerald-50
  expense: '#dc2626',       // red-600 (real expense)
  expensePattern: '#ef4444', // red-500 (projected stripes)
  expenseBg: '#fef2f2',    // red-50
  cash: '#1d4ed8',         // blue-700
};

const Dashboard: React.FC<DashboardProps> = ({ companyCode, bankStatements, proposals, onOpenFlow }) => {
  const [aged, setAged] = useState<AgedBalanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

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

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const { base, baseline } = useMemo(
    () => computeBaseCashFlow(bankStatements, aged, companyCode, today),
    [bankStatements, aged, companyCode, today],
  );
  const evaluated = useMemo(() => evaluateCashFlow(base, proposals), [base, proposals]);

  const currentYear = new Date().getFullYear();
  const currentYm = toYearMonth(today);
  const todayDay = new Date(today).getUTCDate();
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

  // committed expenses por mes — para saber el "techo" del mes actual.
  const committedByMonth = useMemo(() => buildFutureExpenses(aged), [aged]);

  // Datos del chart: cada mes lleva ingresos/egresos partidos en real + proyectado.
  // - Histórico completo: todo al tramo real.
  // - Mes en curso: real = lo capturado; proyectado = lo que falta para cerrar
  //   el mes (ingresos: gap al baseline; egresos: max(gap baseline, programado restante + baseline prorrateado)).
  // - Mes futuro: todo al tramo proyectado.
  const chartData = useMemo(() => evaluated.months.map((m) => {
    const ym = m.yearMonth;
    const cmp = compareYearMonth(ym, currentYm);
    if (cmp < 0) {
      return {
        yearMonth: ym,
        realIncome: m.baseIncome,
        projIncome: 0,
        realExpense: m.baseExpense,
        projExpense: 0,
        cashBase: m.baseClosingCash,
        phase: 'past' as const,
      };
    }
    if (cmp > 0) {
      return {
        yearMonth: ym,
        realIncome: 0,
        projIncome: m.baseIncome,
        realExpense: 0,
        projExpense: m.baseExpense,
        cashBase: m.baseClosingCash,
        phase: 'future' as const,
      };
    }
    // Mes en curso: el engine lo marca como histórico con datos parciales.
    const daysInCurMonth = daysInMonth(ym);
    const daysRemaining = Math.max(0, daysInCurMonth - todayDay);
    const committedThisMonth = committedByMonth.get(ym) ?? 0;
    const expectedIncome = Math.max(baseline.avgIncome, m.baseIncome);
    const projInc = Math.max(0, expectedIncome - m.baseIncome);
    // Egresos esperados: lo ya ocurrido + lo programado restante y el baseline
    // prorrateado a los días que faltan; respetando piso del baseline.
    const baselineRemaining = baseline.avgExpense * (daysRemaining / Math.max(1, daysInCurMonth));
    const projectedRemainder = Math.max(
      baselineRemaining,
      Math.max(0, committedThisMonth - m.baseExpense),
      Math.max(0, baseline.avgExpense - m.baseExpense),
    );
    return {
      yearMonth: ym,
      realIncome: m.baseIncome,
      projIncome: projInc,
      realExpense: m.baseExpense,
      projExpense: projectedRemainder,
      cashBase: m.baseClosingCash,
      phase: 'current' as const,
    };
  }), [evaluated.months, currentYm, todayDay, committedByMonth, baseline]);

  const hasRealData = bankStatements.length > 0;

  const handleBarClick = (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as { activeLabel?: string; activePayload?: { payload?: { yearMonth?: string } }[] };
    const ym = p.activeLabel ?? p.activePayload?.[0]?.payload?.yearMonth;
    if (ym) setSelectedMonth(ym);
  };

  return (
    <div className="space-y-5">
      {/* Patrones SVG para las barras proyectadas (relleno de líneas). */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <pattern id="hatchIncome" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={CHART_COLORS.incomeBg} />
            <line x1="0" y1="0" x2="0" y2="6" stroke={CHART_COLORS.incomePattern} strokeWidth="2.5" />
          </pattern>
          <pattern id="hatchExpense" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={CHART_COLORS.expenseBg} />
            <line x1="0" y1="0" x2="0" y2="6" stroke={CHART_COLORS.expensePattern} strokeWidth="2.5" />
          </pattern>
        </defs>
      </svg>

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
          Barra sólida = real · Barra de líneas = proyectado. Haz clic en un mes para ver el detalle.
        </p>
        <div style={{ height: 340 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 10, right: 20, left: 10, bottom: 10 }}
              onClick={handleBarClick}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis
                dataKey="yearMonth"
                tick={{ fontSize: 11 }}
                tickFormatter={fmtYearMonthShort}
              />
              <YAxis tickFormatter={(v) => fmtCompact(v)} tick={{ fontSize: 11 }} width={70} />
              <Tooltip
                content={<MonthTooltip />}
                cursor={{ fill: 'rgba(99, 102, 241, 0.06)' }}
              />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
              <ReferenceLine y={0} stroke="#cbd5e1" />
              <Bar
                dataKey="realIncome"
                stackId="income"
                fill={CHART_COLORS.income}
                name="Ingresos (real)"
                radius={[0, 0, 0, 0]}
                cursor="pointer"
              />
              <Bar
                dataKey="projIncome"
                stackId="income"
                fill="url(#hatchIncome)"
                stroke={CHART_COLORS.incomePattern}
                strokeWidth={1}
                name="Ingresos (proy.)"
                radius={[4, 4, 0, 0]}
                cursor="pointer"
              />
              <Bar
                dataKey="realExpense"
                stackId="expense"
                fill={CHART_COLORS.expense}
                name="Egresos (real)"
                radius={[0, 0, 0, 0]}
                cursor="pointer"
              />
              <Bar
                dataKey="projExpense"
                stackId="expense"
                fill="url(#hatchExpense)"
                stroke={CHART_COLORS.expensePattern}
                strokeWidth={1}
                name="Egresos (proy.)"
                radius={[4, 4, 0, 0]}
                cursor="pointer"
              />
              <Line
                type="monotone"
                dataKey="cashBase"
                stroke={CHART_COLORS.cash}
                strokeWidth={2.5}
                dot={{ r: 2 }}
                name="Caja Final"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <MonthDrilldown
        yearMonth={selectedMonth}
        bankStatements={bankStatements}
        agedBalances={aged}
        companyCode={companyCode}
        baseline={baseline}
        today={today}
        onClose={() => setSelectedMonth(null)}
      />
    </div>
  );
};

interface TooltipPayloadItem {
  dataKey: string;
  value: number;
  payload: { yearMonth: string; phase?: 'past' | 'current' | 'future' };
}

const TOOLTIP_LABELS: Record<string, string> = {
  realIncome: 'Ingresos (real)',
  projIncome: 'Ingresos (proy.)',
  realExpense: 'Egresos (real)',
  projExpense: 'Egresos (proy.)',
  cashBase: 'Caja Final',
};

const MonthTooltip: React.FC<{ active?: boolean; payload?: TooltipPayloadItem[]; label?: string }> = ({
  active, payload, label,
}) => {
  if (!active || !payload || payload.length === 0) return null;
  const ym = label ?? payload[0]?.payload?.yearMonth ?? '';
  const phase = payload[0]?.payload?.phase;
  const phaseText =
    phase === 'past' ? 'Histórico' :
    phase === 'current' ? 'En curso (real + proy.)' :
    phase === 'future' ? 'Proyectado' : '';
  return (
    <div className="rounded-lg border border-[var(--gray-200)] bg-white shadow-sm px-3 py-2 text-[12px]">
      <p className="font-semibold mb-0.5" style={{ color: 'var(--gray-950)' }}>{fmtYearMonthLong(ym)}</p>
      {phaseText && <p className="text-[11px] mb-1.5" style={{ color: 'var(--gray-400)' }}>{phaseText}</p>}
      <ul className="space-y-0.5">
        {payload
          .filter((p) => p.value !== 0 && p.value !== null && p.value !== undefined)
          .map((p) => (
            <li key={p.dataKey} className="flex items-center justify-between gap-4">
              <span style={{ color: 'var(--gray-600)' }}>{TOOLTIP_LABELS[p.dataKey] ?? p.dataKey}</span>
              <span className="tabular-nums font-medium" style={{ color: 'var(--gray-950)' }}>
                {fmtCurrency(p.value)}
              </span>
            </li>
          ))}
      </ul>
      <p className="text-[10px] mt-1.5" style={{ color: 'var(--gray-400)' }}>
        Clic para ver el detalle abajo
      </p>
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

function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function computeBaseCashFlow(
  bankStatements: BankAccountStatement[],
  agedBalances: AgedBalanceRecord[],
  companyCode: string,
  today: string,
): { base: CashFlowMonth[]; baseline: { avgIncome: number; avgExpense: number } } {
  const filtered = companyCode === 'all' || !companyCode
    ? bankStatements
    : bankStatements.filter((s) => s.cia === companyCode);

  const historical = buildHistoricalMonths(filtered);
  const futureExpenses = buildFutureExpenses(agedBalances);

  const todayYm = toYearMonth(today);
  // Excluimos el mes en curso (parcial) del input de proyección para no sesgar
  // los promedios hacia abajo.
  const completeHistorical = filterCompleteHistorical(historical, today);
  const avgIncome = projectFutureIncome(completeHistorical, 6);
  const expenseProjector = buildExpenseProjector(completeHistorical);
  const avgExpense = expenseProjector(1);

  const horizonMonths = 12;
  const lastHistoricalYm = historical.length > 0
    ? historical[historical.length - 1].yearMonth
    : todayYm;
  const projectionAnchorYm = completeHistorical.length > 0
    ? completeHistorical[completeHistorical.length - 1].yearMonth
    : lastHistoricalYm;
  const firstFutureYm = addMonths(
    compareYearMonth(lastHistoricalYm, todayYm) > 0 ? lastHistoricalYm : todayYm,
    1,
  );
  const lastFutureYm = addMonths(todayYm, horizonMonths);

  const months: CashFlowMonth[] = [...historical];
  let running = historical.length > 0 ? historical[historical.length - 1].closingCash : 0;
  let cursor = firstFutureYm;
  while (compareYearMonth(cursor, lastFutureYm) <= 0) {
    const offset = Math.max(1, monthsBetween(projectionAnchorYm, cursor));
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
  return { base: months, baseline: { avgIncome, avgExpense } };
}

export default Dashboard;
