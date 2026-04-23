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
import type { EvaluatedCashFlow } from '../types';
import { fmtCompact, fmtCurrency } from '../formatters';
import AnimatedNumber from './ui/AnimatedNumber';

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
  danger: '#dc2626',      // var(--danger)
  dangerFill: '#fee2e2',  // fondo delta negativo (var(--danger-muted))
  success: '#16a34a',
  successFill: '#dcfce7', // fondo delta positivo (var(--success-muted))
  proposalMark: '#1e293b',
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
  forecast: { label: 'Caja simulada', color: '#0f172a' },
  historicalArea: { label: 'Histórico', color: '#64748b' },
  deltaAbove: { label: 'Δ positivo', color: '#16a34a' },
  deltaBelow: { label: 'Δ negativo', color: '#dc2626' },
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
        let amount: number | null = null;
        if (Array.isArray(p.value) && p.value.length === 2) {
          const [lo, hi] = p.value;
          if (typeof lo === 'number' && typeof hi === 'number') {
            amount = Math.abs(hi - lo);
          }
        } else if (typeof p.value === 'number') {
          amount = p.value;
        }
        if (amount === null) return null;
        return (
          <div key={i} style={{ padding: '2px 0', color: meta.color, fontWeight: 500 }}>
            {meta.label} : {fmtCurrency(amount)}
          </div>
        );
      })}
    </div>
  );
};

// Dot fijo en el último punto de la proyección. Marca "dónde termina" sin
// pelear con la línea.
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

// Marker en el mes donde inicia una propuesta: un pequeño pin sobre la curva
// simulada. No lleva label largo — el tooltip ya trae el detalle del mes;
// aquí sólo damos la pista visual de "aquí empezó a actuar la propuesta".
const ProposalStartDot: React.FC<{ cx?: number; cy?: number }> = ({ cx, cy }) => {
  if (cx === undefined || cy === undefined) return null;
  return (
    <g>
      {/* Halo apenas perceptible para separar el pin de la línea */}
      <circle cx={cx} cy={cy} r={7} fill="white" />
      <circle cx={cx} cy={cy} r={5} fill={COLOR.proposalMark} fillOpacity={0.12} />
      <circle cx={cx} cy={cy} r={3.5} fill={COLOR.proposalMark} />
      <circle cx={cx} cy={cy} r={1.5} fill="white" />
    </g>
  );
};

const SimulacionChart: React.FC<Props> = ({ data }) => {
  const firstFutureIndex = data.months.findIndex((m) => !m.isHistorical);

  // chartData genera TODAS las series:
  // - base / forecast: las dos curvas principales.
  // - historicalArea: área gris debajo del histórico. Se extiende un mes
  //   más allá del último histórico para que el relleno toque la línea
  //   vertical "Proyección" (antes terminaba un mes antes y quedaba un
  //   hueco visual en el screenshot que reportó el usuario).
  // - deltaAbove / deltaBelow: rangos [low, high] que Recharts rellena
  //   como área entre las dos líneas. Verde cuando la simulación está
  //   arriba de la base, rojo cuando está abajo. Con type="monotone" las
  //   bandas siguen la forma curva de las líneas.
  const chartData = useMemo(() => {
    return data.months.map((m, i) => {
      const base = m.baseClosingCash;
      const forecast = m.forecastClosingCash;
      const extendArea = m.isHistorical || i === firstFutureIndex;
      return {
        yearMonth: m.yearMonth,
        base,
        forecast,
        historicalArea: extendArea ? base : null,
        deltaAbove: forecast > base ? [base, forecast] : null,
        deltaBelow: forecast < base ? [forecast, base] : null,
      };
    });
  }, [data, firstFutureIndex]);

  const crossesZero = useMemo(
    () => chartData.some((d) => d.base < 0 || d.forecast < 0),
    [chartData],
  );

  const lastForecast = chartData.length > 0 ? chartData[chartData.length - 1] : null;

  // Deltas totales para los KPIs de arriba.
  const deltaClosing = data.totalForecastClosingCash - data.totalBaseClosingCash;
  const deltaSign = deltaClosing >= 0 ? '+' : '−';
  const deltaColor = deltaClosing >= 0 ? COLOR.success : COLOR.danger;

  // Meses presentes en el chart — mapa para resolver propuestas cuyo
  // startYearMonth cae fuera del rango visible (las ignoramos) o antes del
  // histórico (las clampeamos al primer mes visible).
  const monthsSet = useMemo(() => new Set(chartData.map((d) => d.yearMonth)), [chartData]);
  const firstVisibleYm = chartData[0]?.yearMonth;
  const forecastByYm = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of chartData) map.set(d.yearMonth, d.forecast);
    return map;
  }, [chartData]);

  // Marker en el mes en que cada propuesta activa empieza a empujar la curva.
  // Si una propuesta arranca antes del rango, anclamos al primer mes visible;
  // si arranca después, no se muestra (su impacto aún no está en el horizonte).
  const proposalMarkers = useMemo(() => {
    return data.proposals
      .filter((p) => p.enabled)
      .map((p) => {
        let ym = p.startYearMonth;
        if (!monthsSet.has(ym)) {
          if (firstVisibleYm && ym < firstVisibleYm) ym = firstVisibleYm;
          else return null;
        }
        const y = forecastByYm.get(ym);
        if (y === undefined) return null;
        return { id: p.id, name: p.name, yearMonth: ym, y };
      })
      .filter((x): x is { id: string; name: string; yearMonth: string; y: number } => x !== null);
  }, [data.proposals, monthsSet, firstVisibleYm, forecastByYm]);

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
    <div className="w-full animate-fade-in">
      {/* Strip de KPIs arriba de la gráfica */}
      <div className="grid grid-cols-3 gap-6 pb-4 mb-2 border-b border-[var(--gray-100)]">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--gray-400)' }}>
            Caja base (fin)
          </p>
          <AnimatedNumber
            value={data.totalBaseClosingCash}
            format={fmtCurrency}
            className="block text-[15px] font-semibold tabular-nums mt-0.5"
            style={{ color: 'var(--gray-700)' }}
          />
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--gray-400)' }}>
            Caja simulada (fin)
          </p>
          <AnimatedNumber
            value={data.totalForecastClosingCash}
            format={fmtCurrency}
            className="block text-[15px] font-semibold tabular-nums mt-0.5"
            style={{ color: 'var(--gray-950)' }}
          />
        </div>
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--gray-400)' }}>
            Δ vs base
          </p>
          <div className="flex items-baseline gap-1 mt-0.5">
            <span className="text-[15px] font-semibold tabular-nums" style={{ color: deltaColor }}>
              {deltaSign}
            </span>
            <AnimatedNumber
              value={Math.abs(deltaClosing)}
              format={fmtCurrency}
              className="text-[15px] font-semibold tabular-nums"
              style={{ color: deltaColor }}
            />
          </div>
        </div>
      </div>

      <div
        style={{ height: 360 }}
        role="img"
        aria-label="Trayectoria de la caja: línea base vs escenario simulado por mes"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 16, right: 24, left: 8, bottom: 8 }}>
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
            />

            {/* Histórico: área gris debajo de la base, extendida al primer
                mes de proyección para tocar la línea vertical "Proyección". */}
            <Area
              type="monotone"
              dataKey="historicalArea"
              fill={COLOR.histArea}
              fillOpacity={0.22}
              stroke="none"
              isAnimationActive
              animationDuration={500}
              animationEasing="ease-out"
              legendType="none"
              name="historicalArea"
            />

            {/* Banda coloreada entre líneas: verde cuando sim > base, roja
                cuando sim < base. Se dibuja ANTES de las líneas para que
                éstas queden por encima y legibles. */}
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

            {/* Motion: base primero (400ms), simulada después (begin=200). */}
            <Line
              type="monotone"
              dataKey="base"
              stroke={COLOR.base}
              strokeWidth={1.5}
              dot={false}
              name="Caja base"
              isAnimationActive
              animationDuration={400}
              animationBegin={0}
              animationEasing="ease-out"
            />
            <Line
              type="monotone"
              dataKey="forecast"
              stroke={COLOR.forecast}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
              name="Caja simulada"
              isAnimationActive
              animationDuration={520}
              animationBegin={200}
              animationEasing="ease-out"
            />

            {/* Markers por propuesta activa: pin en la curva simulada justo
                en el mes donde la propuesta arranca. Ayuda a ver de un
                vistazo "a partir de aquí empezó a empujar". */}
            {proposalMarkers.map((m) => (
              <ReferenceDot
                key={m.id}
                x={m.yearMonth}
                y={m.y}
                shape={<ProposalStartDot />}
                ifOverflow="extendDomain"
                isFront
                label={{
                  value: m.name,
                  position: 'top',
                  fontSize: 10,
                  fill: COLOR.proposalMark,
                  offset: 10,
                }}
              />
            ))}

            {/* Marker fijo en el último punto simulado */}
            {lastForecast && (
              <ReferenceDot
                x={lastForecast.yearMonth}
                y={lastForecast.forecast}
                shape={<LastPointDot />}
                ifOverflow="extendDomain"
                isFront
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default SimulacionChart;
