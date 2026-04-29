import React, { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart,
  Line,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Customized,
} from 'recharts';
import {
  TrendingUp, TrendingDown, Wallet, AlertTriangle, LineChart as LineChartIcon,
  ShieldAlert,
} from 'lucide-react';
import type { Client, Provider, CashFlowAssumptions } from '../domain/types';
import { computeMinimumOperatingExpense, floorForMonth } from '../domain/operatingProjectionMinimumExpense';
import type { CXPRecord } from '../domain/persistence';
import type { Budget } from '../domain/budget';
import { fmtCompact, fmtCurrency, fmtYearMonthShort, fmtYearMonthLong } from '../formatters';
import {
  buildHistoricalMonths,
  toYearMonth,
  addMonths,
  compareYearMonth,
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
import PageHeader from './ui/PageHeader';

interface DashboardProps {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  onOpenFlow: () => void;
  /** Caja inicial fija por decisión de negocio — se muestra pero no se edita. */
  startingBalance: number;
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
  companyCode, bankStatements, clients, providers, cxpRecords, assumptions,
  budget, onOpenFlow,
  startingBalance,
}) => {
  const [aged, setAged] = useState<AgedBalanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<ProjectionOverrides>(() => loadOverrides());

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

  // Gasto mínimo operativo: proveedores de Operación + nómina del presupuesto.
  // Nómina y finiquitos son obligaciones contractuales no-pausables, igual que
  // los proveedores críticos, así que se suman al piso operativo del Dashboard.
  const minimumExpense = useMemo(
    () => computeMinimumOperatingExpense(providers, budget),
    [providers, budget],
  );

  const { base, baseline, projection } = useMemo(
    () => computeBaseCashFlow({
      bankStatements, aged, clients, providers, cxpRecords, assumptions,
      companyCode, today, overrides, budget,
      startingBalance,
    }),
    [bankStatements, aged, clients, providers, cxpRecords, assumptions, companyCode, today, overrides, startingBalance, budget],
  );

  // Antes el Dashboard pasaba por `evaluateCashFlow` (motor de Simulación) con
  // un array vacío de propuestas. Tras eliminar el módulo de Simulación basta
  // con derivar el shape consumido por la UI directamente desde la base.
  const evaluated = useMemo(() => ({
    months: base.map((m) => ({
      yearMonth: m.yearMonth,
      isHistorical: m.isHistorical,
      baseIncome: m.income,
      baseExpense: m.expense,
      baseClosingCash: m.closingCash,
    })),
  }), [base]);

  const currentYear = new Date().getFullYear();
  const currentYm = toYearMonth(today);
  const monthsThisYear = evaluated.months.filter((m) => m.yearMonth.startsWith(String(currentYear)));

  const histThisYear = monthsThisYear.filter((m) => m.isHistorical);
  const ingresosYtd = histThisYear.reduce((s, m) => s + m.baseIncome, 0);
  const egresosYtd = histThisYear.reduce((s, m) => s + m.baseExpense, 0);
  const monthsElapsed = histThisYear.length;
  const ingresosAvgMonth = monthsElapsed > 0 ? ingresosYtd / monthsElapsed : 0;
  const egresosAvgMonth = monthsElapsed > 0 ? egresosYtd / monthsElapsed : 0;
  const flujoNetoYtd = ingresosYtd - egresosYtd;
  const margenYtd = ingresosYtd > 0 ? flujoNetoYtd / ingresosYtd : 0;
  const cajaInicial = (() => {
    const firstHist = evaluated.months.find((m) => m.isHistorical);
    if (firstHist) {
      // Reconstruir caja inicial: closing - net del primer mes
      return firstHist.baseClosingCash - firstHist.baseIncome + firstHist.baseExpense;
    }
    return 0;
  })();
  const cajaActual = (() => {
    const currentMonth = evaluated.months.find((m) => m.yearMonth === currentYm);
    if (currentMonth) return currentMonth.baseClosingCash;
    const lastHist = [...evaluated.months].reverse().find((m) => m.isHistorical);
    return lastHist?.baseClosingCash ?? 0;
  })();
  const cajaDelta = cajaActual - cajaInicial;
  const cajaDeltaPct = cajaInicial !== 0 ? cajaDelta / cajaInicial : 0;

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

  /**
   * Para un mes dado, parte el egreso total en 3 segmentos apilables:
   *   1. floorPortion (yellow rayado) — piso operativo carved out at the bottom
   *   2. realAboveFloor (red solid) — egreso real arriba del piso
   *   3. projGapAboveFloor (red striped) — proyectado arriba del piso
   * La suma de los 3 = realExpense + projExpenseGap (sin cambios en altura total).
   */
  const partitionExpense = (realExpense: number, projGap: number, ym: string) => {
    const floor = floorForMonth(ym, minimumExpense.providersMonthly, budget);
    const total = realExpense + projGap;
    const floorPortion = Math.max(0, Math.min(floor, total));
    const carvedFromReal = Math.min(realExpense, floorPortion);
    const carvedFromProj = floorPortion - carvedFromReal;
    return {
      gastoMinFloor: floorPortion,
      realExpenseAboveFloor: Math.max(0, realExpense - carvedFromReal),
      projExpenseGapAboveFloor: Math.max(0, projGap - carvedFromProj),
      monthlyFloor: floor,
    };
  };

  const chartData = useMemo(() => evaluated.months.map((m) => {
    const ym = m.yearMonth;
    const cmp = compareYearMonth(ym, currentYm);
    const override = overrides[ym];
    const budgetIncome = budgetMonthValue(ym, 'income');
    const budgetExpense = budgetMonthValue(ym, 'expense');

    if (cmp < 0) {
      const projectedIncomeTotal = override?.income ?? budgetIncome ?? 0;
      const projectedExpenseTotal = override?.expense ?? budgetExpense ?? 0;
      const projIncGap = projectedIncomeTotal > 0
        ? Math.max(0, projectedIncomeTotal - m.baseIncome)
        : 0;
      const projExpGap = projectedExpenseTotal > 0
        ? Math.max(0, projectedExpenseTotal - m.baseExpense)
        : 0;
      const parts = partitionExpense(m.baseExpense, projExpGap, ym);
      const projIncomeOverrun =
        projectedIncomeTotal > 0 && m.baseIncome > projectedIncomeTotal
          ? projectedIncomeTotal
          : null;
      const projExpenseOverrun =
        projectedExpenseTotal > 0 && m.baseExpense > projectedExpenseTotal
          ? projectedExpenseTotal
          : null;
      return {
        yearMonth: ym,
        realIncome: m.baseIncome,
        projIncomeGap: projIncGap,
        projIncomeTotal: projectedIncomeTotal || m.baseIncome,
        realExpense: m.baseExpense,
        projExpenseGap: projExpGap,
        projExpenseTotal: projectedExpenseTotal || m.baseExpense,
        ...parts,
        projIncomeOverrun,
        projExpenseOverrun,
        cashBase: m.baseClosingCash,
        phase: 'past' as const,
      };
    }
    if (cmp > 0) {
      const parts = partitionExpense(0, m.baseExpense, ym);
      return {
        yearMonth: ym,
        realIncome: 0,
        projIncomeGap: m.baseIncome,
        projIncomeTotal: m.baseIncome,
        realExpense: 0,
        projExpenseGap: m.baseExpense,
        projExpenseTotal: m.baseExpense,
        ...parts,
        projIncomeOverrun: null,
        projExpenseOverrun: null,
        cashBase: m.baseClosingCash,
        phase: 'future' as const,
      };
    }
    const projectedIncomeTotal = override?.income ?? budgetIncome ?? 0;
    const projectedExpenseTotal = override?.expense ?? budgetExpense ?? 0;
    const projIncGap = Math.max(0, projectedIncomeTotal - m.baseIncome);
    const projExpGap = Math.max(0, projectedExpenseTotal - m.baseExpense);
    const parts = partitionExpense(m.baseExpense, projExpGap, ym);
    return {
      yearMonth: ym,
      realIncome: m.baseIncome,
      projIncomeGap: projIncGap,
      projIncomeTotal: projectedIncomeTotal,
      realExpense: m.baseExpense,
      projExpenseGap: projExpGap,
      projExpenseTotal: projectedExpenseTotal,
      ...parts,
      projIncomeOverrun: null,
      projExpenseOverrun: null,
      cashBase: m.baseClosingCash,
      phase: 'current' as const,
    };
  }), [evaluated.months, currentYm, overrides, projectionByMonth, baseline, budget, minimumExpense.providersMonthly]);

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
          <pattern id="hatchMinimum" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
            <rect width="8" height="8" fill="#FEF3C7" />
            <line x1="0" y1="0" x2="0" y2="8" stroke="#F59E0B" strokeWidth="3" opacity="0.95" />
          </pattern>
        </defs>
      </svg>
      {/* Color sólido del piso operativo para meses pasados (real ya pagado). */}

      <PageHeader
        title="Dashboard"
        actions={
          <>
            <StartingBalanceDisplay value={startingBalance} />
            <button
              onClick={onOpenFlow}
              className="flex items-center gap-2 h-10 px-4 rounded-xl bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary-hover)]"
            >
              <LineChartIcon className="w-4 h-4" strokeWidth={1.5} />
              Abrir Planeación
            </button>
          </>
        }
      />

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
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label={`Ingresos YTD ${currentYear}`}
          value={ingresosYtd}
          icon={<TrendingUp className="w-4 h-4" />}
          color="var(--success)"
          sublabel={monthsElapsed > 0 ? `${fmtCompact(ingresosAvgMonth)} / mes promedio` : undefined}
          breakdown={monthsElapsed > 0 ? [
            { label: 'Meses transcurridos', value: String(monthsElapsed) },
            { label: 'Margen neto', value: `${(margenYtd * 100).toFixed(1)}%`, valueColor: margenYtd >= 0 ? 'var(--success)' : 'var(--danger)' },
          ] : undefined}
        />
        <KpiCard
          label={`Egresos YTD ${currentYear}`}
          value={egresosYtd}
          icon={<TrendingDown className="w-4 h-4" />}
          color="var(--danger)"
          sublabel={monthsElapsed > 0 ? `${fmtCompact(egresosAvgMonth)} / mes promedio` : undefined}
          breakdown={monthsElapsed > 0 ? [
            { label: 'Vs Ingresos', value: `${ingresosYtd > 0 ? ((egresosYtd / ingresosYtd) * 100).toFixed(1) : '—'}%` },
            { label: 'Flujo neto YTD', value: fmtCompact(flujoNetoYtd), valueColor: flujoNetoYtd >= 0 ? 'var(--success)' : 'var(--danger)' },
          ] : undefined}
        />
        <KpiCard
          label="Caja Actual"
          value={cajaActual}
          icon={<Wallet className="w-4 h-4" />}
          color="var(--gray-950)"
          sublabel={cajaInicial !== 0
            ? `${cajaDelta >= 0 ? '+' : ''}${fmtCompact(cajaDelta)} vs inicial (${(cajaDeltaPct * 100).toFixed(1)}%)`
            : undefined}
          breakdown={[
            { label: 'Caja inicial año', value: fmtCompact(cajaInicial) },
            {
              label: 'Runway aprox.',
              value: minimumExpense.totalMonthly > 0
                ? `${(cajaActual / minimumExpense.totalMonthly).toFixed(1)} meses`
                : '—',
              valueColor: cajaActual / Math.max(1, minimumExpense.totalMonthly) < 1
                ? 'var(--danger)'
                : cajaActual / minimumExpense.totalMonthly < 3
                ? 'var(--warning)'
                : 'var(--success)',
            },
          ]}
        />
        <MinimumExpenseKpi
          monthly={minimumExpense.totalMonthly}
          annual={minimumExpense.totalAnnual}
          providersMonthly={minimumExpense.providersMonthly}
          payrollMonthly={minimumExpense.payrollMonthly}
          criticalCount={minimumExpense.criticalCount}
        />
      </div>

      {/* Cash chart */}
      <div className="rounded-2xl border border-[var(--gray-200)] bg-white p-5">
        <h2 className="text-[15px] font-semibold tracking-tight mb-1" style={{ color: 'var(--gray-950)' }}>
          Flujo mensual
        </h2>
        <p className="text-[11px] mb-4" style={{ color: 'var(--gray-400)' }}>
          Barra sólida = real · Barra de líneas = proyectado · Línea punteada = nivel proyectado cuando el real lo excedió. Haz clic en un mes para ver el detalle.
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
              {/* Piso operativo — base del stack de egresos.
                  Sólido amarillo para meses pasados (real, ya ejecutado).
                  Rayado amarillo para meses en curso/futuros (proyectado/forecast).
                  fill default es amarillo sólido para que el legend lo muestre correctamente. */}
              <Bar
                dataKey="gastoMinFloor"
                stackId="expense"
                fill="#FCD34D"
                stroke="#F59E0B"
                strokeWidth={1.5}
                name="Piso operativo"
                radius={[0, 0, 0, 0]}
                cursor="pointer"
                legendType="square"
              >
                {chartData.map((row) => (
                  <Cell
                    key={`floor-${row.yearMonth}`}
                    fill={row.phase === 'past' ? '#FCD34D' : 'url(#hatchMinimum)'}
                  />
                ))}
              </Bar>
              <Bar
                dataKey="realExpenseAboveFloor"
                stackId="expense"
                fill={CHART_COLORS.expense}
                name="Egresos (real)"
                radius={[0, 0, 0, 0]}
                cursor="pointer"
              />
              <Bar
                dataKey="projExpenseGapAboveFloor"
                stackId="expense"
                fill="url(#hatchExpense)"
                stroke={CHART_COLORS.expensePattern}
                strokeWidth={1}
                name="Egresos (proy.)"
                radius={[4, 4, 0, 0]}
                cursor="pointer"
              />
              <Customized component={OverrunMarkers} />
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
        projectionByMonth={projectionByMonth}
        overrides={overrides}
        onOverridesChange={setOverrides}
        tableRows={tableRows}
        today={today}
        onClose={() => setSelectedMonth(null)}
      />

      {/* Monthly editable cash flow table — abajo del detalle del mes seleccionado.
          Incluye botón para descargar todo el flujo como Excel. */}
      <CashFlowTable
        rows={tableRows}
        overrides={overrides}
        onOverridesChange={setOverrides}
        title="Flujo de efectivo mensual"
        subtitle="Ajusta manualmente el ingreso o egreso proyectado; la caja se recalcula al instante en el gráfico superior."
        highlightYearMonth={selectedMonth}
        onRowClick={(ym) => setSelectedMonth(ym)}
        onDownloadExcel={() => downloadCashFlowExcel(chartData, minimumExpense)}
      />
    </div>
  );
};

/** Descarga el flujo mensual como Excel con todas las columnas relevantes. */
async function downloadCashFlowExcel(
  chartData: Array<{
    yearMonth: string;
    realIncome: number;
    projIncomeGap: number;
    projIncomeTotal: number;
    realExpense: number;
    projExpenseGap: number;
    projExpenseTotal: number;
    gastoMinFloor: number;
    realExpenseAboveFloor: number;
    projExpenseGapAboveFloor: number;
    monthlyFloor: number;
    cashBase: number;
    phase: 'past' | 'current' | 'future';
  }>,
  minimumExpense: { totalMonthly: number; providersMonthly: number; payrollMonthly: number },
): Promise<void> {
  const ExcelMod = await import('exceljs');
  const ExcelRuntime = (((ExcelMod as unknown) as { default?: typeof ExcelMod }).default ?? ExcelMod);
  const wb = new ExcelRuntime.Workbook();
  wb.creator = 'Senda · Midas';
  wb.created = new Date();

  const ws = wb.addWorksheet('Flujo mensual', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Mes', key: 'mes', width: 12 },
    { header: 'Fase', key: 'fase', width: 12 },
    { header: 'Ingresos (real)', key: 'ingReal', width: 18, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Ingresos (proy.)', key: 'ingProy', width: 18, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Egresos (real)', key: 'egReal', width: 18, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Egresos (proy.)', key: 'egProy', width: 18, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Piso operativo', key: 'piso', width: 18, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Egreso total', key: 'egTotal', width: 18, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Flujo neto', key: 'neto', width: 18, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Caja final', key: 'caja', width: 18, style: { numFmt: '"$"#,##0.00' } },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };

  const phaseLabel: Record<string, string> = {
    past: 'Histórico',
    current: 'En curso',
    future: 'Proyectado',
  };

  for (const r of chartData) {
    const ingResolved = r.realIncome > 0 ? r.realIncome : r.projIncomeTotal;
    const egResolved = r.realExpense + r.projExpenseGap;
    const row = ws.addRow({
      mes: r.yearMonth,
      fase: phaseLabel[r.phase] ?? r.phase,
      ingReal: r.realIncome,
      ingProy: r.projIncomeTotal,
      egReal: r.realExpense,
      egProy: r.projExpenseTotal,
      piso: r.monthlyFloor,
      egTotal: egResolved,
      neto: ingResolved - egResolved,
      caja: r.cashBase,
    });
    // Highlight piso operativo column in yellow
    row.getCell('piso').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    row.getCell('piso').font = { color: { argb: 'FF92400E' }, bold: true };
  }

  // Hoja de resumen del piso operativo
  const wsMin = wb.addWorksheet('Piso operativo');
  wsMin.columns = [
    { header: 'Concepto', key: 'concepto', width: 32 },
    { header: 'Monto mensual', key: 'monto', width: 20, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Anualizado', key: 'anual', width: 20, style: { numFmt: '"$"#,##0.00' } },
  ];
  wsMin.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  wsMin.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  wsMin.addRow({ concepto: 'Proveedores de Operación', monto: minimumExpense.providersMonthly, anual: minimumExpense.providersMonthly * 12 });
  wsMin.addRow({ concepto: 'Nómina + finiquitos', monto: minimumExpense.payrollMonthly, anual: minimumExpense.payrollMonthly * 12 });
  const totalRow = wsMin.addRow({ concepto: 'TOTAL piso operativo', monto: minimumExpense.totalMonthly, anual: minimumExpense.totalMonthly * 12 });
  totalRow.font = { bold: true };
  totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `flujo-mensual-${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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
    projIncomeOverrun?: number | null;
    projExpenseOverrun?: number | null;
  };
}

const TOOLTIP_LABELS: Record<string, string> = {
  realIncome: 'Ingresos (real)',
  projIncomeGap: 'Ingresos (proy.)',
  realExpense: 'Egresos (real)',
  projExpenseGap: 'Egresos (proy.)',
  gastoMinFloor: 'Piso operativo',
  realExpenseAboveFloor: 'Egresos (real)',
  projExpenseGapAboveFloor: 'Egresos (proy.)',
  cashBase: 'Caja Final',
};

/**
 * Tooltip del chart mensual. Importante: para "Ingresos (proy.)" y
 * "Egresos (proy.)" mostramos el TOTAL proyectado del mes (lo que se
 * espera cerrar), NO el gap contra lo real. Eso quitaba visibilidad
 * al usuario en el mes en curso.
 */
/**
 * Marca el nivel del proyectado en barras de meses pasados donde el real
 * excedió al proyectado. Usa `Customized` para reusar la geometría exacta
 * de las barras ya renderizadas y el scale del eje y.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OverrunMarkers: React.FC<any> = (props) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { yAxisMap, formattedGraphicalItems } = props as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const incomeBar = formattedGraphicalItems?.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gi: any) => gi?.item?.props?.dataKey === 'projIncomeGap',
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const expenseBar = formattedGraphicalItems?.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gi: any) => gi?.item?.props?.dataKey === 'projExpenseGapAboveFloor',
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const yScale = (Object.values(yAxisMap ?? {})[0] as any)?.scale;
  if (!yScale) return null;

  const lines: React.ReactNode[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  incomeBar?.props?.data?.forEach((bar: any, idx: number) => {
    const v = bar?.payload?.projIncomeOverrun;
    if (v == null) return;
    const y = yScale(v);
    lines.push(
      <line
        key={`oi-${idx}`}
        x1={bar.x}
        x2={bar.x + bar.width}
        y1={y}
        y2={y}
        stroke={CHART_COLORS.incomePattern}
        strokeWidth={2}
        strokeDasharray="3 3"
      />,
    );
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expenseBar?.props?.data?.forEach((bar: any, idx: number) => {
    const v = bar?.payload?.projExpenseOverrun;
    if (v == null) return;
    const y = yScale(v);
    lines.push(
      <line
        key={`oe-${idx}`}
        x1={bar.x}
        x2={bar.x + bar.width}
        y1={y}
        y2={y}
        stroke={CHART_COLORS.expensePattern}
        strokeWidth={2}
        strokeDasharray="3 3"
      />,
    );
  });
  return <g>{lines}</g>;
};

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
            // Para los segmentos de la nueva descomposición (piso + above):
            // muestran el monto TOTAL de su categoría, no la porción del bar.
            if (p.dataKey === 'realExpenseAboveFloor' && data?.realExpense !== undefined) {
              displayValue = data.realExpense;
            }
            if (p.dataKey === 'projExpenseGapAboveFloor' && data?.projExpenseTotal !== undefined) {
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
      {data?.phase === 'past' && data?.projIncomeOverrun != null && (
        <p className="text-[10px] mt-1" style={{ color: CHART_COLORS.incomePattern }}>
          Ingreso real excedió proyectado por {fmtCurrency((data.realIncome ?? 0) - data.projIncomeOverrun)}
        </p>
      )}
      {data?.phase === 'past' && data?.projExpenseOverrun != null && (
        <p className="text-[10px]" style={{ color: CHART_COLORS.expensePattern }}>
          Egreso real excedió proyectado por {fmtCurrency((data.realExpense ?? 0) - data.projExpenseOverrun)}
        </p>
      )}
      <p className="text-[10px] mt-1.5" style={{ color: 'var(--gray-400)' }}>
        Clic para ver el detalle abajo
      </p>
    </div>
  );
};

const StartingBalanceDisplay: React.FC<{ value: number }> = ({ value }) => (
  <div
    className="flex items-center gap-2 h-10 px-3 rounded-xl border border-[var(--gray-200)] bg-white"
    title="Caja inicial fija por decisión de negocio."
  >
    <span className="text-[11px]" style={{ color: 'var(--gray-400)' }}>Caja inicial</span>
    <span className="tabular-nums text-[13px] font-medium" style={{ color: 'var(--gray-950)' }}>
      {fmtCurrency(value)}
    </span>
  </div>
);

interface KpiBreakdownItem {
  label: string;
  value: string;
  valueColor?: string;
}

const KpiCard: React.FC<{
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
  sublabel?: string;
  breakdown?: KpiBreakdownItem[];
}> = ({ label, value, icon, color, sublabel, breakdown }) => (
  <div className="rounded-xl border border-[var(--gray-200)] bg-white p-4 flex flex-col">
    <div className="flex items-center justify-between mb-2">
      <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--gray-400)' }}>
        {label}
      </p>
      <span style={{ color }}>{icon}</span>
    </div>
    <p className="text-[20px] font-semibold tabular-nums leading-tight" style={{ color }}>
      {fmtCurrency(value)}
    </p>
    {sublabel && (
      <p className="text-[10px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
        {sublabel}
      </p>
    )}
    {breakdown && breakdown.length > 0 && (
      <div className="mt-2.5 space-y-1 border-t border-[var(--gray-100)] pt-2">
        {breakdown.map((item, idx) => (
          <div key={idx} className="flex items-center justify-between text-[11px]">
            <span style={{ color: 'var(--gray-500)' }}>{item.label}</span>
            <span
              className="font-medium tabular-nums"
              style={{ color: item.valueColor ?? 'var(--gray-950)' }}
            >
              {item.value}
            </span>
          </div>
        ))}
      </div>
    )}
  </div>
);

/**
 * KPI especial del piso operativo. Se renderiza con fondo amarillo rayado
 * (mismo lenguaje visual que la línea amarilla de la proyección operativa).
 */
const MinimumExpenseKpi: React.FC<{
  monthly: number;
  annual: number;
  providersMonthly: number;
  payrollMonthly: number;
  criticalCount: number;
}> = ({ monthly, annual, providersMonthly, payrollMonthly, criticalCount }) => (
  <div
    className="relative overflow-hidden rounded-xl border-2 border-yellow-300 bg-yellow-50 p-4"
    style={{
      backgroundImage: `repeating-linear-gradient(
        45deg,
        rgba(251, 191, 36, 0.12) 0px,
        rgba(251, 191, 36, 0.12) 8px,
        transparent 8px,
        transparent 16px
      )`,
    }}
    title="Piso operativo: proveedores de Operación + nómina/finiquitos. Es el monto que necesitas cubrir cada mes para no afectar operación."
  >
    <div className="flex items-center justify-between mb-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-yellow-800">
        Gasto mín. operativo
      </p>
      <span className="text-yellow-700">
        <ShieldAlert className="w-4 h-4" />
      </span>
    </div>
    <p className="text-[20px] font-semibold tabular-nums text-yellow-900 leading-tight">
      {fmtCurrency(monthly)}
      <span className="text-[11px] font-normal text-yellow-800/80 ml-1">/ mes</span>
    </p>
    <p className="text-[10px] text-yellow-800/70 mt-0.5">
      {fmtCompact(annual)} anualizado
    </p>
    {/* Desglose con jerarquía clara: una línea por componente */}
    <div className="mt-2.5 space-y-1 border-t border-yellow-200/70 pt-2">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-yellow-800/80">
          Proveedores Operación
          <span className="text-yellow-700/60 ml-1">· {criticalCount}</span>
        </span>
        <span className="font-medium tabular-nums text-yellow-900">
          {fmtCompact(providersMonthly)}
        </span>
      </div>
      {payrollMonthly > 0 && (
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-yellow-800/80">
            Nómina + finiquitos
          </span>
          <span className="font-medium tabular-nums text-yellow-900">
            {fmtCompact(payrollMonthly)}
          </span>
        </div>
      )}
    </div>
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
