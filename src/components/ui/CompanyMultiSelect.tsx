import { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronDown } from 'lucide-react';

/**
 * Multi-select de empresas (cia). Patrón de click-outside / Escape espejo de
 * `SelectPicker`, pero con casillas para seleccionar más de una. Muestra el
 * NOMBRE de la empresa (con la cia como subtítulo), no el número crudo. Set
 * vacío en el padre = "Todas las empresas".
 */
export default function CompanyMultiSelect({
  options,
  selected,
  onChange,
  className,
}: {
  options: Array<{ cia: string; nombre: string }>;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const allSelected = selected.size === 0;
  const label = allSelected
    ? 'Todas las empresas'
    : selected.size === 1
      ? options.find((opt) => selected.has(opt.cia))?.nombre ?? '1 empresa'
      : `${selected.size} empresas`;

  const toggle = (cia: string) => {
    const next = new Set(selected);
    if (next.has(cia)) next.delete(cia);
    else next.add(cia);
    onChange(next);
  };

  return (
    <div ref={rootRef} className={`relative${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Filtrar por empresa"
        className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
      >
        <Building2 className="h-3.5 w-3.5 text-[var(--gray-400)]" strokeWidth={1.5} />
        <span className="max-w-[180px] truncate">{label}</span>
        <ChevronDown
          className="h-3.5 w-3.5 text-[var(--gray-400)] transition-transform"
          strokeWidth={1.5}
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute right-0 z-50 mt-2 w-64 rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white"
          style={{ boxShadow: 'var(--shadow-md)' }}
        >
          <button
            type="button"
            onClick={() => onChange(new Set())}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
          >
            <span>Todas las empresas</span>
            {allSelected && <Check className="h-3.5 w-3.5 text-[var(--primary)]" strokeWidth={2.5} />}
          </button>
          <div className="border-t border-[var(--gray-100)]" />
          <ul className="max-h-64 overflow-y-auto py-1">
            {options.map((opt) => {
              const checked = selected.has(opt.cia);
              return (
                <li key={opt.cia}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => toggle(opt.cia)}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--gray-50)]"
                  >
                    <span
                      className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-[4px] border"
                      style={{
                        borderColor: checked ? 'var(--primary)' : 'var(--gray-300)',
                        background: checked ? 'var(--primary)' : 'transparent',
                      }}
                    >
                      {checked && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-[var(--gray-900)]">{opt.nombre}</span>
                      <span className="block text-[10px] text-[var(--gray-400)]">{opt.cia}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!allSelected && (
            <>
              <div className="border-t border-[var(--gray-100)]" />
              <button
                type="button"
                onClick={() => onChange(new Set())}
                className="w-full px-3 py-2 text-left text-[11px] font-medium text-[var(--primary)] hover:bg-[var(--gray-50)]"
              >
                Limpiar selección
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
