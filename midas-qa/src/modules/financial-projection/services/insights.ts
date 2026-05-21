import type { ProjectionSummary } from '../../shared-finance/types';
import { fmtCompact, fmtCurrency } from '../../../formatters';

export type InsightTone = 'positive' | 'warning' | 'critical' | 'neutral';

export interface Insight {
  id: string;
  tone: InsightTone;
  title: string;
  detail: string;
}

export interface InsightInput {
  active: ProjectionSummary;
  approved?: ProjectionSummary;
  scenarioName: string;
  isBaseScenario: boolean;
}

/**
 * Deterministic insights derived purely from projection summaries — no LLM, no
 * randomness. Returns up to 3 observations ordered by importance.
 */
export function deriveInsights(input: InsightInput): Insight[] {
  const { active, approved, scenarioName, isBaseScenario } = input;
  const insights: Insight[] = [];

  // 1. Cash trough — most urgent if any deficit risk.
  if (active.deficitDays > 0 && active.maxRiskDate) {
    insights.push({
      id: 'cash-trough',
      tone: 'critical',
      title: `Caja mínima ${fmtCurrency(active.minCash)} el ${formatDateMx(active.maxRiskDate)}`,
      detail: `${active.deficitDays} día${active.deficitDays === 1 ? '' : 's'} bajo el mínimo. Considera adelantar cobranza o pausar pagos no críticos.`,
    });
  } else if (active.minCash < active.minimumCashRequired) {
    insights.push({
      id: 'cash-trough',
      tone: 'warning',
      title: `Caja mínima ${fmtCurrency(active.minCash)}`,
      detail: `Cerca del umbral de seguridad (${fmtCurrency(active.minimumCashRequired)}). Margen estrecho.`,
    });
  } else if (active.minCash > active.minimumCashRequired * 1.5) {
    insights.push({
      id: 'cash-buffer',
      tone: 'positive',
      title: `Buffer cómodo · mínimo ${fmtCurrency(active.minCash)}`,
      detail: 'Hay holgura sobre el mínimo proyectado. Espacio para inversión o adelantar pagos.',
    });
  }

  // 2. Variance vs Approved — only when active is not base/approved itself.
  if (!isBaseScenario && approved) {
    const delta = active.finalCash - approved.finalCash;
    const approvedAbs = Math.max(1, Math.abs(approved.finalCash));
    const pct = (delta / approvedAbs) * 100;
    if (Math.abs(pct) >= 1) {
      const positive = delta > 0;
      insights.push({
        id: 'variance-vs-approved',
        tone: positive ? 'positive' : 'warning',
        title: `${positive ? '+' : ''}${fmtCompact(delta)} vs Aprobado`,
        detail: `${scenarioName} cierra ${pct >= 0 ? `${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`} ${positive ? 'arriba' : 'abajo'} del escenario aprobado.`,
      });
    }
  }

  // 3. Largest single move — the one entry that moves the needle most.
  const largest = active.largestUpcomingOutflow;
  const largestIn = active.largestUpcomingInflow;
  if (largest && (!largestIn || largest.baseAmount > largestIn.baseAmount)) {
    insights.push({
      id: 'largest-outflow',
      tone: 'neutral',
      title: `Próxima salida grande · ${fmtCurrency(largest.baseAmount)}`,
      detail: `${largest.concept} el ${formatDateMx(largest.projectedDate)}. Confirma liquidez antes.`,
    });
  } else if (largestIn) {
    insights.push({
      id: 'largest-inflow',
      tone: 'neutral',
      title: `Próxima entrada grande · ${fmtCurrency(largestIn.baseAmount)}`,
      detail: `${largestIn.concept} el ${formatDateMx(largestIn.projectedDate)}.`,
    });
  }

  return insights.slice(0, 3);
}

function formatDateMx(iso: string): string {
  try {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short' }).format(date);
  } catch {
    return iso;
  }
}
