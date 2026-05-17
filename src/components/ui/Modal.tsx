import { ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

/*
 * Senda DS modal primitive.
 *
 * Enforces the a11y contract every modal must satisfy:
 *   - role="dialog" + aria-modal
 *   - aria-labelledby pointing at the title
 *   - focus moves into the dialog on open
 *   - focus returns to the trigger on close
 *   - Tab/Shift+Tab cycle inside the dialog (focus trap)
 *   - ESC closes
 *   - backdrop click closes
 *   - body scroll lock
 *
 * Use everywhere a transient sheet floats over the app. Full-screen
 * pages (ProviderDetailModal, drawers) implement their own shell;
 * they should still call the same focus trap and ARIA pattern.
 */

type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_MAX_WIDTH: Record<ModalSize, string> = {
  sm: '400px',
  md: '560px',
  lg: '720px',
  xl: '960px',
};

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: ModalSize;
  closeOnBackdrop?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: React.RefObject<HTMLElement>;
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  closeOnBackdrop = true,
  children,
  footer,
  initialFocusRef,
}: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const bodyOverflowPrev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    queueMicrotask(() => {
      const target =
        initialFocusRef?.current ??
        dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
        dialogRef.current;
      target?.focus({ preventScroll: true });
    });

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((node) => !node.hasAttribute('inert') && node.offsetParent !== null);
      if (focusables.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = bodyOverflowPrev;
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose, initialFocusRef]);

  if (!open) return null;

  const onBackdrop = () => {
    if (closeOnBackdrop) onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 sm:p-6 animate-fade-in"
      style={{ background: 'var(--modal-overlay)' }}
      onClick={onBackdrop}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-full flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-[var(--surface)] shadow-2xl outline-none animate-card-in"
        style={{ maxWidth: `min(${SIZE_MAX_WIDTH[size]}, calc(100vw - 2rem))` }}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--gray-200)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]"
            >
              {title}
            </h2>
            {description && (
              <p
                id={descriptionId}
                className="mt-1 text-[12px] leading-snug text-[var(--gray-500)]"
              >
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[var(--gray-500)] transition-colors duration-150 hover:bg-[var(--gray-100)] hover:text-[var(--gray-900)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/40"
          >
            <span aria-hidden="true" className="text-[18px] leading-none">×</span>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer && (
          <footer className="border-t border-[var(--gray-200)] bg-[var(--surface-alt)] px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
