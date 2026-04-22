import React, { useState } from 'react';
import { Plus, Pencil, Trash2, TrendingUp, TrendingDown } from 'lucide-react';
import type { Proposal } from '../types';
import { PROPOSAL_FREQUENCY_LABELS } from '../types';
import { fmtCompact } from '../formatters';
import ProposalForm from './ProposalForm';

interface Props {
  proposals: Proposal[];
  onAdd: (proposal: Proposal) => void;
  onUpdate: (proposal: Proposal) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
}

const ProposalManager: React.FC<Props> = ({ proposals, onAdd, onUpdate, onDelete, onToggle }) => {
  const [formOpen, setFormOpen] = useState<null | { mode: 'create' } | { mode: 'edit'; proposal: Proposal }>(null);

  return (
    <>
      <div className="rounded-2xl border border-[var(--gray-200)] bg-white">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--gray-100)]">
          <div>
            <h3 className="text-[14px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
              Propuestas
            </h3>
            <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
              {proposals.filter((p) => p.enabled).length} activas / {proposals.length} totales
            </p>
          </div>
          <button
            onClick={() => setFormOpen({ mode: 'create' })}
            className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[var(--primary)] text-white text-[12px] font-medium hover:bg-[var(--primary-hover)]"
          >
            <Plus className="w-3.5 h-3.5" />
            Nueva
          </button>
        </div>

        {proposals.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-[13px]" style={{ color: 'var(--gray-400)' }}>
              Aún no hay propuestas.
            </p>
            <p className="text-[12px] mt-1" style={{ color: 'var(--gray-400)' }}>
              Crea una para ver su impacto en la caja.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--gray-100)] max-h-[440px] overflow-y-auto">
            {proposals.map((p) => (
              <li key={p.id} className="px-4 py-3 flex items-start gap-3">
                <button
                  onClick={() => onToggle(p.id, !p.enabled)}
                  className="relative inline-flex h-5 w-9 flex-shrink-0 mt-0.5 items-center rounded-full transition"
                  style={{ background: p.enabled ? 'var(--primary)' : 'var(--gray-200)' }}
                  aria-label={p.enabled ? 'Apagar propuesta' : 'Prender propuesta'}
                >
                  <span
                    className="inline-block h-4 w-4 rounded-full bg-white shadow transition"
                    style={{ transform: p.enabled ? 'translateX(18px)' : 'translateX(2px)' }}
                  />
                </button>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    {p.kind === 'income_increase' ? (
                      <TrendingUp className="w-3.5 h-3.5" style={{ color: 'var(--success)' }} />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5" style={{ color: 'var(--primary)' }} />
                    )}
                    <p className="text-[13px] font-medium truncate" style={{ color: p.enabled ? 'var(--gray-950)' : 'var(--gray-400)' }}>
                      {p.name}
                    </p>
                  </div>
                  <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
                    {fmtCompact(p.amount)} · {PROPOSAL_FREQUENCY_LABELS[p.frequency]} · desde {p.startYearMonth}
                  </p>
                  {p.description && (
                    <p className="text-[11px] mt-1 line-clamp-2" style={{ color: 'var(--gray-500)' }}>
                      {p.description}
                    </p>
                  )}
                </div>

                <div className="flex gap-0.5">
                  <button
                    onClick={() => setFormOpen({ mode: 'edit', proposal: p })}
                    className="p-1.5 rounded hover:bg-[var(--gray-100)] text-[var(--gray-400)] hover:text-[var(--gray-700)]"
                    aria-label="Editar"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`¿Eliminar "${p.name}"?`)) onDelete(p.id);
                    }}
                    className="p-1.5 rounded hover:bg-[var(--danger)]/10 text-[var(--gray-400)] hover:text-[var(--danger)]"
                    aria-label="Eliminar"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {formOpen && (
        <ProposalForm
          initial={formOpen.mode === 'edit' ? formOpen.proposal : undefined}
          onCancel={() => setFormOpen(null)}
          onSave={(p) => {
            if (formOpen.mode === 'edit') onUpdate(p);
            else onAdd(p);
            setFormOpen(null);
          }}
        />
      )}
    </>
  );
};

export default ProposalManager;
