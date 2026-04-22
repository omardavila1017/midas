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
  /** Si es true, muestra una línea por propuesta activa (delta acumulado). */
  showProposalLines?: boolean;
}

const PROPOSAL_COLORS = [
  '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#ef4444',
  '#06b6d4', '#84cc16', '#f97316', '#6366f1', '#14b8a6',
];

const CashFlowChart: React.FC<Props> = ({ data, showProposalLines = true }) => {
  const chartData = useMemo(() => {
    const proposalIds = data.proposals.filter((p) => p.enabled).map((p) => p.id);
    const cumulative: Record<string, number> = {};
    proposalIds.forEach((id) => (cumulative[id] = 0));

    return data.months.map((m) => {
      const row: Record<string, number | string | boolean | null> = {
        yearMonth: m.yearMonth,
        isHistorical: m.isHistorical,
        base: m.baseClosingCash,
        forecast: m.forecastClosingCash,
        historicalArea: m.isHistorical ? m.baseClosingCash : null,
      };
      for (const id of proposalIds) {
        const delta = m.proposalDeltas.find((d) => d.proposalId === id);
        // extraFlow = deltaIncome - deltaExpense (deltaExpense es negativo para ahorros)
        const monthDelta = delta ? delta.deltaIncome - delta.deltaExpense : 0;
        cumulative[id] += monthDelta;
        row[`p_${id}`] = m.baseClosingCash + cumulative[id];
      }
      return row;
    });
  }, [data]);

  const firstFutureIndex = data.months.findIndex((m) => !m.isHistorical);

  return (
    <div className="w-full" style={{ height: 360 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
          <defs>
            <linearGradient id="historicalFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#e5e7eb" stopOpacity={0.6} />
              <stop offset="100%" stopColor="#e5e7eb" stopOpacity={0.15} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
          <XAxis dataKey="yearMonth" tick={{ fontSize: 11 }} />
          <YAxis tickFormatter={(v) => fmtCompact(v)} tick={{ fontSize: 11 }} width={70} />
          <Tooltip
            formatter={(value: number | string, name: string) => {
              const v = typeof value === 'number' ? fmtCurrency(value) : value;
              const labelMap: Record<string, string> = {
                base: 'Caja Final Base',
                forecast: 'Caja Final Pronosticada',
                historicalArea: 'Histórico',
              };
              let display = labelMap[name] ?? name;
              if (name.startsWith('p_')) {
                const id = name.slice(2);
                const prop = data.proposals.find((p) => p.id === id);
                display = prop ? `+ ${prop.name}` : name;
              }
              return [v, display];
            }}
            labelStyle={{ fontSize: 12 }}
            contentStyle={{ borderRadius: 8, borderColor: '#e5e7eb' }}
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />

          {/* Área sombreada para histórico */}
          <Area
            type="monotone"
            dataKey="historicalArea"
            fill="url(#historicalFill)"
            stroke="none"
            isAnimationActive={false}
            legendType="none"
            name="historicalArea"
          />

          {/* Divisor histórico / proyección */}
          {firstFutureIndex > 0 && (
            <ReferenceLine
              x={chartData[firstFutureIndex]?.yearMonth as string}
              stroke="#cbd5e1"
              strokeDasharray="4 4"
              label={{ value: 'Proyección →', position: 'top', fontSize: 11, fill: '#64748b' }}
            />
          )}

          {/* Base (gris) */}
          <Line
            type="monotone"
            dataKey="base"
            stroke="#94a3b8"
            strokeWidth={2}
            dot={false}
            name="Caja Final Base"
            isAnimationActive={false}
          />

          {/* Forecast (azul) */}
          <Line
            type="monotone"
            dataKey="forecast"
            stroke="#2563eb"
            strokeWidth={2.5}
            dot={{ r: 2 }}
            name="Caja Final Pronosticada"
            isAnimationActive={false}
          />

          {/* Una línea por propuesta habilitada */}
          {showProposalLines &&
            data.proposals
              .filter((p) => p.enabled)
              .map((p, idx) => (
                <Line
                  key={p.id}
                  type="monotone"
                  dataKey={`p_${p.id}`}
                  stroke={PROPOSAL_COLORS[idx % PROPOSAL_COLORS.length]}
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  dot={false}
                  name={`+ ${p.name}`}
                  isAnimationActive={false}
                />
              ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

export default CashFlowChart;
