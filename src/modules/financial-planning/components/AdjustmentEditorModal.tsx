import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { fmtCurrency } from '../../../formatters';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialAdjustment, FinancialMovement, FinancialScenario } from '../../shared-finance/types';
import { adjustmentRequiresApproval } from '../../shared-finance/permissions/guards';
import { createFinancialAdjustment } from '../services/financialPlanningService';

export function AdjustmentEditorModal({
  movement,
  scenarios,
  defaultScenarioId,
  onClose,
  onSave,
}: {
  movement: FinancialMovement | null;
  scenarios: FinancialScenario[];
  defaultScenarioId?: string;
  onClose: () => void;
  onSave: (adjustment: FinancialAdjustment) => void;
}) {
  const [scenarioId, setScenarioId] = useState(defaultScenarioId ?? 'custom');
  const [type, setType] = useState<FinancialAdjustment['type']>('DATE_SHIFT');
  const [date, setDate] = useState('');
  const [amount, setAmount] = useState('');
  const [deltaDays, setDeltaDays] = useState('15');
  const [percentage, setPercentage] = useState('-10');
  const [splitCount, setSplitCount] = useState('4');
  const [reasonCode, setReasonCode] = useState<FinancialAdjustment['reasonCode']>('LIQUIDITY');
  const [justification, setJustification] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!movement) return;
    setScenarioId(defaultScenarioId ?? scenarios.find((scenario) => !scenario.isBase)?.id ?? 'custom');
    setDate(effectiveMovementDate(movement));
    setAmount(String(effectiveAmount(movement)));
    setJustification('');
    setError(null);
  }, [defaultScenarioId, movement, scenarios]);

  const draftAdjustment = useMemo(() => {
    if (!movement) return null;
    try {
      return buildAdjustment('DRAFT');
    } catch {
      return null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movement, scenarioId, type, date, amount, deltaDays, percentage, splitCount, reasonCode, justification]);

  if (!movement) return null;
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
    ? 'Este ajuste afecta impuestos. Requiere validación fiscal antes de aprobarse.'
    : movement.category === 'PAYROLL'
      ? 'Este ajuste afecta nómina. Trátalo como pago crítico.'
      : movement.lockState === 'LOCKED'
        ? 'Este movimiento está bloqueado y requiere aprobación superior.'
        : null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/25 px-4">
      <div className="w-full max-w-[720px] rounded-xl border border-[var(--border)] bg-white shadow-xl">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--gray-400)]">Editor de ajustes</div>
            <h2 className="mt-1 text-[18px] font-semibold text-[var(--gray-950)]">{movement.concept}</h2>
            <p className="mt-1 text-[12px] text-[var(--gray-500)]">
              Base {fmtCurrency(movement.baseAmount)} · fecha {effectiveMovementDate(movement)}
            </p>
          </div>
          <button onClick={onClose} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--gray-500)] hover:bg-[var(--surface-alt)]" aria-label="Cerrar editor">
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-2">
          {warning && (
            <div className="md:col-span-2 rounded-xl border border-[var(--warning)]/25 bg-[var(--warning-muted)] px-3 py-2 text-[12px] text-[var(--gray-700)]">
              <span className="inline-flex items-center gap-2 font-medium text-[var(--warning)]">
                <AlertTriangle className="h-4 w-4" strokeWidth={1.5} />
                Alerta de riesgo
              </span>
              <span className="ml-2">{warning}</span>
            </div>
          )}

          <Field label="Escenario">
            <select value={scenarioId} onChange={(event) => setScenarioId(event.target.value)} className={inputClass}>
              {scenarios.filter((scenario) => !scenario.isBase).map((scenario) => (
                <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Tipo de ajuste">
            <select value={type} onChange={(event) => setType(event.target.value as FinancialAdjustment['type'])} className={inputClass}>
              <option value="DATE_SHIFT">Mover fecha</option>
              <option value="AMOUNT_OVERRIDE">Nuevo monto</option>
              <option value="AMOUNT_DELTA">Delta de monto</option>
              <option value="PERCENTAGE_CHANGE">Cambio porcentual</option>
              <option value="SPLIT_PAYMENT">Dividir pago</option>
              <option value="CANCEL_MOVEMENT">Cancelar movimiento</option>
            </select>
          </Field>

          {type === 'DATE_SHIFT' && <Field label="Nueva fecha"><input type="date" value={date} onChange={(event) => setDate(event.target.value)} className={inputClass} /></Field>}
          {type === 'AMOUNT_OVERRIDE' && <Field label="Nuevo monto"><input type="number" min="0" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} className={inputClass} /></Field>}
          {type === 'AMOUNT_DELTA' && <Field label="Delta de monto"><input type="number" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} className={inputClass} /></Field>}
          {type === 'PERCENTAGE_CHANGE' && <Field label="% de cambio"><input type="number" step="0.1" value={percentage} onChange={(event) => setPercentage(event.target.value)} className={inputClass} /></Field>}
          {type === 'DATE_SHIFT' && <Field label="Días de referencia"><input type="number" step="1" value={deltaDays} onChange={(event) => setDeltaDays(event.target.value)} className={inputClass} /></Field>}
          {type === 'SPLIT_PAYMENT' && <Field label="Número de pagos"><input type="number" min="2" step="1" value={splitCount} onChange={(event) => setSplitCount(event.target.value)} className={inputClass} /></Field>}

          <Field label="Razón">
            <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value as FinancialAdjustment['reasonCode'])} className={inputClass}>
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
              onChange={(event) => setJustification(event.target.value)}
              rows={4}
              className={`${inputClass} h-auto py-2`}
              placeholder="Explica por qué se cambia la fecha, monto o regla."
            />
          </Field>

          <div className="md:col-span-2 rounded-xl border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-[12px] text-[var(--gray-600)]">
            Vista previa: el ajuste queda como diferencia del escenario activo y no modifica JDE, bancos ni el movimiento base.
            {draftAdjustment && adjustmentRequiresApproval(draftAdjustment) && (
              <span className="ml-1 font-medium text-[var(--warning)]">Requiere aprobación por materialidad o criticidad.</span>
            )}
          </div>
          {error && <div className="md:col-span-2 text-[12px] font-medium text-[var(--danger)]">{error}</div>}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
          <button onClick={onClose} className="h-9 rounded-lg border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)]">Cancelar</button>
          <button onClick={() => handleSave('DRAFT')} className="h-9 rounded-lg border border-[var(--border)] bg-white px-3 text-[12px] font-medium text-[var(--gray-950)] hover:bg-[var(--surface-alt)]">Guardar borrador</button>
          <button onClick={() => handleSave('IN_REVIEW')} className="h-9 rounded-lg border border-[var(--primary)] bg-[var(--primary)] px-3 text-[12px] font-medium text-white hover:opacity-90">Enviar a revisión</button>
        </div>
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

const inputClass = 'h-9 w-full rounded-lg border border-[var(--border)] bg-white px-2.5 text-[12px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)]';

function Field({ label, children, span }: { label: string; children: ReactNode; span?: boolean }) {
  return (
    <label className={`block ${span ? 'md:col-span-2' : ''}`}>
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--gray-400)]">{label}</span>
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
