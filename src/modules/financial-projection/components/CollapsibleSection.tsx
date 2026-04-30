import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface CollapsibleSectionProps {
  title: string;
  storageKey?: string;
  defaultOpen?: boolean;
  count?: number | string;
  badge?: ReactNode;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function CollapsibleSection({
  title,
  storageKey,
  defaultOpen = true,
  count,
  badge,
  description,
  actions,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState<boolean>(() => {
    if (!storageKey) return defaultOpen;
    try {
      const raw = sessionStorage.getItem(storageKey);
      return raw === null ? defaultOpen : raw === 'true';
    } catch {
      return defaultOpen;
    }
  });

  useEffect(() => {
    if (!storageKey) return;
    try {
      sessionStorage.setItem(storageKey, String(open));
    } catch {
      /* sessionStorage may be disabled */
    }
  }, [open, storageKey]);

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--gray-200)] px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="inline-flex items-center gap-2 text-left"
        >
          {open
            ? <ChevronDown className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={2} />
            : <ChevronRight className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={2} />}
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">{title}</h2>
              {count !== undefined && (
                <span className="rounded bg-[var(--gray-100)] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--gray-600)]">
                  {count}
                </span>
              )}
              {badge}
            </div>
            {description && (
              <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">{description}</p>
            )}
          </div>
        </button>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {open && <div>{children}</div>}
    </section>
  );
}
