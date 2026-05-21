import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, GitBranch, GitCompare, Lock, ShieldCheck, X } from 'lucide-react';
import { fmtCompact } from '../../../formatters';
import type { FinancialScenario } from '../../shared-finance/types';

/**
 * Comparison bar for Proyección Financiera.
 *
 * Selection of the *active* scenario moved to the global header selector, so
 * the old read-only tab strip + standalone comparison dropdown were
 * redundant and unclear. This single bar makes the mental model explicit:
 * "you pick the active scenario up top ↑, here you compare it against
 * another one." Colors mirror the chart lines (active = blue, comparison =
 * amber, base = gray) so the legend reads against the graph.
 */

const ACTIVE_COLOR = '#1d4ed8';
const COMPARISON_COLOR = 'var(--warning)';
const BASE_COLOR = 'var(--gray-400)';

export interface ScenarioComparisonBarProps {
  scenarios: FinancialScenario[];
  activeScenarioId: string;
  activeName: string;
  activeFinalCash: number;
  comparisonScenarioId: string | null;
  comparisonName: string | null;
  comparisonFinalCash: number | null;
  baseName: string;
  baseFinalCash: number;
  onChangeComparison: (scenarioId: string | null) => void;
}

function kindIcon(kind: FinancialScenario['kind']) {
  if (kind === 'BASE') return Lock;
  if (kind === 'DRAFT') return GitBranch;
  return ShieldCheck;
}

export function ScenarioComparisonBar(props: ScenarioComparisonBarProps) {
  const {
    scenarios,
    activeScenarioId,
    activeName,
    activeFinalCash,
    comparisonScenarioId,
    comparisonName,
    comparisonFinalCash,
    baseName,
    baseFinalCash,
    onChangeComparison,
  } = props;

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const activeScenario = scenarios.find((s) => s.id === activeScenarioId);
  const ActiveIcon = kindIcon(activeScenario?.kind ?? 'APPROVED');
  const candidates = scenarios.filter((s) => s.id !== activeScenarioId && !s.archivedAt);

  const referenceCash = comparisonFinalCash ?? baseFinalCash;
  const referenceName = comparisonName ?? baseName;
  const delta = activeFinalCash - referenceCash;
  const deltaTone =
    delta > 0 ? 'var(--success)' : delta < 0 ? 'var(--danger)' : 'var(--gray-400)';
  const deltaText = `${delta === 0 ? '±0' : (delta > 0 ? '+' : '') + fmtCompact(delta)}`;

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {/* Active scenario — read-only, chosen in the header */}
        <div className="flex items-center gap-2.5">
          <span
            className="h-2.5 w-2.5 rounded-full flex-shrink-0"
            style={{ background: ACTIVE_COLOR }}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
              Escenario activo
            </p>
            <p className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--gray-950)]">
              <ActiveIcon className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.5} />
              <span className="truncate max-w-[200px]">{activeName}</span>
            </p>
          </div>
          <span
            className="inline-flex items-center gap-1 rounded-full bg-[var(--gray-100)] px-2 py-0.5 text-[10px] font-medium text-[var(--gray-500)]"
            title="El escenario activo se elige en la barra superior"
          >
            <ArrowUp className="h-3 w-3" strokeWidth={2} />
            elígelo arriba
          </span>
        </div>

        <span className="text-[12px] font-bold uppercase tracking-[0.1em] text-[var(--gray-300)]">
          vs
        </span>

        {/* Comparison picker */}
        <div className="relative flex items-center gap-2.5" ref={ref}>
          <span
            className="h-2.5 w-2.5 rounded-full flex-shrink-0"
            style={{
              background: comparisonScenarioId ? COMPARISON_COLOR : 'var(--gray-200)',
            }}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
              Comparar contra
            </p>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={open}
              className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--gray-950)] hover:text-[var(--primary)] transition-colors"
            >
              <GitCompare className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.5} />
              <span className="truncate max-w-[200px]">
                {comparisonName ?? 'Sin comparación'}
              </span>
              <ChevronDown
                className={`h-3.5 w-3.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
                strokeWidth={1.5}
              />
            </button>
          </div>
          {comparisonScenarioId && (
            <button
              type="button"
              onClick={() => onChangeComparison(null)}
              aria-label="Quitar comparación"
              className="rounded-full p-1 text-[var(--gray-400)] hover:bg-[var(--gray-100)] hover:text-[var(--gray-700)] transition-colors"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          )}

          {open && (
            <div
              className="absolute left-0 top-12 z-40 w-[280px] rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white p-1.5 shadow-lg max-h-[360px] overflow-y-auto"
            >
              <button
                type="button"
                onClick={() => { onChangeComparison(null); setOpen(false); }}
                className="w-full rounded-[var(--radius-md)] px-3 py-2 text-left text-[13px] font-medium transition"
                style={{
                  background: !comparisonScenarioId ? 'var(--primary-muted)' : undefined,
                  color: !comparisonScenarioId ? 'var(--primary)' : 'var(--gray-700)',
                }}
              >
                Sin comparación
              </button>
              {candidates.length > 0 && <div className="my-1 h-px bg-[var(--gray-100)]" />}
              {candidates.map((s) => {
                const Icon = kindIcon(s.kind);
                const isSel = s.id === comparisonScenarioId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => { onChangeComparison(s.id); setOpen(false); }}
                    className="flex w-full items-center gap-2.5 rounded-[var(--radius-md)] px-3 py-2 text-left text-[13px] transition"
                    style={{
                      background: isSel ? 'var(--primary-muted)' : undefined,
                      color: isSel ? 'var(--primary)' : 'var(--gray-950)',
                    }}
                  >
                    <Icon className="h-4 w-4 flex-shrink-0" strokeWidth={1.5} />
                    <span className="truncate font-medium">{s.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Delta — the headline number of the comparison */}
        <div className="ml-auto text-right">
          <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
            Δ caja final vs {referenceName}
          </p>
          <p className="text-[18px] font-bold tabular-nums leading-tight" style={{ color: deltaTone }}>
            {deltaText}
          </p>
          <p className="text-[11px] tabular-nums text-[var(--gray-400)]">
            {fmtCompact(activeFinalCash)} vs {fmtCompact(referenceCash)}
          </p>
        </div>
      </div>

      {/* Legend — matches the chart line colors */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--gray-100)] pt-2 text-[11px] text-[var(--gray-500)]">
        <LegendDot color={ACTIVE_COLOR} label={`Activo · ${activeName}`} />
        {comparisonScenarioId && comparisonName && (
          <LegendDot color={COMPARISON_COLOR} label={`Comparación · ${comparisonName}`} />
        )}
        <LegendDot color={BASE_COLOR} label={`Base · ${baseName}`} dashed />
      </div>
    </section>
  );
}

function LegendDot({
  color,
  label,
  dashed = false,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {dashed ? (
        <span
          className="inline-block h-0 w-4 flex-shrink-0"
          style={{ borderTop: `2px dashed ${color}` }}
          aria-hidden="true"
        />
      ) : (
        <span
          className="inline-block h-2 w-4 flex-shrink-0 rounded-full"
          style={{ background: color }}
          aria-hidden="true"
        />
      )}
      <span className="truncate max-w-[220px]">{label}</span>
    </span>
  );
}
