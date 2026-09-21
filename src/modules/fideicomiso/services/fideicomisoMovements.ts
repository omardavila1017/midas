// ─────────────────────────────────────────────────────────────────────────
// Fideicomiso Dina → movimientos para los escenarios (no base).
//
// Modelo de negocio (confirmado con Finanzas): CORNING deposita en la cuenta
// BanBajío de la operadora; el día 15 el fideicomiso liquida el arrendamiento
// a DINA. Este módulo inyecta SÓLO el egreso:
//
//   - EGRESO: la obligación mensual fija a DINA el día 15 de cada mes de la
//     ventana (config-driven, lockState 'LOCKED', mismo patrón que convenio).
//
// ⚠️ El INGRESO Corning NO se inyecta aquí, y no es un olvido (2026-09-21).
// Hasta 2026-06-04 Bajío estaba FUERA de la proyección (`excludeBajio`), así
// que este módulo re-inyectaba los ABONOs Corning para no perderlos. Esa
// premisa dejó de ser cierta: `accountableBankStatements` == todos los
// estados (AppCore), y `bajioStatements` es un SUBCONJUNTO de ese mismo
// arreglo, así que MOTOR 1 (`historicalReconciledEngine`) ya emite cada ABONO
// Corning como una línea `bank:` INFLOW real — la cuenta BANBAJIO está
// catalogada `role:'concentradora'`, `flow:'ingreso'` (NO neutra), de modo
// que no la filtra ni el corte de internos ni el de cuentas neutras.
// Re-inyectarlo contaba el MISMO depósito dos veces en todo escenario no-Base:
// el recorte `>= currentMonthStart` de `scenarioForecastRun` dejaba pasar
// justo los ABONOs del mes en curso, que por ser hechos bancarios observados
// son siempre pasados. Dirección del error: INFLABA el ingreso del bucket
// Clientes Citi. Si algún día Bajío vuelve a excluirse, la re-inyección se
// restituye AQUÍ y el corte de ventana para esa pata debe ser `> today`
// (un hecho bancario no es una obligación futura).
//
// El egreso DINA se clasifica como deuda de fideicomiso.
//
// Invariante Base: el llamador NO invoca esto para `id === 'base'` (mismo
// gate que impuestos/convenio). Recortado a la ventana [startDate, endDate].
//
// Nota de modelado: se inyecta el egreso DINA para CADA mes de la ventana
// (pasados y futuros) para que el sub-libro del fideicomiso netee de forma
// coherente. El monto de meses pasados usa la obligación fija de config
// (puede diferir del pago real; Finanzas lo afina vía VITE_DINA_*).
// ─────────────────────────────────────────────────────────────────────────
import { DINA_MONTHLY_OBLIGATION, DINA_PAYMENT_DAY } from '../../../config/fideicomiso.config';
import type { FinancialMovement } from '../../shared-finance/types';
import { calculateConfidenceBand } from '../../shared-finance/calculation-engine/financialProjectionEngine';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}

/** Lista de claves `YYYY-MM` desde el mes de `startDate` al de `endDate`. */
function monthKeysInWindow(startDate: string, endDate: string): Array<{ year: number; month1: number }> {
  const [sy, sm] = startDate.split('-').map(Number);
  const [ey, em] = endDate.split('-').map(Number);
  if (!sy || !sm || !ey || !em) return [];
  const out: Array<{ year: number; month1: number }> = [];
  let y = sy;
  let m = sm;
  // Cota de seguridad: nunca más de ~10 años de buckets.
  for (let guard = 0; guard < 130; guard++) {
    out.push({ year: y, month1: m });
    if (y === ey && m === em) break;
    if (y > ey || (y === ey && m > em)) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export function buildFideicomisoMovements(params: {
  scenarioId: string;
  startDate: string;
  endDate: string;
  asOfDate: string;
}): FinancialMovement[] {
  const { scenarioId, startDate, endDate, asOfDate } = params;
  const ts = `${asOfDate}T00:00:00.000Z`;
  const movements: FinancialMovement[] = [];

  // ── EGRESO: obligación mensual a DINA, día 15 (clamp a fin de mes). ──
  for (const { year, month1 } of monthKeysInWindow(startDate, endDate)) {
    const day = Math.min(DINA_PAYMENT_DAY, daysInMonth(year, month1));
    const dateIso = `${year}-${pad2(month1)}-${pad2(day)}`;
    if (dateIso < startDate || dateIso > endDate) continue;
    const amount = DINA_MONTHLY_OBLIGATION;
    const confidence = 90;
    movements.push({
      id: `fideicomiso-dina:${scenarioId}:${year}-${pad2(month1)}`,
      sourceSystem: 'FORECAST',
      sourceObjectId: `dina-${year}-${pad2(month1)}`,
      type: 'OUTFLOW',
      category: 'DEBT',
      subcategory: 'FIDEICOMISO_DINA',
      counterpartyName: 'DINA (Transportes Logística Jalisco)',
      counterpartyType: 'BANK',
      concept: `Fideicomiso Dina · arrendamiento ${year}-${pad2(month1)}`,
      currency: 'MXN',
      originalAmount: amount,
      baseAmount: amount,
      projectedAmount: amount,
      adjustedAmount: amount,
      issueDate: `${year}-${pad2(month1)}-01`,
      dueDate: dateIso,
      projectedDate: dateIso,
      adjustedDate: dateIso,
      confidenceScore: confidence,
      confidenceBand: calculateConfidenceBand(confidence),
      forecastMethod: 'RULE',
      ruleApplied: `Obligación mensual fideicomiso Dina (día ${DINA_PAYMENT_DAY})`,
      taxTreatment: 'IVA_EXEMPT',
      status: 'APPROVED',
      lockState: 'LOCKED',
      comments: [`Obligación fija ${amount.toLocaleString('es-MX', { maximumFractionDigits: 0 })} MXN a DINA.`],
      createdAt: ts,
      updatedAt: ts,
    });
  }

  return movements;
}
