/**
 * Sub-pestaña "Comparativo" del dashboard de Nómina.
 *
 * Compara el costo de nómina por empresa (cía): barras apiladas de Percepciones
 * + Aportaciones patronales y una tabla con la participación de cada empresa.
 */

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Building2 } from 'lucide-react';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import EmptyState from '../../shared-finance/components/EmptyState';
import type { PayrollCostRecord } from '../../shared-finance/types';
import { summarizeByCompany } from '../services/payrollAnalyticsService';
import { ChartCard, ChartFrame, TOOLTIP_STYLE } from './chartPrimitives';

export default function PayrollCompanyView({ records }: { records: PayrollCostRecord[] }) {
  const companies = useMemo(() => summarizeByCompany(records), [records]);

  if (companies.length === 0) {
    return (
      <EmptyState
        icon={<Building2 className="h-6 w-6" />}
        title="Sin datos por empresa"
        description="Ajusta los filtros para ver el comparativo por compañía."
      />
    );
  }

  const chartData = companies.map(c => ({
    name: c.empresaNomina || c.cia || 'N/D',
    Percepciones: c.grossEarnings,
    'Aportaciones patronales': c.employerTaxes,
  }));

  return (
    <div className="space-y-4">
      <ChartCard
        title="Costo de nómina por empresa"
        subtitle="Percepciones + Aportaciones patronales = costo real para la empresa"
      >
        <ChartFrame height={320}>
          <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" className="recharts-cartesian-grid" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--gray-400)' }} />
            <YAxis tickFormatter={fmtCompact} tick={{ fontSize: 11, fill: 'var(--gray-400)' }} width={60} />
            <Tooltip
              isAnimationActive={false}
              contentStyle={TOOLTIP_STYLE}
              formatter={(value: number, name: string) => [fmtCurrency(value), name]}
            />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            <Bar dataKey="Percepciones" stackId="cost" fill="var(--accent-blue)" isAnimationActive={false} />
            <Bar dataKey="Aportaciones patronales" stackId="cost" fill="var(--danger)" isAnimationActive={false} />
          </BarChart>
        </ChartFrame>
      </ChartCard>

      <section
        className="rounded-[var(--radius-lg)] border"
        style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead
              className="text-[11px] uppercase tracking-wide"
              style={{ color: 'var(--gray-500)', borderBottom: '1px solid var(--gray-200)' }}
            >
              <tr>
                <th className="px-3 py-2 text-left">Empresa</th>
                <th className="px-3 py-2 text-right">Bruto</th>
                <th className="px-3 py-2 text-right">Patronal</th>
                <th className="px-3 py-2 text-right">Costo empresa</th>
                <th className="px-3 py-2 text-right">Pago neto</th>
                <th className="px-3 py-2 text-right">% del total</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.cia || c.empresaNomina} style={{ borderBottom: '1px solid var(--gray-100)' }}>
                  <td className="px-3 py-2">
                    <div className="font-medium" style={{ color: 'var(--gray-900)' }}>
                      {c.empresaNomina || c.cia}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--gray-500)' }}>{c.cia}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(c.grossEarnings)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtCompact(c.employerTaxes)}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums" style={{ color: 'var(--gray-900)' }}>
                    {fmtCompact(c.employerCost)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" style={{ color: 'var(--success)' }}>
                    {fmtCompact(c.netCashOnPaymentDate)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.share.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
