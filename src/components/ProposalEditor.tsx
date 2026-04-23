import React, { useEffect, useState } from 'react';
import { Check, X, TrendingUp, TrendingDown, Repeat, Trash2, Plus, Minus, ChevronDown } from 'lucide-react';
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
  { value: 'one_time', label: PROPOSAL_FREQUENCY_LABELS.one_time },
  { value: 'monthly', label: PROPOSAL_FREQUENCY_LABELS.monthly },
  { value: 'quarterly', label: PROPOSAL_FREQUENCY_LABELS.quarterly },
  { value: 'semiannual', label: PROPOSAL_FREQUENCY_LABELS.semiannual },
];

const KIND_OPTIONS: { value: ProposalKind; label: string; icon: React.ReactNode; color: string }[] = [
  { value: 'income_increase', label: 'Ingreso', icon: <TrendingUp className="w-3.5 h-3.5" />, color: 'var(--success)' },
  { value: 'expense_saving', label: 'Ahorro', icon: <TrendingDown className="w-3.5 h-3.5" />, color: '#2563eb' },
  { value: 'new_expense', label: 'Nuevo egreso', icon: <Plus className="w-3.5 h-3.5" />, color: 'var(--danger)' },
  { value: 'revenue_loss', label: 'Pérdida', icon: <Minus className="w-3.5 h-3.5" />, color: 'var(--warning)' },
];

const ProposalEditor: React.FC<Props> = ({ initial, onSave, onCancel, onDelete }) => {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [showDescription, setShowDescription] = useState(Boolean(initial?.description));
  const [kind, setKind] = useState<ProposalKind>(initial?.kind ?? 'expense_saving');
  const [amount, setAmount] = useState<string>(initial ? String(initial.amount) : '');
  const [startYearMonth, setStartYearMonth] = useState(initial?.startYearMonth ?? currentYearMonth());
  const [endYearMonth, setEndYearMonth] = useState<string | undefined>(initial?.endYearMonth);
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
  const endValid = !endYearMonth || endYearMonth >= startYearMonth;
  const canSave = nameValid && amountValid && endValid;
  const validationHint = !nameValid
    ? 'Dale un nombre a la propuesta.'
    : !amountValid
      ? 'Monto inválido.'
      : !endValid
        ? 'La fecha fin debe ser igual o posterior al inicio.'
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
      endYearMonth: endYearMonth || undefined,
      frequency,
      enabled: initial?.enabled ?? true,
      createdAt: initial?.createdAt ?? now,
      updatedAt: now,
    };
    onSave(proposal);
  };

  const activeKind = KIND_OPTIONS.find((k) => k.value === kind)!;

  return (
    <div
      className="rounded-xl border border-[var(--gray-200)] bg-white"
      style={{ animation: 'scaleIn 0.2s var(--spring) both', boxShadow: '0 4px 16px -4px rgba(15,23,42,0.08)' }}
    >
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--gray-100)] rounded-t-xl">
        <h3 className="text-[13px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
          {initial ? 'Editar propuesta' : 'Nueva propuesta'}
        </h3>
        <button
          type="button"
          onClick={onCancel}
          className="h-6 w-6 flex items-center justify-center rounded-lg hover:bg-[var(--gray-100)] text-[var(--gray-400)] transition-colors"
          aria-label="Cerrar editor"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-4 space-y-3">
        {/* Tipo — pills compactas en una fila */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {KIND_OPTIONS.map((opt) => {
            const active = opt.value === kind;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setKind(opt.value)}
                className="h-8 px-2.5 rounded-lg border text-[12px] font-medium flex items-center gap-1.5 transition-colors"
                style={{
                  borderColor: active ? opt.color : 'var(--gray-200)',
                  background: active ? `${opt.color}0F` : 'white',
                  color: active ? opt.color : 'var(--gray-500)',
                }}
              >
                {opt.icon}
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Nombre + Monto */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_200px] gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`Nombre · ej. ${
              kind === 'income_increase' ? 'Nuevo cliente retail'
              : kind === 'expense_saving' ? 'Ahorro combustible'
              : kind === 'new_expense' ? 'Pago deuda banco X'
              : 'Salida cliente Y'
            }`}
            autoFocus
            className="h-10 px-3 rounded-xl border border-[var(--gray-200)] bg-white text-[13px] transition-colors hover:border-[var(--gray-300)] focus:outline-none focus:border-[var(--primary)]"
            style={{ color: 'var(--gray-950)' }}
          />
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
              className="w-full h-10 pl-7 pr-12 rounded-xl border bg-white text-[13px] tabular-nums transition-colors focus:outline-none"
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

        {/* Frecuencia + Desde + Hasta */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <SelectPicker<ProposalFrequency>
            value={frequency}
            options={FREQUENCY_OPTIONS}
            onChange={setFrequency}
            leftIcon={<Repeat className="w-3.5 h-3.5" />}
          />
          <MonthPicker
            value={startYearMonth}
            onChange={setStartYearMonth}
            minYear={2020}
            maxYear={new Date().getFullYear() + 5}
            placeholder="Desde"
          />
          <div className="flex items-center gap-1.5">
            <div className="flex-1">
              <MonthPicker
                value={endYearMonth ?? ''}
                onChange={setEndYearMonth}
                minYear={2020}
                maxYear={new Date().getFullYear() + 5}
                placeholder="Sin fecha fin"
              />
            </div>
            {endYearMonth && (
              <button
                type="button"
                onClick={() => setEndYearMonth(undefined)}
                className="h-10 w-8 flex items-center justify-center rounded-lg text-[var(--gray-400)] hover:bg-[var(--gray-100)] hover:text-[var(--gray-700)] transition-colors flex-shrink-0"
                aria-label="Quitar fecha fin"
                title="Quitar fecha fin"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Descripción colapsable */}
        {!showDescription ? (
          <button
            type="button"
            onClick={() => setShowDescription(true)}
            className="text-[11px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)] flex items-center gap-1 transition-colors"
          >
            <ChevronDown className="w-3 h-3" />
            Añadir descripción
          </button>
        ) : (
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Contexto o supuestos detrás de esta propuesta"
            rows={2}
            autoFocus
            className="w-full px-3 py-2 rounded-xl border border-[var(--gray-200)] bg-white text-[12px] resize-none transition-colors hover:border-[var(--gray-300)] focus:outline-none focus:border-[var(--primary)]"
            style={{ color: 'var(--gray-950)' }}
          />
        )}
      </div>

      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-[var(--gray-100)] bg-[var(--gray-50)] rounded-b-xl">
        {validationHint ? (
          <span
            className="text-[11px] truncate"
            style={{ color: !endValid || (amount.length > 0 && !amountValid) ? 'var(--danger)' : 'var(--gray-500)' }}
            role="status"
            aria-live="polite"
          >
            {validationHint}
          </span>
        ) : (
          <span className="text-[11px] truncate flex items-center gap-1.5" style={{ color: activeKind.color }}>
            {activeKind.icon}
            {activeKind.label}
          </span>
        )}
        {onDelete && (
          <button
            type="button"
            onClick={() => {
              if (confirm('¿Eliminar esta propuesta?')) onDelete();
            }}
            className="h-8 px-2.5 rounded-lg text-[11px] font-medium text-[var(--danger)] hover:bg-[var(--danger)]/10 transition-colors flex items-center gap-1"
          >
            <Trash2 className="w-3 h-3" />
            Eliminar
          </button>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 rounded-lg text-[11px] font-medium text-[var(--gray-500)] hover:bg-white hover:text-[var(--gray-950)] transition-colors border border-transparent hover:border-[var(--gray-200)]"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="h-8 px-3 rounded-lg bg-[var(--primary)] text-white text-[11px] font-medium hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1"
          >
            <Check className="w-3 h-3" />
            {initial ? 'Guardar' : 'Crear'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProposalEditor;
