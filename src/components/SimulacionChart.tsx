import React, { useMemo } from 'react';
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  Area,
  ReferenceLine,
} from 'recharts';
import type { EvaluatedCashFlow } from '../types';
import { fmtCompact, fmtCurrency } from '../formatters';

interface Props {
  data: EvaluatedCashFlow;
}

// Senda DS tokens — no hardcoded hex, no gradients (BAN 2 in .impeccable.md).
// Recharts doesn't resolve CSS custom properties at render time, so we mirror
// the tokens from index.css here. If the skin tokens change, update these too.
const COLOR = {
  base: '#94a3b8',        // var(--gray-300) — histórico y línea base
  forecast: '#1e293b',    // var(--primary) — caja simulada
  grid: '#f1f5f9',        // var(--gray-100)
  axis: '#e2e8f0',        // var(--border)
  tickText: '#64748b',    // var(--gray-400)
  refLine: '#cbd5e1',
  histArea: '#cbd5e1',    // fill histórico (sólido a baja opacidad)
  danger: '#dc2626',      // var(--danger) — línea de cero cuando caja cae
} as const;

const MONTH_LABELS_SHORT = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
];

function formatMonthTick(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  if (!y || !m) return yearMonth;
  return `${MONTH_LABELS_SHORT[(m - 1) % 12]} ${String(y).slice(2)}`;
}

const SimulacionChart: React.FC<Props> = ({ data }) => {
  const chartData = useMemo(
    () =>
      data.months.map((m) => ({
        yearMonth: m.yearMonth,
        base: m.baseClosingCash,
        forecast: m.forecastClosingCash,
        historicalArea: m.isHistorical ? m.baseClosingCash : null,
      })),
    [data],
  );

  const firstFutureIndex = data.months.findIndex((m) => !m.isHistorical);
  const crossesZero = useMemo(
    () => chartData.some((d) => d.base < 0 || d.forecast < 0),
    [chartData],
  );

  if (data.months.length === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="h-[360px] flex flex-col items-center justify-center gap-1 text-center px-6"
      >
        <p className="text-[13px] font-medium" style={{ color: 'var(--gray-700)' }}>
          Sin datos para graficar
        </p>
        <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
          Carga movimientos o estados de cuenta para ver la trayectoria.
        </p>
      </div>
    );
  }

  return (
    <div
      className="w-full"
      style={{ height: 360 }}
      role="img"
      aria-label="Trayectoria de la caja: línea base vs escenario simulado por mes"
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 12, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={COLOR.grid} vertical={false} />
          <XAxis
            dataKey="yearMonth"
            tickFormatter={formatMonthTick}
            tick={{ fontSize: 11, fill: COLOR.tickText }}
            tickLine={false}
            axisLine={{ stroke: COLOR.axis }}
            minTickGap={16}
          />
          <YAxis
            tickFormatter={(v) => fmtCompact(v)}
            tick={{ fontSize: 11, fill: COLOR.tickText }}
            tickLine={false}
            axisLine={false}
            width={64}
          />
          <Tooltip
            formatter={(v: number | string, name: string) => {
              const labelMap: Record<string, string> = {
                base: 'Caja base',
                forecast: 'Caja simulada',
                historicalArea: 'Histórico',
              };
              const display = labelMap[name] ?? name;
              return [typeof v === 'number' ? fmtCurrency(v) : v, display];
            }}
            labelFormatter={(label: string) => formatMonthTick(label)}
            labelStyle={{ fontSize: 12, fontWeight: 500, color: 'var(--gray-950)' }}
            contentStyle={{
              borderRadius: 'var(--radius-md)',
              border: `1px solid ${COLOR.axis}`,
              boxShadow: 'var(--shadow-sm)',
              padding: '8px 10px',
              fontSize: 12,
            }}
            itemStyle={{ padding: '2px 0' }}
            cursor={{ stroke: COLOR.refLine, strokeWidth: 1 }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 8, color: COLOR.tickText }}
            iconType="plainline"
          />

          <Area
            type="monotone"
            dataKey="historicalArea"
            fill={COLOR.histArea}
            fillOpacity={0.18}
            stroke="none"
            isAnimationActive={false}
            legendType="none"
            name="historicalArea"
          />

          {crossesZero && (
            <ReferenceLine
              y={0}
              stroke={COLOR.danger}
              strokeDasharray="2 4"
              strokeOpacity={0.5}
              ifOverflow="extendDomain"
            />
          )}

          {firstFutureIndex > 0 && (
            <ReferenceLine
              x={chartData[firstFutureIndex]?.yearMonth as string}
              stroke={COLOR.refLine}
              strokeDasharray="4 4"
              label={{ value: 'Proyección', position: 'top', fontSize: 10, fill: COLOR.tickText }}
            />
          )}

          <Line
            type="monotone"
            dataKey="base"
            stroke={COLOR.base}
            strokeWidth={1.5}
            dot={false}
            name="Caja base"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="forecast"
            stroke={COLOR.forecast}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, strokeWidth: 0 }}
            name="Caja simulada"
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

export default SimulacionChart;
