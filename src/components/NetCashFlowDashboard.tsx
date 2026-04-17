'use client';

import { useMemo, useState } from 'react';
import { Client, CashFlowAssumptions, ConfirmedPayment } from '../domain/types';
import { CXPRecord } from '../domain/persistence';
import { FlowPlan } from '../types';
import { projectYear } from '../domain/collectionEngine';
import {
  extractPaymentEvents,
  computeDailyFlow,
  aggregateWeekly,
  aggregateMonthly,
  computeSummary,
  MonthlyFlow,
  WeeklyFlow,
} from '../domain/netCashFlowEngine';
import {
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle,
  ArrowUpRight,
  ArrowDownRight,
  Download,
  Calendar,
} from 'lucide-react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

interface Props {
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  cxpRecords: CXPRecord[];
  plan: FlowPlan | null;
}

// Month abbreviations in Spanish
const MES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// Currency formatter
const fmt = (v: number): string => {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};

// Percentage formatter
const pctFmt = (v: number): string => {
  return `${(v * 100).toFixed(0)}%`;
};

export default function NetCashFlowDashboard({
  clients,
  assumptions,
  confirmedPayments,
  cxpRecords,
  plan,
}: Props) {
  const [viewMode, setViewMode] = useState<'monthly' | 'weekly'>('monthly');

  // ─────────────────────────────────────────────────────────────────────────
  // Data computation (memoized)
  // ─────────────────────────────────────────────────────────────────────────

  const collectionEvents = useMemo(
    () => projectYear(clients, assumptions),
    [clients, assumptions]
  );

  const paymentEvents = useMemo(
    () => extractPaymentEvents(cxpRecords),
    [cxpRecords]
  );

  const dailyFlow = useMemo(
    () =>
      computeDailyFlow(
        collectionEvents,
        paymentEvents,
        confirmedPayments,
        assumptions.year,
        plan?.cajaInicial ?? 0
      ),
    [collectionEvents, paymentEvents, confirmedPayments, assumptions.year, plan?.cajaInicial]
  );

  const weeklyFlow = useMemo(() => aggregateWeekly(dailyFlow), [dailyFlow]);

  const monthlyFlow = useMemo(
    () => aggregateMonthly(dailyFlow, plan?.cajaInicial ?? 0),
    [dailyFlow, plan?.cajaInicial]
  );

  const summary = useMemo(
    () => computeSummary(monthlyFlow, collectionEvents, confirmedPayments),
    [monthlyFlow, collectionEvents, confirmedPayments]
  );

  // ─────────────────────────────────────────────────────────────────────────
  // State checks: empty, partial, or full data
  // ─────────────────────────────────────────────────────────────────────────

  const hasClients = clients.length > 0;
  const hasCXP = cxpRecords.length > 0;
  const isEmpty = !hasClients && !hasCXP;
  const isPartial = (hasClients && !hasCXP) || (!hasClients && hasCXP);

  // ─────────────────────────────────────────────────────────────────────────
  // Chart data preparation
  // ─────────────────────────────────────────────────────────────────────────

  const chartData = useMemo(() => {
    return monthlyFlow.map((m) => ({
      month: MES[m.month],
      inflows: m.inflows,
      outflows: m.outflows * -1, // negative for visual distinction
      net: m.net,
      cumulative: m.cumulative,
      monthIndex: m.month,
    }));
  }, [monthlyFlow]);

  // For weekly view
  const weeklyChartData = useMemo(() => {
    return weeklyFlow.map((w) => {
      const [year, month, day] = w.weekStart.split('-');
      const displayLabel = `W${w.weekNumber} ${month}-${day}`;
      return {
        week: displayLabel,
        weekStart: w.weekStart,
        inflows: w.inflows,
        outflows: w.outflows * -1,
        net: w.net,
        cumulative: w.cumulative,
      };
    });
  }, [weeklyFlow]);

  // ─────────────────────────────────────────────────────────────────────────
  // Export CSV function
  // ─────────────────────────────────────────────────────────────────────────

  const exportAsCSV = () => {
    const rows = [
      ['Flujo Neto Mensual', `${assumptions.year}`],
      [],
      ['Mes', 'Cobros', 'Pagos', 'Neto', 'Acumulado'],
    ];

    monthlyFlow.forEach((m) => {
      rows.push([
        m.monthName,
        fmt(m.inflows),
        fmt(m.outflows),
        fmt(m.net),
        fmt(m.cumulative),
      ]);
    });

    rows.push([]);
    rows.push(['Total', fmt(summary.totalInflows), fmt(summary.totalOutflows), fmt(summary.netFlow), '']);

    const csv = rows.map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n');
    navigator.clipboard.writeText(csv);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render: Empty State
  // ─────────────────────────────────────────────────────────────────────────

  if (isEmpty) {
    return (
      <div className="min-h-screen bg-[#f5f5f7] p-6">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-2xl p-12 border border-[#d2d2d7]/60 text-center animate-card-in stagger-0">
            <Calendar className="w-16 h-16 text-[#0071e3] mx-auto mb-4" />
            <h2 className="text-20 font-semibold mb-2">Flujo Neto {assumptions.year}</h2>
            <p className="text-13 text-[#666] max-w-sm mx-auto">
              Agrega clientes en la pestaña Clientes o carga un CSV de CXP para ver tu flujo neto.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render: Partial Data Banner
  // ─────────────────────────────────────────────────────────────────────────

  const partialBanner = isPartial && (
    <div className="bg-[#fff5e6] border border-[#ff9f0a]/30 rounded-2xl p-4 mb-5 flex items-start gap-3 animate-card-in stagger-0">
      <AlertTriangle className="w-5 h-5 text-[#ff9f0a] flex-shrink-0 mt-0.5" />
      <div className="text-13 text-[#8B6914]">
        {hasClients && !hasCXP
          ? 'Solo mostrando proyección de cobros. Carga un CSV de CXP para ver el flujo neto completo.'
          : 'Solo mostrando datos de CXP. Agrega clientes para ver la proyección de cobros.'}
      </div>
    </div>
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Render: Alert Banner (negative months)
  // ─────────────────────────────────────────────────────────────────────────

  const alertBanner = summary.monthsNegative.length > 0 && (
    <div className="bg-[#fff5e6] border border-[#ff9f0a]/30 rounded-2xl p-4 mb-5 flex items-start gap-3 animate-card-in stagger-1">
      <AlertTriangle className="w-5 h-5 text-[#ff9f0a] flex-shrink-0 mt-0.5" />
      <div className="text-13 text-[#8B6914]">
        Flujo negativo en {summary.monthsNegative.map((m) => MES[m]).join(', ')}. Revisa la
        cobranza de estos periodos.
      </div>
    </div>
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Render: Main Layout
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#f5f5f7] p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 animate-card-in stagger-0">
          <div className="flex items-center gap-4">
            <h1 className="text-28 font-bold">Flujo Neto {assumptions.year}</h1>
            <span className="px-3 py-1 bg-[#0071e3]/10 text-[#0071e3] text-11 font-semibold rounded-full">
              {viewMode === 'monthly' ? 'Mensual' : 'Semanal'}
            </span>
          </div>
          <button
            onClick={exportAsCSV}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-[#d2d2d7]/60 text-13 font-medium hover:bg-[#f5f5f7] transition-colors"
          >
            <Download className="w-4 h-4" />
            Exportar
          </button>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          {/* Cobros */}
          <div className="bg-white rounded-2xl p-5 border border-[#d2d2d7]/60 hover:shadow-md transition-shadow animate-card-in stagger-0">
            <div className="flex items-center justify-between mb-3">
              <span className="text-11 font-semibold text-[#666] uppercase tracking-wider">
                Cobros
              </span>
              <ArrowUpRight className="w-4 h-4 text-[#0071e3]" />
            </div>
            <div className="text-[28px] font-bold tabular-nums tracking-[-0.02em] text-[#0071e3]">
              {fmt(summary.totalInflows)}
            </div>
            <div className="text-11 text-[#999] mt-2">
              {collectionEvents.length} eventos proyectados
            </div>
          </div>

          {/* Pagos */}
          <div className="bg-white rounded-2xl p-5 border border-[#d2d2d7]/60 hover:shadow-md transition-shadow animate-card-in stagger-1">
            <div className="flex items-center justify-between mb-3">
              <span className="text-11 font-semibold text-[#666] uppercase tracking-wider">
                Pagos
              </span>
              <ArrowDownRight className="w-4 h-4 text-[#ff3b30]" />
            </div>
            <div className="text-[28px] font-bold tabular-nums tracking-[-0.02em] text-[#ff3b30]">
              {fmt(summary.totalOutflows)}
            </div>
            <div className="text-11 text-[#999] mt-2">
              {paymentEvents.length} facturas pendientes
            </div>
          </div>

          {/* Flujo Neto */}
          <div className="bg-white rounded-2xl p-5 border border-[#d2d2d7]/60 hover:shadow-md transition-shadow animate-card-in stagger-2">
            <div className="flex items-center justify-between mb-3">
              <span className="text-11 font-semibold text-[#666] uppercase tracking-wider">
                Neto
              </span>
              {summary.netFlow >= 0 ? (
                <TrendingUp className="w-4 h-4 text-[#34c759]" />
              ) : (
                <TrendingDown className="w-4 h-4 text-[#ff3b30]" />
              )}
            </div>
            <div
              className={`text-[28px] font-bold tabular-nums tracking-[-0.02em] ${
                summary.netFlow >= 0 ? 'text-[#34c759]' : 'text-[#ff3b30]'
              }`}
            >
              {fmt(summary.netFlow)}
            </div>
            <div className="text-11 text-[#999] mt-2">
              {summary.netFlow >= 0 ? 'Superávit' : 'Déficit'} neto
            </div>
          </div>

          {/* Eficiencia de Cobro */}
          <div className="bg-white rounded-2xl p-5 border border-[#d2d2d7]/60 hover:shadow-md transition-shadow animate-card-in stagger-3">
            <div className="flex items-center justify-between mb-3">
              <span className="text-11 font-semibold text-[#666] uppercase tracking-wider">
                Eficiencia
              </span>
              <CheckCircle className="w-4 h-4 text-[#34c759]" />
            </div>
            <div className="text-[28px] font-bold tabular-nums tracking-[-0.02em] text-[#34c759]">
              {pctFmt(summary.collectionEfficiency)}
            </div>
            <div className="text-11 text-[#999] mt-2">Confirmado vs total</div>
          </div>
        </div>

        {/* Partial/Alert Banners */}
        {partialBanner}
        {alertBanner}

        {/* Main Chart */}
        <div className="bg-white rounded-2xl p-6 border border-[#d2d2d7]/60 mb-6 animate-card-in stagger-2">
          <h2 className="text-15 font-semibold mb-4">Flujo de Caja {assumptions.year}</h2>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart
              data={viewMode === 'monthly' ? chartData : weeklyChartData}
              margin={{ top: 20, right: 30, left: 0, bottom: 20 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
              <XAxis
                dataKey={viewMode === 'monthly' ? 'month' : 'week'}
                tick={{ fontSize: 12, fill: '#666' }}
              />
              <YAxis tick={{ fontSize: 12, fill: '#666' }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #d2d2d7',
                  borderRadius: '8px',
                }}
                formatter={(value: number) => fmt(value)}
                labelFormatter={(label) => `${label}`}
              />
              <ReferenceLine y={0} stroke="#999" strokeDasharray="5 5" />
              <Area
                type="monotone"
                dataKey="inflows"
                fill="#0071e3"
                stroke="none"
                fillOpacity={0.3}
                name="Cobros"
              />
              <Area
                type="monotone"
                dataKey="outflows"
                fill="#ff3b30"
                stroke="none"
                fillOpacity={0.3}
                name="Pagos"
              />
              <Line
                type="monotone"
                dataKey="cumulative"
                stroke="#000"
                strokeWidth={2}
                dot={false}
                name="Acumulado"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* View Toggle */}
        <div className="flex gap-3 mb-6 animate-card-in stagger-3">
          <button
            onClick={() => setViewMode('monthly')}
            className={`px-4 py-2 rounded-lg text-13 font-medium transition-colors ${
              viewMode === 'monthly'
                ? 'bg-[#0071e3] text-white'
                : 'bg-white border border-[#d2d2d7]/60 text-[#666] hover:bg-[#f5f5f7]'
            }`}
          >
            Mensual
          </button>
          <button
            onClick={() => setViewMode('weekly')}
            className={`px-4 py-2 rounded-lg text-13 font-medium transition-colors ${
              viewMode === 'weekly'
                ? 'bg-[#0071e3] text-white'
                : 'bg-white border border-[#d2d2d7]/60 text-[#666] hover:bg-[#f5f5f7]'
            }`}
          >
            Semanal
          </button>
        </div>

        {/* Data Table */}
        <div className="bg-white rounded-2xl border border-[#d2d2d7]/60 overflow-hidden animate-card-in stagger-4">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[#d2d2d7]/60 bg-[#f5f5f7]">
                  <th className="px-6 py-3 text-left text-11 font-semibold text-[#666] uppercase tracking-wider">
                    {viewMode === 'monthly' ? 'Mes' : 'Semana'}
                  </th>
                  <th className="px-6 py-3 text-right text-11 font-semibold text-[#0071e3] uppercase tracking-wider">
                    Cobros
                  </th>
                  <th className="px-6 py-3 text-right text-11 font-semibold text-[#ff3b30] uppercase tracking-wider">
                    Pagos
                  </th>
                  <th className="px-6 py-3 text-right text-11 font-semibold text-[#666] uppercase tracking-wider">
                    Neto
                  </th>
                  <th className="px-6 py-3 text-right text-11 font-semibold text-[#666] uppercase tracking-wider">
                    Acumulado
                  </th>
                  <th className="px-6 py-3 text-center text-11 font-semibold text-[#666] uppercase tracking-wider">
                    Gráfico
                  </th>
                </tr>
              </thead>
              <tbody>
                {(viewMode === 'monthly' ? monthlyFlow : weeklyFlow).map((row, idx) => {
                  const isMonthly = viewMode === 'monthly';
                  const label = isMonthly
                    ? (row as MonthlyFlow).monthName
                    : `Sem ${(row as WeeklyFlow).weekNumber}`;
                  const maxAbs = Math.max(
                    ...((viewMode === 'monthly' ? monthlyFlow : weeklyFlow).map((r) =>
                      Math.abs(r.net)
                    )),
                    1
                  );
                  const barWidth = Math.abs((row.net / maxAbs) * 100);

                  return (
                    <tr
                      key={idx}
                      className="border-b border-[#d2d2d7]/30 hover:bg-[#f5f5f7] transition-colors"
                    >
                      <td className="px-6 py-4 text-13 font-medium">{label}</td>
                      <td className="px-6 py-4 text-right text-13 font-medium text-[#0071e3]">
                        {fmt(row.inflows)}
                      </td>
                      <td className="px-6 py-4 text-right text-13 font-medium text-[#ff3b30]">
                        {fmt(row.outflows)}
                      </td>
                      <td
                        className={`px-6 py-4 text-right text-13 font-medium ${
                          row.net >= 0 ? 'text-[#34c759]' : 'text-[#ff3b30]'
                        }`}
                      >
                        {fmt(row.net)}
                      </td>
                      <td className="px-6 py-4 text-right text-13 font-medium">{fmt(row.cumulative)}</td>
                      <td className="px-6 py-4">
                        <div className="flex justify-center">
                          <div
                            className={`h-2 rounded-full transition-all ${
                              row.net >= 0 ? 'bg-[#34c759]' : 'bg-[#ff3b30]'
                            }`}
                            style={{ width: `${barWidth}px`, maxWidth: '60px' }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer Stats */}
        <div className="mt-6 text-center text-11 text-[#999] animate-card-in stagger-5">
          CXC: {clients.length} clientes · CXP: {cxpRecords.length} facturas ·
          {confirmedPayments.length > 0 && (
            <>
              {' '}
              {pctFmt(confirmedPayments.length / Math.max(collectionEvents.length, 1))} confirmado
            </>
          )}
        </div>
      </div>
    </div>
  );
}
