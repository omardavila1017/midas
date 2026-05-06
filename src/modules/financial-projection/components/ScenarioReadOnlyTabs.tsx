import { GitBranch, Lock, ShieldCheck } from 'lucide-react';
import { fmtCompact } from '../../../formatters';
import type { FinancialScenario } from '../../shared-finance/types';

export interface ScenarioReadOnlyTabsProps {
  scenarios: FinancialScenario[];
  activeScenarioId: string;
  approvedFinalCash: number;
  finalCashFor: (scenarioId: string) => number;
  onSelect: (scenarioId: string) => void;
}

export function ScenarioReadOnlyTabs(props: ScenarioReadOnlyTabsProps) {
  const { scenarios, activeScenarioId, approvedFinalCash, finalCashFor, onSelect } = props;
  const baseScenario = scenarios.find((s) => s.kind === 'BASE');
  const approvedScenario = scenarios.find((s) => s.kind === 'APPROVED' && !s.archivedAt);
  const drafts = scenarios.filter((s) => s.kind === 'DRAFT' && !s.archivedAt);

  const tooltip = 'Solo lectura. Edita en Planeación Financiera.';

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
          Escenarios
        </span>
        {baseScenario && (
          <CoreTab
            label={baseScenario.name}
            badge="base"
            active={activeScenarioId === baseScenario.id}
            tone="base"
            onClick={() => onSelect(baseScenario.id)}
            tooltip={tooltip}
          />
        )}
        {approvedScenario && (
          <CoreTab
            label={approvedScenario.name}
            badge="main"
            active={activeScenarioId === approvedScenario.id}
            tone="approved"
            onClick={() => onSelect(approvedScenario.id)}
            tooltip={tooltip}
          />
        )}
        {drafts.length > 0 && (
          <span className="mx-2 h-6 w-px bg-[var(--gray-200)]" aria-hidden="true" />
        )}
        {drafts.map((draft) => {
          const finalCash = finalCashFor(draft.id);
          const delta = finalCash - approvedFinalCash;
          const active = activeScenarioId === draft.id;
          return (
            <button
              key={draft.id}
              type="button"
              onClick={() => onSelect(draft.id)}
              aria-pressed={active}
              title={tooltip}
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] border px-3 text-[12px] font-medium transition-colors"
              style={{
                background: active ? 'var(--primary)' : 'white',
                color: active ? 'white' : 'var(--gray-700)',
                borderColor: active ? 'var(--primary)' : 'var(--gray-200)',
              }}
            >
              <GitBranch className="h-3.5 w-3.5" strokeWidth={1.5} />
              <span className="truncate max-w-[160px]">{draft.name}</span>
              {delta !== 0 && (
                <span
                  className="text-[11px] tabular-nums font-bold"
                  style={{ color: active ? 'rgba(255,255,255,0.85)' : delta > 0 ? 'var(--success)' : 'var(--danger)' }}
                >
                  {`${delta > 0 ? '+' : ''}${fmtCompact(delta)}`}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CoreTab({
  label,
  badge,
  active,
  tone,
  onClick,
  tooltip,
}: {
  label: string;
  badge: string;
  active: boolean;
  tone: 'base' | 'approved';
  onClick: () => void;
  tooltip: string;
}) {
  const Icon = tone === 'base' ? Lock : ShieldCheck;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={tooltip}
      className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] border px-3 text-[12px] font-medium transition-colors"
      style={{
        background: active ? 'var(--gray-950)' : 'white',
        color: active ? 'white' : 'var(--gray-700)',
        borderColor: active ? 'var(--gray-950)' : 'var(--gray-200)',
      }}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
      <span className="truncate max-w-[160px]">{label}</span>
      <span
        className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em]"
        style={{
          background: active ? 'rgba(255,255,255,0.15)' : 'var(--gray-100)',
          color: active ? 'white' : 'var(--gray-500)',
        }}
      >
        {badge}
      </span>
    </button>
  );
}
