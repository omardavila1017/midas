import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { fmtCurrency } from '../../../formatters';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialAdjustment, FinancialMovement, FinancialScenario } from '../../shared-finance/types';
import { adjustmentRequiresApproval } from '../../shared-finance/permissions/guards';
import { createFinancialAdjustment } from '../services/financialPlanningService';

const POPOVER_WIDTH = 460;
const POPOVER_MARGIN = 8;
// Altura estimada conservadora; el popover tiene scroll interno si crece
// más, pero ya está en el ballpark de un viewport regular.
const POPOVER_EST_HEIGHT = 540;

/**
 * Editor de ajustes anclado al row clickeado. La posición se calcula de
 * forma síncrona en el render — antes la usábamos en useLayoutEffect y
 * había una ventana donde el popover quedaba a (0, 0) y "no aparecía".
 */
export function AdjustmentEditorPopover({
  movement,
  anchor,
  scenarios,
  defaultScenarioId,
  onClose,
  onSave,
}: {
  movement: FinancialMovement | null;
  anchor: DOMRect | null;
  scenarios: FinancialScenario[];
  defaultScenarioId?: string;
  onClose: () => void;
  onSave: (adjustment: FinancialAdjustment) => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [scenarioId, setScenarioId] = useState(defaultScenarioId ?? 'approved');
  const [type, setType] = useState<FinancialAdjustment['type']>('DATE_SHIFT');
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');
  const [deltaDays, setDeltaDays] = useState('15');
  const [percentage, setPercentage] = useState('-10');
  const [splitCount, setSplitCount] = useState('4');
  const [reasonCode, setReasonCode] = useState<FinancialAdjustment['reasonCode']>('LIQUIDITY');
  const [justification, setJustification] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Inicializa los campos cuando cambia el movement.
  useEffect(() => {
    if (!movement) return;
    setScenarioId(defaultScenarioId ?? scenarios.find((s) => !s.isBase)?.id ?? 'liquidity');
    setDate(effectiveMovementDate(movement));
    setAmount(String(effectiveAmount(movement)));
    setJustification('');
    setError(null);
  }, [defaultScenarioId, movement, scenarios]);

  // Cierre con Escape.
  useEffect(() => {
    if (!movement) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [movement, onClose]);

  // Cierre con click afuera, pero NO cerrar si el click ocurrió antes
  // de que el popover se montara (el click que lo abrió).
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

  // Posición síncrona — sin useLayoutEffect, sin estado intermedio.
  // Cuando no hay anchor (entrada vía Cmd+K / botón global) se renderiza
  // como modal centrado en el viewport.
  const pos = useMemo(() => {
    if (!anchor) {
      return {
        top: Math.max(POPOVER_MARGIN, (window.innerHeight - POPOVER_EST_HEIGHT) / 2),
        left: Math.max(POPOVER_MARGIN, (window.innerWidth - POPOVER_WIDTH) / 2),
      };
    }
    return computePosition(anchor);
  }, [anchor]);

  const draftAdjustment = useMemo(() => {
    if (!movement) return null;
    try {
      return buildAdjustment('DRAFT');
    } catch {
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movement, scenarioId, type, date, amount, deltaDays, percentage, splitCount, reasonCode, justification]);

  if (!movement || !pos) return null;
  const currentMovement = movement;

  const handleSave = (status: FinancialAdjustment['status']) => {
    try {
      const adjustment = buildAdjustment(status);
      onSave(adjustment);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear el ajuste.');
    }
  };

  const warning = movement.category === 'TAX'
    ? 'Este ajuste afecta impuestos. Requiere validación fiscal.'
    : movement.category === 'PAYROLL'
      ? 'Este ajuste afecta nómina. Trátalo como pago crítico.'
      : movement.lockState === 'LOCKED'
        ? 'Este movimiento está bloqueado y requiere aprobación.'
        : null;

  return (
    <div
      ref={popoverRef}
      className="fixed z-[80] rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white shadow-xl"
      style={{
        top: pos.top,
        left: pos.left,
        width: POPOVER_WIDTH,
        maxHeight: 'calc(100vh - 32px)',
        overflowY: 'auto',
      }}
      role="dialog"
      aria-label={`Editar ajuste para ${movement.concept}`}
    >
      <div className="flex items-start justify-between gap-3 border-b border-[var(--gray-200)] px-4 py-3 sticky top-0 bg-white">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
            Editor de ajuste
          </div>
          <h2 className="mt-1 truncate text-[15px] font-bold text-[var(--gray-950)]">{movement.concept}</h2>
          <p className="mt-0.5 text-[11px] text-[var(--gray-500)]">
            Base {fmtCurrency(movement.baseAmount)} · {effectiveMovementDate(movement)}
          </p>
        </div>
        <button
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white text-[var(--gray-500)] hover:bg-[var(--gray-50)]"
          aria-label="Cerrar editor"
        >
          <X className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-2">
        {warning && (
          <div className="md:col-span-2 rounded-[var(--radius)] border border-[var(--warning)]/25 bg-[var(--warning-muted)] px-3 py-2 text-[11px] text-[var(--gray-700)]">
            <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: 'var(--warning)' }}>
              <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.5} />
              {warning}
            </span>
          </div>
        )}

        <Field label="Escenario">
          <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} className={inputClass}>
            {scenarios.filter((s) => !s.isBase).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Tipo de ajuste">
          <select value={type} onChange={(e) => setType(e.target.value as FinancialAdjustment['type'])} className={inputClass}>
            <option value="DATE_SHIFT">Mover fecha</option>
            <option value="AMOUNT_OVERRIDE">Nuevo monto</option>
            <option value="AMOUNT_DELTA">Delta de monto</option>
            <option value="PERCENTAGE_CHANGE">Cambio porcentual</option>
            <option value="SPLIT_PAYMENT">Dividir pago</option>
            <option value="CANCEL_MOVEMENT">Cancelar movimiento</option>
          </select>
        </Field>

        {type === 'DATE_SHIFT' && (
          <Field label="Nueva fecha">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputClass} />
          </Field>
        )}
        {type === 'AMOUNT_OVERRIDE' && (
          <Field label="Nuevo monto">
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} />
          </Field>
        )}
        {type === 'AMOUNT_DELTA' && (
          <Field label="Delta de monto">
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputClass} />
          </Field>
        )}
        {type === 'PERCENTAGE_CHANGE' && (
          <Field label="% de cambio">
            <input type="number" step="0.1" value={percentage} onChange={(e) => setPercentage(e.target.value)} className={inputClass} />
          </Field>
        )}
        {type === 'DATE_SHIFT' && (
          <Field label="Días de referencia">
            <input type="number" step="1" value={deltaDays} onChange={(e) => setDeltaDays(e.target.value)} className={inputClass} />
          </Field>
        )}
        {type === 'SPLIT_PAYMENT' && (
          <Field label="Número de pagos">
            <input type="number" min="2" step="1" value={splitCount} onChange={(e) => setSplitCount(e.target.value)} className={inputClass} />
          </Field>
        )}

        <Field label="Razón">
          <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value as FinancialAdjustment['reasonCode'])} className={inputClass}>
            <option value="LIQUIDITY">Liquidez</option>
            <option value="NEGOTIATION">Negociación</option>
            <option value="CRISIS">Crisis</option>
            <option value="UPSIDE">Upside</option>
            <option value="FORECAST_CORRECTION">Corrección de forecast</option>
            <option value="MANAGEMENT_DECISION">Decisión directiva</option>
          </select>
        </Field>

        <Field label="Justificación obligatoria" span>
          <textarea
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            rows={3}
            className={`${inputClass} h-auto py-2`}
            placeholder="Por qué cambias la fecha, el monto o la regla."
          />
        </Field>

        <div className="md:col-span-2 rounded-[var(--radius)] border border-[var(--gray-200)] bg-[var(--gray-50)] p-2.5 text-[11px] text-[var(--gray-600)]">
          El ajuste se guarda como diferencia del escenario activo. No modifica JDE ni los movimientos base.
          {draftAdjustment && adjustmentRequiresApproval(draftAdjustment) && (
            <span className="ml-1 font-medium" style={{ color: 'var(--warning)' }}>
              Requiere aprobación por materialidad.
            </span>
          )}
        </div>
        {error && (
          <div className="md:col-span-2 text-[12px] font-medium" style={{ color: 'var(--danger)' }}>{error}</div>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--gray-200)] px-4 py-3 sticky bottom-0 bg-white">
        <button
          onClick={onClose}
          className="h-9 rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
        >
          Cancelar
        </button>
        <button
          onClick={() => handleSave('DRAFT')}
          className="h-9 rounded-[var(--radius-md)] bg-[var(--primary)] px-3 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)]"
        >
          Guardar
        </button>
      </div>
    </div>
  );

  function buildAdjustment(status: FinancialAdjustment['status']): FinancialAdjustment {
    const parsedAmount = Number(amount);
    const parsedDeltaDays = Number(deltaDays);
    const parsedPercentage = Number(percentage) / 100;
    const parsedSplit = Number(splitCount);
    const adjustment = createFinancialAdjustment({
      name: `${typeLabel(type)} · ${currentMovement.concept}`,
      scenarioIds: [scenarioId],
      type,
      targetType: 'MOVEMENT',
      targetExpression: currentMovement.id,
      reasonCode,
      justification,
      adjustedValue: type === 'DATE_SHIFT' ? date : type === 'AMOUNT_OVERRIDE' ? parsedAmount : undefined,
      deltaAmount: type === 'AMOUNT_DELTA' ? parsedAmount : undefined,
      deltaDays: type === 'DATE_SHIFT' ? parsedDeltaDays : undefined,
      percentageChange: type === 'PERCENTAGE_CHANGE' ? parsedPercentage : undefined,
      splitConfig: type === 'SPLIT_PAYMENT' ? { numberOfPayments: Math.max(2, parsedSplit || 2), frequency: 'WEEKLY' } : undefined,
    });
    return { ...adjustment, status };
  }
}

function computePosition(anchor: DOMRect): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.right - POPOVER_WIDTH;
  if (left < POPOVER_MARGIN) left = POPOVER_MARGIN;
  if (left + POPOVER_WIDTH + POPOVER_MARGIN > vw) left = vw - POPOVER_WIDTH - POPOVER_MARGIN;

  // Intentar debajo del anchor
  let top = anchor.bottom + POPOVER_MARGIN;
  if (top + POPOVER_EST_HEIGHT + POPOVER_MARGIN > vh) {
    // Intentar arriba del anchor
    const above = anchor.top - POPOVER_EST_HEIGHT - POPOVER_MARGIN;
    if (above >= POPOVER_MARGIN) {
      top = above;
    } else {
      // No cabe ni arriba ni abajo: centrar respecto al anchor,
      // manteniéndolo dentro del viewport.
      top = Math.max(
        POPOVER_MARGIN,
        Math.min(
          anchor.top + anchor.height / 2 - POPOVER_EST_HEIGHT / 2,
          vh - POPOVER_EST_HEIGHT - POPOVER_MARGIN,
        ),
      );
    }
  }
  return { top, left };
}

const inputClass = 'h-9 w-full rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white px-2.5 text-[12px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]';

function Field({ label, children, span }: { label: string; children: ReactNode; span?: boolean }) {
  return (
    <label className={`block ${span ? 'md:col-span-2' : ''}`}>
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
        {label}
      </span>
      {children}
    </label>
  );
}

function typeLabel(type: FinancialAdjustment['type']): string {
  if (type === 'DATE_SHIFT') return 'Mover fecha';
  if (type === 'AMOUNT_OVERRIDE') return 'Nuevo monto';
  if (type === 'AMOUNT_DELTA') return 'Delta monto';
  if (type === 'PERCENTAGE_CHANGE') return 'Cambio porcentual';
  if (type === 'SPLIT_PAYMENT') return 'Dividir pago';
  if (type === 'CANCEL_MOVEMENT') return 'Cancelar';
  return 'Ajuste';
}
