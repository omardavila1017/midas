import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import type { ForecastRun } from '../../shared-finance/types';

export function CashFlowChart({
  projection,
  baseProjection,
}: {
  projection: ForecastRun;
  baseProjection?: ForecastRun;
}) {
  const baseByDate = new Map(baseProjection?.buckets.map((bucket) => [bucket.date, bucket.closingCash]) ?? []);
  const data = projection.buckets.map((bucket) => ({
    date: bucket.label,
    rawDate: bucket.date,
    entradas: bucket.inflows,
    salidas: bucket.outflows,
    caja: bucket.closingCash,
    minimo: bucket.minimumCash,
    base: baseByDate.get(bucket.date),
  }));

  return (
    <section className="rounded-xl border border-[var(--border)] bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Caja proyectada</h2>
          <p className="mt-1 text-[12px] text-[var(--gray-500)]">Entradas, salidas, cierre y caja mínima. La línea punteada compara contra el base.</p>
        </div>
        <div className="text-right text-[12px] text-[var(--gray-500)]">
          {projection.startDate} → {projection.endDate}
        </div>
      </div>
      <div className="mt-4 h-[320px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 18, bottom: 0, left: 4 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--gray-400)' }} minTickGap={18} />
            <YAxis tickFormatter={fmtCompact} tick={{ fontSize: 11, fill: 'var(--gray-400)' }} width={72} />
            <Tooltip
              formatter={(value: number, name: string) => [fmtCurrency(value), name]}
              labelFormatter={(_, payload) => payload?.[0]?.payload?.rawDate ?? ''}
              contentStyle={{ border: '1px solid var(--border)', borderRadius: '10px', fontSize: 12 }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="entradas" name="Entradas" fill="var(--success)" barSize={12} radius={[4, 4, 0, 0]} />
            <Bar dataKey="salidas" name="Salidas" fill="var(--danger)" barSize={12} radius={[4, 4, 0, 0]} />
            <Line type="monotone" dataKey="caja" name="Caja final" stroke="var(--primary)" strokeWidth={2} dot={false} />
            {baseProjection && (
              <Line type="monotone" dataKey="base" name="Base" stroke="var(--gray-400)" strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
            )}
            <ReferenceLine y={projection.summary.minimumCashRequired} stroke="var(--warning)" strokeDasharray="3 3" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
