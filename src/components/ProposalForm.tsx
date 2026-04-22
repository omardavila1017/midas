import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Proposal, ProposalKind, ProposalFrequency } from '../types';
import { PROPOSAL_KIND_LABELS, PROPOSAL_FREQUENCY_LABELS } from '../types';

interface Props {
  initial?: Proposal;
  onSave: (proposal: Proposal) => void;
  onCancel: () => void;
}

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function newId(): string {
  return `prop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const ProposalForm: React.FC<Props> = ({ initial, onSave, onCancel }) => {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [kind, setKind] = useState<ProposalKind>(initial?.kind ?? 'expense_saving');
  const [amount, setAmount] = useState<string>(initial ? String(initial.amount) : '');
  const [startYearMonth, setStartYearMonth] = useState(initial?.startYearMonth ?? currentYearMonth());
  const [frequency, setFrequency] = useState<ProposalFrequency>(initial?.frequency ?? 'monthly');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const canSave = name.trim().length > 0 && Number(amount) > 0;

  const handleSave = () => {
    if (!canSave) return;
    const now = new Date().toISOString();
    const proposal: Proposal = {
      id: initial?.id ?? newId(),
      name: name.trim(),
      description: description.trim() || undefined,
      kind,
      amount: Math.abs(Number(amount)),
      startYearMonth,
      frequency,
      enabled: initial?.enabled ?? true,
      createdAt: initial?.createdAt ?? now,
      updatedAt: now,
    };
    onSave(proposal);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'oklch(0% 0 0 / 0.4)' }}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-md mx-4 shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--gray-100)]">
          <h2 className="text-[16px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
            {initial ? 'Editar propuesta' : 'Nueva propuesta'}
          </h2>
          <button
            onClick={onCancel}
            className="p-1.5 rounded-lg hover:bg-[var(--gray-100)] text-[var(--gray-400)]"
            aria-label="Cerrar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Nombre */}
          <div>
            <label className="block text-[12px] font-medium text-[var(--gray-500)] mb-1.5">Nombre</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej: Ahorro en combustible"
              autoFocus
              className="input w-full"
            />
          </div>

          {/* Descripción */}
          <div>
            <label className="block text-[12px] font-medium text-[var(--gray-500)] mb-1.5">Descripción (opcional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Detalles adicionales"
              rows={2}
              className="input w-full resize-none"
            />
          </div>

          {/* Tipo */}
          <div>
            <label className="block text-[12px] font-medium text-[var(--gray-500)] mb-1.5">Tipo</label>
            <div className="grid grid-cols-2 gap-2">
              {(['expense_saving', 'income_increase'] as ProposalKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className="h-10 rounded-xl border text-[13px] font-medium transition"
                  style={{
                    borderColor: kind === k ? 'var(--primary)' : 'var(--gray-200)',
                    background: kind === k ? 'var(--primary-muted)' : 'white',
                    color: kind === k ? 'var(--primary)' : 'var(--gray-700)',
                  }}
                >
                  {PROPOSAL_KIND_LABELS[k]}
                </button>
              ))}
            </div>
          </div>

          {/* Monto */}
          <div>
            <label className="block text-[12px] font-medium text-[var(--gray-500)] mb-1.5">
              Monto por aplicación (MXN)
            </label>
            <input
              type="number"
              min={0}
              step={1000}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="50000"
              className="input w-full"
            />
          </div>

          {/* Inicio + Frecuencia */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[12px] font-medium text-[var(--gray-500)] mb-1.5">Mes de inicio</label>
              <input
                type="month"
                value={startYearMonth}
                onChange={(e) => setStartYearMonth(e.target.value)}
                className="input w-full"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--gray-500)] mb-1.5">Frecuencia</label>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as ProposalFrequency)}
                className="input w-full"
              >
                {(Object.keys(PROPOSAL_FREQUENCY_LABELS) as ProposalFrequency[]).map((f) => (
                  <option key={f} value={f}>
                    {PROPOSAL_FREQUENCY_LABELS[f]}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="flex gap-2 p-4 bg-[var(--gray-50)] border-t border-[var(--gray-100)]">
          <button
            onClick={onCancel}
            className="flex-1 h-10 rounded-xl border border-[var(--gray-200)] text-[13px] text-[var(--gray-500)] hover:bg-white"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="flex-1 h-10 rounded-xl bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {initial ? 'Guardar cambios' : 'Crear propuesta'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProposalForm;
