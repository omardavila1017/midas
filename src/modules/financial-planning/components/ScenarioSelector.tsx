import { Plus } from 'lucide-react';
import type { FinancialScenario, ScenarioComparison } from '../../shared-finance/types';
import { ApprovalBadge } from '../../shared-finance/components/FinanceBadges';
import { fmtCompact } from '../../../formatters';

export function ScenarioSelector({
  scenarios,
  activeScenarioId,
  comparisons,
  onSelect,
  onCreate,
}: {
  scenarios: FinancialScenario[];
  activeScenarioId: string;
  comparisons: ScenarioComparison[];
  onSelect: (scenarioId: string) => void;
  onCreate: () => void;
}) {
  const comparisonById = new Map(comparisons.map((comparison) => [comparison.scenarioId, comparison]));
  return (
    <section className="rounded-xl border border-[var(--border)] bg-white shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Escenarios</h2>
          <p className="mt-1 text-[12px] text-[var(--gray-500)]">El escenario base permanece visible como referencia.</p>
        </div>
        <button onClick={onCreate} className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--primary)] bg-[var(--primary)] px-3 text-[12px] font-medium text-white">
          <Plus className="h-4 w-4" strokeWidth={1.5} />
          Nuevo
        </button>
      </div>
      <div className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-3">
        {scenarios.map((scenario) => {
          const comparison = comparisonById.get(scenario.id);
          const active = activeScenarioId === scenario.id;
          return (
            <button
              key={scenario.id}
              onClick={() => onSelect(scenario.id)}
              className={`rounded-xl border p-3 text-left transition-colors ${active ? 'border-[var(--primary)] bg-[var(--primary-muted)]' : 'border-[var(--border)] bg-white hover:bg-[var(--surface-alt)]'}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-[var(--gray-950)]">{scenario.name}</div>
                  <div className="mt-1 text-[11px] text-[var(--gray-400)]">{scenario.kind}</div>
                </div>
                <ApprovalBadge status={scenario.status} />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-[var(--gray-500)]">
                <span>Caja final <strong className="text-[var(--gray-950)]">{comparison ? fmtCompact(comparison.finalCash) : 'Base'}</strong></span>
                <span>Impacto <strong className={comparison && comparison.finalCashDelta < 0 ? 'text-[var(--danger)]' : 'text-[var(--success)]'}>{comparison ? fmtCompact(comparison.finalCashDelta) : '—'}</strong></span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
