// ─────────────────────────────────────────────────────────────────────────
// Convenio Concursal → movimientos para el Escenario Aprobado.
//
// Inyecta los pagos FUTUROS del convenio (interés + capital de cada
// trimestre por vencer) como egresos `DEBT` bloqueados, siguiendo el mismo
// patrón que los impuestos (`buildApprovedTaxPaymentMovements`):
//
//   - Solo escenarios NO base (el invariante del Base se respeta aguas
//     arriba: el llamador no invoca esto para `id === 'base'`).
//   - Recortado a la ventana de proyección [startDate, endDate].
//   - `lockState: 'LOCKED'` — obligación legal fija, no editable en la malla.
//   - Nivel grupo (sin `companyId`): el convenio es del grupo; la columna
//     "empresa" del Excel se ignora por decisión del cliente.
//
// Origen de datos: dataset del convenio congelado en código (parseado del
// Excel), por eso `sourceSystem: 'EXCEL'`.
// ─────────────────────────────────────────────────────────────────────────
import type { FinancialMovement } from '../../shared-finance/types';
import { calculateConfidenceBand } from '../../shared-finance/calculation-engine/financialProjectionEngine';
import { buildConvenioSchedule } from '../../../domain/convenioConcursal';

export function buildConvenioPaymentMovements(params: {
  scenarioId: string;
  startDate: string;
  endDate: string;
  asOfDate: string;
}): FinancialMovement[] {
  const schedule = buildConvenioSchedule(params.asOfDate);
  return schedule.future
    .filter(
      (q) =>
        q.scheduledDateIso >= params.startDate && q.scheduledDateIso <= params.endDate,
    )
    .map((q) => {
      const amount = q.totalMxn;
      const confidence = 90;
      const movement: FinancialMovement = {
        id: `convenio-payment:${params.scenarioId}:${q.key}`,
        sourceSystem: 'EXCEL',
        sourceObjectId: q.key,
        type: 'OUTFLOW',
        category: 'DEBT',
        subcategory: 'CONVENIO_CONCURSAL',
        counterpartyName: 'Convenio Concursal (acreedores)',
        counterpartyType: 'BANK',
        concept: `Convenio Concursal ${q.month} ${q.year} · interés + capital`,
        currency: 'MXN',
        originalAmount: amount,
        baseAmount: amount,
        projectedAmount: amount,
        adjustedAmount: amount,
        issueDate: `${q.year}-${String(q.monthIndex).padStart(2, '0')}-01`,
        dueDate: q.naturalDateIso,
        projectedDate: q.scheduledDateIso,
        adjustedDate: q.scheduledDateIso,
        confidenceScore: confidence,
        confidenceBand: calculateConfidenceBand(confidence),
        forecastMethod: 'RULE',
        ruleApplied: 'Calendario convenio concursal (trimestral)',
        taxTreatment: 'IVA_EXEMPT',
        status: 'APPROVED',
        lockState: 'LOCKED',
        comments: [
          `Interés ${q.interesMxn.toLocaleString('es-MX', { maximumFractionDigits: 0 })} + capital ${q.capitalMxn.toLocaleString('es-MX', { maximumFractionDigits: 0 })} MXN.`,
          q.rolledDays > 0
            ? `Fecha recorrida ${q.rolledDays} día(s) por inhábil (devenga interés extra).`
            : null,
        ].filter((v): v is string => Boolean(v)),
        createdAt: `${params.asOfDate}T00:00:00.000Z`,
        updatedAt: `${params.asOfDate}T00:00:00.000Z`,
      };
      return movement;
    });
}
