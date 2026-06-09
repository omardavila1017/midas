import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, GitMerge, X } from 'lucide-react';
import { fmtCompact, fmtCurrency } from '../../../formatters';
import type { FinancialScenario, ScenarioChangeLogEntry } from '../../shared-finance/types';
import type { MergeDiffEntry } from '../services/scenarioMerge';

export interface MergeDialogProps {
  open: boolean;
  draft: FinancialScenario | null;
  approved: FinancialScenario | null;
  diff: MergeDiffEntry[];
  changeLog: ScenarioChangeLogEntry[];
  draftFinalCash: number;
  approvedFinalCash: number;
  draftDeficitDays: number;
  approvedDeficitDays: number;
  onClose: () => void;
  onConfirm: (args: { selectedChanges: MergeDiffEntry[]; archiveDraft: boolean }) => void;
}

export function MergeDialog(props: MergeDialogProps) {
  const {
    open,
    draft,
    approved,
    diff,
    changeLog,
    draftFinalCash,
    approvedFinalCash,
    draftDeficitDays,
    approvedDeficitDays,
    onClose,
    onConfirm,
  } = props;

  const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set());
  const [archiveDraft, setArchiveDraft] = useState(true);

  useEffect(() => {
    setSelectedSet(new Set(diff.filter((entry) => entry.selectedByDefault).map((entry) => keyOf(entry))));
  }, [diff]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, open]);

  const finalCashDelta = draftFinalCash - approvedFinalCash;
  const deficitDelta = draftDeficitDays - approvedDeficitDays;

  const sortedDiff = useMemo(
    () => [...diff].sort((a, b) => {
      if (a.kind !== b.kind) return kindWeight(a.kind) - kindWeight(b.kind);
      const bucketCompare = (a.bucketKey ?? '').localeCompare(b.bucketKey ?? '');
      if (bucketCompare !== 0) return bucketCompare;
      return a.label.localeCompare(b.label, 'es-MX');
    }),
    [diff],
  );

  if (!open || !draft || !approved) return null;

  const toggle = (key: string) => {
    setSelectedSet((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedSet.size === diff.length) setSelectedSet(new Set());
    else setSelectedSet(new Set(diff.map((entry) => keyOf(entry))));
  };

  const selected = diff.filter((entry) => selectedSet.has(keyOf(entry)));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'var(--modal-overlay)' }}
      role="dialog"
      aria-modal="true"
      aria-label="Aplicar propuesta al Aprobado"
    >
      <div className="flex max-h-[88vh] w-[840px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border border-[var(--gray-200)] bg-white shadow-2xl">
        <header className="flex items-start justify-between border-b border-[var(--gray-200)] px-5 py-4">
          <div>
            <div className="flex items-center gap-2">
              <GitMerge className="h-4 w-4 text-[var(--primary)]" strokeWidth={2} />
              <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">
                Aplicar "{draft.name}" al Aprobado
              </h2>
            </div>
            <p className="mt-1 text-[12px] text-[var(--gray-500)]">
              Selecciona qué cambios de la propuesta pasan al plan vivo. Los no seleccionados se quedan solo en la propuesta.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--gray-400)] hover:bg-[var(--gray-50)] hover:text-[var(--gray-700)]"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border-b border-[var(--gray-200)] px-5 py-3">
          <KpiPill label="Cambios a aplicar" value={`${selected.length} / ${diff.length}`} />
          <KpiPill
            label="Δ caja final"
            value={`${finalCashDelta >= 0 ? '+' : ''}${fmtCurrency(finalCashDelta)}`}
            tone={finalCashDelta > 0 ? 'positive' : finalCashDelta < 0 ? 'negative' : 'neutral'}
          />
          <KpiPill
            label="Δ días en déficit"
            value={`${deficitDelta >= 0 ? '+' : ''}${deficitDelta}`}
            tone={deficitDelta < 0 ? 'positive' : deficitDelta > 0 ? 'negative' : 'neutral'}
          />
        </div>

        <div className="grid flex-1 grid-cols-[1fr_280px] overflow-hidden">
          <div className="overflow-auto">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 z-10 bg-[var(--gray-50)] text-left text-[10px] uppercase tracking-wider text-[var(--gray-400)]">
                <tr>
                  <th className="px-4 py-2.5 w-8">
                    <input
                      type="checkbox"
                      checked={diff.length > 0 && selectedSet.size === diff.length}
                      onChange={toggleAll}
                      aria-label="Seleccionar todo"
                    />
                  </th>
                  <th className="px-4 py-2.5">Cambio</th>
                  <th className="px-4 py-2.5">Impacto</th>
                  <th className="px-4 py-2.5 text-right">Aprobado</th>
                  <th className="px-4 py-2.5 text-right">Propuesta</th>
                  <th className="px-4 py-2.5 text-right">Δ</th>
                </tr>
              </thead>
              <tbody>
                {sortedDiff.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-[12px] text-[var(--gray-400)]">
                      No hay cambios pendientes en esta propuesta.
                    </td>
                  </tr>
                ) : (
                  sortedDiff.map((entry) => {
                    const key = keyOf(entry);
                    const checked = selectedSet.has(key);
                    return (
                      <tr key={key} className="border-t border-[var(--gray-100)] hover:bg-[var(--gray-50)]/40">
                        <td className="px-4 py-2.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(key)}
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            {entry.conflict && <AlertTriangle className="h-3 w-3 text-[var(--warning)]" strokeWidth={2} />}
                            <span className="font-medium text-[var(--gray-950)]">{entry.label}</span>
                          </div>
                          <span className="text-[10px] text-[var(--gray-400)]">{kindLabel(entry.kind)}</span>
                        </td>
                        <td className="px-4 py-2.5 text-[var(--gray-700)]">{entry.impactLabel}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-[var(--gray-700)]">
                          {entry.approvedValue == null ? '—' : fmtCompact(entry.approvedValue)}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-medium text-[var(--gray-950)]">
                          {entry.draftValue == null ? '—' : fmtCompact(entry.draftValue)}
                        </td>
                        <td
                          className="px-4 py-2.5 text-right tabular-nums font-semibold"
                          style={{ color: (entry.delta ?? 0) > 0 ? 'var(--success)' : (entry.delta ?? 0) < 0 ? 'var(--danger)' : 'var(--gray-400)' }}
                        >
                          {!entry.delta ? '—' : `${entry.delta > 0 ? '+' : ''}${fmtCompact(entry.delta)}`}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="border-l border-[var(--gray-200)] bg-[var(--gray-50)]/40 overflow-auto p-3">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">
              Bitácora de la propuesta
            </h4>
            <ul className="mt-2 space-y-1.5">
              {changeLog.length === 0 ? (
                <li className="text-[11px] text-[var(--gray-400)]">Sin entradas registradas.</li>
              ) : (
                changeLog.slice(0, 30).map((entry) => (
                  <li key={entry.id} className="text-[11px] leading-snug text-[var(--gray-700)]">
                    • {entry.autoDescription}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>

        <footer className="flex items-center justify-between border-t border-[var(--gray-200)] px-5 py-3">
          <label className="inline-flex items-center gap-2 text-[12px] font-medium text-[var(--gray-700)]">
            <input
              type="checkbox"
              checked={archiveDraft}
              onChange={(event) => setArchiveDraft(event.target.checked)}
            />
            Archivar propuesta al aplicar
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 items-center rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={selected.length === 0}
              onClick={() => onConfirm({ selectedChanges: selected, archiveDraft })}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--primary)] px-3 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <GitMerge className="h-3.5 w-3.5" strokeWidth={2} />
              Aplicar ({selected.length} cambio{selected.length === 1 ? '' : 's'})
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function KpiPill({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'positive' | 'negative';
}) {
  const color = tone === 'positive' ? 'var(--success)' : tone === 'negative' ? 'var(--danger)' : 'var(--gray-950)';
  return (
    <div className="rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--gray-400)]">{label}</div>
      <div className="mt-0.5 text-[14px] font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function keyOf(entry: MergeDiffEntry): string {
  return `${entry.kind}:${entry.id}`;
}

function kindWeight(kind: MergeDiffEntry['kind']): number {
  if (kind === 'CELL_OVERRIDE') return 0;
  if (kind === 'CUSTOM_ROW') return 1;
  if (kind === 'MOVEMENT_ADJUSTMENT') return 2;
  return 3;
}

function kindLabel(kind: MergeDiffEntry['kind']): string {
  if (kind === 'CELL_OVERRIDE') return 'Celda editada';
  if (kind === 'CUSTOM_ROW') return 'Fila nueva';
  if (kind === 'MOVEMENT_ADJUSTMENT') return 'Movimiento ajustado';
  return 'Ingreso/egreso manual';
}
