/**
 * Sub-pestaña "Conceptos" del dashboard de Nómina.
 *
 * Top conceptos por monto (barra horizontal) + tabla agrupada por tipo de
 * concepto con drill-down a los conceptos de cada grupo.
 */

import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChevronDown, ChevronRight, Tags } from 'lucide-react';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import EmptyState from '../../shared-finance/components/EmptyState';
import type { PayrollCostRecord } from '../../shared-finance/types';
import {
  groupConceptsByType,
  paletteColor,
  topConceptsWithShare,
} from '../services/payrollAnalyticsService';
import { ChartCard, ChartFrame, TOOLTIP_STYLE } from './chartPrimitives';

const TOP_N = 12;

export default function PayrollConceptView({ records }: { records: PayrollCostRecord[] }) {
  const topConcepts = useMemo(() => topConceptsWithShare(records, TOP_N), [records]);
  const groups = useMemo(() => groupConceptsByType(records), [records]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (topConcepts.length === 0) {
    return (
      <EmptyState
        icon={<Tags className="h-6 w-6" />}
        title="Sin conceptos para estos filtros"
        description="Ajusta los filtros para ver la composición por concepto."
      />
    );
  }

  const chartData = topConcepts.map((c, i) => ({
    name: c.conceptName.length > 28 ? `${c.conceptName.slice(0, 27)}…` : c.conceptName,
    total: c.total,
    color: paletteColor(i),
  }));

  const toggle = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-4">
      <ChartCard title={`Top ${TOP_N} conceptos`} subtitle="Por monto absoluto en el filtro actual">
        <ChartFrame height={Math.max(240, chartData.length * 28)}>
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" className="recharts-cartesian-grid" horizontal={false} />
            <XAxis type="number" tickFormatter={fmtCompact} tick={{ fontSize: 11, fill: 'var(--gray-400)' }} />
            <YAxis
              type="category"
              dataKey="name"
              width={180}
              tick={{ fontSize: 11, fill: 'var(--gray-600)' }}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ fill: 'var(--gray-100)' }}
              contentStyle={TOOLTIP_STYLE}
              formatter={(value: number) => [fmtCurrency(value), 'Total']}
            />
            <Bar dataKey="total" isAnimationActive={false} radius={[0, 4, 4, 0]}>
              {chartData.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Bar>
          </BarChart>
        </ChartFrame>
      </ChartCard>

      <section
        className="rounded-[var(--radius-lg)] border"
        style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
      >
        <header className="border-b px-4 py-3" style={{ borderColor: 'var(--gray-200)' }}>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--gray-900)' }}>
            Conceptos por tipo
          </h3>
          <p className="text-xs" style={{ color: 'var(--gray-500)' }}>
            Clic en un tipo para ver sus conceptos.
          </p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {groups.map((g) => {
                const open = expanded.has(g.conceptType);
                return (
                  <FragmentGroup
                    key={g.conceptType}
                    open={open}
                    conceptType={g.conceptType}
                    total={g.total}
                    onToggle={() => toggle(g.conceptType)}
                    concepts={g.concepts}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function FragmentGroup({
  open,
  conceptType,
  total,
  onToggle,
  concepts,
}: {
  open: boolean;
  conceptType: string;
  total: number;
  onToggle: () => void;
  concepts: { conceptId: string | number; conceptName: string; total: number; occurrences: number }[];
}) {
  return (
    <>
      <tr
        className="cursor-pointer"
        onClick={onToggle}
        style={{ borderBottom: '1px solid var(--gray-100)', background: 'var(--surface-alt, var(--gray-50))' }}
      >
        <td className="px-3 py-2">
          <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: 'var(--gray-900)' }}>
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {conceptType}
            <span className="text-xs font-normal" style={{ color: 'var(--gray-500)' }}>
              · {concepts.length} concepto(s)
            </span>
          </span>
        </td>
        <td className="px-3 py-2 text-right font-semibold tabular-nums" style={{ color: 'var(--gray-900)' }}>
          {fmtCurrency(total)}
        </td>
      </tr>
      {open &&
        concepts.map((c) => (
          <tr key={`${conceptType}|${c.conceptId}`} style={{ borderBottom: '1px solid var(--gray-100)' }}>
            <td className="px-3 py-1.5 pl-9">
              <span style={{ color: 'var(--gray-700)' }}>{c.conceptName}</span>
              <span className="ml-2 text-xs" style={{ color: 'var(--gray-400)' }}>#{c.conceptId}</span>
            </td>
            <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: 'var(--gray-700)' }}>
              {fmtCompact(c.total)}
            </td>
          </tr>
        ))}
    </>
  );
}
