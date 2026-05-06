import { GitBranch, Lock, ShieldCheck } from 'lucide-react';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import type { FinancialScenario, ProjectionSummary } from '../../shared-finance/types';

export interface CompareRow {
  scenario: FinancialScenario;
  summary: ProjectionSummary;
  isActive: boolean;
}

interface Props {
  rows: CompareRow[];
  baselineFinalCash: number;
}

export function ScenarioCompareTable({ rows, baselineFinalCash }: Props) {
  return (
    <section
      role="region"
      aria-label="Comparación de escenarios"
      className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-[var(--surface)] animate-card-in"
    >
      <header className="flex items-center justify-between border-b border-[var(--gray-100)] px-4 py-2.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-500)]">
          Comparación
        </span>
        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--gray-400)]">
          Δ vs Aprobado
        </span>
      </header>
      <div className="grid grid-cols-[minmax(180px,1.4fr)_repeat(4,minmax(110px,1fr))] gap-x-3 border-b border-[var(--gray-100)] px-4 py-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
        <span>Escenario</span>
        <span className="text-right">Caja final</span>
        <span className="text-right">Caja mínima</span>
        <span className="text-right">Días en déficit</span>
        <span className="text-right">Δ caja final</span>
      </div>
      <ul role="list" className="divide-y divide-[var(--gray-100)]">
        {rows.map((row) => (
          <CompareRowItem key={row.scenario.id} row={row} baselineFinalCash={baselineFinalCash} />
        ))}
      </ul>
    </section>
  );
}

function CompareRowItem({ row, baselineFinalCash }: { row: CompareRow; baselineFinalCash: number }) {
  const { scenario, summary, isActive } = row;
  const delta = summary.finalCash - baselineFinalCash;
  const deltaColor = delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--danger)' : 'var(--gray-700)';
  const Icon = scenario.kind === 'BASE' ? Lock : scenario.kind === 'APPROVED' ? ShieldCheck : GitBranch;
  const tone = scenario.kind === 'BASE' ? 'base' : scenario.kind === 'APPROVED' ? 'main' : 'draft';

  return (
    <li
      className="grid grid-cols-[minmax(180px,1.4fr)_repeat(4,minmax(110px,1fr))] items-center gap-x-3 px-4 py-2.5 transition-colors duration-150 hover:bg-[var(--surface-alt)]"
      style={isActive ? { background: 'var(--primary-subtle)' } : undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
          style={{ background: 'var(--gray-100)', color: 'var(--gray-700)' }}
        >
          <Icon className="h-3 w-3" strokeWidth={1.5} />
        </span>
        <span className="truncate text-[12px] font-medium text-[var(--gray-950)]">
          {scenario.name}
        </span>
        <span
          className="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] text-[var(--gray-500)]"
          style={{ background: 'var(--gray-100)' }}
        >
          {tone}
        </span>
        {isActive && (
          <span
            className="rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em]"
            style={{ background: 'var(--primary)', color: 'white' }}
          >
            activo
          </span>
        )}
      </div>
      <span className="text-right text-[12px] tabular-nums font-medium text-[var(--gray-950)]">
        {fmtCurrency(summary.finalCash)}
      </span>
      <span
        className="text-right text-[12px] tabular-nums font-medium"
        style={{ color: summary.minCash < summary.minimumCashRequired ? 'var(--danger)' : 'var(--gray-950)' }}
      >
        {fmtCurrency(summary.minCash)}
      </span>
      <span
        className="text-right text-[12px] tabular-nums font-medium"
        style={{ color: summary.deficitDays > 0 ? 'var(--danger)' : 'var(--gray-500)' }}
      >
        {summary.deficitDays}
      </span>
      <span
        className="text-right text-[12px] tabular-nums font-bold"
        style={{ color: deltaColor }}
      >
        {delta === 0 ? '±0' : `${delta > 0 ? '+' : ''}${fmtCompact(delta)}`}
      </span>
    </li>
  );
}
