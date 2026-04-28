import { Pencil } from 'lucide-react';
import { fmtCurrency } from '../../../formatters';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import { ConfidenceBadge } from '../../shared-finance/components/FinanceBadges';
import type { FinancialAdjustment, FinancialMovement } from '../../shared-finance/types';

/**
 * Grid editable de movimientos del escenario activo.
 *
 * Cambios respecto a la versión anterior:
 *   - Una sola acción por fila ("Editar"). Antes había Editar + Dividir
 *     + Revertir y el usuario reportó que "las acciones estaban
 *     confusas" — la mayoría no se usaban y obstruían el click hit
 *     target.
 *   - El callback `onAdjust` recibe el DOMRect del botón clickeado
 *     para que el popover de edición aparezca pegado al row, no
 *     centrado en pantalla.
 *   - Toda fila bloqueada (LOCKED o REAL) muestra el botón en
 *     estado deshabilitado con tooltip explicando por qué.
 */
export function EditablePlanningGrid({
  movements,
  activeScenarioName,
  onAdjust,
}: {
  movements: FinancialMovement[];
  activeScenarioName: string;
  onAdjust: (movement: FinancialMovement, anchor: DOMRect) => void;
}) {
  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="border-b border-[var(--gray-200)] px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-tight text-[var(--gray-950)]">
          Movimientos del escenario
        </h2>
        <p className="mt-1 text-[12px] text-[var(--gray-400)]">
          Edita un movimiento para crear un ajuste sobre <strong>{activeScenarioName}</strong>. El movimiento base no se modifica.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-[13px]">
          <thead className="bg-[var(--gray-50)] text-left text-[11px] font-medium uppercase tracking-wider text-[var(--gray-400)]">
            <tr>
              <th className="px-4 py-2.5">Fecha</th>
              <th className="px-4 py-2.5">Movimiento</th>
              <th className="px-4 py-2.5 text-right">Monto base</th>
              <th className="px-4 py-2.5 text-right">Monto ajustado</th>
              <th className="px-4 py-2.5 text-right">Impacto</th>
              <th className="px-4 py-2.5">Confianza</th>
              <th className="px-4 py-2.5 text-right">Acción</th>
            </tr>
          </thead>
          <tbody>
            {movements.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-[12px] text-[var(--gray-400)]">
                  Sin movimientos editables para este escenario.
                </td>
              </tr>
            )}
            {movements.slice(0, 80).map((movement) => {
              const effective = effectiveAmount(movement);
              const delta = movement.type === 'INFLOW'
                ? effective - movement.baseAmount
                : movement.baseAmount - effective;
              const editable = movement.status !== 'REAL' && movement.lockState !== 'LOCKED';
              const lockReason = movement.status === 'REAL'
                ? 'Movimiento real del banco; no se edita.'
                : movement.lockState === 'LOCKED'
                  ? 'Movimiento bloqueado por proveedor inamovible.'
                  : '';
              return (
                <tr key={movement.id} className="border-t border-[var(--gray-200)] hover:bg-[var(--gray-50)]">
                  <td className="px-4 py-3 tabular-nums text-[var(--gray-700)]">
                    {effectiveMovementDate(movement)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-[var(--gray-950)]">{movement.concept}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">
                      {movement.counterpartyName ?? movement.category}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-[var(--gray-700)]">
                    {fmtCurrency(movement.baseAmount)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-[var(--gray-950)] font-medium">
                    {fmtCurrency(effective)}
                  </td>
                  <td
                    className="px-4 py-3 text-right font-medium tabular-nums"
                    style={{ color: delta >= 0 ? 'var(--success)' : 'var(--danger)' }}
                  >
                    {fmtCurrency(delta)}
                  </td>
                  <td className="px-4 py-3">
                    <ConfidenceBadge band={movement.confidenceBand} score={movement.confidenceScore} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <button
                        onClick={(event) => {
                          if (!editable) return;
                          const rect = event.currentTarget.getBoundingClientRect();
                          onAdjust(movement, rect);
                        }}
                        disabled={!editable}
                        title={editable ? 'Crear ajuste sobre este movimiento' : lockReason}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)] disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                        Editar
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

export function splitAdjustmentForMovement(movement: FinancialMovement, scenarioId: string): FinancialAdjustment {
  return {
    id: `adj-split-${movement.id}-${Date.now()}`,
    name: `Dividir ${movement.concept}`,
    scenarioIds: [scenarioId],
    type: 'SPLIT_PAYMENT',
    targetType: 'MOVEMENT',
    targetExpression: movement.id,
    splitConfig: { numberOfPayments: 2, frequency: 'WEEKLY' },
    reasonCode: 'LIQUIDITY',
    justification: 'División rápida.',
    status: 'DRAFT',
    createdBy: 'analyst@senda.local',
    createdAt: new Date().toISOString(),
  };
}
