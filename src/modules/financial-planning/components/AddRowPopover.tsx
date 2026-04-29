import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import type {
  FinancialMovementCategory,
  FinancialMovementType,
} from '../../shared-finance/types';
import { CATEGORY_LABELS } from '../services/planningRowTaxonomy';

const INFLOW_CATEGORIES: FinancialMovementCategory[] = ['AR_COLLECTION', 'TRANSFER', 'MANUAL'];
const OUTFLOW_CATEGORIES: FinancialMovementCategory[] = [
  'AP_PAYMENT',
  'PAYROLL',
  'TAX',
  'DEBT',
  'CAPEX',
  'OPEX',
  'TRANSFER',
  'MANUAL',
];

export interface AddRowPopoverProps {
  type: FinancialMovementType;
  onClose: () => void;
  onCreate: (input: { type: FinancialMovementType; label: string; category: FinancialMovementCategory }) => void;
}

export function AddRowPopover(props: AddRowPopoverProps) {
  const { type, onClose, onCreate } = props;
  const [label, setLabel] = useState('');
  const [category, setCategory] = useState<FinancialMovementCategory>(type === 'INFLOW' ? 'MANUAL' : 'MANUAL');
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) onClose();
    };
    const escapeHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', handler);
    window.addEventListener('keydown', escapeHandler);
    return () => {
      window.removeEventListener('mousedown', handler);
      window.removeEventListener('keydown', escapeHandler);
    };
  }, [onClose]);

  const submit = () => {
    const trimmed = label.trim();
    if (!trimmed) {
      setError('El nombre es obligatorio.');
      return;
    }
    onCreate({ type, label: trimmed, category });
  };

  const categories = type === 'INFLOW' ? INFLOW_CATEGORIES : OUTFLOW_CATEGORIES;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
      role="dialog"
      aria-label="Crear fila personalizada"
    >
      <div
        ref={containerRef}
        className="w-[400px] rounded-2xl border border-[var(--gray-200)] bg-white p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-[14px] font-semibold text-[var(--gray-950)]">
              Nueva fila en {type === 'INFLOW' ? 'Ingresos' : 'Egresos'}
            </h3>
            <p className="mt-0.5 text-[11px] text-[var(--gray-500)]">
              Crea un concepto para esta propuesta. Aparecerá como fila editable.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--gray-400)] hover:bg-[var(--gray-50)] hover:text-[var(--gray-700)]"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>

        <label className="block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
            Nombre
          </span>
          <input
            ref={inputRef}
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
            placeholder="Nombre del concepto"
            className="h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
          />
        </label>

        <label className="mt-3 block">
          <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
            Categoría
          </span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as FinancialMovementCategory)}
            className="h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
          >
            {categories.map((value) => (
              <option key={value} value={value}>
                {CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p className="mt-2 text-[11px] font-medium text-[var(--danger)]">{error}</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 items-center rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={submit}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--primary)] px-3 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)]"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            Crear fila
          </button>
        </div>
      </div>
    </div>
  );
}
