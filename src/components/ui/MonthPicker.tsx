import React, { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { MONTHS, MONTHS_FULL } from '../../types';

interface Props {
  /** "YYYY-MM" */
  value: string;
  onChange: (yearMonth: string) => void;
  label?: string;
  minYear?: number;
  maxYear?: number;
  placeholder?: string;
}

function parseYm(ym: string): { y: number; m: number } {
  const [y, m] = ym.split('-').map(Number);
  return { y: y || new Date().getFullYear(), m: m || 1 };
}

function formatYm(ym: string): string {
  const { y, m } = parseYm(ym);
  if (!y || !m) return '';
  return `${MONTHS_FULL[m - 1]} ${y}`;
}

const MonthPicker: React.FC<Props> = ({
  value,
  onChange,
  label,
  minYear,
  maxYear,
  placeholder = 'Selecciona un mes',
}) => {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState<number>(() => parseYm(value).y);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setViewYear(parseYm(value).y);
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const { y: selectedY, m: selectedM } = parseYm(value);
  const canPrev = !minYear || viewYear > minYear;
  const canNext = !maxYear || viewYear < maxYear;

  const handlePick = (m: number) => {
    const ym = `${viewYear}-${String(m).padStart(2, '0')}`;
    onChange(ym);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      {label && (
        <label className="block text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)] mb-1.5">
          {label}
        </label>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full h-10 pl-3 pr-3 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white text-[13px] text-left flex items-center justify-between gap-2 transition-colors hover:border-[var(--gray-300)] hover:shadow-sm"
        style={{ color: value ? 'var(--gray-950)' : 'var(--gray-400)' }}
      >
        <span className="flex items-center gap-2 min-w-0">
          <Calendar className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--gray-400)' }} />
          <span className="truncate capitalize">{value ? formatYm(value) : placeholder}</span>
        </span>
        <span
          className="text-[var(--gray-400)] transition-transform"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)' }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 mt-2 z-50 rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white shadow-xl overflow-hidden origin-top"
          style={{
            animation: 'slideDown var(--motion-state) var(--ease-smooth) both',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {/* Year nav */}
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--gray-100)] bg-[var(--gray-50)]">
            <button
              type="button"
              onClick={() => canPrev && setViewYear((y) => y - 1)}
              disabled={!canPrev}
              className="h-7 w-7 flex items-center justify-center rounded-[var(--radius-md)] hover:bg-white text-[var(--gray-500)] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              aria-label="Año anterior"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[13px] font-bold tracking-tight text-[var(--gray-950)] tabular-nums">
              {viewYear}
            </span>
            <button
              type="button"
              onClick={() => canNext && setViewYear((y) => y + 1)}
              disabled={!canNext}
              className="h-7 w-7 flex items-center justify-center rounded-[var(--radius-md)] hover:bg-white text-[var(--gray-500)] disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              aria-label="Año siguiente"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Month grid */}
          <div className="grid grid-cols-3 gap-1.5 p-2.5">
            {MONTHS.map((name, idx) => {
              const m = idx + 1;
              const isSelected = viewYear === selectedY && m === selectedM;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => handlePick(m)}
                  className="h-9 rounded-[var(--radius-md)] text-[12px] font-medium transition-colors"
                  style={{
                    background: isSelected ? 'var(--gray-950)' : 'transparent',
                    color: isSelected ? 'white' : 'var(--gray-700)',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.background = 'var(--gray-100)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {name}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between px-3 py-2 border-t border-[var(--gray-100)]">
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
                onChange(ym);
                setOpen(false);
              }}
              className="text-[11px] font-medium text-[var(--primary)] hover:underline"
            >
              Hoy
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[11px] text-[var(--gray-400)] hover:text-[var(--gray-700)]"
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default MonthPicker;
