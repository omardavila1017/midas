import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface CollapsibleSectionProps {
  title: string;
  storageKey?: string;
  defaultOpen?: boolean;
  count?: number | string;
  badge?: ReactNode;
  description?: string;
  actions?: ReactNode;
  /**
   * When true, children stay mounted across collapse cycles (kept hidden via
   * `display:none`). Avoids re-running the expensive subtree mount when the
   * user just toggles a section back open. Default: true — silky toggles.
   */
  keepMounted?: boolean;
  /**
   * When true, the subtree is *not* rendered until the section is opened for
   * the first time. Combines well with `keepMounted` so default-closed
   * heavy sections (suppliers, taxes, alerts) never cost first paint.
   * Default: false.
   */
  lazy?: boolean;
  children: ReactNode;
}

/**
 * Light-weight collapsible section. Two performance levers:
 *   - `lazy`: skip mounting until first open (saves first-paint work).
 *   - `keepMounted`: hide instead of unmounting so collapse/expand is free
 *     and downstream component state survives toggles.
 *
 * Both default toward "do less work" — closed sections don't render until
 * needed, and open sections don't re-mount when toggled.
 */
function CollapsibleSectionImpl({
  title,
  storageKey,
  defaultOpen = true,
  count,
  badge,
  description,
  actions,
  keepMounted = true,
  lazy = false,
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

  // Once the section has been opened we remember it so `lazy` only blocks
  // the first paint — subsequent toggles never tear children down.
  const hasOpenedRef = useRef(open);
  if (open) hasOpenedRef.current = true;

  useEffect(() => {
    if (!storageKey) return;
    try {
      sessionStorage.setItem(storageKey, String(open));
    } catch {
      /* sessionStorage may be disabled */
    }
  }, [open, storageKey]);

  const shouldRenderChildren = lazy ? hasOpenedRef.current : true;

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
            ? <ChevronDown className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={1.5} />
            : <ChevronRight className="h-4 w-4 text-[var(--gray-500)]" strokeWidth={1.5} />}
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-semibold tracking-tight text-[var(--gray-950)]">{title}</h2>
              {count !== undefined && (
                <span className="rounded bg-[var(--gray-100)] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--gray-600)]">
                  {count}
                </span>
              )}
              {badge}
            </div>
            {description && (
              <p className="mt-0.5 text-[11.5px] text-[var(--gray-400)]">{description}</p>
            )}
          </div>
        </button>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {shouldRenderChildren && (
        keepMounted
          ? <div hidden={!open}>{children}</div>
          : (open ? <div>{children}</div> : null)
      )}
    </section>
  );
}

export const CollapsibleSection = memo(CollapsibleSectionImpl);
