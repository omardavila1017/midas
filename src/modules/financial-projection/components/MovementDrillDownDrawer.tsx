import { useEffect, useMemo, useRef } from 'react';
import { X } from 'lucide-react';
import { fmtCurrency, fmtPctInt } from '../../../formatters';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import { ConfidenceBadge, StatusBadge } from '../../shared-finance/components/FinanceBadges';
import type { FinancialMovement } from '../../shared-finance/types';

const POPOVER_WIDTH = 460;
const POPOVER_MARGIN = 8;
const POPOVER_EST_HEIGHT = 540;

/**
 * Detalle del movimiento como popover anclado al row clickeado. La
 * posición se calcula síncronamente para que el popover aparezca de
 * inmediato (antes había una ventana donde la pos se calculaba en
 * useLayoutEffect y el popover quedaba a (0, 0) sin ser visible).
 */
export function MovementDrillDownDrawer({
  movement,
  anchor,
  onClose,
}: {
  movement: FinancialMovement | null;
  anchor: DOMRect | null;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);

  // Cierre con Escape.
  useEffect(() => {
    if (!movement) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [movement, onClose]);

  // Cierre con click afuera, ignorando el click que abrió el popover.
  useEffect(() => {
    if (!movement) return;
    let mounted = false;
    const t = setTimeout(() => { mounted = true; }, 0);
    const onMouse = (event: MouseEvent) => {
      if (!mounted) return;
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', onMouse);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onMouse);
    };
  }, [movement, onClose]);

  const pos = useMemo(() => {
    if (!anchor) return null;
    return computePosition(anchor);
  }, [anchor]);

  if (!movement || !anchor || !pos) return null;

  const rows: [string, string][] = [
    ['Fuente', `${movement.sourceSystem}${movement.sourceObjectId ? ` · ${movement.sourceObjectId}` : ''}`],
    ['Fecha emisión', movement.issueDate ?? '—'],
    ['Fecha vencimiento', movement.dueDate ?? '—'],
    ['Fecha proyectada', movement.projectedDate],
    ['Fecha ajustada', movement.adjustedDate ?? '—'],
    ['Fecha efectiva', effectiveMovementDate(movement)],
    ['Monto base (catálogo)', fmtCurrency(movement.baseAmount)],
    ['Monto proyectado', fmtCurrency(movement.projectedAmount)],
    ['Monto efectivo', fmtCurrency(effectiveAmount(movement))],
    ['Regla aplicada', movement.ruleApplied ?? '—'],
    ['Método', movement.forecastMethod],
    ['Bloqueo', humanLockState(movement.lockState)],
  ];

  return (
    <div
      ref={popoverRef}
      className="fixed z-[80] rounded-2xl border border-[var(--gray-200)] bg-white shadow-xl"
      style={{
        top: pos.top,
        left: pos.left,
        width: POPOVER_WIDTH,
        maxHeight: 'calc(100vh - 32px)',
        overflowY: 'auto',
      }}
      role="dialog"
      aria-label={`Detalle de ${movement.concept}`}
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[var(--gray-200)] bg-white px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
            Detalle del movimiento
          </div>
          <h2 className="mt-1 truncate text-[15px] font-semibold text-[var(--gray-950)]">
            {movement.concept}
          </h2>
          <p className="mt-0.5 text-[11px] text-[var(--gray-500)]">
            {movement.counterpartyName ?? 'Sin contraparte'} · {movement.category}
          </p>
        </div>
        <button
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--gray-200)] bg-white text-[var(--gray-500)] hover:bg-[var(--gray-50)]"
          aria-label="Cerrar detalle"
        >
          <X className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>

      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-[var(--gray-200)] bg-[var(--gray-50)] p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-[var(--gray-400)]">Estado</div>
            <div className="mt-1.5"><StatusBadge status={movement.status} /></div>
          </div>
          <div className="rounded-lg border border-[var(--gray-200)] bg-[var(--gray-50)] p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-[var(--gray-400)]">Confianza</div>
            <div className="mt-1.5">
              <ConfidenceBadge band={movement.confidenceBand} score={movement.confidenceScore} />
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-[var(--gray-200)]">
          <div className="border-b border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
            Trazabilidad
          </div>
          <div className="divide-y divide-[var(--gray-100)]">
            {rows.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[140px_1fr] gap-3 px-3 py-2 text-[11px]">
                <div className="text-[var(--gray-400)]">{label}</div>
                <div className="min-w-0 break-words font-medium tabular-nums text-[var(--gray-950)]">
                  {value}
                </div>
              </div>
            ))}
          </div>
        </div>

        {movement.category === 'AR_COLLECTION' && (
          <DetailBlock
            title="Cobranza / factura"
            items={[
              ['Cliente', movement.counterpartyName ?? '—'],
              ['Confianza', `${fmtPctInt(movement.confidenceScore)}`],
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
            ]}
          />
        )}
        {movement.category === 'TAX' && (
          <DetailBlock
            title="Impuesto"
            items={[
              ['Tipo', movement.concept],
              ['Riesgo', movement.lockState === 'LOCKED' ? 'Legal / crítico' : 'Validar fiscal'],
            ]}
          />
        )}

        {movement.comments && movement.comments.length > 0 && (
          <div className="rounded-lg border border-[var(--gray-200)] p-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
              Comentarios
            </div>
            <div className="mt-1.5 space-y-1.5">
              {movement.comments.map((comment, index) => (
                <p key={`${comment}-${index}`} className="text-[11px] text-[var(--gray-600)]">
                  {comment}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function computePosition(anchor: DOMRect): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.right - POPOVER_WIDTH;
  if (left < POPOVER_MARGIN) left = POPOVER_MARGIN;
  if (left + POPOVER_WIDTH + POPOVER_MARGIN > vw) left = vw - POPOVER_WIDTH - POPOVER_MARGIN;

  let top = anchor.bottom + POPOVER_MARGIN;
  if (top + POPOVER_EST_HEIGHT + POPOVER_MARGIN > vh) {
    const above = anchor.top - POPOVER_EST_HEIGHT - POPOVER_MARGIN;
    top = above >= POPOVER_MARGIN ? above : Math.max(POPOVER_MARGIN, vh - POPOVER_EST_HEIGHT - POPOVER_MARGIN);
  }
  return { top, left };
}

function DetailBlock({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div className="rounded-lg border border-[var(--gray-200)] p-3">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">{title}</div>
      <div className="mt-2 grid gap-1.5">
        {items.map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-3 text-[11px]">
            <span className="text-[var(--gray-400)]">{label}</span>
            <span className="max-w-[280px] text-right font-medium text-[var(--gray-950)]">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function humanLockState(state: string): string {
  switch (state) {
    case 'UNLOCKED': return 'Sin restricción';
    case 'RESTRICTED': return 'Restringido';
    case 'LOCKED': return 'Bloqueado';
    default: return state;
  }
}
