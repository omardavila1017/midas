import { GitCompare } from 'lucide-react';
import type { FinancialScenario } from '../../shared-finance/types';

export interface ComparisonControlProps {
  scenarios: FinancialScenario[];
  activeScenarioId: string;
  comparisonScenarioId: string | null;
  onChange: (scenarioId: string | null) => void;
}

export function ComparisonControl({
  scenarios,
  activeScenarioId,
  comparisonScenarioId,
  onChange,
}: ComparisonControlProps) {
  const candidates = scenarios.filter((scenario) =>
    scenario.id !== activeScenarioId && !scenario.archivedAt,
  );

  return (
    <label className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)]">
      <GitCompare className="h-3.5 w-3.5" strokeWidth={2} />
      <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
        Comparar
      </span>
      <select
        value={comparisonScenarioId ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        className="h-7 bg-transparent text-[12px] font-medium text-[var(--gray-950)] outline-none"
      >
        <option value="">Sin comparación</option>
        {candidates.map((scenario) => (
          <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
        ))}
      </select>
    </label>
  );
}
