/**
 * Sub-pestaña "Tendencia" del dashboard de Nómina.
 *
 * Serie temporal del costo de nómina sobre la historia completa (no acotada al
 * mes filtrado). Toggle de granularidad: semanal (ancla lunes ISO de la fecha
 * de pago — apropiado para nómina Semanal) o mensual. Muestra la variación del
 * último periodo contra el anterior.
 *
 * La ventana semanal se acota a las últimas ~26 semanas (regla de CLAUDE.md:
 * "Granularity-bounded window") para no renderizar cientos de buckets.
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
import { ArrowDownRight, ArrowRight, ArrowUpRight, TrendingUp } from 'lucide-react';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import EmptyState from '../../shared-finance/components/EmptyState';
import type { PayrollCostRecord } from '../../shared-finance/types';
import {
  buildPayrollTimeSeries,
  seriesVariation,
  type PayrollGranularity,
} from '../services/payrollAnalyticsService';
import { ChartCard, ChartFrame, TOOLTIP_STYLE } from './chartPrimitives';

const WEEKLY_WINDOW = 26;

export default function PayrollTrendView({ records }: { records: PayrollCostRecord[] }) {
  const [granularity, setGranularity] = useState<PayrollGranularity>('monthly');

  const series = useMemo(() => {
    const all = buildPayrollTimeSeries(records, granularity);
    return granularity === 'weekly' ? all.slice(-WEEKLY_WINDOW) : all;
  }, [records, granularity]);

  const variation = useMemo(
    () => seriesVariation(series.map(p => p.employerCost)),
    [series],
  );

  if (records.length === 0) {
    return (
      <EmptyState
        icon={<TrendingUp className="h-6 w-6" />}
        title="Sin historia para estos filtros"
        description="La tendencia usa la historia completa (todos los meses) de la empresa y tipo de nómina seleccionados."
      />
    );
  }

  const periodLabel = granularity === 'weekly' ? 'vs semana anterior' : 'vs mes anterior';
  const deltaColor = variation.deltaAbs > 0 ? 'var(--danger)' : variation.deltaAbs < 0 ? 'var(--success)' : 'var(--gray-400)';
  const DeltaIcon = variation.deltaAbs > 0 ? ArrowUpRight : variation.deltaAbs < 0 ? ArrowDownRight : ArrowRight;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-md border" style={{ borderColor: 'var(--gray-300)' }}>
          {(['monthly', 'weekly'] as const).map((g) => (
            <button
              key={g}
              type="button"
              onClick={() => setGranularity(g)}
              className="px-3 py-1.5 text-sm font-medium transition first:rounded-l-md last:rounded-r-md"
              style={{
                background: granularity === g ? 'var(--accent-blue)' : 'var(--surface)',
                color: granularity === g ? '#fff' : 'var(--gray-600)',
              }}
            >
              {g === 'monthly' ? 'Mensual' : 'Semanal'}
            </button>
          ))}
        </div>
        <div
          className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
          style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
        >
          <span style={{ color: 'var(--gray-500)' }}>Último periodo:</span>
          <span className="font-semibold tabular-nums" style={{ color: 'var(--gray-900)' }}>
            {fmtCompact(variation.current)}
          </span>
          <span className="inline-flex items-center gap-0.5 font-medium tabular-nums" style={{ color: deltaColor }}>
            <DeltaIcon className="h-3.5 w-3.5" />
            {variation.deltaPct != null ? `${variation.deltaPct >= 0 ? '+' : ''}${variation.deltaPct.toFixed(1)}%` : 'N/D'}
          </span>
          <span className="text-xs" style={{ color: 'var(--gray-400)' }}>{periodLabel}</span>
        </div>
      </div>

      <ChartCard
        title="Costo de nómina en el tiempo"
        subtitle={
          granularity === 'weekly'
            ? `Últimas ${WEEKLY_WINDOW} semanas · ancla lunes ISO de la fecha de pago`
            : 'Costo empresa (Percepciones + Aportaciones patronales) por mes'
        }
      >
        <ChartFrame height={340}>
          <ComposedChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id="payrollTrendFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent-blue)" stopOpacity={0.25} />
                <stop offset="100%" stopColor="var(--accent-blue)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="recharts-cartesian-grid" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--gray-400)' }} minTickGap={16} />
            <YAxis tickFormatter={fmtCompact} tick={{ fontSize: 11, fill: 'var(--gray-400)' }} width={60} />
            <Tooltip
              isAnimationActive={false}
              contentStyle={TOOLTIP_STYLE}
              formatter={(value: number, name: string) => [fmtCurrency(value), name]}
            />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            <Area
              type="monotone"
              dataKey="employerCost"
              name="Costo empresa"
              stroke="var(--accent-blue)"
              strokeWidth={2}
              fill="url(#payrollTrendFill)"
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="netCashOnPaymentDate"
              name="Pago neto"
              stroke="var(--success)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="employerTaxes"
              name="Aportaciones patronales"
              stroke="var(--danger)"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ChartFrame>
      </ChartCard>
    </div>
  );
}
