import { useMemo } from 'react';
import { Clock } from 'lucide-react';
import type { ScenarioChangeLogEntry } from '../../shared-finance/types';

export interface ChangeLogDrawerProps {
  open: boolean;
  scenarioName: string;
  entries: ScenarioChangeLogEntry[];
  onClose: () => void;
}

export function ChangeLogDrawer({ open, scenarioName, entries }: ChangeLogDrawerProps) {
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
      <header className="border-b border-[var(--gray-200)] px-4 py-3">
        <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Cambios</h3>
        <p className="mt-0.5 text-[11px] text-[var(--gray-400)]">{scenarioName}</p>
      </header>

      <div className="flex-1 overflow-auto px-2 py-2" style={{ maxHeight: 480 }}>
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12 text-center text-[12px] text-[var(--gray-400)]">
            <Clock className="mb-2 h-5 w-5" strokeWidth={1.5} />
            Aún no hay cambios en esta propuesta. Edita una celda o agrega una fila para comenzar.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {sorted.map((entry) => (
              <li
                key={entry.id}
                className="rounded-lg border border-transparent px-3 py-2 hover:border-[var(--gray-200)] hover:bg-[var(--gray-50)]/40 transition-colors"
              >
                <p className="text-[12px] leading-snug text-[var(--gray-950)]">{entry.autoDescription}</p>
                {entry.userNote && (
                  <p className="mt-1 text-[11px] italic text-[var(--gray-500)]">“{entry.userNote}”</p>
                )}
                <p className="mt-1 text-[10px] uppercase tracking-wider text-[var(--gray-400)]">
                  {formatRelative(entry.createdAt)}
                </p>
              </li>
            ))}
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
