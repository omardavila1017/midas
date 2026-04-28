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

/**
 * Chart de caja proyectada. Mantiene el modelo del Dashboard:
 *   - Barras apiladas de ingresos vs egresos
 *   - Línea de caja final
 *   - Referencia horizontal a caja mínima
 *   - Línea punteada del base cuando se compara escenario vs base
 *
 * Antes el chart estaba dentro de un card con `shadow-[var(--shadow-card)]`
 * que no usa nadie más; ahora hereda el patrón de Dashboard
 * (border-[var(--gray-200)] sin sombra) para consistencia visual.
 */
export function CashFlowChart({
  projection,
  baseProjection,
}: {
  projection: ForecastRun;
  baseProjection?: ForecastRun;
}) {
  const baseByDate = new Map(
    baseProjection?.buckets.map((bucket) => [bucket.date, bucket.closingCash]) ?? [],
  );
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
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">
            Caja proyectada
          </h2>
          <p className="mt-1 text-[12px] text-[var(--gray-400)]">
            Entradas, salidas, cierre y caja mínima.
            {baseProjection ? ' La línea punteada es el escenario base.' : ' Vista del escenario base.'}
          </p>
        </div>
        <div className="text-right text-[12px] text-[var(--gray-400)]">
          {projection.startDate} → {projection.endDate}
        </div>
      </div>
      <div className="mt-4" style={{ height: 340 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 12, right: 18, bottom: 0, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: 'var(--gray-400)' }}
              minTickGap={18}
            />
            <YAxis
              tickFormatter={fmtCompact}
              tick={{ fontSize: 11, fill: 'var(--gray-400)' }}
              width={72}
            />
            <Tooltip
              formatter={(value: number, name: string) => [fmtCurrency(value), name]}
              labelFormatter={(_, payload) => payload?.[0]?.payload?.rawDate ?? ''}
              contentStyle={{
                border: '1px solid var(--gray-200)',
                borderRadius: '10px',
                fontSize: 12,
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            <Bar
              dataKey="entradas"
              name="Ingresos"
              fill="var(--success)"
              barSize={12}
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="salidas"
              name="Egresos"
              fill="var(--danger)"
              barSize={12}
              radius={[4, 4, 0, 0]}
            />
            <Line
              type="monotone"
              dataKey="caja"
              name="Caja final"
              stroke="#1d4ed8"
              strokeWidth={2.5}
              dot={false}
            />
            {baseProjection && (
              <Line
                type="monotone"
                dataKey="base"
                name="Caja base"
                stroke="var(--gray-400)"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
              />
            )}
            <ReferenceLine
              y={projection.summary.minimumCashRequired}
              stroke="var(--warning)"
              strokeDasharray="3 3"
              label={{
                value: 'Caja mínima',
                position: 'right',
                fill: 'var(--warning)',
                fontSize: 10,
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
