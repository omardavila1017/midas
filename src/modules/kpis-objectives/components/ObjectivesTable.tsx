import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { KpiRow, Objective, ObjectiveEvaluation, ObjectiveStatus } from '../types';
import { objectiveStatusBadge } from '../services/objectiveEvaluator';

interface ObjectiveRow {
  objective: Objective;
  evaluation: ObjectiveEvaluation;
}

interface Props {
  rows: ObjectiveRow[];
  kpiRows: KpiRow[];
  onAdd: () => void;
  onEdit: (objectiveId: string) => void;
  onDelete: (objectiveId: string) => void;
  onChangeManualStatus: (objectiveId: string, status: ObjectiveStatus | null) => void;
}

const STATUS_TONE: Record<'success' | 'danger' | 'warning', { bg: string; fg: string; border: string }> = {
  success: { bg: 'var(--success-muted)', fg: 'var(--success)', border: 'color-mix(in oklch, var(--success) 25%, var(--gray-200))' },
  danger: { bg: 'var(--danger-muted)', fg: 'var(--danger)', border: 'color-mix(in oklch, var(--danger) 25%, var(--gray-200))' },
  warning: { bg: 'var(--warning-muted)', fg: 'var(--warning)', border: 'color-mix(in oklch, var(--warning) 25%, var(--gray-200))' },
};

export function ObjectivesTable({ rows, kpiRows, onAdd, onEdit, onDelete, onChangeManualStatus }: Props) {
  return (
    <section
      className="rounded-[var(--radius-lg)] border"
      style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
    >
      <header className="flex items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--gray-200)' }}>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
            Objetivos
          </h2>
          <p className="mt-0.5 text-[12px] leading-snug" style={{ color: 'var(--gray-500)' }}>
            Define metas y dales seguimiento. El estado se calcula automáticamente cuando es posible.
          </p>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] px-3 py-1.5 text-[12px] font-medium text-white"
          style={{ background: 'var(--accent-blue, var(--gray-900))' }}
        >
          <Plus className="h-3.5 w-3.5" />
          Crear objetivo
        </button>
      </header>

      <div className="overflow-x-auto">
        <table className="min-w-full text-[13px]">
          <thead className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--gray-500)', background: 'var(--surface-alt)' }}>
            <tr>
              <th className="px-5 py-2.5 text-left font-medium">Objetivo</th>
              <th className="px-5 py-2.5 text-left font-medium">Tipo</th>
              <th className="px-5 py-2.5 text-left font-medium">Meta</th>
              <th className="px-5 py-2.5 text-left font-medium">Estado</th>
              <th className="px-5 py-2.5 text-right font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-[12px]" style={{ color: 'var(--gray-500)' }}>
                  Aún no tienes objetivos. Crea el primero para empezar el seguimiento.
                </td>
              </tr>
            )}
            {rows.map(({ objective, evaluation }) => {
              const badge = objectiveStatusBadge(evaluation.status);
              const tone = STATUS_TONE[badge.tone];
              return (
                <tr key={objective.id} className="border-t align-top" style={{ borderColor: 'var(--gray-100)' }}>
                  <td className="px-5 py-3">
                    <div className="font-medium" style={{ color: 'var(--gray-950)' }}>{objective.name}</div>
                    {objective.description && (
                      <div className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--gray-500)' }}>
                        {objective.description}
                      </div>
                    )}
                    {objective.notes && (
                      <div className="mt-1 text-[11px] italic leading-snug" style={{ color: 'var(--gray-500)' }}>
                        {objective.notes}
                      </div>
                    )}
                  </td>
                  <td className="px-5 py-3 text-[12px]" style={{ color: 'var(--gray-700)' }}>
                    {describeKind(objective)}
                  </td>
                  <td className="px-5 py-3 text-[12px]" style={{ color: 'var(--gray-700)' }}>
                    {describeTarget(objective, kpiRows)}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex flex-col gap-1.5">
                      <span
                        className="inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                        style={{ background: tone.bg, color: tone.fg, borderColor: tone.border }}
                      >
                        {badge.label}
                        {evaluation.manualOverride && <span style={{ opacity: 0.7 }}>(manual)</span>}
                      </span>
                      <div className="text-[11px] leading-snug" style={{ color: 'var(--gray-500)' }}>
                        {evaluation.reason}
                      </div>
                      <select
                        value={objective.manualStatus ?? ''}
                        onChange={(e) =>
                          onChangeManualStatus(
                            objective.id,
                            e.target.value === '' ? null : (e.target.value as ObjectiveStatus),
                          )
                        }
                        className="mt-1 w-fit rounded-[var(--radius-md)] border bg-[var(--surface)] px-2 py-1 text-[11px]"
                        style={{ borderColor: 'var(--gray-300)' }}
                        aria-label="Forzar estado"
                      >
                        <option value="">Cálculo automático</option>
                        <option value="MET">Forzar: cumplido</option>
                        <option value="MISSED">Forzar: no cumplido</option>
                        <option value="IN_PROGRESS">Forzar: en progreso</option>
                      </select>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        type="button"
                        onClick={() => onEdit(objective.id)}
                        aria-label={`Editar ${objective.name}`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] transition-colors duration-150 hover:bg-[var(--gray-100)]"
                        style={{ color: 'var(--gray-600)' }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete(objective.id)}
                        aria-label={`Borrar ${objective.name}`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] transition-colors duration-150 hover:bg-[var(--danger-muted)]"
                        style={{ color: 'var(--danger)' }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function describeKind(objective: Objective): string {
  if (objective.kind === 'NUMERIC_MONTHLY') return 'Numérico mensual';
  if (objective.kind === 'KPI_THRESHOLD') return 'Umbral de KPI';
  return 'Hito cualitativo';
}

function describeTarget(objective: Objective, kpiRows: KpiRow[]): string {
  if (objective.kind === 'NUMERIC_MONTHLY') {
    const concept =
      objective.numericConcept === 'INFLOW'
        ? 'Cobranza'
        : objective.numericConcept === 'OUTFLOW'
        ? 'Egresos'
        : 'Saldo de cierre';
    const cmp = objective.comparison === 'GTE' ? '≥' : objective.comparison === 'LTE' ? '≤' : '=';
    const amount =
      typeof objective.targetAmount === 'number'
        ? new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(objective.targetAmount)
        : '—';
    return `${concept} ${cmp} ${amount} en ${objective.targetYearMonth ?? '—'}`;
  }
  if (objective.kind === 'KPI_THRESHOLD') {
    const kpi = kpiRows.find((r) => r.key === objective.linkedKpiKey);
    const cmp = objective.comparison === 'GTE' ? '≥' : objective.comparison === 'LTE' ? '≤' : '=';
    const threshold =
      typeof objective.threshold === 'number' ? new Intl.NumberFormat('es-MX').format(objective.threshold) : '—';
    return `${kpi?.label ?? 'KPI'} ${cmp} ${threshold}`;
  }
  return objective.dueDate ? `Fecha límite ${objective.dueDate}` : 'Sin fecha límite';
}
