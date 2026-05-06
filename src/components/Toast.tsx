import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Info,
  X,
} from 'lucide-react';

/* ─────────────────────────────────────────────────
   Types
   ───────────────────────────────────────────────── */

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface ToastOptions {
  undo?: () => void;
  duration?: number;
}

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  options?: ToastOptions;
  createdAt: number;
}

interface ToastContextType {
  success: (message: string, options?: ToastOptions) => void;
  error: (message: string, options?: ToastOptions) => void;
  warning: (message: string, options?: ToastOptions) => void;
  info: (message: string, options?: ToastOptions) => void;
}

/* ─────────────────────────────────────────────────
   Context
   ───────────────────────────────────────────────── */

const ToastContext = createContext<ToastContextType | undefined>(undefined);

/* ─────────────────────────────────────────────────
   Provider Component
   ───────────────────────────────────────────────── */

interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback(
    (type: ToastType, message: string, options?: ToastOptions) => {
      const id = crypto.randomUUID();
      const duration = options?.duration ?? 4000;

      setToasts(prev => {
        const updated = [...prev, { id, type, message, options, createdAt: Date.now() }];
        // Keep only the last 5 toasts
        if (updated.length > 5) {
          return updated.slice(-5);
        }
        return updated;
      });

      // Dismiss after duration
      const timer = setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);

      return () => clearTimeout(timer);
    },
    [],
  );

  const success = useCallback(
    (message: string, options?: ToastOptions) => addToast('success', message, options),
    [addToast],
  );
  const error = useCallback(
    (message: string, options?: ToastOptions) => addToast('error', message, options),
    [addToast],
  );
  const warning = useCallback(
    (message: string, options?: ToastOptions) => addToast('warning', message, options),
    [addToast],
  );
  const info = useCallback(
    (message: string, options?: ToastOptions) => addToast('info', message, options),
    [addToast],
  );

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const handleUndo = useCallback((toast: Toast) => {
    if (toast.options?.undo) {
      toast.options.undo();
    }
    removeToast(toast.id);
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ success, error, warning, info }}>
      {children}
      <ToastContainer toasts={toasts} onRemove={removeToast} onUndo={handleUndo} />
    </ToastContext.Provider>
  );
}

/* ─────────────────────────────────────────────────
   Toast Container (bottom-right, stacked)
   ───────────────────────────────────────────────── */

interface ToastContainerProps {
  toasts: Toast[];
  onRemove: (id: string) => void;
  onUndo: (toast: Toast) => void;
}

function ToastContainer({ toasts, onRemove, onUndo }: ToastContainerProps) {
  return (
    <div
      className="fixed bottom-0 right-0 pointer-events-none"
      style={{
        zIndex: 500,
        padding: 'var(--page-gutter)',
      }}
    >
      <div className="flex flex-col gap-3">
        {toasts.map((toast, idx) => (
          <ToastItem
            key={toast.id}
            toast={toast}
            onRemove={onRemove}
            onUndo={onUndo}
            isLast={idx === toasts.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────
   Individual Toast Item
   ───────────────────────────────────────────────── */

interface ToastItemProps {
  toast: Toast;
  onRemove: (id: string) => void;
  onUndo: (toast: Toast) => void;
  isLast: boolean;
}

function ToastItem({ toast, onRemove, onUndo, isLast }: ToastItemProps) {
  const getToastStyles = (type: ToastType) => {
    switch (type) {
      case 'success':
        return {
          accentColor: 'var(--success)',
          bgColor: 'var(--success-muted)',
          textColor: 'var(--gray-950)',
          icon: CheckCircle2,
        };
      case 'error':
        return {
          accentColor: 'var(--danger)',
          bgColor: 'var(--danger-muted)',
          textColor: 'var(--gray-950)',
          icon: AlertCircle,
        };
      case 'warning':
        return {
          accentColor: 'var(--warning)',
          bgColor: 'var(--warning-muted)',
          textColor: 'var(--gray-950)',
          icon: AlertTriangle,
        };
      case 'info':
        return {
          accentColor: 'var(--info)',
          bgColor: 'var(--info-muted)',
          textColor: 'var(--gray-950)',
          icon: Info,
        };
    }
  };

  const styles = getToastStyles(toast.type);
  const IconComponent = styles.icon;

  return (
    <div
      className="pointer-events-auto animate-slide-up"
      style={{
        opacity: isLast ? 1 : 0.95,
      }}
    >
      <div
        className="flex gap-3 rounded-[var(--radius-md)] p-4 border border-[var(--gray-200)]/40"
        style={{
          backgroundColor: styles.bgColor,
          boxShadow: 'var(--shadow-md)',
          animation: 'slideUp 0.3s var(--spring) both',
        }}
      >
        {/* Left accent bar */}
        <div
          className="w-1 rounded-full"
          style={{
            backgroundColor: styles.accentColor,
            flexShrink: 0,
          }}
        />

        {/* Icon and content */}
        <div className="flex gap-3 flex-1 min-w-0">
          <IconComponent
            className="w-5 h-5 flex-shrink-0 mt-0.5"
            style={{
              color: styles.accentColor,
            }}
          />

          <div className="flex-1 min-w-0">
            <p
              className="text-[13px] font-medium leading-snug break-words"
              style={{
                color: styles.textColor,
              }}
            >
              {toast.message}
            </p>

            {/* Undo link */}
            {toast.options?.undo && (
              <button
                onClick={() => onUndo(toast)}
                className="text-[12px] font-medium mt-1.5 transition-opacity hover:opacity-70 active:opacity-50"
                style={{
                  color: styles.accentColor,
                }}
              >
                Deshacer
              </button>
            )}
          </div>
        </div>

        {/* Close button */}
        <button
          onClick={() => onRemove(toast.id)}
          className="flex-shrink-0 text-[var(--gray-400)] hover:text-[var(--gray-500)] transition-colors"
          aria-label="Cerrar notificación"
        >
          <X className="w-4 h-4 mt-0.5" />
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────
   Hook
   ───────────────────────────────────────────────── */

export function useToast(): ToastContextType {
  const context = useContext(ToastContext);
  if (context === undefined) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
