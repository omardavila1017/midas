import { SplitSquareHorizontal, Undo2 } from 'lucide-react';
import { fmtCurrency } from '../../../formatters';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import { ConfidenceBadge } from '../../shared-finance/components/FinanceBadges';
import type { FinancialAdjustment, FinancialMovement } from '../../shared-finance/types';

export function EditablePlanningGrid({
  movements,
  activeScenarioId,
  onAdjust,
  onSplit,
  onRevertMovement,
}: {
  movements: FinancialMovement[];
  activeScenarioId: string;
  onAdjust: (movement: FinancialMovement) => void;
  onSplit: (movement: FinancialMovement) => void;
  onRevertMovement: (movement: FinancialMovement) => void;
}) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-white shadow-[var(--shadow-card)]">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Grid editable de planeación</h2>
        <p className="mt-1 text-[12px] text-[var(--gray-500)]">Edita fecha o monto creando ajustes; no se muta el movimiento base.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1100px] text-[12px]">
          <thead className="bg-[var(--surface-alt)] text-left text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--gray-400)]">
            <tr>
              <th className="px-4 py-2.5">Fecha base</th>
              <th className="px-4 py-2.5">Fecha ajustada</th>
              <th className="px-4 py-2.5">Movimiento</th>
              <th className="px-4 py-2.5 text-right">Monto base</th>
              <th className="px-4 py-2.5 text-right">Monto ajustado</th>
              <th className="px-4 py-2.5 text-right">Impacto</th>
              <th className="px-4 py-2.5">Confianza</th>
              <th className="px-4 py-2.5">Escenario</th>
              <th className="px-4 py-2.5 text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {movements.slice(0, 80).map((movement) => {
              const effective = effectiveAmount(movement);
              const delta = movement.type === 'INFLOW' ? effective - movement.baseAmount : movement.baseAmount - effective;
              return (
                <tr key={movement.id} className="border-t border-[var(--border)] hover:bg-[var(--surface-alt)]/60">
                  <td className="px-4 py-3 tabular-nums">{movement.projectedDate}</td>
                  <td className="px-4 py-3 tabular-nums">{movement.adjustedDate ?? effectiveMovementDate(movement)}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-[var(--gray-950)]">{movement.concept}</div>
                    <div className="mt-0.5 text-[11px] text-[var(--gray-400)]">{movement.counterpartyName ?? movement.category}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtCurrency(movement.baseAmount)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtCurrency(effective)}</td>
                  <td className={`px-4 py-3 text-right font-medium tabular-nums ${delta >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>{fmtCurrency(delta)}</td>
                  <td className="px-4 py-3"><ConfidenceBadge band={movement.confidenceBand} score={movement.confidenceScore} /></td>
                  <td className="px-4 py-3">{activeScenarioId}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      <button onClick={() => onAdjust(movement)} disabled={movement.status === 'REAL' || movement.lockState === 'LOCKED'} className="h-8 rounded-lg border border-[var(--border)] bg-white px-2 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)] disabled:opacity-40">Editar</button>
                      <button onClick={() => onSplit(movement)} disabled={movement.type !== 'OUTFLOW' || movement.status === 'REAL'} className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--border)] bg-white px-2 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)] disabled:opacity-40">
                        <SplitSquareHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
                        Dividir
                      </button>
                      <button onClick={() => onRevertMovement(movement)} className="inline-flex h-8 items-center gap-1 rounded-lg border border-[var(--border)] bg-white px-2 text-[11px] font-medium text-[var(--gray-700)] hover:bg-[var(--surface-alt)]">
                        <Undo2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                        Revertir
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
    justification: 'División rápida desde grid de planeación para reducir presión de caja.',
    status: 'DRAFT',
    createdBy: 'analyst@senda.local',
    createdAt: new Date().toISOString(),
  };
}
