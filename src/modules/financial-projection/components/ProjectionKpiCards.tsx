import {
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { fmtCompact, fmtCurrency, fmtPctInt } from '../../../formatters';
import KpiCard from '../../../components/ui/KpiCard';
import type { ForecastRun, ScenarioComparison } from '../../shared-finance/types';

/**
 * KPI cards de Proyección Financiera. Vienen agrupados en dos filas
 * lógicas para que la jerarquía visual coincida con el modelo mental
 * del tesorero:
 *
 *   Fila 1 — Trayectoria de caja (qué va a pasar)
 *     · Caja actual / 7 / 30 / 90 días
 *
 *   Fila 2 — Riesgo y composición (qué tan seguro estás)
 *     · Días de déficit · Mayor ingreso · Mayor egreso · Confianza
 *
 * Se reusa el `<KpiCard>` canónico del Dashboard para que el lenguaje
 * visual sea idéntico (border, padding, tipografía, breakdown). Antes
 * cada módulo definía su propia versión con sutiles diferencias (22px
 * vs 20px, ícono dentro de un cuadro extra) que rompían la consistencia.
 */
export function ProjectionKpiCards({
  projection,
  comparison,
}: {
  projection: ForecastRun;
  comparison?: ScenarioComparison;
}) {
  const { summary } = projection;
  const minimumLabel = `Mínimo ${fmtCompact(summary.minimumCashRequired)}`;

  return (
    <div className="space-y-3">
      {/* Trayectoria — la lectura primaria del tesorero. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Caja actual"
          value={fmtCurrency(summary.currentCash)}
          icon={<Wallet className="w-4 h-4" />}
          color="var(--gray-950)"
          sublabel="Saldo inicial bancario"
        />
        <KpiCard
          label="Caja 7 días"
          value={fmtCurrency(summary.projectedCash7)}
          icon={<Wallet className="w-4 h-4" />}
          color={tone(summary.projectedCash7, summary.minimumCashRequired)}
          sublabel="Cierre proyectado"
        />
        <KpiCard
          label="Caja 30 días"
          value={fmtCurrency(summary.projectedCash30)}
          icon={<Wallet className="w-4 h-4" />}
          color={tone(summary.projectedCash30, summary.minimumCashRequired)}
          sublabel={comparison ? `${formatDelta(comparison.finalCashDelta)} vs base` : 'Comparado al base'}
        />
        <KpiCard
          label="Caja 90 días"
          value={fmtCurrency(summary.projectedCash90)}
          icon={<Wallet className="w-4 h-4" />}
          color={tone(summary.projectedCash90, summary.minimumCashRequired)}
          sublabel={minimumLabel}
        />
      </div>

      {/* Riesgo y composición — lectura secundaria. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Días en déficit"
          value={String(summary.deficitDays)}
          icon={<AlertTriangle className="w-4 h-4" />}
          color={summary.deficitDays > 0 ? 'var(--danger)' : 'var(--success)'}
          sublabel={summary.maxRiskDate ? `Mayor riesgo: ${summary.maxRiskDate}` : 'Sin fecha crítica'}
        />
        <KpiCard
          label="Mayor ingreso"
          value={summary.largestUpcomingInflow ? fmtCurrency(summary.largestUpcomingInflow.projectedAmount) : '—'}
          icon={<ArrowUpCircle className="w-4 h-4" />}
          color="var(--success)"
          sublabel={summary.largestUpcomingInflow?.counterpartyName ?? 'Sin cobranza próxima'}
        />
        <KpiCard
          label="Mayor egreso"
          value={summary.largestUpcomingOutflow ? fmtCurrency(summary.largestUpcomingOutflow.projectedAmount) : '—'}
          icon={<ArrowDownCircle className="w-4 h-4" />}
          color="var(--danger)"
          sublabel={summary.largestUpcomingOutflow?.counterpartyName ?? 'Sin egreso próximo'}
        />
        <KpiCard
          label="Confianza prom."
          value={fmtPctInt(summary.averageConfidence)}
          icon={<ShieldCheck className="w-4 h-4" />}
          color="var(--gray-950)"
          sublabel="Fuente · método · historial"
        />
      </div>
    </div>
  );
}

function tone(value: number, minimum: number): string {
  if (value < minimum) return 'var(--danger)';
  if (value < minimum * 1.2) return 'var(--warning)';
  return 'var(--gray-950)';
}

function formatDelta(value: number): string {
  if (value === 0) return '±0';
  return `${value > 0 ? '+' : ''}${fmtCompact(value)}`;
}
