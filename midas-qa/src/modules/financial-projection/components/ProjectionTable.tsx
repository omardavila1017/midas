import { Eye } from 'lucide-react';
import { fmtCurrency } from '../../../formatters';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import { ConfidenceBadge, StatusBadge } from '../../shared-finance/components/FinanceBadges';
import SelectPicker from '../../../components/ui/SelectPicker';
import type { FinancialMovement } from '../../shared-finance/types';

export interface ProjectionTableFilters {
  search: string;
  type: 'ALL' | FinancialMovement['type'];
  category: 'ALL' | FinancialMovement['category'];
  status: 'ALL' | FinancialMovement['status'];
  confidence: 'ALL' | FinancialMovement['confidenceBand'];
}

const TYPE_OPTIONS: Array<{ value: ProjectionTableFilters['type']; label: string }> = [
  { value: 'ALL', label: 'Todos los tipos' },
  { value: 'INFLOW', label: 'Ingresos' },
  { value: 'OUTFLOW', label: 'Egresos' },
];

const CONFIDENCE_OPTIONS: Array<{ value: ProjectionTableFilters['confidence']; label: string }> = [
  { value: 'ALL', label: 'Toda la confianza' },
  { value: 'CONFIRMED', label: 'Confirmado' },
  { value: 'HIGH', label: 'Alta' },
  { value: 'MEDIUM', label: 'Media' },
  { value: 'LOW', label: 'Baja' },
  { value: 'EXPLORATORY', label: 'Exploratorio' },
];

/**
 * Tabla de movimientos proyectados. Antes tenía 13 columnas (fecha, tipo,
 * categoría, contraparte, concepto, monto base, monto proyectado, monto
 * ajustado, diferencia, estado, confianza, fuente, acciones) a 12px —
 * inadmisible en pantallas estándar.
 *
 * Ahora se queda en 7 columnas esenciales (fecha · tipo · contraparte ·
 * concepto · monto · estado/confianza · acciones). El detalle queda en el
 * drilldown.
 *
 * El botón "Ajustar" se eliminó de aquí: editar movimientos pertenece a
 * Planeación Financiera. Proyección es vista de solo lectura.
 */
export function ProjectionTable({
  movements,
  filters,
  onFiltersChange,
  onSelectMovement,
}: {
  movements: FinancialMovement[];
  filters: ProjectionTableFilters;
  onFiltersChange: (filters: ProjectionTableFilters) => void;
  /**
   * Callback para abrir el detalle del movimiento. Se incluye `anchor`
   * (DOMRect del botón clickeado) para que el popover aparezca pegado a
   * la fila del usuario, no centrado en pantalla.
   */
  onSelectMovement: (movement: FinancialMovement, anchor: DOMRect) => void;
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
    <section className="rounded-[var(--radius)] border border-[var(--gray-200)] bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--gray-200)] px-4 py-3">
        <div>
          <h2 className="text-[15px] font-bold tracking-tight text-[var(--gray-950)]">
            Movimientos proyectados
          </h2>
          <p className="mt-1 text-[12px] text-[var(--gray-500)]">
            Vista de solo lectura. Para editar, abre Planeación Financiera y crea un ajuste de escenario.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label
              htmlFor="projection-search"
              className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]"
            >
              Buscar
            </label>
            <input
              id="projection-search"
              value={filters.search}
              onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
              placeholder="Contraparte o concepto"
              className="h-10 w-[240px] rounded-[var(--radius)] border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
            />
          </div>
          <div className="w-[180px]">
            <SelectPicker
              label="Tipo"
              value={filters.type}
              onChange={(value) => onFiltersChange({ ...filters, type: value })}
              options={TYPE_OPTIONS}
            />
          </div>
          <div className="w-[200px]">
            <SelectPicker
              label="Confianza"
              value={filters.confidence}
              onChange={(value) => onFiltersChange({ ...filters, confidence: value })}
              options={CONFIDENCE_OPTIONS}
            />
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[960px] text-[13px]">
          <thead className="bg-[var(--gray-50)] text-left text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
            <tr>
              <th className="px-4 py-2.5">Fecha</th>
              <th className="px-4 py-2.5">Tipo</th>
              <th className="px-4 py-2.5">Contraparte</th>
              <th className="px-4 py-2.5">Concepto</th>
              <th className="px-4 py-2.5 text-right">Monto</th>
              <th className="px-4 py-2.5">Estado · Confianza</th>
              <th className="px-4 py-2.5 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-[12px] text-[var(--gray-400)]">
                  No hay movimientos para los filtros aplicados.
                </td>
              </tr>
            )}
            {filtered.map((movement) => {
              const effective = effectiveAmount(movement);
              return (
                <tr
                  key={movement.id}
                  className="border-t border-[var(--gray-200)] align-top hover:bg-[var(--gray-50)]"
                >
                  <td className="px-4 py-3 tabular-nums text-[var(--gray-700)]">
                    {effectiveMovementDate(movement)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="inline-flex h-6 items-center rounded-full px-2 text-[11px] font-medium"
                      style={{
                        background: movement.type === 'INFLOW' ? 'var(--success-muted)' : 'var(--danger-muted)',
                        color: movement.type === 'INFLOW' ? 'var(--success)' : 'var(--danger)',
                      }}
                    >
                      {movement.type === 'INFLOW' ? 'Ingreso' : 'Egreso'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-[220px] truncate font-medium text-[var(--gray-950)]">
                      {movement.counterpartyName ?? '—'}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">
                      {counterpartyTypeLabel(movement.counterpartyType)}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="max-w-[300px] truncate text-[var(--gray-700)]">{movement.concept}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">
                      {movement.ruleApplied ?? movement.category}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium text-[var(--gray-950)]">
                    {fmtCurrency(effective)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={movement.status} />
                      <ConfidenceBadge band={movement.confidenceBand} score={movement.confidenceScore} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      <button
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          onSelectMovement(movement, rect);
                        }}
                        className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white px-2.5 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
                      >
                        <Eye className="h-3.5 w-3.5" strokeWidth={1.5} />
                        Ver detalle
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

function counterpartyTypeLabel(type?: string): string {
  if (!type) return 'Sin contraparte';
  switch (type) {
    case 'CUSTOMER': return 'Cliente';
    case 'SUPPLIER': return 'Proveedor';
    case 'EMPLOYEE': return 'Nómina';
    case 'TAX_AUTHORITY': return 'Autoridad fiscal';
    case 'BANK': return 'Banco';
    case 'INTERNAL': return 'Interno';
    default: return type;
  }
}
