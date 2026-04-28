import { Check, Send, X } from 'lucide-react';
import { fmtCompact } from '../../../formatters';
import { ApprovalBadge } from '../../shared-finance/components/FinanceBadges';
import type { FinancialAdjustment } from '../../shared-finance/types';

export function AdjustmentLibrary({
  adjustments,
  activeScenarioId,
  onSubmit,
  onApprove,
  onReject,
}: {
  adjustments: FinancialAdjustment[];
  activeScenarioId: string;
  onSubmit: (adjustment: FinancialAdjustment) => void;
  onApprove: (adjustment: FinancialAdjustment) => void;
  onReject: (adjustment: FinancialAdjustment) => void;
}) {
  const scoped = adjustments.filter((adjustment) => adjustment.scenarioIds.includes(activeScenarioId));
  return (
    <section className="rounded-xl border border-[var(--border)] bg-white shadow-[var(--shadow-card)]">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Ajustes financieros</h2>
        <p className="mt-1 text-[12px] text-[var(--gray-500)]">Biblioteca reutilizable de cambios por escenario.</p>
      </div>
      <div className="divide-y divide-[var(--border)]">
        {scoped.length === 0 ? (
          <div className="px-4 py-6 text-[12px] text-[var(--gray-500)]">Sin ajustes para este escenario.</div>
        ) : scoped.map((adjustment) => (
          <div key={adjustment.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-[var(--gray-950)]">{adjustment.name}</div>
                <div className="mt-1 text-[11px] text-[var(--gray-400)]">{adjustment.type} · {adjustment.targetType} · {adjustment.reasonCode}</div>
                <p className="mt-2 text-[12px] text-[var(--gray-600)]">{adjustment.justification}</p>
              </div>
              <ApprovalBadge status={adjustment.status} />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] text-[var(--gray-500)]">
                Impacto caja {fmtCompact(adjustment.impactSummary?.cashImpact ?? 0)}
              </div>
              <div className="flex gap-1.5">
                {adjustment.status === 'DRAFT' && (
                  <button onClick={() => onSubmit(adjustment)} className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--border)] px-2 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)]">
                    <Send className="h-3.5 w-3.5" strokeWidth={1.5} />
                    Revisión
                  </button>
                )}
                {adjustment.status === 'IN_REVIEW' && (
                  <>
                    <button onClick={() => onApprove(adjustment)} className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--success)]/30 bg-[var(--success-muted)] px-2 text-[11px] font-medium text-[var(--success)]">
                      <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
                      Aprobar
                    </button>
                    <button onClick={() => onReject(adjustment)} className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--danger)]/20 bg-[var(--danger-muted)] px-2 text-[11px] font-medium text-[var(--danger)]">
                      <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                      Rechazar
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
