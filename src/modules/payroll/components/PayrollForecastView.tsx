/**
 * Sub-pestaña "Predictivo" del dashboard de Nómina.
 *
 * Proyecta la serie mensual de nómina (costo total de empresa o un concepto
 * seleccionado) con los modelos de suavizado exponencial reutilizados de
 * `domain/predictive/holtWinters` (vía `payrollForecastAdapter`). Muestra la
 * historia, el horizonte proyectado y las bandas de confianza 80/95 %.
 *
 * El cómputo (44 conceptos × Holt-Winters no, sólo la serie seleccionada) corre
 * sólo cuando esta sub-pestaña está montada (gating natural por render).
 */

import { useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Sparkles } from 'lucide-react';
import { fmtCompact, fmtCurrency, fmtYearMonthShort } from '../../../formatters';
import EmptyState from '../../shared-finance/components/EmptyState';
import type { PayrollCostRecord } from '../../shared-finance/types';
import {
  distinctMonths,
  monthlyConceptSeries,
  monthlyEmployerCostSeries,
  topConceptsWithShare,
} from '../services/payrollAnalyticsService';
import { FORECAST_MODEL_LABELS, forecastSeries } from '../services/payrollForecastAdapter';
import { ChartCard, ChartFrame, TOOLTIP_STYLE } from './chartPrimitives';

const HORIZON = 6;
const TOTAL_KEY = '__total__';

function addMonths(ym: string, k: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + k, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export default function PayrollForecastView({ records }: { records: PayrollCostRecord[] }) {
  const months = useMemo(() => distinctMonths(records), [records]);
  const topConcepts = useMemo(() => topConceptsWithShare(records, 10), [records]);
  const [selected, setSelected] = useState<string>(TOTAL_KEY);

  const history = useMemo(() => {
    if (selected === TOTAL_KEY) return monthlyEmployerCostSeries(records, months);
    return monthlyConceptSeries(records, selected, months);
  }, [records, months, selected]);

  const forecast = useMemo(() => forecastSeries(history, HORIZON), [history]);

  const chartData = useMemo(() => {
    const rows: Array<{
      label: string;
      actual?: number;
      expected?: number;
      band80?: [number, number];
      band95?: [number, number];
    }> = months.map((m, i) => ({ label: fmtYearMonthShort(m), actual: history[i] }));

    // Puente: ancla el inicio del forecast en el último valor real.
    if (rows.length > 0) {
      rows[rows.length - 1].expected = history[history.length - 1];
    }

    const lastMonth = months[months.length - 1] ?? `${new Date().getFullYear()}-01`;
    forecast.bands.forEach((b) => {
      rows.push({
        label: fmtYearMonthShort(addMonths(lastMonth, b.step)),
        expected: b.expected,
        band80: [b.lo80, b.hi80],
        band95: [b.lo95, b.hi95],
      });
    });
    return rows;
  }, [months, history, forecast]);

  if (months.length < 3) {
    return (
      <EmptyState
        icon={<Sparkles className="h-6 w-6" />}
        title="Historia insuficiente para proyectar"
        description="Se requieren al menos 3 meses de historia. Refresca TRESS para cargar más periodos."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span style={{ color: 'var(--gray-500)' }}>Serie:</span>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded-md border px-2 py-1.5 text-sm"
            style={{ borderColor: 'var(--gray-300)', background: 'var(--surface)' }}
          >
            <option value={TOTAL_KEY}>Total empresa (costo)</option>
            {topConcepts.map((c) => (
              <option key={c.conceptId} value={String(c.conceptId)}>
                {c.conceptName}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2 text-xs">
          <span
            className="rounded-md px-2 py-1"
            style={{ background: 'var(--gray-100)', color: 'var(--gray-700)' }}
          >
            {FORECAST_MODEL_LABELS[forecast.model]}
          </span>
          <span
            className="rounded-md px-2 py-1"
            style={{ background: 'var(--gray-100)', color: 'var(--gray-700)' }}
          >
            MAPE {forecast.mape.toFixed(1)}%
          </span>
        </div>
      </div>

      <ChartCard
        title="Proyección de nómina"
        subtitle={`Horizonte ${HORIZON} meses · bandas de confianza 80 % y 95 %`}
      >
        <ChartFrame height={360}>
          <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" className="recharts-cartesian-grid" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--gray-400)' }} minTickGap={16} />
            <YAxis tickFormatter={fmtCompact} tick={{ fontSize: 11, fill: 'var(--gray-400)' }} width={60} />
            <Tooltip
              isAnimationActive={false}
              contentStyle={TOOLTIP_STYLE}
              formatter={(value: number | [number, number], name: string) => {
                if (Array.isArray(value)) return [`${fmtCompact(value[0])} – ${fmtCompact(value[1])}`, name];
                return [fmtCurrency(value), name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            <Area
              dataKey="band95"
              name="IC 95 %"
              stroke="none"
              fill="var(--accent-blue)"
              fillOpacity={0.08}
              isAnimationActive={false}
            />
            <Area
              dataKey="band80"
              name="IC 80 %"
              stroke="none"
              fill="var(--accent-blue)"
              fillOpacity={0.16}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="actual"
              name="Real"
              stroke="var(--gray-700)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="expected"
              name="Proyección"
              stroke="var(--accent-blue)"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ChartFrame>
      </ChartCard>
    </div>
  );
}
