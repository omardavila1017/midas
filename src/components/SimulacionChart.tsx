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

  if (data.months.length === 0) {
    return (
      <div className="h-[360px] flex items-center justify-center text-[12px]" style={{ color: 'var(--gray-400)' }}>
        Sin datos para graficar.
      </div>
    );
  }

  return (
    <div className="w-full" style={{ height: 360 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
          <defs>
            <linearGradient id="simHistFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#cbd5e1" stopOpacity={0.45} />
              <stop offset="100%" stopColor="#cbd5e1" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="simForecastFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2563eb" stopOpacity={0.18} />
              <stop offset="100%" stopColor="#2563eb" stopOpacity={0.0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis dataKey="yearMonth" tick={{ fontSize: 11, fill: '#64748b' }} tickLine={false} axisLine={{ stroke: '#e2e8f0' }} />
          <YAxis
            tickFormatter={(v) => fmtCompact(v)}
            tick={{ fontSize: 11, fill: '#64748b' }}
            tickLine={false}
            axisLine={false}
            width={70}
          />
          <Tooltip
            formatter={(v: number | string, name: string) => {
              const labelMap: Record<string, string> = {
                base: 'Caja Final Base',
                forecast: 'Caja Simulada',
                historicalArea: 'Histórico',
              };
              const display = labelMap[name] ?? name;
              return [typeof v === 'number' ? fmtCurrency(v) : v, display];
            }}
            labelStyle={{ fontSize: 12, fontWeight: 600 }}
            contentStyle={{ borderRadius: 12, borderColor: '#e5e7eb', boxShadow: '0 8px 24px -8px rgba(15,23,42,0.18)' }}
          />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />

          <Area
            type="monotone"
            dataKey="historicalArea"
            fill="url(#simHistFill)"
            stroke="none"
            isAnimationActive={false}
            legendType="none"
            name="historicalArea"
          />

          {firstFutureIndex > 0 && (
            <ReferenceLine
              x={chartData[firstFutureIndex]?.yearMonth as string}
              stroke="#cbd5e1"
              strokeDasharray="4 4"
              label={{ value: 'Proyección →', position: 'top', fontSize: 10, fill: '#94a3b8' }}
            />
          )}

          <Line
            type="monotone"
            dataKey="base"
            stroke="#94a3b8"
            strokeWidth={2}
            dot={false}
            name="Caja Final Base"
            isAnimationActive
            animationDuration={400}
          />
          <Line
            type="monotone"
            dataKey="forecast"
            stroke="#2563eb"
            strokeWidth={2.5}
            dot={{ r: 3, fill: '#2563eb' }}
            activeDot={{ r: 5 }}
            name="Caja Simulada"
            isAnimationActive
            animationDuration={500}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

export default SimulacionChart;
