import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { KpiRow } from '../types';
import { formatKpiDelta, formatKpiValue } from '../services/kpiFormatting';

interface Props {
  rows: KpiRow[];
  onAddCustom: () => void;
  onEditCustom: (kpiId: string) => void;
  onDeleteCustom: (kpiId: string) => void;
}

export function KpisTable({ rows, onAddCustom, onEditCustom, onDeleteCustom }: Props) {
  return (
    <section
      className="rounded-[var(--radius-lg)] border"
      style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
    >
      <header className="flex items-center justify-between gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--gray-200)' }}>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
            KPIs
          </h2>
          <p className="mt-0.5 text-[12px] leading-snug" style={{ color: 'var(--gray-500)' }}>
            Indicadores autocalculados desde bancos + cobranza + CXP. Agrega tus propios KPIs con un valor manual.
          </p>
        </div>
        <button
          type="button"
          onClick={onAddCustom}
          className="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border px-3 py-1.5 text-[12px] font-medium transition-colors duration-150 hover:bg-[var(--gray-50)]"
          style={{ borderColor: 'var(--gray-300)', color: 'var(--gray-900)' }}
        >
          <Plus className="h-3.5 w-3.5" />
          Agregar KPI custom
        </button>
      </header>

      <div className="overflow-x-auto">
        <table className="min-w-full text-[13px]">
          <thead className="text-[11px] uppercase tracking-[0.06em]" style={{ color: 'var(--gray-500)', background: 'var(--surface-alt)' }}>
            <tr>
              <th className="px-5 py-2.5 text-left font-medium">KPI</th>
              <th className="px-5 py-2.5 text-right font-medium">Valor</th>
              <th className="px-5 py-2.5 text-right font-medium">Δ vs periodo previo</th>
              <th className="px-5 py-2.5 text-left font-medium">Periodo</th>
              <th className="px-5 py-2.5 text-left font-medium">Origen</th>
              <th className="px-5 py-2.5 text-right font-medium">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-8 text-center text-[12px]" style={{ color: 'var(--gray-500)' }}>
                  No hay KPIs disponibles. Agrega un KPI custom para empezar.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={row.key} className="border-t" style={{ borderColor: 'var(--gray-100)' }}>
                <td className="px-5 py-3">
                  <div className="font-medium" style={{ color: 'var(--gray-950)' }}>{row.label}</div>
                  {row.description && (
                    <div className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--gray-500)' }}>
                      {row.description}
                    </div>
                  )}
                </td>
                <td className="px-5 py-3 text-right">
                  <div className="tabular-nums font-medium" style={{ color: 'var(--gray-950)' }}>
                    {formatKpiValue(row.value, row.unit)}
                  </div>
                  {row.value === null && row.emptyReason && (
                    <div className="mt-0.5 text-[10px] leading-tight" style={{ color: 'var(--gray-400)' }}>
                      {row.emptyReason}
                    </div>
                  )}
                </td>
                <td className="px-5 py-3 text-right tabular-nums">
                  {row.deltaPrev === null ? (
                    <span style={{ color: 'var(--gray-400)' }}>-</span>
                  ) : (
                    <span
                      style={{
                        color:
                          row.deltaPrev > 0
                            ? 'var(--success)'
                            : row.deltaPrev < 0
                            ? 'var(--danger)'
                            : 'var(--gray-500)',
                      }}
                    >
                      {formatKpiDelta(row.deltaPrev, row.unit)}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3 text-[12px]" style={{ color: 'var(--gray-600)' }}>{row.periodLabel}</td>
                <td className="px-5 py-3">
                  <span
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                    style={
                      row.source === 'system'
                        ? { background: 'var(--gray-100)', color: 'var(--gray-700)' }
                        : { background: 'var(--accent-blue-muted, var(--gray-100))', color: 'var(--accent-blue, var(--gray-700))' }
                    }
                  >
                    {row.source === 'system' ? 'Sistema' : 'Custom'}
                  </span>
                </td>
                <td className="px-5 py-3 text-right">
                  {row.source === 'custom' && row.custom && (
                    <div className="inline-flex gap-1">
                      <button
                        type="button"
                        onClick={() => onEditCustom(row.custom!.id)}
                        aria-label={`Editar ${row.label}`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] transition-colors duration-150 hover:bg-[var(--gray-100)]"
                        style={{ color: 'var(--gray-600)' }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteCustom(row.custom!.id)}
                        aria-label={`Borrar ${row.label}`}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-md)] transition-colors duration-150 hover:bg-[var(--danger-muted)]"
                        style={{ color: 'var(--danger)' }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
