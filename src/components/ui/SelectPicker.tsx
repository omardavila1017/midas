import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  icon?: React.ReactNode;
}

interface Props<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  label?: string;
  placeholder?: string;
  leftIcon?: React.ReactNode;
}

function SelectPicker<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = 'Selecciona',
  leftIcon,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const current = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className="relative">
      {label && (
        <label className="block text-[11px] font-medium uppercase tracking-wider text-[var(--gray-400)] mb-1.5">
          {label}
        </label>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full h-10 pl-3 pr-3 rounded-xl border border-[var(--gray-200)] bg-white text-[13px] text-left flex items-center justify-between gap-2 transition-all hover:border-[var(--gray-300)] hover:shadow-sm active:scale-[0.99]"
        style={{ color: current ? 'var(--gray-950)' : 'var(--gray-400)' }}
      >
        <span className="flex items-center gap-2 min-w-0">
          {leftIcon && <span className="flex-shrink-0" style={{ color: 'var(--gray-400)' }}>{leftIcon}</span>}
          <span className="truncate">{current ? current.label : placeholder}</span>
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
          className="absolute left-0 right-0 mt-2 z-50 rounded-2xl border border-[var(--gray-200)] bg-white overflow-hidden origin-top"
          style={{
            animation: 'scaleIn 0.18s var(--spring) both',
            boxShadow: '0 20px 40px -12px rgba(15,23,42,0.18), 0 4px 8px -4px rgba(15,23,42,0.08)',
          }}
        >
          <ul className="py-1.5 max-h-64 overflow-y-auto">
            {options.map((opt) => {
              const isSelected = opt.value === value;
              return (
                <li key={opt.value}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors"
                    style={{ background: isSelected ? 'var(--gray-50)' : 'transparent' }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.background = 'var(--gray-50)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    {opt.icon && (
                      <span className="flex-shrink-0 text-[var(--gray-400)]">{opt.icon}</span>
                    )}
                    <span className="flex-1 min-w-0">
                      <span
                        className="block text-[13px] font-medium truncate"
                        style={{ color: 'var(--gray-950)' }}
                      >
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="block text-[11px] truncate" style={{ color: 'var(--gray-400)' }}>
                          {opt.description}
                        </span>
                      )}
                    </span>
                    {isSelected && (
                      <Check className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--primary)' }} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

export default SelectPicker;
