import { AlertTriangle, Banknote, ShieldAlert, Waves } from 'lucide-react';
import { fmtCompact, fmtPct } from '../../../formatters';
import KpiCard from '../../../components/ui/KpiCard';
import type { ProbabilisticForecastRun } from '../../shared-finance/types';

export function ProbabilisticRiskStrip({
  run,
  loading,
  error,
}: {
  run: ProbabilisticForecastRun | null;
  loading: boolean;
  error: string | null;
}) {
  const summary = run?.summary;
  const confidence = run?.diagnostics.confidence ?? 'LOW';
  const confidenceLabel = confidence === 'HIGH'
    ? 'Confianza alta'
    : confidence === 'MEDIUM'
      ? 'Confianza media'
      : 'Confianza baja';

  if (!run && !loading && !error) return null;

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-[13px] font-bold text-[var(--gray-950)]">Riesgo estadístico</h2>
          <p className="text-[11px] text-[var(--gray-400)]">
            {loading
              ? 'Calculando bandas probabilísticas a 12 meses.'
              : error
                ? 'No se pudo recalcular la capa probabilística.'
                : `${confidenceLabel} · ${run?.diagnostics.modelKind ?? '—'} · ${run?.simulations ?? 0} trayectorias`}
          </p>
        </div>
        {error && (
          <span className="rounded-[var(--radius-md)] border border-[var(--danger)]/20 bg-white px-2 py-1 text-[11px] font-medium text-[var(--danger)]">
            {error}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Prob. déficit"
          value={summary ? fmtPct(summary.probabilityOfDeficit) : '—'}
          icon={<AlertTriangle className="h-4 w-4" />}
          color={probabilityTone(summary?.probabilityOfDeficit ?? 0)}
          sublabel={summary?.maxRiskDate ? `Pico ${summary.maxRiskDate}` : 'Sin fecha dominante'}
        />
        <KpiCard
          label="Prob. bajo mínimo"
          value={summary ? fmtPct(summary.probabilityBelowMinimumCash) : '—'}
          icon={<ShieldAlert className="h-4 w-4" />}
          color={probabilityTone(summary?.probabilityBelowMinimumCash ?? 0)}
          sublabel="Caja mínima configurada"
        />
        <KpiCard
          label="Crédito esperado"
          value={summary ? fmtCompact(summary.expectedCreditRequired) : '—'}
          icon={<Banknote className="h-4 w-4" />}
          color={creditTone(summary?.expectedCreditRequired ?? 0)}
          sublabel="Promedio de faltante máximo"
        />
        <KpiCard
          label="Crédito P90"
          value={summary ? fmtCompact(summary.p90CreditRequired) : '—'}
          icon={<Waves className="h-4 w-4" />}
          color={creditTone(summary?.p90CreditRequired ?? 0)}
          sublabel="Cola de estrés"
        />
      </div>
    </section>
  );
}

function probabilityTone(value: number): string {
  if (value >= 0.35) return 'var(--danger)';
  if (value >= 0.15) return 'var(--warning)';
  return 'var(--success)';
}

function creditTone(value: number): string {
  if (value > 0) return 'var(--danger)';
  return 'var(--success)';
}
