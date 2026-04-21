import React from 'react';
import { CheckCircle2, Download, X } from 'lucide-react';

/* ─────────────────────────────────────────────────
   Types
   ───────────────────────────────────────────────── */

export interface BatchActionsProps {
  selectedCount: number;
  totalCount: number;
  onConfirmAll: () => void;
  onExport: () => void;
  onClear: () => void;
  visible: boolean;
}

/* ─────────────────────────────────────────────────
   BatchActions Component
   ───────────────────────────────────────────────── */

export default function BatchActions({
  selectedCount,
  totalCount,
  onConfirmAll,
  onExport,
  onClear,
  visible,
}: BatchActionsProps) {
  return (
    <div
      className="fixed bottom-0 left-1/2 z-400 pointer-events-none"
      style={{
        transform: 'translateX(-50%)',
        padding: 'var(--page-gutter)',
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 0.3s var(--ease-smooth)',
      }}
    >
      <div
        className="flex items-center gap-4 px-6 py-4 rounded-2xl backdrop-blur-sm border border-[var(--gray-200)]/40"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.85)',
          boxShadow: 'var(--shadow-lg)',
          animation: visible
            ? 'slideUp 0.4s var(--spring) both'
            : undefined,
        }}
      >
        {/* Selection count */}
        <div
          className="text-sm font-medium tabular-nums whitespace-nowrap"
          style={{
            color: 'var(--gray-950)',
          }}
        >
          <span style={{ color: 'var(--primary)' }}>
            {selectedCount}
          </span>
          {' '}
          seleccionados
          {totalCount > selectedCount && (
            <>
              {' / '}
              <span style={{ color: 'var(--gray-500)' }}>
                {totalCount}
              </span>
            </>
          )}
        </div>

        {/* Divider */}
        <div
          className="h-6 w-px"
          style={{
            backgroundColor: 'var(--gray-200)',
          }}
        />

        {/* Confirm all button */}
        <button
          onClick={onConfirmAll}
          className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all hover:opacity-90 active:scale-95"
          style={{
            backgroundColor: 'var(--success)',
            color: '#ffffff',
            cursor: 'pointer',
          }}
          aria-label="Confirmar todos"
        >
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          Confirmar todos
        </button>

        {/* Export button */}
        <button
          onClick={onExport}
          className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all hover:opacity-90 active:scale-95 border"
          style={{
            backgroundColor: 'var(--surface)',
            color: 'var(--gray-950)',
            borderColor: 'var(--gray-200)',
            cursor: 'pointer',
          }}
          aria-label="Exportar seleccionados"
        >
          <Download className="w-4 h-4 flex-shrink-0" />
          Exportar
        </button>

        {/* Clear button */}
        <button
          onClick={onClear}
          className="flex items-center justify-center w-10 h-10 rounded-lg transition-all hover:opacity-90 active:scale-95"
          style={{
            backgroundColor: 'var(--gray-100)',
            color: 'var(--gray-500)',
            cursor: 'pointer',
          }}
          aria-label="Limpiar selección"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Global slideUp animation - in case not already defined globally */}
      <style>{`
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}
