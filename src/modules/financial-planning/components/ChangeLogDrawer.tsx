import { useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Copy,
  Eraser,
  GitMerge,
  History,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Type,
} from 'lucide-react';
import type { ScenarioChangeKind, ScenarioChangeLogEntry } from '../../shared-finance/types';

export interface ChangeLogDrawerProps {
  open: boolean;
  scenarioName: string;
  /** Aprobado vs propuesta: ajusta el copy del estado vacío. Default DRAFT. */
  scenarioKind?: 'APPROVED' | 'DRAFT';
  entries: ScenarioChangeLogEntry[];
  onClose: () => void;
}

// Visual por tipo de cambio: icono + acento. Decorativo — el orden y el
// contenido del historial no cambian.
const KIND_VISUALS: Record<ScenarioChangeKind, { Icon: LucideIcon; color: string; bg: string }> = {
  ADD_ROW: { Icon: Plus, color: 'var(--success)', bg: 'var(--success-muted)' },
  REMOVE_ROW: { Icon: Trash2, color: 'var(--danger)', bg: 'var(--danger-muted)' },
  RENAME_ROW: { Icon: Type, color: 'var(--gray-500)', bg: 'var(--gray-100)' },
  EDIT_CELL: { Icon: Pencil, color: 'var(--primary)', bg: 'var(--primary-muted)' },
  CLEAR_CELL: { Icon: Eraser, color: 'var(--warning)', bg: 'var(--warning-muted)' },
  CREATE_DRAFT: { Icon: Sparkles, color: 'var(--primary)', bg: 'var(--primary-muted)' },
  DUPLICATE_DRAFT: { Icon: Copy, color: 'var(--gray-500)', bg: 'var(--gray-100)' },
  MERGE_TO_APPROVED: { Icon: GitMerge, color: 'var(--success)', bg: 'var(--success-muted)' },
};

const FALLBACK_VISUAL = { Icon: Pencil, color: 'var(--gray-500)', bg: 'var(--gray-100)' };

export function ChangeLogDrawer({ open, scenarioName, scenarioKind = 'DRAFT', entries }: ChangeLogDrawerProps) {
  const sorted = useMemo(
    () => [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [entries],
  );

  if (!open) return null;

  return (
    <aside
      className="flex flex-col rounded-2xl border border-[var(--gray-200)] bg-white"
      style={{ width: 320 }}
      aria-label="Historial de cambios de la propuesta"
    >
      <header className="flex items-center justify-between gap-3 border-b border-[var(--gray-200)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
            style={{ background: 'var(--primary-muted)', color: 'var(--primary)' }}
          >
            <History className="h-3.5 w-3.5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h3 className="text-[13px] font-semibold leading-tight text-[var(--gray-950)]">Cambios</h3>
            <p className="truncate text-[11px] text-[var(--gray-400)]">{scenarioName}</p>
          </div>
        </div>
        {sorted.length > 0 && (
          <span className="shrink-0 rounded-full bg-[var(--gray-100)] px-2 py-0.5 text-[10px] font-bold tabular-nums text-[var(--gray-600)]">
            {sorted.length}
          </span>
        )}
      </header>

      <div className="flex-1 overflow-auto px-2 py-2" style={{ maxHeight: 480 }}>
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
            <span
              className="mb-3 flex h-10 w-10 items-center justify-center rounded-full"
              style={{ background: 'var(--gray-100)', color: 'var(--gray-400)' }}
            >
              <History className="h-5 w-5" strokeWidth={1.5} />
            </span>
            <p className="text-[12px] font-medium text-[var(--gray-600)]">
              {scenarioKind === 'APPROVED' ? 'Sin cambios aplicados' : 'Aún no hay cambios'}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--gray-400)]">
              {scenarioKind === 'APPROVED'
                ? 'Los cambios que apliques desde una propuesta al Aprobado aparecerán aquí.'
                : 'Edita una celda o agrega una fila en esta propuesta para comenzar.'}
            </p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {sorted.map((entry) => {
              const visual = KIND_VISUALS[entry.kind] ?? FALLBACK_VISUAL;
              return (
                <li
                  key={entry.id}
                  className="flex gap-2.5 rounded-lg border border-transparent px-2.5 py-2 hover:border-[var(--gray-200)] hover:bg-[var(--gray-50)]/40 transition-colors"
                >
                  <span
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                    style={{ background: visual.bg, color: visual.color }}
                  >
                    <visual.Icon className="h-3 w-3" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] leading-snug text-[var(--gray-950)]">{entry.autoDescription}</p>
                    {entry.userNote && (
                      <p className="mt-1 rounded-md bg-[var(--gray-50)] px-2 py-1 text-[11px] italic leading-snug text-[var(--gray-500)]">
                        “{entry.userNote}”
                      </p>
                    )}
                    <p className="mt-1 text-[10px] uppercase tracking-wider text-[var(--gray-400)]">
                      {formatRelative(entry.createdAt)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

function formatRelative(iso: string): string {
  const created = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = Math.max(0, now - created);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'hace segundos';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `hace ${days} d`;
  return iso.slice(0, 10);
}
