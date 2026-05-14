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
import { computeMinimumOperatingExpense, floorForMonth } from '../domain/minimumOperatingExpense';
import type { CXPRecord } from '../domain/persistence';
import type { Budget } from '../domain/budget';
import { fmtCompact, fmtCurrency, fmtYearMonthShort, fmtYearMonthLong } from '../formatters';
import {
  toYearMonth,
  compareYearMonth,
} from '../domain/cashFlowEngine';
import {
  type ProjectionOverrides,
  type MonthlyProjection,
} from '../domain/projectionEngine';
import {
  computeBaseCashFlow,
  computeBankStartingBalance,
} from '../domain/dashboardEngine';
import type { CashFlowMonth } from '../types';
import {
  fetchAgedBalances,
  type BankAccountStatement,
  type AgedBalanceRecord,
} from '../services/jde';
import type { RealReconciliationResult } from '../domain/realReconciliationEngine';
import MonthDrilldown from './MonthDrilldown';
import { type CashFlowTableRow } from './CashFlowTable';
import PageHeader from './ui/PageHeader';
import SharedKpiCard from './ui/KpiCard';
import EmptyState from '../modules/shared-finance/components/EmptyState';
import { useNavigateToTab } from '../modules/shared-finance/components/NavigationContext';
import {
  toneByDelta,
  toneByFloor,
} from '../modules/shared-finance/components/tone';

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
  /**
   * Resultado pre-computado del cruce cobranza ↔ bancos. Cuando llega
   * (con datos reales JDE + bancos cargados), el dashboard muestra el
   * KPI "Cobranza cruzada" arriba; si no, ese KPI no aparece.
   */
  cobranzaReconciliation?: RealReconciliationResult;
  /**
   * Costo real de nómina del mes en curso traído de TRESS. Cuando se
   * provee > 0, el KPI de gasto mínimo añade una sub-línea de referencia
   * "Real TRESS" para que el usuario compare contra el budget. NO
   * reemplaza el `payrollMonthly` que sale del presupuesto: ese sigue
   * siendo el piso operativo conservador.
   */
  payrollMonthlyActualJDE?: number;
}

/*
 * Chart hex literals. Recharts forwards these to SVG `stroke=` / `fill=`
 * attributes which can't resolve `var(--token)`. Dark-mode adjustments
 * for stroke colors (cash line, grid) live as `!important` overrides in
 * index.css targeting `.recharts-line-curve` / `.recharts-cartesian-grid`
 * inside `html.dark`. Semantic fills (success/danger) stay saturated
 * enough to read on both light and dark slate canvases.
 */
const CHART_COLORS = {
  income:         '#16a34a',
  incomePattern:  '#22c55e',
  incomeBg:       '#dcfce7',
  expense:        '#dc2626',
  expensePattern: '#ef4444',
  expenseBg:      '#fee2e2',
  cash:           '#1e293b',
} as const;

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
  cobranzaReconciliation,
  payrollMonthlyActualJDE,
}) => {
  const goTo = useNavigateToTab();
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

  // Gasto mínimo operativo: proveedores de Operación calculados desde catálogo.
  // La nómina real se modela en la proyección operativa cuando existe fuente
  // TRESS/JDE; el Dashboard no toma nómina desde una plantilla.
  const minimumExpense = useMemo(
    () => computeMinimumOperatingExpense(providers, null),
    [providers],
  );

  const { base, baseline, projection } = useMemo(
    () => computeBaseCashFlow({
      bankStatements, aged, clients, providers, cxpRecords, assumptions,
      companyCode, today, overrides, budget,
      startingBalance,
    }),
    [bankStatements, aged, clients, providers, cxpRecords, assumptions, companyCode, today, overrides, budget, startingBalance],
  );

  // Antes el Dashboard pasaba por `evaluateCashFlow` (motor de Simulación) con
  // un array vacío de propuestas. Tras eliminar el módulo de Simulación basta
  // con derivar el shape consumido por la UI directamente desde la base.
  // Rellenamos con meses-cero los huecos del año natural para que el chart
  // mensual cubra Ene–Dic incluso cuando no hay datos bancarios para algunos
  // meses (típico cuando el primer estado de cuenta arranca en abril).
  const evaluated = useMemo(() => {
    const mapped = base.map((m) => ({
      yearMonth: m.yearMonth,
      isHistorical: m.isHistorical,
      baseIncome: m.income,
      baseExpense: m.expense,
      baseClosingCash: m.closingCash,
    }));
    if (mapped.length === 0) return { months: mapped };
    const presentYears = new Set(mapped.map((m) => m.yearMonth.slice(0, 4)));
    presentYears.add(String(new Date().getFullYear()));
    const byYm = new Map(mapped.map((m) => [m.yearMonth, m]));
    const filled: typeof mapped = [];
    let lastClosing = 0;
    const years = Array.from(presentYears).sort();
    for (const y of years) {
      for (let mo = 1; mo <= 12; mo++) {
        const ym = `${y}-${String(mo).padStart(2, '0')}`;
        const existing = byYm.get(ym);
        if (existing) {
          lastClosing = existing.baseClosingCash;
          filled.push(existing);
        } else {
          filled.push({
            yearMonth: ym,
            isHistorical: false,
            baseIncome: 0,
            baseExpense: 0,
            baseClosingCash: lastClosing,
          });
        }
      }
    }
    return { months: filled };
  }, [base]);

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

  // Datos del chart: cada mes lleva ingresos/egresos partidos en real +
  // proyectado. La parte proyectada sale de lógica operativa
  // (clientes, CXP/JDE, proveedores y overrides manuales).
  const operationalMonthValue = (
    ym: string,
    kind: 'income' | 'expense',
  ): number | null => {
    const projected = projectionByMonth.get(ym);
    const v = kind === 'income' ? projected?.income.total : projected?.expense.total;
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
    const floor = floorForMonth(ym, minimumExpense.providersMonthly, null);
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
    const projectedIncome = operationalMonthValue(ym, 'income');
    const projectedExpense = operationalMonthValue(ym, 'expense');

    if (cmp < 0) {
      const projectedIncomeTotal = override?.income ?? projectedIncome ?? 0;
      const projectedExpenseTotal = override?.expense ?? projectedExpense ?? 0;
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
      // Meses futuros: la proyección entera se rinde como barra "Egresos
      // (proy.)" (roja rayada). El piso operativo NO se apila — ya está
      // implícito en la proyección. Se rinde aparte como marker horizontal
      // de referencia en `OverrunMarkers` cuando `floorReference` > 0.
      const floor = floorForMonth(ym, minimumExpense.providersMonthly, null);
      return {
        yearMonth: ym,
        realIncome: 0,
        projIncomeGap: m.baseIncome,
        projIncomeTotal: m.baseIncome,
        realExpense: 0,
        projExpenseGap: m.baseExpense,
        projExpenseTotal: m.baseExpense,
        gastoMinFloor: 0,
        realExpenseAboveFloor: 0,
        projExpenseGapAboveFloor: m.baseExpense,
        monthlyFloor: floor,
        floorReference: m.baseExpense > 0 ? floor : null,
        projIncomeOverrun: null,
        projExpenseOverrun: null,
        cashBase: m.baseClosingCash,
        phase: 'future' as const,
      };
    }
    const projectedIncomeTotal = override?.income ?? projectedIncome ?? 0;
    const projectedExpenseTotal = override?.expense ?? projectedExpense ?? 0;
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
  }), [evaluated.months, currentYm, overrides, projectionByMonth, minimumExpense.providersMonthly]);

  const tableRows: CashFlowTableRow[] = useMemo(
    () => evaluated.months.map((m) => {
      const ym = m.yearMonth;
      const cmp = compareYearMonth(ym, currentYm);
      const phase: 'past' | 'current' | 'future' = cmp < 0 ? 'past' : cmp === 0 ? 'current' : 'future';
      const override = overrides[ym];
      const projDetail = projectionByMonth.get(ym);
      const projectedIncome = operationalMonthValue(ym, 'income');
      const projectedExpense = operationalMonthValue(ym, 'expense');

      if (phase === 'past') {
        // En pasado mostramos el real; sólo un override manual puede agregar
        // una columna proyectada contra el dato capturado.
        const projectedIncomeVal = override?.income ?? projectedIncome ?? 0;
        const projectedExpenseVal = override?.expense ?? projectedExpense ?? 0;
        return {
          yearMonth: ym,
          phase,
          realIncome: m.baseIncome,
          realExpense: m.baseExpense,
          projectedIncome: projectedIncomeVal > 0 ? Math.max(0, projectedIncomeVal - m.baseIncome) : 0,
          projectedExpense: projectedExpenseVal > 0 ? Math.max(0, projectedExpenseVal - m.baseExpense) : 0,
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
      // Mes en curso: sólo proyección operativa u override manual.
      const projIncTotal = override?.income ?? projectedIncome ?? 0;
      const projExpTotal = override?.expense ?? projectedExpense ?? 0;
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
    [evaluated.months, currentYm, overrides, projectionByMonth],
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
            <rect width="8" height="8" fill="#D1FAE5" />
            <line x1="0" y1="0" x2="0" y2="8" stroke="#059669" strokeWidth="3" opacity="0.95" />
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
              className="flex items-center gap-2 h-10 px-4 rounded-[var(--radius)] bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary-hover)]"
            >
              <LineChartIcon className="w-4 h-4" strokeWidth={1.5} />
              Abrir Planeación
            </button>
          </>
        }
      />

      {!hasRealData && (
        <EmptyState
          tone="warning"
          density="compact"
          icon={<AlertTriangle className="w-4 h-4" />}
          title="No hay estados de cuenta cargados."
          description="Ve a Flujo Neto y haz refresh para traer datos reales desde JDE."
          action={
            <button
              type="button"
              onClick={() => goTo('netflow')}
              className="text-[12px] font-medium underline-offset-2 hover:underline"
              style={{ color: 'var(--warning)' }}
            >
              Abrir Flujo Neto →
            </button>
          }
        />
      )}
      {error && (
        <EmptyState
          tone="info"
          density="compact"
          live
          icon={<AlertTriangle className="w-4 h-4" />}
          title={`Error al cargar Antigüedad de Saldos: ${error}`}
        />
      )}
      {loading && (
        <p className="text-[11px] animate-soft-pulse" style={{ color: 'var(--gray-400)' }}>Cargando saldos comprometidos…</p>
      )}

      {/* KPI cards — shared SharedKpiCard for cross-module consistency.
          Each card is a navigation entry into the relevant deep view. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <SharedKpiCard
          label={`Ingresos YTD ${currentYear}`}
          value={fmtCurrency(ingresosYtd)}
          icon={<TrendingUp className="w-4 h-4" />}
          color="var(--tone-success, var(--success))"
          sublabel={monthsElapsed > 0 ? `${fmtCompact(ingresosAvgMonth)} / mes promedio` : undefined}
          breakdown={monthsElapsed > 0 ? [
            { label: 'Meses transcurridos', value: String(monthsElapsed) },
            { label: 'Margen neto', value: `${(margenYtd * 100).toFixed(1)}%`, valueColor: toneByDelta(margenYtd) },
          ] : undefined}
          onClick={() => goTo({ tab: 'collections', focus: 'ingresos-ytd' })}
          navHint="Ver detalle de cobranza"
        />
        <SharedKpiCard
          label={`Egresos YTD ${currentYear}`}
          value={fmtCurrency(egresosYtd)}
          icon={<TrendingDown className="w-4 h-4" />}
          color="var(--tone-danger, var(--danger))"
          sublabel={monthsElapsed > 0 ? `${fmtCompact(egresosAvgMonth)} / mes promedio` : undefined}
          breakdown={monthsElapsed > 0 ? [
            { label: 'Vs Ingresos', value: `${ingresosYtd > 0 ? ((egresosYtd / ingresosYtd) * 100).toFixed(1) : '—'}%` },
            { label: 'Flujo neto YTD', value: fmtCompact(flujoNetoYtd), valueColor: toneByDelta(flujoNetoYtd) },
          ] : undefined}
          onClick={() => goTo({ tab: 'cxp', focus: 'egresos-ytd' })}
          navHint="Ver CXP"
        />
        <SharedKpiCard
          label="Caja Actual"
          value={fmtCurrency(cajaActual)}
          icon={<Wallet className="w-4 h-4" />}
          color={toneByFloor(cajaActual, minimumExpense.totalMonthly)}
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
              valueColor: toneByFloor(cajaActual / Math.max(1, minimumExpense.totalMonthly), 3),
            },
          ]}
          onClick={() => goTo({ tab: 'financialPlanning', focus: 'caja-actual' })}
          navHint="Abrir Planeación"
        />
        <MinimumExpenseKpi
          monthly={minimumExpense.totalMonthly}
          annual={minimumExpense.totalAnnual}
          providersMonthly={minimumExpense.providersMonthly}
          payrollMonthly={minimumExpense.payrollMonthly}
          payrollActualJDE={payrollMonthlyActualJDE}
          criticalCount={minimumExpense.criticalCount}
        />
      </div>

      {/* KPI cobranza ↔ bancos.
          Solo aparece cuando hay datos de cobranza JDE Y estados de cuenta
          cargados (caso normal después del boot). El semáforo (verde/ámbar/
          rojo) replica el de la pestaña Cobranza para que el escaneo
          matutino sea consistente. */}
      {cobranzaReconciliation && cobranzaReconciliation.summary.totalAbonos > 0 && (
        <CobranzaKpiCard reconciliation={cobranzaReconciliation} onOpenFlow={onOpenFlow} />
      )}

      {/* Cash chart */}
      <div className="rounded-[var(--radius-lg)] border p-5" style={{ background: 'var(--card)', borderColor: 'var(--border)' }}>
        <h2 className="text-[15px] font-bold tracking-tight mb-1" style={{ color: 'var(--gray-950)' }}>
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
              <CartesianGrid strokeDasharray="3 3" className="recharts-cartesian-grid" />
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
                fill="#34D399"
                stroke="#059669"
                strokeWidth={1.5}
                name="Piso operativo"
                radius={[0, 0, 0, 0]}
                cursor="pointer"
                legendType="square"
              >
                {chartData.map((row) => (
                  <Cell
                    key={`floor-${row.yearMonth}`}
                    fill={row.phase === 'past' ? '#34D399' : 'url(#hatchMinimum)'}
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
                strokeWidth={1.5}
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
        strokeWidth={1.5}
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
        strokeWidth={1.5}
        strokeDasharray="3 3"
      />,
    );
  });
  // Marcador de piso operativo para meses futuros. La proyección futura ya
  // no apila el piso; aquí lo dibujamos como línea horizontal de referencia
  // sobre la barra de proyección para señalar "¿cubre el mes el piso?".
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expenseBar?.props?.data?.forEach((bar: any, idx: number) => {
    const v = bar?.payload?.floorReference;
    if (v == null || v <= 0) return;
    const y = yScale(v);
    lines.push(
      <line
        key={`floorref-${idx}`}
        x1={bar.x}
        x2={bar.x + bar.width}
        y1={y}
        y2={y}
        stroke="#059669"
        strokeWidth={2}
        strokeDasharray="4 2"
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
    <div className="rounded-[var(--radius-md)] border shadow-sm px-3 py-2 text-[12px]" style={{ background: 'var(--popover)', borderColor: 'var(--border)', color: 'var(--popover-foreground)' }}>
      <p className="font-bold mb-0.5" style={{ color: 'var(--gray-950)' }}>{fmtYearMonthLong(ym)}</p>
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
    className="flex items-center gap-2 h-10 px-3 rounded-[var(--radius)] border"
    style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
    title="Caja inicial fija por decisión de negocio."
  >
    <span className="text-[11px]" style={{ color: 'var(--gray-400)' }}>Caja inicial</span>
    <span className="tabular-nums text-[13px] font-medium" style={{ color: 'var(--gray-950)' }}>
      {fmtCurrency(value)}
    </span>
  </div>
);

/**
 * KPI especial del piso operativo. Se renderiza con fondo amarillo rayado
 * (mismo lenguaje visual que la línea amarilla de la proyección operativa).
 *
 * NOTA: el `KpiCard` local fue eliminado en la unificación con
 * `components/ui/KpiCard.tsx` (SharedKpiCard) para que los 4 dashboards
 * usen el mismo componente y comportamiento de navegación.
 */
const MinimumExpenseKpi: React.FC<{
  monthly: number;
  annual: number;
  providersMonthly: number;
  payrollMonthly: number;
  /** Nómina real del último periodo cargado en TRESS — referencia, no piso. */
  payrollActualJDE?: number;
  criticalCount: number;
}> = ({ monthly, annual, providersMonthly, payrollMonthly, payrollActualJDE, criticalCount }) => (
  <div
    className="relative overflow-hidden rounded-[var(--radius)] p-4 floor-kpi"
    title="Piso operativo: proveedores de Operación + nómina/finiquitos. Es el monto que necesitas cubrir cada mes para no afectar operación."
    style={{
      background: 'var(--color-floor-bg)',
      border: '1px solid color-mix(in oklch, var(--color-floor) 35%, transparent)',
      boxShadow: 'var(--shadow-card)',
      backgroundImage: `repeating-linear-gradient(
        45deg,
        color-mix(in oklch, var(--color-floor-pattern) 14%, transparent) 0px,
        color-mix(in oklch, var(--color-floor-pattern) 14%, transparent) 8px,
        transparent 8px,
        transparent 16px
      )`,
    }}
  >
    <div className="flex items-center justify-between mb-2">
      <p
        className="text-[11px] font-bold uppercase tracking-[0.08em]"
        style={{ color: 'var(--color-floor)' }}
      >
        Gasto mín. operativo
      </p>
      <span style={{ color: 'var(--color-floor)' }}>
        <ShieldAlert className="w-4 h-4" />
      </span>
    </div>
    <p
      className="text-[20px] font-bold tabular-nums leading-tight"
      style={{ color: 'var(--gray-950)' }}
    >
      {fmtCurrency(monthly)}
      <span
        className="text-[11px] font-normal ml-1"
        style={{ color: 'var(--gray-500)' }}
      >
        / mes
      </span>
    </p>
    <p
      className="text-[10px] mt-0.5"
      style={{ color: 'var(--gray-500)' }}
    >
      {fmtCompact(annual)} anualizado
    </p>
    <div
      className="mt-2.5 space-y-1 pt-2"
      style={{ borderTop: '1px solid color-mix(in oklch, var(--color-floor) 25%, transparent)' }}
    >
      <div className="flex items-center justify-between text-[11px]">
        <span style={{ color: 'var(--gray-700)' }}>
          Proveedores Operación
          <span className="ml-1" style={{ color: 'var(--gray-500)' }}>· {criticalCount}</span>
        </span>
        <span
          className="font-medium tabular-nums"
          style={{ color: 'var(--gray-950)' }}
        >
          {fmtCompact(providersMonthly)}
        </span>
      </div>
      {payrollMonthly > 0 && (
        <div className="flex items-center justify-between text-[11px]">
          <span style={{ color: 'var(--gray-700)' }}>
            Nómina + finiquitos
          </span>
          <span
            className="font-medium tabular-nums"
            style={{ color: 'var(--gray-950)' }}
          >
            {fmtCompact(payrollMonthly)}
          </span>
        </div>
      )}
      {payrollActualJDE !== undefined && payrollActualJDE > 0 && (
        <div className="flex items-center justify-between text-[10px] pl-3">
          <span className="text-yellow-800/60">
            · Real TRESS últ. mes
          </span>
          <span className="font-medium tabular-nums text-yellow-800/80">
            {fmtCompact(payrollActualJDE)}
          </span>
        </div>
      )}
    </div>
  </div>
);

export type { ComputeInputs, ComputeOutput } from '../domain/dashboardEngine';
export { computeBaseCashFlow, computeBankStartingBalance };

/**
 * Tarjeta de KPI para Cobranza ↔ Bancos.
 *
 * Muestra:
 *   - Saldo CXC pendiente (suma de importePendientePesos del cruce).
 *   - % de ABONOs bancarios cruzados con factura JDE (KPI principal).
 *   - Conteos de facturas cobradas con banco vs pendientes.
 *   - Click → enlaza a la pestaña Cobranza para drill-down.
 *
 * Color semáforo: verde ≥95%, ámbar ≥70%, rojo <70%.
 */
const CobranzaKpiCard: React.FC<{
  reconciliation: RealReconciliationResult;
  onOpenFlow: () => void;
}> = ({ reconciliation, onOpenFlow }) => {
  void onOpenFlow; // reservado para drill-down en una iteración futura
  const [showDiagnose, setShowDiagnose] = useState(false);
  const s = reconciliation.summary;
  const pct = s.pctAbonosCruzados * 100;
  // Detectar el caso "no hay cobranza cargada" — el KPI no debe pintar
  // rojo cuando simplemente no hay nada que cruzar todavía.
  const sinCobranza = s.totalFacturas === 0;
  const tierColor = sinCobranza
    ? 'var(--gray-400)'
    : pct >= 95
      ? 'var(--success)'
      : pct >= 70
        ? 'var(--warning, #d97706)'
        : 'var(--danger)';
  const tierBg = sinCobranza
    ? 'var(--gray-50)'
    : pct >= 95
      ? 'var(--success-muted)'
      : pct >= 70
        ? 'var(--warning-muted, #fef3c7)'
        : 'var(--danger-muted)';

  // Diagnóstico: cias que aparecen solo en facturas o solo en abonos.
  // Es el indicador #1 de mismatch de formato/permisos entre los dos
  // endpoints — la cia "00011" no cruza con "00011," ni con "11" ni
  // con "00011 - SERVICIO".
  const ciasSoloFacturas = s.ciaBreakdown.filter(c => c.facturas > 0 && c.abonos === 0);
  const ciasSoloAbonos = s.ciaBreakdown.filter(c => c.abonos > 0 && c.facturas === 0);
  const tieneAlerta = !sinCobranza && pct < 70 && (ciasSoloFacturas.length > 0 || ciasSoloAbonos.length > 0);

  return (
    <div
      className="rounded-[var(--radius)] border-2 p-4"
      style={{
        borderColor: tierColor,
        backgroundColor: tierBg,
      }}
    >
      <div className="flex items-stretch gap-6 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: 'var(--gray-500)' }}>
              Cobranza cruzada con banco
            </p>
          </div>
          <p className="text-[28px] font-bold tabular-nums leading-tight mt-1" style={{ color: tierColor }}>
            {sinCobranza ? '—' : `${pct.toFixed(1)}%`}
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-500)' }}>
            {sinCobranza
              ? 'Sin cobranza JDE cargada · revisa la pestaña Cobranza'
              : `${s.abonosFacturaCobrada} de ${s.totalAbonos} abonos · ${s.abonosSinFactura} sin factura`}
          </p>
        </div>

        <div className="flex-1 min-w-[200px] border-l border-[var(--gray-200)]/60 pl-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: 'var(--gray-500)' }}>
            Saldo CXC pendiente
          </p>
          <p className="text-[20px] font-bold tabular-nums leading-tight mt-1" style={{ color: 'var(--gray-950)' }}>
            {fmtCurrency(s.totalSaldoPendiente)}
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-500)' }}>
            {s.facturasPendientes.toLocaleString('es-MX')} facturas pendientes ·
            &nbsp;{s.facturasCobradasBanco.toLocaleString('es-MX')} ya cobradas
          </p>
        </div>

        <div className="flex-1 min-w-[200px] border-l border-[var(--gray-200)]/60 pl-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: 'var(--gray-500)' }}>
            Cobrado vs banco (período)
          </p>
          <p className="text-[20px] font-bold tabular-nums leading-tight mt-1" style={{ color: 'var(--success)' }}>
            {fmtCurrency(s.totalCobradoBanco)}
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-500)' }}>
            {s.abonosTraspasoInterno > 0
              ? `${s.abonosTraspasoInterno} traspasos internos descartados`
              : 'sin traspasos internos detectados'}
          </p>
        </div>
      </div>

      {/* Diagnose link — solo cuando algo no está cuadrando. */}
      {(tieneAlerta || (!sinCobranza && pct === 0)) && (
        <div className="mt-3 pt-3 border-t border-[var(--gray-200)]/60">
          <button
            onClick={() => setShowDiagnose(v => !v)}
            className="text-[12px] text-[var(--primary)] hover:underline flex items-center gap-1"
          >
            {showDiagnose ? '▾' : '▸'} Diagnosticar bajo cruce
          </button>
          {showDiagnose && (
            <div className="mt-2 text-[11px] space-y-2">
              {ciasSoloFacturas.length > 0 && (
                <div>
                  <span className="font-bold text-[var(--danger)]">Cías con facturas pero sin abonos:</span>{' '}
                  {ciasSoloFacturas.map(c => `${c.cia} (${c.facturas} fac)`).join(', ')}
                  <div className="text-[var(--gray-500)] mt-0.5">
                    → Revisa que los estados de cuenta de esas cías estén cargados en la pestaña Bancos.
                  </div>
                </div>
              )}
              {ciasSoloAbonos.length > 0 && (
                <div>
                  <span className="font-bold text-[var(--danger)]">Cías con abonos pero sin facturas:</span>{' '}
                  {ciasSoloAbonos.map(c => `${c.cia} (${c.abonos} ab)`).join(', ')}
                  <div className="text-[var(--gray-500)] mt-0.5">
                    → /cobranza no devolvió data para esas cías. Revisa permisos del token productivo en JDE.
                  </div>
                </div>
              )}
              <div className="pt-1 border-t border-[var(--gray-200)]/60">
                <span className="font-bold">Breakdown completo:</span>
                <table className="w-full text-[11px] mt-1">
                  <thead className="text-[var(--gray-400)]">
                    <tr>
                      <th className="text-left">Cía</th>
                      <th className="text-right">Facturas</th>
                      <th className="text-right">Abonos</th>
                      <th className="text-right">Cruzados</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.ciaBreakdown.map(c => (
                      <tr key={c.cia}>
                        <td className="tabular-nums">{c.cia}</td>
                        <td className="text-right tabular-nums">{c.facturas}</td>
                        <td className="text-right tabular-nums">{c.abonos}</td>
                        <td className="text-right tabular-nums">{c.matches}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Dashboard;
