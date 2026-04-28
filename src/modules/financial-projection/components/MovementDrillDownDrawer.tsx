import { X } from 'lucide-react';
import { fmtCurrency, fmtPctInt } from '../../../formatters';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import { ConfidenceBadge, StatusBadge } from '../../shared-finance/components/FinanceBadges';
import type { FinancialMovement } from '../../shared-finance/types';

export function MovementDrillDownDrawer({
  movement,
  onClose,
}: {
  movement: FinancialMovement | null;
  onClose: () => void;
}) {
  if (!movement) return null;
  const rows = [
    ['ID', movement.id],
    ['Fuente', `${movement.sourceSystem}${movement.sourceObjectId ? ` · ${movement.sourceObjectId}` : ''}`],
    ['Fecha emisión', movement.issueDate ?? '—'],
    ['Fecha vencimiento', movement.dueDate ?? '—'],
    ['Fecha proyectada', movement.projectedDate],
    ['Fecha ajustada', movement.adjustedDate ?? '—'],
    ['Fecha efectiva', effectiveMovementDate(movement)],
    ['Monto base', fmtCurrency(movement.baseAmount)],
    ['Monto proyectado', fmtCurrency(movement.projectedAmount)],
    ['Monto efectivo', fmtCurrency(effectiveAmount(movement))],
    ['Regla aplicada', movement.ruleApplied ?? '—'],
    ['Método', movement.forecastMethod],
    ['Bloqueo', movement.lockState],
  ];

  return (
    <div className="fixed inset-0 z-[80] flex justify-end bg-black/20">
      <aside className="h-full w-full max-w-[520px] overflow-y-auto border-l border-[var(--border)] bg-white shadow-xl">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[var(--border)] bg-white px-5 py-4">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--gray-400)]">Drill down de movimiento</div>
            <h2 className="mt-1 truncate text-[18px] font-semibold text-[var(--gray-950)]">{movement.concept}</h2>
            <p className="mt-1 text-[12px] text-[var(--gray-500)]">{movement.counterpartyName ?? 'Sin contraparte'} · {movement.category}</p>
          </div>
          <button
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-white text-[var(--gray-500)] hover:bg-[var(--surface-alt)]"
            aria-label="Cerrar drill down"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-alt)] p-3">
              <div className="text-[11px] text-[var(--gray-400)]">Estado</div>
              <div className="mt-2"><StatusBadge status={movement.status} /></div>
            </div>
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-alt)] p-3">
              <div className="text-[11px] text-[var(--gray-400)]">Confianza</div>
              <div className="mt-2"><ConfidenceBadge band={movement.confidenceBand} score={movement.confidenceScore} /></div>
            </div>
          </div>
          <div className="rounded-xl border border-[var(--border)]">
            <div className="border-b border-[var(--border)] bg-[var(--surface-alt)] px-3 py-2 text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--gray-400)]">
              Trazabilidad
            </div>
            <div className="divide-y divide-[var(--border)]">
              {rows.map(([label, value]) => (
                <div key={label} className="grid grid-cols-[150px_1fr] gap-3 px-3 py-2.5 text-[12px]">
                  <div className="text-[var(--gray-400)]">{label}</div>
                  <div className="min-w-0 break-words font-medium text-[var(--gray-950)]">{value}</div>
                </div>
              ))}
            </div>
          </div>
          {movement.category === 'AR_COLLECTION' && (
            <DetailBlock
              title="Cobranza / factura proyectada"
              items={[
                ['Cliente', movement.counterpartyName ?? '—'],
                ['Factura', movement.concept],
                ['Historial de pago', `${fmtPctInt(movement.confidenceScore)} de confianza`],
                ['Responsable', 'Cobranza'],
              ]}
            />
          )}
          {movement.category === 'AP_PAYMENT' && (
            <DetailBlock
              title="Proveedor / pago"
              items={[
                ['Proveedor', movement.counterpartyName ?? '—'],
                ['Prioridad', movement.lockState === 'LOCKED' ? 'Crítico' : 'Planificable'],
                ['Flexibilidad', movement.ruleApplied ?? 'Sin clasificación'],
                ['Responsable', 'Tesorería'],
              ]}
            />
          )}
          {movement.category === 'TAX' && (
            <DetailBlock
              title="Impuesto"
              items={[
                ['Tipo', movement.concept],
                ['Riesgo', movement.lockState === 'LOCKED' ? 'Legal / crítico' : 'Requiere validación fiscal'],
                ['Regla', 'No mezclar como proveedor normal'],
                ['Responsable', 'Fiscal / Tesorería'],
              ]}
            />
          )}
          <div className="rounded-xl border border-[var(--border)] p-3">
            <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--gray-400)]">Comentarios</div>
            <div className="mt-2 space-y-2">
              {(movement.comments ?? ['Sin comentarios']).map((comment, index) => (
                <p key={`${comment}-${index}`} className="text-[12px] text-[var(--gray-600)]">{comment}</p>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function DetailBlock({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div className="rounded-xl border border-[var(--border)] p-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--gray-400)]">{title}</div>
      <div className="mt-3 grid gap-2">
        {items.map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-3 text-[12px]">
            <span className="text-[var(--gray-400)]">{label}</span>
            <span className="max-w-[280px] text-right font-medium text-[var(--gray-950)]">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
