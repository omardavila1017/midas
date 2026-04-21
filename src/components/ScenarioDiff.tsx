import React, { useMemo } from 'react';
import {
  BarChart,
  Bar,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { Trophy, X } from 'lucide-react';
import type { ScenarioKpis } from '../types';
import { fmtCurrency } from '../formatters';
import { hex } from '../theme';

interface ScenarioDiffProps {
  scenarioA: { name: string; kpis: ScenarioKpis };
  scenarioB: { name: string; kpis: ScenarioKpis };
  onClose: () => void;
}

interface KpiRow {
  key: keyof ScenarioKpis;
  label: string;
  direction: 'higher' | 'lower';
}

const KPI_ROWS: KpiRow[] = [
  { key: 'ingresos12m', label: 'Ingresos 12M', direction: 'higher' },
  { key: 'egresos12m', label: 'Egresos 12M', direction: 'lower' },
  { key: 'flujoNeto12m', label: 'Flujo Neto 12M', direction: 'higher' },
  { key: 'cajaFinal', label: 'Caja Final', direction: 'higher' },
  { key: 'cajaMinima', label: 'Caja Mínima', direction: 'higher' },
  { key: 'cobranza12m', label: 'Cobranza 12M', direction: 'higher' },
  { key: 'pagosProveedores12m', label: 'Pagos Proveedores', direction: 'lower' },
];

const TOP_4_KPIS = ['ingresos12m', 'flujoNeto12m', 'cajaFinal', 'cobranza12m'] as const;

export default function ScenarioDiff({
  scenarioA,
  scenarioB,
  onClose,
}: ScenarioDiffProps): React.ReactElement {
  const analysis = useMemo(() => {
    let aWins = 0;
    let bWins = 0;

    KPI_ROWS.forEach(({ key, direction }) => {
      const valA = scenarioA.kpis[key];
      const valB = scenarioB.kpis[key];

      if (direction === 'higher') {
        if (valA > valB) aWins++;
        else if (valB > valA) bWins++;
      } else {
        if (valA < valB) aWins++;
        else if (valB < valA) bWins++;
      }
    });

    return { aWins, bWins, totalKpis: KPI_ROWS.length };
  }, [scenarioA.kpis, scenarioB.kpis]);

  const chartData = useMemo(() => {
    return TOP_4_KPIS.map((kpiKey) => {
      const kpiRow = KPI_ROWS.find((r) => r.key === kpiKey);
      if (!kpiRow) return null;

      return {
        name: kpiRow.label,
        [scenarioA.name]: scenarioA.kpis[kpiKey],
        [scenarioB.name]: scenarioB.kpis[kpiKey],
      };
    }).filter(Boolean);
  }, [scenarioA, scenarioB]);

  const isDarkBg = false;
  const textColor = isDarkBg ? '#ffffff' : '#000000';
  const gridColor = isDarkBg ? '#404040' : '#e5e7eb';

  return (
    <div className="animate-card-in fixed inset-0 z-[400] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-lg bg-white shadow-lg">
        {/* Header */}
        <div className="sticky top-0 bg-gradient-to-r from-blue-50 to-blue-100 px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Comparativa de Escenarios</h2>
            <p className="text-sm text-gray-600 mt-1">
              {scenarioA.name} vs {scenarioB.name}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/50 rounded-md transition-colors"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5 text-gray-700" />
          </button>
        </div>

        {/* Main Content */}
        <div className="p-6 space-y-6">
          {/* KPI Comparison Table */}
          <section>
            <h3 className="text-sm font-semibold text-gray-900 mb-3 uppercase tracking-wider">
              Comparación de KPIs
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-100 border-b border-gray-300">
                    <th className="px-4 py-3 text-left font-semibold text-gray-900 w-40">KPI</th>
                    <th className="px-4 py-3 text-right font-semibold text-gray-900">
                      {scenarioA.name}
                    </th>
                    <th className="px-4 py-3 text-right font-semibold text-gray-900">
                      {scenarioB.name}
                    </th>
                    <th className="px-4 py-3 text-right font-semibold text-gray-700">Delta ($)</th>
                    <th className="px-4 py-3 text-right font-semibold text-gray-700">Delta (%)</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-700 w-12">Ganador</th>
                  </tr>
                </thead>
                <tbody>
                  {KPI_ROWS.map(({ key, label, direction }) => {
                    const valA = scenarioA.kpis[key];
                    const valB = scenarioB.kpis[key];
                    const deltaAbs = valB - valA;
                    const deltaAbsVal = Math.abs(deltaAbs);
                    const deltaPct = valA !== 0 ? (deltaAbs / Math.abs(valA)) * 100 : 0;

                    // Determine color coding
                    // Green = improvement, Red = deterioration
                    let deltaColor = 'text-gray-700';
                    const isImprovement =
                      (direction === 'higher' && deltaAbs > 0) ||
                      (direction === 'lower' && deltaAbs < 0);
                    if (Math.abs(deltaAbs) > 0.01) {
                      deltaColor = isImprovement ? 'text-green-600' : 'text-red-600';
                    }

                    // Winner logic
                    let winner: 'A' | 'B' | null = null;
                    if (direction === 'higher') {
                      if (valA > valB) winner = 'A';
                      else if (valB > valA) winner = 'B';
                    } else {
                      if (valA < valB) winner = 'A';
                      else if (valB < valA) winner = 'B';
                    }

                    return (
                      <tr key={key} className="border-b border-gray-200 hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">{label}</td>
                        <td className="px-4 py-3 text-right font-mono text-gray-900">
                          {fmtCurrency(valA)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-gray-900">
                          {fmtCurrency(valB)}
                        </td>
                        <td className={`px-4 py-3 text-right font-mono font-medium ${deltaColor}`}>
                          {deltaAbs >= 0 ? '+' : ''}{fmtCurrency(deltaAbs)}
                        </td>
                        <td className={`px-4 py-3 text-right font-mono font-medium ${deltaColor}`}>
                          {deltaPct >= 0 ? '+' : ''}{deltaPct.toFixed(1)}%
                        </td>
                        <td className="px-4 py-3 text-center">
                          {winner && (
                            <div className="flex justify-center">
                              <Trophy
                                className="w-4 h-4"
                                style={{
                                  color: hex.warning,
                                }}
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Verdict */}
          <section className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg border border-blue-200 p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-2 uppercase tracking-wider">
              Veredicto
            </h3>
            <div className="flex gap-6 items-center">
              <div className="flex-1">
                <p className="text-sm text-gray-700">
                  <span className="font-semibold text-blue-900">{scenarioA.name}</span>: ganador en{' '}
                  <span className="font-bold text-blue-900">{analysis.aWins}</span> de{' '}
                  {analysis.totalKpis} KPIs
                </p>
              </div>
              <div className="flex-1">
                <p className="text-sm text-gray-700">
                  <span className="font-semibold text-blue-900">{scenarioB.name}</span>: ganador en{' '}
                  <span className="font-bold text-blue-900">{analysis.bWins}</span> de{' '}
                  {analysis.totalKpis} KPIs
                </p>
              </div>
              {analysis.aWins !== analysis.bWins && (
                <div className="flex items-center gap-2 bg-white/60 px-4 py-2 rounded-md border border-yellow-300">
                  <Trophy className="w-4 h-4" style={{ color: hex.warning }} />
                  <p className="text-sm font-bold text-gray-900">
                    {analysis.aWins > analysis.bWins ? scenarioA.name : scenarioB.name} destaca
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Bar Chart */}
          <section>
            <h3 className="text-sm font-semibold text-gray-900 mb-3 uppercase tracking-wider">
              Top 4 KPIs
            </h3>
            <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
              <ResponsiveContainer width="100%" height={300}>
                <BarChart
                  data={chartData}
                  margin={{ top: 20, right: 30, left: 20, bottom: 60 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke={gridColor}
                    vertical={false}
                  />
                  <XAxis
                    dataKey="name"
                    angle={-20}
                    textAnchor="end"
                    height={100}
                    tick={{ fontSize: 12, fill: textColor }}
                  />
                  <YAxis tick={{ fontSize: 12, fill: textColor }} />
                  <Tooltip
                    formatter={(value: number) => fmtCurrency(value)}
                    contentStyle={{
                      backgroundColor: 'rgba(255, 255, 255, 0.95)',
                      border: `1px solid ${gridColor}`,
                      borderRadius: '8px',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                    }}
                    labelStyle={{ color: textColor }}
                  />
                  <Legend
                    wrapperStyle={{ paddingTop: '20px' }}
                    iconType="rect"
                  />
                  <Bar dataKey={scenarioA.name} fill={hex.primary} radius={[4, 4, 0, 0]} />
                  <Bar dataKey={scenarioB.name} fill={hex.success} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        </div>

        {/* Footer Actions */}
        <div className="sticky bottom-0 bg-gray-50 px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-6 py-2 rounded-lg bg-white border border-gray-300 text-gray-900 font-medium hover:bg-gray-100 transition-colors"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
