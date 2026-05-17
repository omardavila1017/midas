import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

interface UseKeyboardShortcutsOptions {
  onTabSwitch?: (tabNumber: number) => void;
  onExport?: () => void;
  onNew?: () => void;
  onSearch?: () => void;
}

const SHORTCUTS = [
  { keys: 'Cmd+K', description: 'Buscar / Command Palette' },
  { keys: '1-9', description: 'Cambiar sub-tab dentro de la sección activa' },
  { keys: '?', description: 'Atajos de teclado' },
  { keys: 'E', description: 'Exportar CSV' },
  { keys: 'N', description: 'Nuevo (cliente, proveedor, propuesta)' },
  { keys: 'Esc', description: 'Cerrar panel / modal' },
  { keys: '/', description: 'Buscar en la tabla' },
] as const;

/**
 * KeyboardShortcutsModal
 * Renders a controlled modal displaying keyboard shortcuts in a clean grid
 */
export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({
  open,
  onClose,
}) => {
  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-[300]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <dialog
        open={open}
        className="fixed inset-0 z-[400] flex items-center justify-center"
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            onClose();
          }
        }}
      >
        <div
          className="bg-white rounded-[var(--radius-md)] shadow-lg w-full max-w-md max-h-[80vh] overflow-y-auto animate-scale-in"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
            <h2 className="text-lg font-bold text-gray-950">Atajos de teclado</h2>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 rounded-md transition-colors touch-target-44 flex items-center justify-center"
              aria-label="Cerrar"
            >
              <X size={20} className="text-gray-500" />
            </button>
          </div>

          {/* Content */}
          <div className="p-6">
            <div className="grid grid-cols-2 gap-4">
              {SHORTCUTS.map((shortcut) => (
                <div
                  key={shortcut.keys}
                  className="space-y-1"
                >
                  <kbd className="block px-2 py-1 bg-gray-100 border border-gray-300 rounded text-xs font-mono font-medium text-gray-950 text-center">
                    {shortcut.keys}
                  </kbd>
                  <p className="text-xs text-gray-700 text-center leading-tight">
                    {shortcut.description}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Footer tip */}
          <div className="bg-gray-50 border-t border-gray-200 px-6 py-3">
            <p className="text-xs text-gray-500 text-center">
              Presiona <kbd className="inline-block px-1.5 py-0.5 bg-gray-200 rounded text-xs font-mono font-medium">?</kbd> para volver a abrir
            </p>
          </div>
        </div>
      </dialog>
    </>
  );
};

/**
 * useKeyboardShortcuts
 * Hook that registers global keyboard listeners for all shortcuts
 * Accepts callbacks for actions that require parent coordination
 */
export const useKeyboardShortcuts = (
  options: UseKeyboardShortcutsOptions = {}
): {
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
} => {
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  // Stable ref for callbacks. Previously the handler was rebuilt every render
  // because `options` is a fresh object literal at the call site, which
  // caused the global keydown listener to be removed+readded each render.
  // Under heavy compute (Proyección Financiera) digit keypresses were
  // dropped between unmount and remount. Ref keeps the listener stable and
  // always reads the latest callbacks.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const isEditableTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      const role = el.getAttribute('role');
      if (role === 'textbox' || role === 'combobox' || role === 'searchbox') return true;
      return false;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      const opts = optionsRef.current;
      const editable = isEditableTarget(event.target) || isEditableTarget(document.activeElement);

      if (event.key === 'Escape') {
        setShortcutsOpen(false);
        return;
      }

      if (editable) return;

      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        return;
      }

      if (event.key >= '1' && event.key <= '9' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const tabNumber = parseInt(event.key, 10);
        event.preventDefault();
        opts.onTabSwitch?.(tabNumber);
        return;
      }

      if (event.shiftKey && event.key === '?') {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      if (event.key === 'e' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        opts.onExport?.();
        return;
      }

      if (event.key === 'n' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        opts.onNew?.();
        return;
      }

      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault();
        opts.onSearch?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return { shortcutsOpen, setShortcutsOpen };
};
