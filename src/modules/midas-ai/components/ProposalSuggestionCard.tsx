import { Check, Pencil, X } from 'lucide-react';
import { fmtCurrency } from '../../../formatters';
import type { MidasProposalSuggestion } from '../types';

interface Props {
  suggestion: MidasProposalSuggestion;
  onAccept: (suggestion: MidasProposalSuggestion) => void;
  onEdit?: (suggestion: MidasProposalSuggestion) => void;
  onDismiss: (suggestionId: string) => void;
}

export function ProposalSuggestionCard({ suggestion, onAccept, onEdit, onDismiss }: Props) {
  const { draft, estimatedCashImpact, citedSuppliers } = suggestion;
  const positive = estimatedCashImpact >= 0;
  return (
    <div className="rounded-[var(--radius)] border border-[#E5B441]/40 bg-gradient-to-br from-[#FFFCF1] to-white p-3 text-[12px] shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold uppercase tracking-wider text-[#8C6618]">
            Propuesta MIDAS · {draft.type}
          </div>
          <div className="mt-1 text-[13px] font-bold text-[var(--gray-950)] truncate">{draft.name}</div>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(suggestion.id)}
          className="rounded p-1 text-[var(--gray-400)] hover:bg-[var(--gray-100)] hover:text-[var(--gray-700)]"
          aria-label="Descartar"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <div className="text-[var(--gray-500)]">Razón</div>
          <div className="font-medium text-[var(--gray-800)]">{draft.reasonCode}</div>
        </div>
        <div>
          <div className="text-[var(--gray-500)]">Impacto en caja</div>
          <div className={`font-bold ${positive ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>
            {positive ? '+' : ''}
            {fmtCurrency(estimatedCashImpact)}
          </div>
        </div>
      </div>

      {(draft.deltaDays != null || draft.deltaAmount != null || draft.percentageChange != null) && (
        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
          {draft.deltaDays != null && (
            <span className="rounded-full bg-[var(--gray-100)] px-2 py-0.5 text-[var(--gray-700)]">
              {draft.deltaDays > 0 ? `+${draft.deltaDays}` : draft.deltaDays} días
            </span>
          )}
          {draft.deltaAmount != null && (
            <span className="rounded-full bg-[var(--gray-100)] px-2 py-0.5 text-[var(--gray-700)]">
              Δ {fmtCurrency(draft.deltaAmount)}
            </span>
          )}
          {draft.percentageChange != null && (
            <span className="rounded-full bg-[var(--gray-100)] px-2 py-0.5 text-[var(--gray-700)]">
              {draft.percentageChange > 0 ? '+' : ''}
              {draft.percentageChange}%
            </span>
          )}
        </div>
      )}

      <p className="mt-2 text-[12px] leading-relaxed text-[var(--gray-700)]">{draft.justification}</p>

      {citedSuppliers.length > 0 && (
        <div className="mt-1.5 text-[10px] text-[var(--gray-500)]">
          Proveedores citados: {citedSuppliers.join(', ')}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => onAccept(suggestion)}
          className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius)] bg-[var(--gray-950)] px-3 text-[11px] font-bold text-white hover:bg-[var(--gray-800)]"
        >
          <Check className="h-3.5 w-3.5" />
          Aceptar como DRAFT
        </button>
        {onEdit && (
          <button
            type="button"
            onClick={() => onEdit(suggestion)}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-3 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
          >
            <Pencil className="h-3.5 w-3.5" />
            Editar
          </button>
        )}
      </div>
    </div>
  );
}
