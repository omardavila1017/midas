import React, { useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { CashFlowMonth, Proposal, Scenario } from '../types';
import { evaluateCashFlow } from '../domain/cashFlowEngine';
import { fmtCompact, fmtCurrency } from '../formatters';

interface Props {
  base: CashFlowMonth[];
  proposals: Proposal[];
  scenarios: Scenario[];
}

const LINE_COLORS = ['#94a3b8', '#2563eb', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444', '#06b6d4'];

const ScenarioComparator: React.FC<Props> = ({ base, proposals, scenarios }) => {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const series = useMemo(() => {
    const evaluations = new Map<string, { label: string; months: { yearMonth: string; closing: number }[] }>();

    // Línea base (propuestas apagadas)
    const baseProposals = proposals.map((p) => ({ ...p, enabled: false }));
    const baseEval = evaluateCashFlow(base, baseProposals);
    evaluations.set('__base__', {
      label: 'Base (sin propuestas)',
      months: baseEval.months.map((m) => ({ yearMonth: m.yearMonth, closing: m.forecastClosingCash })),
    });

    for (const id of selected) {
      const scen = scenarios.find((s) => s.id === id);
      if (!scen) continue;
      const scenProposals = proposals.map((p) => ({
        ...p,
        enabled: scen.proposalStates[p.id] ?? p.enabled,
      }));
      const ev = evaluateCashFlow(base, scenProposals);
      evaluations.set(id, {
        label: scen.name,
        months: ev.months.map((m) => ({ yearMonth: m.yearMonth, closing: m.forecastClosingCash })),
      });
    }

    const chartRows: Record<string, number | string>[] = base.map((m) => ({ yearMonth: m.yearMonth }));
    const keys: string[] = [];
    let i = 0;
    for (const [id, ev] of evaluations) {
      keys.push(id);
      ev.months.forEach((pt, idx) => {
        chartRows[idx][id] = pt.closing;
      });
      i++;
    }
    void i;
    return { chartRows, keys, evaluations };
  }, [base, proposals, scenarios, selected]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const lastIdx = base.length - 1;
  const baseFinal = series.evaluations.get('__base__')?.months[lastIdx]?.closing ?? 0;

  return (
    <div className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="px-4 py-3 border-b border-[var(--gray-100)]">
        <h3 className="text-[14px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
          Comparador de escenarios
        </h3>
        <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
          Selecciona escenarios guardados para superponerlos contra la base.
        </p>
      </div>

      {scenarios.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="text-[13px]" style={{ color: 'var(--gray-400)' }}>
            Guarda al menos un escenario para comparar.
          </p>
        </div>
      ) : (
        <>
          {/* Selector */}
          <div className="px-4 py-3 border-b border-[var(--gray-100)] flex flex-wrap gap-2">
            {scenarios.map((s) => {
              const isSel = selected.has(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => toggle(s.id)}
                  className="px-3 h-8 rounded-full text-[12px] font-medium border transition"
                  style={{
                    background: isSel ? 'var(--primary-muted)' : 'white',
                    borderColor: isSel ? 'var(--primary)' : 'var(--gray-200)',
                    color: isSel ? 'var(--primary)' : 'var(--gray-700)',
                  }}
                >
                  {s.name}
                </button>
              );
            })}
          </div>

          {/* Gráfica */}
          <div className="p-4" style={{ height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series.chartRows} margin={{ top: 10, right: 20, left: 10, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="yearMonth" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => fmtCompact(v)} tick={{ fontSize: 11 }} width={70} />
                <Tooltip
                  formatter={(value: number | string, name: string) => {
                    const ev = series.evaluations.get(name);
                    return [typeof value === 'number' ? fmtCurrency(value) : value, ev?.label ?? name];
                  }}
                  contentStyle={{ borderRadius: 8, borderColor: '#e5e7eb' }}
                />
                <Legend
                  wrapperStyle={{ fontSize: 12, paddingTop: 8 }}
                  formatter={(_value, entry) => {
                    const name = entry?.dataKey as string | undefined;
                    return name ? (series.evaluations.get(name)?.label ?? name) : _value;
                  }}
                />
                {series.keys.map((id, idx) => (
                  <Line
                    key={id}
                    type="monotone"
                    dataKey={id}
                    stroke={LINE_COLORS[idx % LINE_COLORS.length]}
                    strokeWidth={id === '__base__' ? 1.5 : 2}
                    strokeDasharray={id === '__base__' ? '4 4' : undefined}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Tabla de deltas */}
          <div className="px-4 pb-4">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-[var(--gray-100)]">
                  <th className="text-left py-2 font-medium" style={{ color: 'var(--gray-500)' }}>Escenario</th>
                  <th className="text-right py-2 font-medium" style={{ color: 'var(--gray-500)' }}>Caja final ({base[lastIdx]?.yearMonth})</th>
                  <th className="text-right py-2 font-medium" style={{ color: 'var(--gray-500)' }}>Delta vs base</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="py-2" style={{ color: 'var(--gray-950)' }}>Base</td>
                  <td className="text-right tabular-nums">{fmtCurrency(baseFinal)}</td>
                  <td className="text-right tabular-nums" style={{ color: 'var(--gray-400)' }}>—</td>
                </tr>
                {Array.from(selected).map((id) => {
                  const ev = series.evaluations.get(id);
                  if (!ev) return null;
                  const final = ev.months[lastIdx]?.closing ?? 0;
                  const delta = final - baseFinal;
                  return (
                    <tr key={id} className="border-t border-[var(--gray-50)]">
                      <td className="py-2" style={{ color: 'var(--gray-950)' }}>{ev.label}</td>
                      <td className="text-right tabular-nums">{fmtCurrency(final)}</td>
                      <td className="text-right tabular-nums" style={{ color: delta >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                        {delta >= 0 ? '+' : ''}{fmtCurrency(delta)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};

export default ScenarioComparator;
