import { fmtCompact, fmtPctInt } from '../../../formatters';
import type { ScenarioComparison as ScenarioComparisonModel } from '../../shared-finance/types';

export function ScenarioComparison({
  comparisons,
}: {
  comparisons: ScenarioComparisonModel[];
}) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-white shadow-[var(--shadow-card)]">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Comparador</h2>
        <p className="mt-1 text-[12px] text-[var(--gray-500)]">Base vs escenarios de trabajo.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[940px] text-[12px]">
          <thead className="bg-[var(--surface-alt)] text-left text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--gray-400)]">
            <tr>
              <th className="px-4 py-2.5">Escenario</th>
              <th className="px-4 py-2.5 text-right">Caja final</th>
              <th className="px-4 py-2.5 text-right">Caja mínima</th>
              <th className="px-4 py-2.5 text-right">Días déficit</th>
              <th className="px-4 py-2.5 text-right">Ingresos</th>
              <th className="px-4 py-2.5 text-right">Egresos</th>
              <th className="px-4 py-2.5">Mayor riesgo</th>
              <th className="px-4 py-2.5 text-right">Crédito req.</th>
              <th className="px-4 py-2.5 text-right">Confianza</th>
              <th className="px-4 py-2.5 text-right">Impacto</th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map((comparison) => (
              <tr key={comparison.scenarioId} className="border-t border-[var(--border)]">
                <td className="px-4 py-3 font-medium text-[var(--gray-950)]">{comparison.scenarioName}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtCompact(comparison.finalCash)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtCompact(comparison.minCash)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{comparison.deficitDays}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtCompact(comparison.totalInflows)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtCompact(comparison.totalOutflows)}</td>
                <td className="px-4 py-3">{comparison.maxRiskDate ?? '—'}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtCompact(comparison.creditRequired)}</td>
                <td className="px-4 py-3 text-right tabular-nums">{fmtPctInt(comparison.averageConfidence)}</td>
                <td className={`px-4 py-3 text-right font-semibold tabular-nums ${comparison.finalCashDelta >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
                  {fmtCompact(comparison.finalCashDelta)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
