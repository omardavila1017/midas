import React, { useEffect, useState } from 'react';
import { Check, X, TrendingUp, TrendingDown, Repeat, Trash2, Plus, Minus } from 'lucide-react';
import type { Proposal, ProposalKind, ProposalFrequency } from '../types';
import { PROPOSAL_FREQUENCY_LABELS } from '../types';
import MonthPicker from './ui/MonthPicker';
import SelectPicker, { type SelectOption } from './ui/SelectPicker';

interface Props {
  initial?: Proposal;
  onSave: (proposal: Proposal) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function newId(): string {
  return `prop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Parseo tolerante del campo monto. Soporta separadores de miles mexicanos
 * ("50,000", "50 000"), símbolo de moneda y espacios. Devuelve NaN si el
 * texto no contiene un número válido; 0 o negativos se consideran inválidos
 * río abajo.
 */
export function parseAmount(input: string): number {
  if (typeof input !== 'string') return NaN;
  const cleaned = input.replace(/[\s,$_]/g, '').trim();
  if (!cleaned) return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

const FREQUENCY_OPTIONS: SelectOption<ProposalFrequency>[] = [
  { value: 'one_time', label: PROPOSAL_FREQUENCY_LABELS.one_time, description: 'Aplica solo en el mes de inicio' },
  { value: 'monthly', label: PROPOSAL_FREQUENCY_LABELS.monthly, description: 'Aplica todos los meses' },
  { value: 'quarterly', label: PROPOSAL_FREQUENCY_LABELS.quarterly, description: 'Aplica cada 3 meses' },
  { value: 'semiannual', label: PROPOSAL_FREQUENCY_LABELS.semiannual, description: 'Aplica cada 6 meses' },
];

/**
 * Editor inline de propuestas — no es modal, no usa overlay oscuro.
 * Se renderiza como una card expandible en el flujo normal de la página.
 */
const ProposalEditor: React.FC<Props> = ({ initial, onSave, onCancel, onDelete }) => {
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

  const parsedAmount = parseAmount(amount);
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const nameValid = name.trim().length > 0;
  const canSave = nameValid && amountValid;
  const validationHint = !nameValid
    ? 'Dale un nombre a la propuesta para poder guardarla.'
    : !amountValid
      ? 'Escribe un monto mayor a $0 (acepta "50,000" o "50000").'
      : null;

  const handleSave = () => {
    if (!canSave) return;
    const now = new Date().toISOString();
    const proposal: Proposal = {
      id: initial?.id ?? newId(),
      name: name.trim(),
      description: description.trim() || undefined,
      kind,
      amount: Math.abs(parsedAmount),
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
      className="rounded-2xl border border-[var(--gray-200)] bg-white overflow-hidden"
      style={{ animation: 'scaleIn 0.25s var(--spring) both', boxShadow: '0 4px 16px -4px rgba(15,23,42,0.08)' }}
    >
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--gray-100)]">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--gray-100)' }}>
            {kind === 'income_increase' && <TrendingUp className="w-4 h-4" style={{ color: 'var(--success)' }} />}
            {kind === 'expense_saving' && <TrendingDown className="w-4 h-4" style={{ color: 'var(--primary)' }} />}
            {kind === 'new_expense' && <Plus className="w-4 h-4" style={{ color: 'var(--danger)' }} />}
            {kind === 'revenue_loss' && <Minus className="w-4 h-4" style={{ color: 'var(--warning)' }} />}
          </div>
          <h3 className="text-[14px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
            {initial ? 'Editar propuesta' : 'Nueva propuesta'}
          </h3>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-[var(--gray-100)] text-[var(--gray-400)] transition-colors"
          aria-label="Cerrar editor"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 space-y-4">
        {/* Tipo — pills grandes */}
        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider text-[var(--gray-400)] mb-1.5">
            Tipo de propuesta
          </label>
          <div className="grid grid-cols-2 gap-2">
            <KindPill
              active={kind === 'income_increase'}
              onClick={() => setKind('income_increase')}
              icon={<TrendingUp className="w-4 h-4" />}
              label="Ingreso"
              description="Suma ingresos (nuevo cliente, venta extra)"
              accentColor="var(--success)"
            />
            <KindPill
              active={kind === 'expense_saving'}
              onClick={() => setKind('expense_saving')}
              icon={<TrendingDown className="w-4 h-4" />}
              label="Ahorro"
              description="Reduce egresos"
              accentColor="#2563eb"
            />
            <KindPill
              active={kind === 'new_expense'}
              onClick={() => setKind('new_expense')}
              icon={<Plus className="w-4 h-4" />}
              label="Nuevo egreso / Deuda"
              description="Suma egresos (pago de deuda, nómina, renta)"
              accentColor="var(--danger)"
            />
            <KindPill
              active={kind === 'revenue_loss'}
              onClick={() => setKind('revenue_loss')}
              icon={<Minus className="w-4 h-4" />}
              label="Pérdida de ingresos"
              description="Resta ingresos (baja de cliente)"
              accentColor="var(--warning)"
            />
          </div>
        </div>

        {/* Nombre */}
        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider text-[var(--gray-400)] mb-1.5">
            Nombre
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              kind === 'income_increase' ? 'Ej: Nuevo cliente retail'
              : kind === 'expense_saving' ? 'Ej: Ahorro en combustible'
              : kind === 'new_expense' ? 'Ej: Pago de deuda banco X'
              : 'Ej: Salida cliente Y'
            }
            autoFocus
            className="w-full h-10 px-3 rounded-xl border border-[var(--gray-200)] bg-white text-[13px] transition-colors hover:border-[var(--gray-300)] focus:outline-none focus:border-[var(--primary)]"
            style={{ color: 'var(--gray-950)' }}
          />
        </div>

        {/* Monto */}
        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider text-[var(--gray-400)] mb-1.5">
            Monto por aplicación
          </label>
          <div className="relative">
            <span
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[13px] font-medium pointer-events-none"
              style={{ color: 'var(--gray-400)' }}
            >
              $
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="50,000"
              aria-invalid={amount.length > 0 && !amountValid}
              className="w-full h-10 pl-7 pr-14 rounded-xl border bg-white text-[13px] tabular-nums transition-colors focus:outline-none"
              style={{
                color: 'var(--gray-950)',
                borderColor: amount.length > 0 && !amountValid ? 'var(--danger)' : 'var(--gray-200)',
              }}
            />
            <span
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-medium pointer-events-none"
              style={{ color: 'var(--gray-400)' }}
            >
              MXN
            </span>
          </div>
        </div>

        {/* Inicio + Frecuencia */}
        <div className="grid grid-cols-2 gap-3">
          <MonthPicker
            label="Mes de inicio"
            value={startYearMonth}
            onChange={setStartYearMonth}
            minYear={2020}
            maxYear={new Date().getFullYear() + 5}
          />
          <SelectPicker<ProposalFrequency>
            label="Frecuencia"
            value={frequency}
            options={FREQUENCY_OPTIONS}
            onChange={setFrequency}
            leftIcon={<Repeat className="w-3.5 h-3.5" />}
          />
        </div>

        {/* Descripción */}
        <div>
          <label className="block text-[11px] font-medium uppercase tracking-wider text-[var(--gray-400)] mb-1.5">
            Descripción <span className="text-[var(--gray-400)] normal-case font-normal tracking-normal">(opcional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Contexto o supuestos detrás de esta propuesta"
            rows={2}
            className="w-full px-3 py-2 rounded-xl border border-[var(--gray-200)] bg-white text-[13px] resize-none transition-colors hover:border-[var(--gray-300)] focus:outline-none focus:border-[var(--primary)]"
            style={{ color: 'var(--gray-950)' }}
          />
        </div>
      </div>

      <div className="flex items-center gap-2 px-5 py-3.5 border-t border-[var(--gray-100)] bg-[var(--gray-50)]">
        {validationHint && (
          <span
            className="text-[11px] truncate"
            style={{ color: 'var(--gray-500)' }}
            role="status"
            aria-live="polite"
          >
            {validationHint}
          </span>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={() => {
              if (confirm('¿Eliminar esta propuesta?')) onDelete();
            }}
            className="h-9 px-3 rounded-lg text-[12px] font-medium text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors flex items-center gap-1.5"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Eliminar
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 px-4 rounded-lg text-[12px] font-medium text-[var(--gray-500)] hover:bg-white hover:text-[var(--gray-950)] transition-colors border border-transparent hover:border-[var(--gray-200)]"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="h-9 px-4 rounded-lg bg-[var(--primary)] text-white text-[12px] font-medium hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
          >
            <Check className="w-3.5 h-3.5" />
            {initial ? 'Guardar cambios' : 'Crear propuesta'}
          </button>
        </div>
      </div>
    </div>
  );
};

const KindPill: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  description: string;
  accentColor: string;
}> = ({ active, onClick, icon, label, description, accentColor }) => (
  <button
    type="button"
    onClick={onClick}
    className="relative rounded-xl border p-3 text-left transition-colors"
    style={{
      borderColor: active ? accentColor : 'var(--gray-200)',
      background: active ? `${accentColor}0F` : 'white',
      boxShadow: active ? `0 0 0 3px ${accentColor}22` : 'none',
    }}
  >
    <div className="flex items-center gap-2 mb-0.5">
      <span style={{ color: active ? accentColor : 'var(--gray-400)' }}>{icon}</span>
      <span
        className="text-[13px] font-semibold"
        style={{ color: active ? accentColor : 'var(--gray-700)' }}
      >
        {label}
      </span>
    </div>
    <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
      {description}
    </p>
  </button>
);

export default ProposalEditor;
