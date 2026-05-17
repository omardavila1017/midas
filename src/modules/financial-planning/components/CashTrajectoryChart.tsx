import React, { useMemo } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import type { ForecastRun, ProbabilisticForecastRun } from '../../shared-finance/types';
import { aggregateProjectionToMonths } from './cashTrajectoryAggregation';

interface Props {
  projection: ForecastRun;
  baseProjection?: ForecastRun;
  probabilisticProjection?: ProbabilisticForecastRun | null;
}

const CHART_COLORS = {
  income:         '#16a34a',
  incomePattern:  '#22c55e',
  incomeBg:       '#dcfce7',
  expense:        '#dc2626',
  expensePattern: '#ef4444',
  expenseBg:      '#fee2e2',
  cash:           '#1e293b',
  cashBase:       '#94a3b8',
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

const SERIES_LABEL: Record<string, string> = {
  realIncome: 'Ingresos (real)',
  projIncome: 'Ingresos (proy.)',
  realExpense: 'Egresos (real)',
  projExpense: 'Egresos (proy.)',
  cash: 'Caja final',
  cashBase: 'Caja base',
};

interface TooltipRow {
  dataKey?: string;
  name?: string;
  value?: number;
  color?: string;
}

const MonthTooltip: React.FC<{ active?: boolean; payload?: TooltipRow[]; label?: string }> = ({
  active,
  payload,
  label,
}) => {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      style={{
        borderRadius: 'var(--radius-md)',
        border: '1px solid #e2e8f0',
        background: 'white',
        boxShadow: 'var(--shadow-sm)',
        padding: '8px 10px',
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 500, color: 'var(--gray-950)', marginBottom: 4 }}>
        {label ? formatMonthTick(label) : ''}
      </div>
      {payload.map((p, i) => {
        const key = p.dataKey ?? '';
        const labelText = SERIES_LABEL[key] ?? p.name ?? key;
        const v = typeof p.value === 'number' ? p.value : 0;
        if (!v) return null;
        return (
          <div key={i} style={{ padding: '2px 0', color: p.color, fontWeight: 500 }}>
            {labelText} : {fmtCurrency(v)}
          </div>
        );
      })}
    </div>
  );
};

function todayYm(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export const CashTrajectoryChart: React.FC<Props> = ({ projection, baseProjection }) => {
  const months = useMemo(
    () => aggregateProjectionToMonths(projection, baseProjection),
    [projection, baseProjection],
  );

  const hasBaseline = Boolean(baseProjection) && projection.scenarioId !== baseProjection?.scenarioId;
  const currentYm = todayYm();

  const chartData = useMemo(() => months.map((m) => {
    const isPast = m.yearMonth < currentYm;
    return {
      yearMonth: m.yearMonth,
      phase: isPast ? 'past' : 'future',
      realIncome: isPast ? m.forecastIncome : 0,
      projIncome: isPast ? 0 : m.forecastIncome,
      realExpense: isPast ? m.forecastExpense : 0,
      projExpense: isPast ? 0 : m.forecastExpense,
      cash: m.forecastClosingCash,
      cashBase: hasBaseline ? m.baseClosingCash : null,
    };
  }), [months, currentYm, hasBaseline]);

  if (chartData.length === 0) {
    return (
      <section className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white p-5">
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
      </section>
    );
  }

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white p-5">
      <h2 className="text-[15px] font-bold tracking-tight mb-1" style={{ color: 'var(--gray-950)' }}>
        Trayectoria de la caja
      </h2>
      <p className="text-[11px] mb-4" style={{ color: 'var(--gray-400)' }}>
        Barra sólida = real · Barra de líneas = proyectado · Línea = caja final del escenario.
        {hasBaseline ? ' Línea punteada gris = caja base.' : ''}
      </p>

      <div
        style={{ height: 340 }}
        role="img"
        aria-label="Trayectoria de la caja: ingresos y egresos por mes con línea de caja final"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
            <defs>
              <pattern id="planHatchIncome" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                <rect width="6" height="6" fill={CHART_COLORS.incomeBg} />
                <line x1="0" y1="0" x2="0" y2="6" stroke={CHART_COLORS.incomePattern} strokeWidth="2.5" />
              </pattern>
              <pattern id="planHatchExpense" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
                <rect width="6" height="6" fill={CHART_COLORS.expenseBg} />
                <line x1="0" y1="0" x2="0" y2="6" stroke={CHART_COLORS.expensePattern} strokeWidth="2.5" />
              </pattern>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="recharts-cartesian-grid" />
            <XAxis
              dataKey="yearMonth"
              tick={{ fontSize: 11 }}
              tickFormatter={formatMonthTick}
            />
            <YAxis tickFormatter={(v) => fmtCompact(v)} tick={{ fontSize: 11 }} width={70} />
            <Tooltip content={<MonthTooltip />} cursor={{ fill: 'rgba(99, 102, 241, 0.06)' }} />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            <Bar
              dataKey="realIncome"
              stackId="income"
              fill={CHART_COLORS.income}
              name="Ingresos (real)"
              radius={[0, 0, 0, 0]}
            />
            <Bar
              dataKey="projIncome"
              stackId="income"
              fill="url(#planHatchIncome)"
              stroke={CHART_COLORS.incomePattern}
              strokeWidth={1}
              name="Ingresos (proy.)"
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="realExpense"
              stackId="expense"
              fill={CHART_COLORS.expense}
              name="Egresos (real)"
              radius={[0, 0, 0, 0]}
            />
            <Bar
              dataKey="projExpense"
              stackId="expense"
              fill="url(#planHatchExpense)"
              stroke={CHART_COLORS.expensePattern}
              strokeWidth={1}
              name="Egresos (proy.)"
              radius={[4, 4, 0, 0]}
            />
            {hasBaseline && (
              <Line
                type="monotone"
                dataKey="cashBase"
                stroke={CHART_COLORS.cashBase}
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
                name="Caja base"
                connectNulls
              />
            )}
            <Line
              type="monotone"
              dataKey="cash"
              stroke={CHART_COLORS.cash}
              strokeWidth={1.5}
              dot={{ r: 2 }}
              name="Caja Final"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
};

export default CashTrajectoryChart;
