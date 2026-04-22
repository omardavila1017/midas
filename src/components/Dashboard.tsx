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
  FileSpreadsheet,
} from 'lucide-react';
import type { Proposal } from '../types';
import type { Client, Provider, CashFlowAssumptions } from '../domain/types';
import type { CXPRecord } from '../domain/persistence';
import type { Budget } from '../domain/budget';
import { fmtCompact, fmtCurrency, fmtYearMonthShort, fmtYearMonthLong } from '../formatters';
import {
  buildHistoricalMonths,
  toYearMonth,
  addMonths,
  compareYearMonth,
  evaluateCashFlow,
} from '../domain/cashFlowEngine';
import {
  buildMonthlyProjection,
  type ProjectionOverrides,
  type MonthlyProjection,
} from '../domain/projectionEngine';
import type { CashFlowMonth } from '../types';
import {
  fetchAgedBalances,
  type BankAccountStatement,
  type AgedBalanceRecord,
} from '../services/jde';
import MonthDrilldown from './MonthDrilldown';
import CashFlowTable, { type CashFlowTableRow } from './CashFlowTable';
import BudgetModal from './BudgetModal';

interface DashboardProps {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  proposals: Proposal[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  onBudgetChange: (b: Budget | null) => void;
  onOpenFlow: () => void;
  /** Override manual de la caja inicial. null = usar la suma de saldoInicial del banco. */
  startingBalanceOverride: number | null;
  /** Suma de saldoInicial reportada por banco (filtrada por cia). */
  bankStartingBalance: number;
  /** Sincroniza "Caja inicial" con "Saldo inicial" de CashFlowDetail. */
  onStartingBalanceChange: (v: number | null) => void;
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

const OVERRIDES_KEY = 'midas.dashboard.projectionOverrides.v1';
const LEGACY_OVERRIDES_KEY = 'flowsense.dashboard.projectionOverrides.v1';

function migrateLegacyKey(newKey: string, legacyKey: string): string | null {
  try {
    const current = localStorage.getItem(newKey);
    if (current !== null) return current;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy === null) return null;
    try {
      localStorage.setItem(newKey, legacy);
      localStorage.removeItem(legacyKey);
    } catch { /* ignore */ }
    return legacy;
  } catch { return null; }
}

export function loadOverrides(): ProjectionOverrides {
  try {
    const raw = migrateLegacyKey(OVERRIDES_KEY, LEGACY_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as ProjectionOverrides;
  } catch { return {}; }
}

const Dashboard: React.FC<DashboardProps> = ({
  companyCode, bankStatements, proposals, clients, providers, cxpRecords, assumptions,
  budget, onBudgetChange, onOpenFlow,
  startingBalanceOverride, bankStartingBalance, onStartingBalanceChange,
}) => {
  const [aged, setAged] = useState<AgedBalanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<ProjectionOverrides>(() => loadOverrides());
  const [budgetModalOpen, setBudgetModalOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides)); } catch { /* ignore */ }
  }, [overrides]);

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

  const { base, baseline, projection } = useMemo(
    () => computeBaseCashFlow({
      bankStatements, aged, clients, providers, cxpRecords, assumptions,
      companyCode, today, overrides, budget,
      startingBalance: startingBalanceOverride ?? undefined,
    }),
    [bankStatements, aged, clients, providers, cxpRecords, assumptions, companyCode, today, overrides, startingBalanceOverride, budget],
  );

  // Caja inicial "auto" desde banco (suma saldoInicial). La UI la muestra como
  // placeholder cuando no hay override; si el usuario la edita, se usa el
  // valor editado. `bankStartingBalance` viene de App para compartirse con
  // "Saldo inicial" en CashFlowDetail.
  const effectiveStartingBalance = startingBalanceOverride ?? bankStartingBalance;
  const evaluated = useMemo(() => evaluateCashFlow(base, proposals), [base, proposals]);

  const currentYear = new Date().getFullYear();
  const currentYm = toYearMonth(today);
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

  const projectionByMonth = useMemo(() => {
    const map = new Map<string, MonthlyProjection>();
    for (const p of projection.months) map.set(p.yearMonth, p);
    return map;
  }, [projection]);

  // Datos del chart: cada mes lleva ingresos/egresos partidos en real + proyectado.
  // - Histórico completo: real = lo del banco. Si hay budget y supera lo real,
  //   la diferencia se muestra como overlay rayado (variación vs presupuesto).
  // - Mes en curso: real = lo capturado; proyectado = lo que falta para llegar
  //   al total proyectado del mes (clientes/aged/budget).
  // - Mes futuro: todo al tramo proyectado (engine + override + budget).
  const budgetMonthValue = (
    ym: string,
    kind: 'income' | 'expense',
  ): number | null => {
    if (!budget) return null;
    const [y, mo] = ym.split('-').map(Number);
    if (budget.year !== y) return null;
    const arr = kind === 'income' ? budget.incomeTotal : budget.expenseTotal;
    const v = arr[mo - 1];
    return typeof v === 'number' ? v : null;
  };

  const chartData = useMemo(() => evaluated.months.map((m) => {
    const ym = m.yearMonth;
    const cmp = compareYearMonth(ym, currentYm);
    const override = overrides[ym];
    const budgetIncome = budgetMonthValue(ym, 'income');
    const budgetExpense = budgetMonthValue(ym, 'expense');

    if (cmp < 0) {
      // Mes pasado: real del banco. Si hay budget, mostramos la variación
      // contra presupuesto como overlay rayado cuando budget > real.
      const projectedIncomeTotal = override?.income ?? budgetIncome ?? 0;
      const projectedExpenseTotal = override?.expense ?? budgetExpense ?? 0;
      const projIncGap = projectedIncomeTotal > 0
        ? Math.max(0, projectedIncomeTotal - m.baseIncome)
        : 0;
      const projExpGap = projectedExpenseTotal > 0
        ? Math.max(0, projectedExpenseTotal - m.baseExpense)
        : 0;
      return {
        yearMonth: ym,
        realIncome: m.baseIncome,
        projIncomeGap: projIncGap,
        projIncomeTotal: projectedIncomeTotal || m.baseIncome,
        realExpense: m.baseExpense,
        projExpenseGap: projExpGap,
        projExpenseTotal: projectedExpenseTotal || m.baseExpense,
        cashBase: m.baseClosingCash,
        phase: 'past' as const,
      };
    }
    if (cmp > 0) {
      return {
        yearMonth: ym,
        realIncome: 0,
        projIncomeGap: m.baseIncome,
        projIncomeTotal: m.baseIncome,
        realExpense: 0,
        projExpenseGap: m.baseExpense,
        projExpenseTotal: m.baseExpense,
        cashBase: m.baseClosingCash,
        phase: 'future' as const,
      };
    }
    // Mes en curso: real parcial + lo que falta para llegar al total proyectado.
    // El total proyectado sale del presupuesto (o del override si existe).
    // Antes caía a baseline.avgIncome/avgExpense (regresión sobre el histórico)
    // cuando no había budget — eso se removió a pedido del usuario.
    const projectedIncomeTotal = override?.income ?? budgetIncome ?? 0;
    const projectedExpenseTotal = override?.expense ?? budgetExpense ?? 0;
    const projIncGap = Math.max(0, projectedIncomeTotal - m.baseIncome);
    const projExpGap = Math.max(0, projectedExpenseTotal - m.baseExpense);
    return {
      yearMonth: ym,
      realIncome: m.baseIncome,
      projIncomeGap: projIncGap,
      projIncomeTotal: projectedIncomeTotal,
      realExpense: m.baseExpense,
      projExpenseGap: projExpGap,
      projExpenseTotal: projectedExpenseTotal,
      cashBase: m.baseClosingCash,
      phase: 'current' as const,
    };
  }), [evaluated.months, currentYm, overrides, projectionByMonth, baseline, budget]);

  const tableRows: CashFlowTableRow[] = useMemo(
    () => evaluated.months.map((m) => {
      const ym = m.yearMonth;
      const cmp = compareYearMonth(ym, currentYm);
      const phase: 'past' | 'current' | 'future' = cmp < 0 ? 'past' : cmp === 0 ? 'current' : 'future';
      const override = overrides[ym];
      const projDetail = projectionByMonth.get(ym);
      const budgetIncome = budgetMonthValue(ym, 'income');
      const budgetExpense = budgetMonthValue(ym, 'expense');

      if (phase === 'past') {
        // En pasado mostramos el real; si budget > real, la diferencia va en
        // la columna "proyectado" para que el usuario vea la variación.
        const budgetIncomeVal = override?.income ?? budgetIncome ?? 0;
        const budgetExpenseVal = override?.expense ?? budgetExpense ?? 0;
        return {
          yearMonth: ym,
          phase,
          realIncome: m.baseIncome,
          realExpense: m.baseExpense,
          projectedIncome: budgetIncomeVal > 0 ? Math.max(0, budgetIncomeVal - m.baseIncome) : 0,
          projectedExpense: budgetExpenseVal > 0 ? Math.max(0, budgetExpenseVal - m.baseExpense) : 0,
          closingCash: m.baseClosingCash,
          projectionDetail: projDetail,
          override,
        };
      }
      if (phase === 'future') {
        return {
          yearMonth: ym,
          phase,
          realIncome: 0,
          realExpense: 0,
          projectedIncome: m.baseIncome,
          projectedExpense: m.baseExpense,
          closingCash: m.baseClosingCash,
          projectionDetail: projDetail,
          override,
        };
      }
      // current — sólo budget o override manual, no baseline.avg*.
      const projIncTotal = override?.income ?? budgetIncome ?? 0;
      const projExpTotal = override?.expense ?? budgetExpense ?? 0;
      return {
        yearMonth: ym,
        phase,
        realIncome: m.baseIncome,
        realExpense: m.baseExpense,
        projectedIncome: Math.max(0, projIncTotal - m.baseIncome),
        projectedExpense: Math.max(0, projExpTotal - m.baseExpense),
        closingCash: m.baseClosingCash,
        projectionDetail: projDetail,
        override,
      };
    }),
    [evaluated.months, currentYm, overrides, projectionByMonth, baseline, budget],
  );

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
        <div className="flex items-center gap-2 flex-wrap">
          <StartingBalanceInput
            value={effectiveStartingBalance}
            isOverride={startingBalanceOverride !== null}
            bankValue={bankStartingBalance}
            onChange={onStartingBalanceChange}
          />
          <button
            onClick={() => setBudgetModalOpen(true)}
            className="flex items-center gap-2 h-10 px-4 rounded-xl border border-[var(--gray-200)] text-[13px] font-medium hover:bg-[var(--gray-50)]"
            style={{ color: budget ? 'var(--success)' : 'var(--gray-950)' }}
          >
            <FileSpreadsheet className="w-4 h-4" />
            {budget ? `Presupuesto ${budget.year}` : 'Cargar presupuesto'}
          </button>
          <button
            onClick={onOpenFlow}
            className="flex items-center gap-2 h-10 px-4 rounded-xl bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary-hover)]"
          >
            <LineChartIcon className="w-4 h-4" />
            Abrir Simulación
          </button>
        </div>
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
          {clients.length > 0 && ' Ingreso proyectado desde catálogo de clientes; egreso desde /AntiguedadSaldos + CARGOs recurrentes.'}
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
                dataKey="projIncomeGap"
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
                dataKey="projExpenseGap"
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

      {/* Monthly editable cash flow table */}
      <CashFlowTable
        rows={tableRows}
        overrides={overrides}
        onOverridesChange={setOverrides}
        title="Flujo de efectivo mensual"
        subtitle="Ajusta manualmente el ingreso o egreso proyectado; la caja se recalcula al instante en el gráfico superior."
        highlightYearMonth={selectedMonth}
        onRowClick={(ym) => setSelectedMonth(ym)}
      />

      <MonthDrilldown
        yearMonth={selectedMonth}
        bankStatements={bankStatements}
        agedBalances={aged}
        companyCode={companyCode}
        baseline={baseline}
        projectionByMonth={projectionByMonth}
        overrides={overrides}
        onOverridesChange={setOverrides}
        tableRows={tableRows}
        today={today}
        onClose={() => setSelectedMonth(null)}
      />

      <BudgetModal
        open={budgetModalOpen}
        budget={budget}
        onClose={() => setBudgetModalOpen(false)}
        onApply={(b) => onBudgetChange(b)}
        onClear={() => onBudgetChange(null)}
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
    projIncomeTotal?: number;
    projExpenseTotal?: number;
    realIncome?: number;
    realExpense?: number;
  };
}

const TOOLTIP_LABELS: Record<string, string> = {
  realIncome: 'Ingresos (real)',
  projIncomeGap: 'Ingresos (proy.)',
  realExpense: 'Egresos (real)',
  projExpenseGap: 'Egresos (proy.)',
  cashBase: 'Caja Final',
};

/**
 * Tooltip del chart mensual. Importante: para "Ingresos (proy.)" y
 * "Egresos (proy.)" mostramos el TOTAL proyectado del mes (lo que se
 * espera cerrar), NO el gap contra lo real. Eso quitaba visibilidad
 * al usuario en el mes en curso.
 */
const MonthTooltip: React.FC<{ active?: boolean; payload?: TooltipPayloadItem[]; label?: string }> = ({
  active, payload, label,
}) => {
  if (!active || !payload || payload.length === 0) return null;
  const ym = label ?? payload[0]?.payload?.yearMonth ?? '';
  const data = payload[0]?.payload;
  const phase = data?.phase;
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
          .map((p) => {
            let displayValue = p.value;
            // Para las barras proyectadas del mes en curso, el valor en el
            // chart es el GAP apilado sobre lo real. En el tooltip queremos
            // que diga el TOTAL proyectado del mes, que es lo que el usuario
            // entiende como "Ingreso proy.".
            if (p.dataKey === 'projIncomeGap' && data?.projIncomeTotal !== undefined) {
              displayValue = data.projIncomeTotal;
            }
            if (p.dataKey === 'projExpenseGap' && data?.projExpenseTotal !== undefined) {
              displayValue = data.projExpenseTotal;
            }
            return (
              <li key={p.dataKey} className="flex items-center justify-between gap-4">
                <span style={{ color: 'var(--gray-600)' }}>{TOOLTIP_LABELS[p.dataKey] ?? p.dataKey}</span>
                <span className="tabular-nums font-medium" style={{ color: 'var(--gray-950)' }}>
                  {fmtCurrency(displayValue)}
                </span>
              </li>
            );
          })}
      </ul>
      <p className="text-[10px] mt-1.5" style={{ color: 'var(--gray-400)' }}>
        Clic para ver el detalle abajo
      </p>
    </div>
  );
};

/**
 * Control para ajustar la caja inicial del mes más antiguo. El valor por
 * defecto sale de la suma de saldoInicial de las cuentas; si difiere del
 * dato real de contabilidad, el usuario lo edita aquí y la caja final se
 * recalcula encadenada en toda la serie.
 */
const StartingBalanceInput: React.FC<{
  value: number;
  isOverride: boolean;
  bankValue: number;
  onChange: (v: number | null) => void;
}> = ({ value, isOverride, bankValue, onChange }) => {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  if (editing) {
    const finish = (save: boolean) => {
      setEditing(false);
      if (!save) return;
      const t = draft.replace(/[$,\s]/g, '');
      if (t === '') { onChange(null); return; }
      const n = Number(t);
      if (Number.isFinite(n)) onChange(n);
    };
    return (
      <div className="flex items-center gap-1 h-10 px-3 rounded-xl border border-[var(--primary)] bg-white">
        <span className="text-[11px]" style={{ color: 'var(--gray-400)' }}>Caja inicial</span>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
          }}
          className="tabular-nums text-right bg-transparent outline-none text-[13px] w-36"
          placeholder={bankValue.toFixed(0)}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => { setDraft(String(Math.round(value))); setEditing(true); }}
      className="flex items-center gap-2 h-10 px-3 rounded-xl border border-[var(--gray-200)] bg-white hover:bg-[var(--gray-50)]"
      title={
        isOverride
          ? `Override manual. Banco reporta ${fmtCurrency(bankValue)}. Clic para editar.`
          : 'Caja inicial = suma de saldoInicial reportado por JDE. Clic para editar.'
      }
    >
      <span className="text-[11px]" style={{ color: 'var(--gray-400)' }}>Caja inicial</span>
      <span className="tabular-nums text-[13px] font-medium" style={{ color: 'var(--gray-950)' }}>
        {fmtCurrency(value)}
      </span>
      {isOverride && (
        <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full" style={{ background: 'var(--warning-muted)', color: 'var(--warning)' }}>
          Manual
        </span>
      )}
    </button>
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
  /**
   * Caja inicial (pesos) para el primer mes histórico. Si es undefined se
   * usa la suma de saldoInicial reportado por JDE. Esta es la base del
   * encadenado: todas las cajas finales salen de la fórmula
   * caja_inicial + ingresos - egresos.
   */
  startingBalance?: number;
}

export interface ComputeOutput {
  base: CashFlowMonth[];
  baseline: { avgIncome: number; avgExpense: number };
  projection: ReturnType<typeof buildMonthlyProjection>;
}

/**
 * Caja inicial derivada del banco: suma de saldoInicial de todas las
 * cuentas en el scope. Si una cuenta no reporta saldoInicial, vale 0 y
 * se refleja como tal en la caja encadenada; el usuario puede sobreescribir
 * este valor desde la UI para ajustarlo al dato real de contabilidad.
 */
export function computeBankStartingBalance(statements: BankAccountStatement[]): number {
  return statements.reduce((s, acc) => s + (acc.saldoInicial ?? 0), 0);
}

export function computeBaseCashFlow(inputs: ComputeInputs): ComputeOutput {
  const { bankStatements, aged, clients, providers, cxpRecords, assumptions, companyCode, today, overrides, startingBalance, budget } = inputs;
  const filtered = companyCode === 'all' || !companyCode
    ? bankStatements
    : bankStatements.filter((s) => s.cia === companyCode);
  // CXP ya filtrado por compañía — se suma al aged cuando hay records
  // cargados para el mismo rango. Nos da granularidad per-factura para la
  // proyección per-proveedor.
  const filteredCxp = companyCode === 'all' || !companyCode
    ? cxpRecords
    : cxpRecords.filter((r) => r.cia === companyCode);
  const combinedAged: AgedBalanceRecord[] = aged.length > 0
    ? aged
    : filteredCxp as unknown as AgedBalanceRecord[];

  const historical = buildHistoricalMonths(filtered);

  const todayYm = toYearMonth(today);

  // Horizonte: diciembre del año en curso.
  // El usuario pidió explícitamente que el flujo mensual cubra enero-diciembre
  // y que las proyecciones salgan únicamente del CSV de presupuesto, sin
  // regresión lineal ni promedios móviles. Cortamos el horizonte al fin del
  // año calendario actual en vez de los 12 meses rolling que teníamos antes.
  const todayYear = Number(todayYm.slice(0, 4));
  const endOfYearYm = `${todayYear}-12`;
  const lastHistoricalYm = historical.length > 0
    ? historical[historical.length - 1].yearMonth
    : todayYm;
  const firstFutureYm = addMonths(
    compareYearMonth(lastHistoricalYm, todayYm) > 0 ? lastHistoricalYm : todayYm,
    1,
  );
  // Si el horizonte calendario ya quedó atrás del último histórico, no hay
  // proyección — sólo rendiremos el histórico.
  const lastFutureYm = compareYearMonth(endOfYearYm, firstFutureYm) >= 0
    ? endOfYearYm
    : null;

  // La proyección per-cliente / per-proveedor se mantiene para alimentar los
  // drilldowns mensuales (vista detallada del mes en curso). No se usa ya
  // para la línea de caja: esa sale del presupuesto.
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
    budget,
  });

  // Baseline queda expuesto como 0 — ya no se calcula linear regression.
  const baseline = { avgIncome: 0, avgExpense: 0 };

  // ── Encadenado de caja con fórmula simple y predecible ──────────────
  // caja_final[m] = caja_final[m-1] + ingresos[m] - egresos[m]
  //
  // Los meses históricos SIEMPRE usan sus ingresos/egresos REALES (del
  // banco). No sustituimos con el budget — el budget sólo aparece como
  // overlay visual (barra rayada) cuando excede lo real del mes, para
  // que el usuario pueda ver la variación vs presupuesto.
  //
  // Para la caja inicial, si el usuario no dio override manual, usamos
  // la declarada en el budget cuando aplica; si no, la suma de
  // saldoInicial de las cuentas.
  const baseStart = typeof startingBalance === 'number'
    ? startingBalance
    : (budget?.openingCash?.[0] ?? computeBankStartingBalance(filtered));
  const historicalChained: CashFlowMonth[] = [];
  let runningHist = baseStart;
  for (const m of historical) {
    runningHist = runningHist + m.income - m.expense;
    historicalChained.push({ ...m, closingCash: runningHist });
  }

  // Proyección budget-only para los meses futuros. Si el usuario cargó un
  // override manual del mes, ese valor manda; si no, toma el valor directo
  // del presupuesto. Si no hay presupuesto, el mes queda en 0 — la UI debe
  // mostrar claramente ese estado para que el usuario cargue el CSV.
  const months: CashFlowMonth[] = [...historicalChained];
  let running = historicalChained.length > 0
    ? historicalChained[historicalChained.length - 1].closingCash
    : baseStart;
  if (lastFutureYm !== null) {
    let cursor = firstFutureYm;
    while (compareYearMonth(cursor, lastFutureYm) <= 0) {
      const monthIndex = Number(cursor.slice(5, 7)) - 1;
      const budgetIncome = budget?.incomeTotal?.[monthIndex] ?? 0;
      const budgetExpense = budget?.expenseTotal?.[monthIndex] ?? 0;
      const ov = overrides[cursor];
      const income = ov?.income ?? budgetIncome;
      const expense = ov?.expense ?? budgetExpense;
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

export default Dashboard;
