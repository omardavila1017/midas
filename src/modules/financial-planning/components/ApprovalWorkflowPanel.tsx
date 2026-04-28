import { CheckCircle2, FileCheck2, Send } from 'lucide-react';
import type { FinancialScenario } from '../../shared-finance/types';
import { ApprovalBadge } from '../../shared-finance/components/FinanceBadges';

export function ApprovalWorkflowPanel({
  scenario,
  onApproveScenario,
  onPublishPlan,
}: {
  scenario: FinancialScenario;
  onApproveScenario: () => void;
  onPublishPlan: () => void;
}) {
  const steps = [
    { label: 'Borrador', active: true },
    { label: 'Revisión', active: scenario.status === 'IN_REVIEW' || scenario.status === 'APPROVED' || scenario.status === 'PUBLISHED' },
    { label: 'Aprobado', active: scenario.status === 'APPROVED' || scenario.status === 'PUBLISHED' },
    { label: 'Publicado', active: scenario.status === 'PUBLISHED' },
  ];
  return (
    <section className="rounded-xl border border-[var(--border)] bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Aprobaciones</h2>
          <p className="mt-1 text-[12px] text-[var(--gray-500)]">Flujo: ajuste → revisión → aprobación → plan oficial.</p>
        </div>
        <ApprovalBadge status={scenario.status} />
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-4">
        {steps.map((step) => (
          <div key={step.label} className={`rounded-lg border px-3 py-2 text-[12px] ${step.active ? 'border-[var(--primary)]/25 bg-[var(--primary-muted)] text-[var(--gray-950)]' : 'border-[var(--border)] bg-white text-[var(--gray-400)]'}`}>
            {step.label}
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)]">
          <Send className="h-4 w-4" strokeWidth={1.5} />
          Enviar escenario
        </button>
        <button onClick={onApproveScenario} disabled={scenario.isBase} className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--success)]/30 bg-[var(--success-muted)] px-3 text-[12px] font-medium text-[var(--success)] disabled:cursor-not-allowed disabled:opacity-40">
          <CheckCircle2 className="h-4 w-4" strokeWidth={1.5} />
          Aprobar escenario
        </button>
        <button onClick={onPublishPlan} disabled={scenario.status !== 'APPROVED'} className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--primary)] bg-[var(--primary)] px-3 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">
          <FileCheck2 className="h-4 w-4" strokeWidth={1.5} />
          Publicar plan
        </button>
      </div>
    </section>
  );
}
