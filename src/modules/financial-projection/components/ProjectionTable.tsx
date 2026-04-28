import { Eye, Pencil } from 'lucide-react';
import { fmtCurrency } from '../../../formatters';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import { ConfidenceBadge, StatusBadge } from '../../shared-finance/components/FinanceBadges';
import type { FinancialMovement } from '../../shared-finance/types';

export interface ProjectionTableFilters {
  search: string;
  type: 'ALL' | FinancialMovement['type'];
  category: 'ALL' | FinancialMovement['category'];
  status: 'ALL' | FinancialMovement['status'];
  confidence: 'ALL' | FinancialMovement['confidenceBand'];
}

export function ProjectionTable({
  movements,
  filters,
  onFiltersChange,
  onSelectMovement,
  onAdjustMovement,
}: {
  movements: FinancialMovement[];
  filters: ProjectionTableFilters;
  onFiltersChange: (filters: ProjectionTableFilters) => void;
  onSelectMovement: (movement: FinancialMovement) => void;
  onAdjustMovement: (movement: FinancialMovement) => void;
}) {
  const filtered = movements.filter((movement) => {
    const haystack = `${movement.counterpartyName ?? ''} ${movement.concept} ${movement.category}`.toLowerCase();
    return (
      (!filters.search || haystack.includes(filters.search.toLowerCase()))
      && (filters.type === 'ALL' || movement.type === filters.type)
      && (filters.category === 'ALL' || movement.category === filters.category)
      && (filters.status === 'ALL' || movement.status === filters.status)
      && (filters.confidence === 'ALL' || movement.confidenceBand === filters.confidence)
    );
  });

  return (
    <section className="rounded-xl border border-[var(--border)] bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div>
          <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Tabla de proyección</h2>
          <p className="mt-1 text-[12px] text-[var(--gray-500)]">Fecha y monto base son de sólo lectura; cualquier cambio crea un ajuste.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={filters.search}
            onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
            placeholder="Buscar contraparte o concepto"
            className="h-9 w-[240px] rounded-lg border border-[var(--border)] bg-white px-3 text-[12px] outline-none focus:border-[var(--primary)]"
          />
          <select
            value={filters.type}
            onChange={(event) => onFiltersChange({ ...filters, type: event.target.value as ProjectionTableFilters['type'] })}
            className="h-9 rounded-lg border border-[var(--border)] bg-white px-2 text-[12px] outline-none focus:border-[var(--primary)]"
          >
            <option value="ALL">Tipo</option>
            <option value="INFLOW">Ingreso</option>
            <option value="OUTFLOW">Egreso</option>
          </select>
          <select
            value={filters.confidence}
            onChange={(event) => onFiltersChange({ ...filters, confidence: event.target.value as ProjectionTableFilters['confidence'] })}
            className="h-9 rounded-lg border border-[var(--border)] bg-white px-2 text-[12px] outline-none focus:border-[var(--primary)]"
          >
            <option value="ALL">Confianza</option>
            <option value="CONFIRMED">Confirmado</option>
            <option value="HIGH">Alta</option>
            <option value="MEDIUM">Media</option>
            <option value="LOW">Baja</option>
            <option value="EXPLORATORY">Exploratorio</option>
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1280px] text-[12px]">
          <thead className="bg-[var(--surface-alt)] text-left text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--gray-400)]">
            <tr>
              <th className="px-4 py-2.5">Fecha</th>
              <th className="px-4 py-2.5">Tipo</th>
              <th className="px-4 py-2.5">Categoría</th>
              <th className="px-4 py-2.5">Contraparte</th>
              <th className="px-4 py-2.5">Concepto</th>
              <th className="px-4 py-2.5 text-right">Monto base</th>
              <th className="px-4 py-2.5 text-right">Monto proyectado</th>
              <th className="px-4 py-2.5 text-right">Monto ajustado</th>
              <th className="px-4 py-2.5 text-right">Diferencia</th>
              <th className="px-4 py-2.5">Estado</th>
              <th className="px-4 py-2.5">Confianza</th>
              <th className="px-4 py-2.5">Fuente</th>
              <th className="px-4 py-2.5 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((movement) => {
              const effective = effectiveAmount(movement);
              const diff = effective - movement.baseAmount;
              return (
                <tr key={movement.id} className="border-t border-[var(--border)] align-top hover:bg-[var(--surface-alt)]/60">
                  <td className="px-4 py-3 tabular-nums">{effectiveMovementDate(movement)}</td>
                  <td className="px-4 py-3">{movement.type === 'INFLOW' ? 'Ingreso' : 'Egreso'}</td>
                  <td className="px-4 py-3">{movement.category}</td>
                  <td className="px-4 py-3">
                    <div className="max-w-[220px] truncate font-medium text-[var(--gray-950)]">{movement.counterpartyName ?? '—'}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">{movement.counterpartyType ?? 'Sin contraparte'}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-[260px] truncate text-[var(--gray-700)]">{movement.concept}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">{movement.ruleApplied ?? 'Sin regla'}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtCurrency(movement.baseAmount)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtCurrency(movement.projectedAmount)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{movement.adjustedAmount === undefined ? '—' : fmtCurrency(movement.adjustedAmount)}</td>
                  <td className={`px-4 py-3 text-right font-medium tabular-nums ${diff >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>{fmtCurrency(diff)}</td>
                  <td className="px-4 py-3"><StatusBadge status={movement.status} /></td>
                  <td className="px-4 py-3"><ConfidenceBadge band={movement.confidenceBand} score={movement.confidenceScore} /></td>
                  <td className="px-4 py-3">{movement.sourceSystem}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      <button
                        onClick={() => onSelectMovement(movement)}
                        className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--border)] bg-white px-2 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)]"
                      >
                        <Eye className="h-3.5 w-3.5" strokeWidth={1.5} />
                        Drill down
                      </button>
                      <button
                        onClick={() => onAdjustMovement(movement)}
                        disabled={movement.status === 'REAL' || movement.lockState === 'LOCKED'}
                        className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--border)] bg-white px-2 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                        Ajustar
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
