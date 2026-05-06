import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Search, X } from 'lucide-react';
import { fmtCurrency } from '../../../formatters';
import { effectiveAmount, effectiveMovementDate } from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialMovement } from '../../shared-finance/types';

interface Props {
  movements: FinancialMovement[];
  asOfDate: string;
  onPick: (movement: FinancialMovement) => void;
  onClose: () => void;
}

const HORIZON_DAYS = 90;
const MAX_RESULTS = 50;

export function MovementPickerModal({ movements, asOfDate, onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const candidates = useMemo(() => {
    const startMs = new Date(asOfDate).getTime();
    const endMs = startMs + HORIZON_DAYS * 24 * 60 * 60 * 1000;
    const q = query.trim().toLowerCase();
    return movements
      .filter((m) => {
        const dateMs = new Date(effectiveMovementDate(m)).getTime();
        if (Number.isNaN(dateMs)) return false;
        if (dateMs < startMs || dateMs > endMs) return false;
        if (!q) return true;
        const hay = `${m.concept} ${m.counterpartyName ?? ''}`.toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => effectiveMovementDate(a).localeCompare(effectiveMovementDate(b)))
      .slice(0, MAX_RESULTS);
  }, [movements, query, asOfDate]);

  return (
    <div
      role="dialog"
      aria-label="Selecciona movimiento para crear propuesta"
      className="fixed inset-0 z-[75] flex items-center justify-center bg-black/30 backdrop-blur-sm p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[560px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-[var(--surface)] shadow-2xl animate-card-in"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--gray-100)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-500)]">
              Crear propuesta
            </div>
            <h2 className="mt-0.5 text-[14px] font-bold leading-tight text-[var(--gray-950)]">
              Selecciona un movimiento
            </h2>
            <p className="mt-1 text-[11px] leading-snug text-[var(--gray-500)]">
              Próximos {HORIZON_DAYS} días · busca por concepto o contraparte
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[var(--gray-400)] transition-colors duration-150 hover:bg-[var(--gray-50)] hover:text-[var(--gray-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/30"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </header>

        <div className="border-b border-[var(--gray-100)] px-4 py-3">
          <div className="flex items-center gap-2 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-3 transition-colors duration-150 focus-within:border-[var(--primary)]/40 focus-within:ring-2 focus-within:ring-[var(--primary)]/15">
            <Search className="h-4 w-4 text-[var(--gray-400)]" strokeWidth={1.5} aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar concepto o contraparte…"
              className="h-10 flex-1 bg-transparent text-[13px] text-[var(--gray-950)] outline-none placeholder:text-[var(--gray-400)]"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Limpiar búsqueda"
                className="rounded-[var(--radius-sm)] px-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)] transition-colors duration-150 hover:text-[var(--gray-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/30"
              >
                Limpiar
              </button>
            )}
          </div>
        </div>

        <ul className="max-h-[420px] divide-y divide-[var(--gray-100)] overflow-y-auto" role="list">
          {candidates.length === 0 ? (
            <li className="px-4 py-8 text-center text-[12px] text-[var(--gray-500)]">
              {query ? 'Sin coincidencias para esta búsqueda.' : 'No hay movimientos en los próximos 90 días.'}
            </li>
          ) : (
            candidates.map((movement) => (
              <li key={movement.id}>
                <button
                  type="button"
                  onClick={() => onPick(movement)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-[var(--surface-alt)] focus-visible:outline-none focus-visible:bg-[var(--surface-alt)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--primary)]/30"
                >
                  <span
                    aria-hidden="true"
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
                    style={{
                      background: movement.type === 'INFLOW' ? 'var(--success-muted)' : 'var(--danger-muted)',
                      color: movement.type === 'INFLOW' ? 'var(--success)' : 'var(--danger)',
                    }}
                  >
                    {movement.type === 'INFLOW'
                      ? <ArrowDownLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
                      : <ArrowUpRight className="h-3.5 w-3.5" strokeWidth={1.5} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium leading-tight text-[var(--gray-950)]">{movement.concept}</p>
                    <p className="mt-0.5 truncate text-[11px] text-[var(--gray-500)]">
                      {movement.counterpartyName ?? 'Sin contraparte'} · {formatDateMx(effectiveMovementDate(movement))}
                    </p>
                  </div>
                  <span className="text-[12px] tabular-nums font-bold text-[var(--gray-950)]">
                    {fmtCurrency(effectiveAmount(movement))}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>

        <footer className="border-t border-[var(--gray-100)] bg-[var(--surface-alt)] px-4 py-2 text-[10px] text-[var(--gray-500)]">
          {candidates.length} {candidates.length === 1 ? 'resultado' : 'resultados'}
          {candidates.length === MAX_RESULTS && ' (límite — refina la búsqueda)'}
        </footer>
      </div>
    </div>
  );
}

function formatDateMx(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short', year: '2-digit' }).format(date);
  } catch {
    return iso;
  }
}
