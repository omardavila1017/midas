import React, { useEffect, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { MONTHS_FULL } from '../../types';

interface Props {
  /** "YYYY-MM-DD" */
  value: string;
  onChange: (date: string) => void;
  label?: string;
  minYear?: number;
  maxYear?: number;
  placeholder?: string;
}

const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

function parseDate(d: string): { y: number; m: number; day: number } {
  const [y, m, day] = d.split('-').map(Number);
  return {
    y: y || new Date().getFullYear(),
    m: m || new Date().getMonth() + 1,
    day: day || 0,
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDateLong(d: string): string {
  const { y, m, day } = parseDate(d);
  if (!y || !m || !day) return '';
  return `${day} ${MONTHS_FULL[m - 1]} ${y}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

/** weekday index Mon=0..Sun=6 for the 1st of (y,m) */
function firstWeekdayMon0(y: number, m: number): number {
  const js = new Date(y, m - 1, 1).getDay(); // Sun=0..Sat=6
  return (js + 6) % 7;
}

const DatePicker: React.FC<Props> = ({
  value,
  onChange,
  label,
  minYear,
  maxYear,
  placeholder = 'Selecciona un día',
}) => {
  const [open, setOpen] = useState(false);
  const initial = parseDate(value);
  const [viewY, setViewY] = useState<number>(initial.y);
  const [viewM, setViewM] = useState<number>(initial.m);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const p = parseDate(value);
    setViewY(p.y);
    setViewM(p.m);
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

  const sel = parseDate(value);
  const total = daysInMonth(viewY, viewM);
  const offset = firstWeekdayMon0(viewY, viewM);

  const prevMonth = () => {
    let y = viewY;
    let m = viewM - 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
    if (minYear && y < minYear) return;
    setViewY(y);
    setViewM(m);
  };

  const nextMonth = () => {
    let y = viewY;
    let m = viewM + 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (maxYear && y > maxYear) return;
    setViewY(y);
    setViewM(m);
  };

  const handlePick = (day: number) => {
    onChange(`${viewY}-${pad(viewM)}-${pad(day)}`);
    setOpen(false);
  };

  const cells: (number | null)[] = [
    ...Array(offset).fill(null),
    ...Array.from({ length: total }, (_, i) => i + 1),
  ];

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
          <span className="truncate capitalize">{value ? formatDateLong(value) : placeholder}</span>
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
            minWidth: 280,
          }}
        >
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-[var(--gray-100)] bg-[var(--gray-50)]">
            <button
              type="button"
              onClick={prevMonth}
              className="h-7 w-7 flex items-center justify-center rounded-[var(--radius-md)] hover:bg-white text-[var(--gray-500)] transition-colors"
              aria-label="Mes anterior"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[13px] font-bold tracking-tight text-[var(--gray-950)] capitalize">
              {MONTHS_FULL[viewM - 1]} {viewY}
            </span>
            <button
              type="button"
              onClick={nextMonth}
              className="h-7 w-7 flex items-center justify-center rounded-[var(--radius-md)] hover:bg-white text-[var(--gray-500)] transition-colors"
              aria-label="Mes siguiente"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 px-2.5 pt-2.5">
            {WEEKDAYS.map((w, i) => (
              <div
                key={i}
                className="h-6 flex items-center justify-center text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--gray-400)]"
              >
                {w}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1 p-2.5">
            {cells.map((day, idx) => {
              if (day === null) return <div key={idx} className="h-8" />;
              const isSelected = viewY === sel.y && viewM === sel.m && day === sel.day;
              return (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handlePick(day)}
                  className="h-8 rounded-[var(--radius-md)] text-[12px] font-medium tabular-nums transition-colors"
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
                  {day}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between px-3 py-2 border-t border-[var(--gray-100)]">
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                onChange(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
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

export default DatePicker;
