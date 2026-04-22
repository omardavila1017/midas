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
import type { Proposal, CashFlowOverrides, EvaluatedCashFlow } from '../types';
import type { Client, CashFlowAssumptions } from '../domain/types';
import { fmtCompact, fmtCurrency, fmtYearMonthShort, fmtYearMonthLong } from '../formatters';
import {
  toYearMonth,
  compareYearMonth,
  evaluateCashFlow,
} from '../domain/cashFlowEngine';
import { forecastCashFlow, type ForecastMonth } from '../domain/forecastEngine';
import {
  fetchAgedBalances,
  type BankAccountStatement,
  type AgedBalanceRecord,
} from '../services/jde';
import MonthDrilldown from './MonthDrilldown';
import CashFlowTable from './CashFlowTable';

interface DashboardProps {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  proposals: Proposal[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  overrides: CashFlowOverrides;
  onOverridesChange: (next: CashFlowOverrides) => void;
  onOpenFlow: () => void;
}

const CHART_COLORS = {
  income: '#059669',
  incomePattern: '#10b981',
  incomeBg: '#ecfdf5',
  expense: '#dc2626',
  expensePattern: '#ef4444',
  expenseBg: '#fef2f2',
  cash: '#1d4ed8',
};

const HORIZON_MONTHS = 12;

const Dashboard: React.FC<DashboardProps> = ({
  companyCode, bankStatements, proposals, clients, assumptions,
  overrides, onOverridesChange, onOpenFlow,
}) => {
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
  const currentYm = toYearMonth(today);
  const todayDay = new Date(today).getUTCDate();
  const currentYear = new Date().getFullYear();

  // Motor de forecast alimentado por clientes + AntiguedadSaldos + overrides.
  const forecast = useMemo(
    () => forecastCashFlow({
      today,
      horizonMonths: HORIZON_MONTHS,
      bankStatements,
      agedBalances: aged,
      clients,
      assumptions,
      overrides,
      companyCode,
    }),
    [today, bankStatements, aged, clients, assumptions, overrides, companyCode],
  );

  // Wrap en la estructura que espera evaluateCashFlow (para conservar el
  // tratamiento de propuestas sobre los meses proyectados). Los históricos
  // llevan su closingCash real; los futuros ya vienen encadenados.
  const base = forecast.months;
  const evaluated: EvaluatedCashFlow = useMemo(
    () => evaluateCashFlow(base.map(toBaseMonth), proposals),
    [base, proposals],
  );

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

  // Datos del chart: cada mes lleva ingresos/egresos partidos en real +
  // proyectado para meses en curso; histórico sólido; futuro con patrón.
  const chartData = useMemo(() => evaluated.months.map((m) => {
    const ym = m.yearMonth;
    const cmp = compareYearMonth(ym, currentYm);
    if (cmp < 0) {
      return {
        yearMonth: ym, phase: 'past' as const,
        realIncome: m.baseIncome, projIncome: 0,
        realExpense: m.baseExpense, projExpense: 0,
        totalIncome: m.baseIncome, totalExpense: m.baseExpense,
        cashBase: m.baseClosingCash,
      };
    }
    if (cmp > 0) {
      return {
        yearMonth: ym, phase: 'future' as const,
        realIncome: 0, projIncome: m.baseIncome,
        realExpense: 0, projExpense: m.baseExpense,
        totalIncome: m.baseIncome, totalExpense: m.baseExpense,
        cashBase: m.baseClosingCash,
      };
    }
    // Mes en curso: parte real capturada hasta hoy + proyección del resto.
    const daysInCurMonth = daysInMonth(ym);
    const daysRemaining = Math.max(0, daysInCurMonth - todayDay);
    const committedThisMonth = forecast.months.find((fm) => fm.yearMonth === ym)?.expenseCommitted ?? 0;
    const expectedIncome = Math.max(forecast.avgIncomeBaseline, m.baseIncome);
    const projInc = Math.max(0, expectedIncome - m.baseIncome);
    const baselineRemaining = forecast.avgExpenseBaseline * (daysRemaining / Math.max(1, daysInCurMonth));
    const projectedRemainder = Math.max(
      baselineRemaining,
      Math.max(0, committedThisMonth - m.baseExpense),
      Math.max(0, forecast.avgExpenseBaseline - m.baseExpense),
    );
    return {
      yearMonth: ym, phase: 'current' as const,
      realIncome: m.baseIncome, projIncome: projInc,
      realExpense: m.baseExpense, projExpense: projectedRemainder,
      totalIncome: m.baseIncome + projInc,
      totalExpense: m.baseExpense + projectedRemainder,
      cashBase: m.baseClosingCash,
    };
  }), [evaluated.months, currentYm, todayDay, forecast]);

  const hasRealData = bankStatements.length > 0;

  const handleBarClick = (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as { activeLabel?: string; activePayload?: { payload?: { yearMonth?: string } }[] };
    const ym = p.activeLabel ?? p.activePayload?.[0]?.payload?.yearMonth;
    if (ym) setSelectedMonth(ym);
  };

  const baseline = { avgIncome: forecast.avgIncomeBaseline, avgExpense: forecast.avgExpenseBaseline };

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
          Barra sólida = real · Barra de líneas = proyectado (clientes + programado).
          {forecast.hasClientsCatalog
            ? ` Calibrado con ${forecast.clientsCoverageMonths} meses (×${forecast.incomeCalibrationFactor.toFixed(2)} ingresos, ×${forecast.expenseCalibrationFactor.toFixed(2)} egresos).`
            : ' Catálogo de clientes vacío — usando media móvil histórica.'}
        </p>
        <div style={{ height: 340 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 10, right: 20, left: 10, bottom: 10 }}
              onClick={handleBarClick}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="yearMonth" tick={{ fontSize: 11 }} tickFormatter={fmtYearMonthShort} />
              <YAxis tickFormatter={(v) => fmtCompact(v)} tick={{ fontSize: 11 }} width={70} />
              <Tooltip content={<MonthTooltip />} cursor={{ fill: 'rgba(99, 102, 241, 0.06)' }} />
              <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
              <ReferenceLine y={0} stroke="#cbd5e1" />
              <Bar dataKey="realIncome" stackId="income" fill={CHART_COLORS.income} name="Ingresos (real)" cursor="pointer" />
              <Bar dataKey="projIncome" stackId="income" fill="url(#hatchIncome)" stroke={CHART_COLORS.incomePattern} strokeWidth={1} name="Ingresos (proy.)" radius={[4, 4, 0, 0]} cursor="pointer" />
              <Bar dataKey="realExpense" stackId="expense" fill={CHART_COLORS.expense} name="Egresos (real)" cursor="pointer" />
              <Bar dataKey="projExpense" stackId="expense" fill="url(#hatchExpense)" stroke={CHART_COLORS.expensePattern} strokeWidth={1} name="Egresos (proy.)" radius={[4, 4, 0, 0]} cursor="pointer" />
              <Line type="monotone" dataKey="cashBase" stroke={CHART_COLORS.cash} strokeWidth={2.5} dot={{ r: 2 }} name="Caja Final" />
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

      <CashFlowTable
        months={forecast.months}
        overrides={overrides}
        onOverridesChange={onOverridesChange}
        currentYm={currentYm}
        incomeCalibrationFactor={forecast.incomeCalibrationFactor}
        expenseCalibrationFactor={forecast.expenseCalibrationFactor}
        hasClientsCatalog={forecast.hasClientsCatalog}
      />
    </div>
  );
};

interface TooltipPayloadItem {
  dataKey: string;
  value: number;
  payload: {
    yearMonth: string;
    phase?: 'past' | 'current' | 'future';
    totalIncome: number;
    totalExpense: number;
    cashBase: number;
  };
}

const MonthTooltip: React.FC<{ active?: boolean; payload?: TooltipPayloadItem[]; label?: string }> = ({
  active, payload, label,
}) => {
  if (!active || !payload || payload.length === 0) return null;
  const ym = label ?? payload[0]?.payload?.yearMonth ?? '';
  const row = payload[0]?.payload;
  if (!row) return null;
  const phase = row.phase;
  const phaseText =
    phase === 'past' ? 'Histórico' :
    phase === 'current' ? 'En curso (real + proyección del resto del mes)' :
    phase === 'future' ? 'Proyectado' : '';
  const net = row.totalIncome - row.totalExpense;
  return (
    <div className="rounded-lg border border-[var(--gray-200)] bg-white shadow-sm px-3 py-2 text-[12px]">
      <p className="font-semibold mb-0.5" style={{ color: 'var(--gray-950)' }}>{fmtYearMonthLong(ym)}</p>
      {phaseText && <p className="text-[11px] mb-1.5" style={{ color: 'var(--gray-400)' }}>{phaseText}</p>}
      <ul className="space-y-0.5">
        <TooltipRow label="Ingresos" value={row.totalIncome} color="var(--success)" />
        <TooltipRow label="Egresos" value={row.totalExpense} color="var(--danger)" />
        <TooltipRow label="Flujo neto" value={net} color={net >= 0 ? 'var(--success)' : 'var(--danger)'} showSign />
        <TooltipRow label="Caja final" value={row.cashBase} color="var(--gray-950)" />
      </ul>
      <p className="text-[10px] mt-1.5" style={{ color: 'var(--gray-400)' }}>
        Clic para ver el detalle abajo
      </p>
    </div>
  );
};

const TooltipRow: React.FC<{ label: string; value: number; color: string; showSign?: boolean }> = ({
  label, value, color, showSign,
}) => (
  <li className="flex items-center justify-between gap-4">
    <span style={{ color: 'var(--gray-600)' }}>{label}</span>
    <span className="tabular-nums font-medium" style={{ color }}>
      {showSign && value > 0 ? '+' : ''}{fmtCurrency(value)}
    </span>
  </li>
);

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

function toBaseMonth(f: ForecastMonth) {
  return {
    yearMonth: f.yearMonth,
    isHistorical: f.isHistorical,
    income: f.income,
    expense: f.expense,
    closingCash: f.closingCash,
  };
}

export default Dashboard;
