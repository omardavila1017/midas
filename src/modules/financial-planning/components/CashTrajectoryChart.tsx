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
  ReferenceDot,
} from 'recharts';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import AnimatedNumber from '../../../components/ui/AnimatedNumber';
import type { ForecastRun, ProbabilisticForecastRun } from '../../shared-finance/types';
import { aggregateProjectionToMonths } from './cashTrajectoryAggregation';

interface Props {
  projection: ForecastRun;
  baseProjection?: ForecastRun;
  probabilisticProjection?: ProbabilisticForecastRun | null;
}

const COLOR = {
  base: '#94a3b8',
  forecast: '#1e293b',
  grid: '#f1f5f9',
  axis: '#e2e8f0',
  tickText: '#64748b',
  refLine: '#cbd5e1',
  warning: '#f59e0b',
  danger: '#dc2626',
  dangerFill: '#fee2e2',
  success: '#16a34a',
  successFill: '#dcfce7',
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

const TOOLTIP_SERIES: Record<string, { label: string; color: string }> = {
  base: { label: 'Caja base', color: '#475569' },
  forecast: { label: 'Caja escenario', color: '#0f172a' },
  'Caja base': { label: 'Caja base', color: '#475569' },
  'Caja escenario': { label: 'Caja escenario', color: '#0f172a' },
  'Caja final': { label: 'Caja final', color: '#0f172a' },
  deltaAbove: { label: 'Δ positivo', color: '#16a34a' },
  deltaBelow: { label: 'Δ negativo', color: '#dc2626' },
  riskBand: { label: 'Rango P10-P90', color: '#7c3aed' },
  p50: { label: 'Caja P50', color: '#7c3aed' },
};

const ChartTooltip: React.FC<{
  active?: boolean;
  payload?: Array<{ name?: string; value?: number | [number, number] | string }>;
  label?: string;
}> = ({ active, payload, label }) => {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div
      style={{
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${COLOR.axis}`,
        background: 'white',
        boxShadow: 'var(--shadow-sm)',
        padding: '8px 10px',
        fontSize: 12,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--gray-950)', marginBottom: 4 }}>
        {label ? formatMonthTick(label) : ''}
      </div>
      {payload.map((p, i) => {
        const name = p.name ?? '';
        const meta = TOOLTIP_SERIES[name];
        if (!meta) return null;
        let amount: number | string | null = null;
        if (Array.isArray(p.value) && p.value.length === 2) {
          const [lo, hi] = p.value;
          if (typeof lo === 'number' && typeof hi === 'number') {
            amount = `${fmtCurrency(lo)} a ${fmtCurrency(hi)}`;
          }
        } else if (typeof p.value === 'number') {
          amount = fmtCurrency(p.value);
        }
        if (amount === null) return null;
        return (
          <div key={i} style={{ padding: '2px 0', color: meta.color, fontWeight: 500 }}>
            {meta.label} : {amount}
          </div>
        );
      })}
    </div>
  );
};

const LastPointDot: React.FC<{ cx?: number; cy?: number }> = ({ cx, cy }) => {
  if (cx === undefined || cy === undefined) return null;
  return (
    <g>
      <circle cx={cx} cy={cy} r={8} fill={COLOR.forecast} fillOpacity={0.08} />
      <circle cx={cx} cy={cy} r={4} fill={COLOR.forecast} />
      <circle cx={cx} cy={cy} r={2} fill="white" />
    </g>
  );
};

export const CashTrajectoryChart: React.FC<Props> = ({ projection, baseProjection, probabilisticProjection }) => {
  const months = useMemo(
    () => aggregateProjectionToMonths(projection, baseProjection),
    [projection, baseProjection],
  );

  const hasBaseline = Boolean(baseProjection) && projection.scenarioId !== baseProjection?.scenarioId;

  const probabilisticByMonth = useMemo(() => {
    const grouped = new Map<string, ProbabilisticForecastRun['buckets'][number]>();
    for (const bucket of probabilisticProjection?.buckets ?? []) {
      const ym = bucket.date.slice(0, 7);
      grouped.set(ym, bucket);
    }
    return grouped;
  }, [probabilisticProjection?.buckets]);

  const chartData = useMemo(() => months.map((m) => {
    const base = m.baseClosingCash;
    const forecast = m.forecastClosingCash;
    const probabilistic = probabilisticByMonth.get(m.yearMonth);
    return {
      yearMonth: m.yearMonth,
      base,
      forecast,
      deltaAbove: hasBaseline && forecast > base ? [base, forecast] : null,
      deltaBelow: hasBaseline && forecast < base ? [forecast, base] : null,
      riskBand: probabilistic ? [probabilistic.cash.p10, probabilistic.cash.p90] : null,
      p50: probabilistic?.cash.p50,
    };
  }), [months, hasBaseline, probabilisticByMonth]);

  const crossesZero = useMemo(
    () => chartData.some((d) => d.base < 0 || d.forecast < 0),
    [chartData],
  );

  const lastPoint = chartData.length > 0 ? chartData[chartData.length - 1] : null;
  const finalForecast = projection.summary.finalCash;
  const finalBase = baseProjection?.summary.finalCash ?? finalForecast;
  const delta = finalForecast - finalBase;
  const deltaSign = delta >= 0 ? '+' : '−';
  const deltaColor = delta >= 0 ? COLOR.success : COLOR.danger;
  const minimumCash = projection.summary.minimumCashRequired;

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
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div>
          <h2 className="text-[15px] font-bold tracking-tight text-[var(--gray-950)]">
            Trayectoria de la caja
          </h2>
          <p className="mt-1 text-[12px] text-[var(--gray-400)]">
            {hasBaseline
              ? 'Línea base (gris) vs escenario activo (negro). El área sombreada es el impacto.'
              : 'Cierre mensual proyectado del escenario activo.'}
          </p>
        </div>
        <div className="text-right text-[12px] text-[var(--gray-400)]">
          {projection.startDate} → {projection.endDate}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-6 pb-4 mb-2 border-b border-[var(--gray-100)]">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: 'var(--gray-400)' }}>
            Caja base (fin)
          </p>
          <AnimatedNumber
            value={finalBase}
            format={fmtCurrency}
            className="block text-[15px] font-bold tabular-nums mt-0.5"
            style={{ color: 'var(--gray-700)' }}
          />
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: 'var(--gray-400)' }}>
            Caja escenario (fin)
          </p>
          <AnimatedNumber
            value={finalForecast}
            format={fmtCurrency}
            className="block text-[15px] font-bold tabular-nums mt-0.5"
            style={{ color: 'var(--gray-950)' }}
          />
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-[0.08em]" style={{ color: 'var(--gray-400)' }}>
            Δ vs base
          </p>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span className="text-[15px] font-bold tabular-nums" style={{ color: deltaColor }}>
              {deltaSign}
            </span>
            <AnimatedNumber
              value={Math.abs(delta)}
              format={fmtCurrency}
              className="text-[15px] font-bold tabular-nums"
              style={{ color: deltaColor }}
            />
          </div>
        </div>
      </div>

      <div
        style={{ height: 360 }}
        role="img"
        aria-label="Trayectoria de la caja: línea base vs escenario activo por mes"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 16, right: 16, left: 8, bottom: 8 }}>
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
              content={<ChartTooltip />}
              cursor={{ stroke: COLOR.refLine, strokeWidth: 1 }}
              isAnimationActive={false}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8, color: COLOR.tickText }}
              iconType="plainline"
              payload={
                hasBaseline
                  ? [
                      { value: 'Caja base', type: 'plainline', id: 'base', color: COLOR.base, payload: { strokeDasharray: '4 4' } },
                      { value: 'Caja escenario', type: 'plainline', id: 'forecast', color: COLOR.forecast, payload: { strokeDasharray: '0' } },
                      ...(minimumCash > 0
                        ? [{ value: 'Caja mínima', type: 'plainline' as const, id: 'min', color: COLOR.warning, payload: { strokeDasharray: '3 3' } }]
                        : []),
                    ]
                  : [
                      { value: 'Caja final', type: 'plainline', id: 'forecast', color: COLOR.forecast, payload: { strokeDasharray: '0' } },
                      ...(probabilisticProjection
                        ? [
                          { value: 'Rango P10-P90', type: 'plainline' as const, id: 'riskBand', color: '#7c3aed', payload: { strokeDasharray: '0' } },
                          { value: 'Caja P50', type: 'plainline' as const, id: 'p50', color: '#7c3aed', payload: { strokeDasharray: '5 4' } },
                        ]
                        : []),
                      ...(minimumCash > 0
                        ? [{ value: 'Caja mínima', type: 'plainline' as const, id: 'min', color: COLOR.warning, payload: { strokeDasharray: '3 3' } }]
                        : []),
                    ]
              }
            />

            {hasBaseline && (
              <Area
                type="monotone"
                dataKey="deltaAbove"
                fill={COLOR.successFill}
                fillOpacity={0.75}
                stroke="none"
                isAnimationActive
                animationDuration={500}
                animationEasing="ease-out"
                name="deltaAbove"
                legendType="none"
                connectNulls={false}
              />
            )}
            {probabilisticProjection && (
              <Area
                type="monotone"
                dataKey="riskBand"
                fill="#ede9fe"
                fillOpacity={0.85}
                stroke="none"
                isAnimationActive
                animationDuration={450}
                animationEasing="ease-out"
                name="riskBand"
                legendType="none"
                connectNulls={false}
              />
            )}
            {hasBaseline && (
              <Area
                type="monotone"
                dataKey="deltaBelow"
                fill={COLOR.dangerFill}
                fillOpacity={0.75}
                stroke="none"
                isAnimationActive
                animationDuration={500}
                animationEasing="ease-out"
                name="deltaBelow"
                legendType="none"
                connectNulls={false}
              />
            )}

            {crossesZero && (
              <ReferenceLine
                y={0}
                stroke={COLOR.danger}
                strokeDasharray="2 4"
                strokeOpacity={0.5}
                ifOverflow="extendDomain"
              />
            )}

            {minimumCash > 0 && (
              <ReferenceLine
                y={minimumCash}
                stroke={COLOR.warning}
                strokeDasharray="3 3"
                label={{
                  value: `Caja mínima · ${fmtCompact(minimumCash)}`,
                  position: 'insideTopRight',
                  fill: COLOR.warning,
                  fontSize: 10,
                  fontWeight: 600,
                  offset: 6,
                }}
              />
            )}

            {hasBaseline && (
              <Line
                type="monotone"
                dataKey="base"
                stroke={COLOR.base}
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
                name="Caja base"
                isAnimationActive
                animationDuration={400}
                animationBegin={0}
                animationEasing="ease-out"
              />
            )}
            <Line
              type="monotone"
              dataKey="forecast"
              stroke={COLOR.forecast}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
              name={hasBaseline ? 'Caja escenario' : 'Caja final'}
              isAnimationActive
              animationDuration={520}
              animationBegin={hasBaseline ? 200 : 0}
              animationEasing="ease-out"
            />
            {probabilisticProjection && (
              <Line
                type="monotone"
                dataKey="p50"
                stroke="#7c3aed"
                strokeWidth={1.5}
                strokeDasharray="5 4"
                dot={false}
                name="Caja P50"
                isAnimationActive
                animationDuration={480}
                animationBegin={120}
                animationEasing="ease-out"
              />
            )}

            {lastPoint && (
              <ReferenceDot
                x={lastPoint.yearMonth}
                y={lastPoint.forecast}
                shape={<LastPointDot />}
                ifOverflow="extendDomain"
                isFront
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
};

export default CashTrajectoryChart;
