// ─────────────────────────────────────────────────────────────────────────
// Fideicomiso Dina → movimientos para los escenarios (no base).
//
// Modelo de negocio (confirmado con Finanzas): CORNING deposita en la cuenta
// BanBajío de la operadora; el día 15 el fideicomiso liquida el arrendamiento
// a DINA. Hoy ese flujo está EXCLUIDO de la proyección (excludeBajio en
// App.tsx), así que lo re-inyectamos como dos patas:
//
//   - INGRESO: los ABONOs reales de CORNING detectados en los estados de
//     cuenta Bajío, en su fecha real (sourceSystem 'BANK', status 'REAL').
//   - EGRESO:  la obligación mensual fija a DINA el día 15 de cada mes de la
//     ventana (config-driven, lockState 'LOCKED', mismo patrón que convenio).
//
// El egreso DINA se clasifica como deuda de fideicomiso. El ingreso Corning
// se presenta como Clientes Citi para que sume en el bucket comercial correcto
// de Planeación, sin perder el id/concepto de fideicomiso para auditoría.
//
// Invariante Base: el llamador NO invoca esto para `id === 'base'` (mismo
// gate que impuestos/convenio). Recortado a la ventana [startDate, endDate].
//
// Nota de modelado: se inyecta el egreso DINA para CADA mes de la ventana
// (pasados y futuros) para que el sub-libro del fideicomiso netee de forma
// coherente contra los depósitos Corning reales (que pueden ser de meses ya
// transcurridos). El monto de meses pasados usa la obligación fija de config
// (puede diferir del pago real; Finanzas lo afina vía VITE_DINA_*).
// ─────────────────────────────────────────────────────────────────────────
import type { BankAccountStatement } from '../../../services/jde';
import { isCorningAbono } from '../../../domain/bankStatements';
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
  bajioStatements: readonly BankAccountStatement[];
}): FinancialMovement[] {
  const { scenarioId, startDate, endDate, asOfDate, bajioStatements } = params;
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

  // ── INGRESO: ABONOs reales de CORNING en Bajío, fecha real. ──
  const seen = new Set<string>();
  for (const stmt of bajioStatements) {
    for (const m of stmt.movimientos) {
      if (!isCorningAbono(m)) continue;
      const fecha = m.fechaOperacion;
      if (!fecha || fecha < startDate || fecha > endDate) continue;
      const amount = Math.abs(m.importe ?? 0);
      if (amount <= 0) continue;
      // Dedupe estable: dos cargas de estado de cuenta pueden traer el mismo
      // ABONO; no lo contamos dos veces.
      const dedupe = `${stmt.cia}|${stmt.cuenta}|${fecha}|${amount}|${m.referencia ?? ''}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      movements.push({
        id: `fideicomiso-corning:${scenarioId}:${dedupe}`,
        sourceSystem: 'BANK',
        sourceObjectId: dedupe,
        type: 'INFLOW',
        category: 'DEBT',
        subcategory: 'Clientes Citi',
        counterpartyName: 'CORNING',
        counterpartyType: 'BANK',
        concept: m.concepto || `Depósito Corning · Fideicomiso Dina ${fecha}`,
        currency: 'MXN',
        originalAmount: amount,
        baseAmount: amount,
        projectedAmount: amount,
        adjustedAmount: amount,
        issueDate: fecha,
        dueDate: fecha,
        projectedDate: fecha,
        adjustedDate: fecha,
        actualDate: fecha,
        confidenceScore: 100,
        confidenceBand: calculateConfidenceBand(100),
        forecastMethod: 'RULE',
        ruleApplied: 'ABONO Corning real en cuenta Bajío',
        taxTreatment: 'IVA_EXEMPT',
        status: 'REAL',
        lockState: 'LOCKED',
        comments: [`Depósito Corning real detectado en Bajío (${stmt.cuenta}).`],
        createdAt: ts,
        updatedAt: ts,
      });
    }
  }

  return movements;
}
