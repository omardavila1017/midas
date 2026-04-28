import { AlertTriangle, ArrowDownCircle, ArrowUpCircle, ShieldCheck, Wallet } from 'lucide-react';
import { fmtCompact, fmtPctInt } from '../../../formatters';
import type { ForecastRun, ScenarioComparison } from '../../shared-finance/types';

export function ProjectionKpiCards({
  projection,
  comparison,
}: {
  projection: ForecastRun;
  comparison?: ScenarioComparison;
}) {
  const { summary } = projection;
  const cards = [
    { label: 'Caja actual', value: fmtCompact(summary.currentCash), meta: 'Bancos / saldo inicial', icon: Wallet },
    { label: 'Caja 7 días', value: fmtCompact(summary.projectedCash7), meta: 'Cierre proyectado', icon: Wallet },
    { label: 'Caja 30 días', value: fmtCompact(summary.projectedCash30), meta: comparison ? delta(comparison.finalCashDelta) : 'Escenario base visible', icon: Wallet },
    { label: 'Caja 90 días', value: fmtCompact(summary.projectedCash90), meta: `Mínimo ${fmtCompact(summary.minimumCashRequired)}`, icon: Wallet },
    { label: 'Días déficit', value: String(summary.deficitDays), meta: summary.maxRiskDate ? `Mayor riesgo ${summary.maxRiskDate}` : 'Sin fecha crítica', icon: AlertTriangle },
    { label: 'Mayor ingreso', value: summary.largestUpcomingInflow ? fmtCompact(summary.largestUpcomingInflow.projectedAmount) : '—', meta: summary.largestUpcomingInflow?.counterpartyName ?? 'Sin cobranza futura', icon: ArrowUpCircle },
    { label: 'Mayor egreso', value: summary.largestUpcomingOutflow ? fmtCompact(summary.largestUpcomingOutflow.projectedAmount) : '—', meta: summary.largestUpcomingOutflow?.counterpartyName ?? 'Sin egreso futuro', icon: ArrowDownCircle },
    { label: 'Confianza prom.', value: fmtPctInt(summary.averageConfidence), meta: 'Fuente + historial + método', icon: ShieldCheck },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <div key={card.label} className="rounded-xl border border-[var(--border)] bg-white p-4 shadow-[var(--shadow-card)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--gray-400)]">{card.label}</div>
              <div className="mt-2 text-[22px] font-semibold leading-none text-[var(--gray-950)] tabular-nums">{card.value}</div>
            </div>
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-alt)] text-[var(--gray-500)]">
              <card.icon className="h-4 w-4" strokeWidth={1.5} />
            </span>
          </div>
          <div className="mt-3 truncate text-[12px] text-[var(--gray-500)]">{card.meta}</div>
        </div>
      ))}
    </div>
  );
}

function delta(value: number): string {
  if (value === 0) return 'Sin variación contra base';
  return `${value > 0 ? '+' : ''}${fmtCompact(value)} vs base`;
}
