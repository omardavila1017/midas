import { AlertTriangle } from 'lucide-react';
import { fmtCurrency } from '../../../formatters';
import type { ForecastRun } from '../types';

interface CashDeficitBannerProps {
  run: ForecastRun;
  scenarioName: string;
  onClickDetail?: () => void;
}

/**
 * Banner rojo que aparece SOBRE el grid de Planeación/Proyección cuando la
 * trayectoria proyectada cae por debajo de cero o del mínimo operativo. El
 * usuario aceptó que matemáticamente la caja PUEDA quedar negativa cuando
 * los egresos LOCKED exceden ingresos — este banner garantiza que sea
 * imposible no verlo.
 *
 * Reglas de visibilidad:
 * - Severidad CRÍTICA si algún `bucket.closingCash < 0`.
 * - Severidad WARNING si `summary.deficitDays > 0` (cae bajo el mínimo pero no
 *   negativo) o si `summary.finalCash < minimumCashRequired`.
 * - Si nada aplica, no renderiza nada.
 */
export function CashDeficitBanner({ run, scenarioName, onClickDetail }: CashDeficitBannerProps): JSX.Element | null {
  const negativeBuckets = run.buckets.filter((bucket) => bucket.closingCash < 0);
  const isCritical = negativeBuckets.length > 0;
  const isWarning = !isCritical
    && (run.summary.deficitDays > 0
      || run.summary.finalCash < run.summary.minimumCashRequired);
  if (!isCritical && !isWarning) return null;

  const worstBucket = isCritical
    ? [...negativeBuckets].sort((a, b) => a.closingCash - b.closingCash)[0]
    : [...run.buckets].sort((a, b) => a.closingCash - b.closingCash)[0];
  const palette = isCritical
    ? {
      container: 'border-[var(--danger)] bg-[var(--danger-soft,#fee2e2)]/60',
      icon: 'text-[var(--danger)]',
      title: 'text-[var(--danger)]',
      body: 'text-[var(--gray-900)] dark:text-[var(--foreground)]',
      button: 'border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger)]/10',
    }
    : {
      container: 'border-amber-400 bg-amber-50/70',
      icon: 'text-amber-600',
      title: 'text-amber-700',
      body: 'text-[var(--gray-900)] dark:text-[var(--foreground)]',
      button: 'border-amber-500 text-amber-700 hover:bg-amber-100',
    };

  const headline = isCritical
    ? `Caja proyectada en NEGATIVO en ${negativeBuckets.length} ${negativeBuckets.length === 1 ? 'periodo' : 'periodos'}`
    : `Caja proyectada bajo el mínimo operativo (${run.summary.deficitDays} ${run.summary.deficitDays === 1 ? 'día' : 'días'})`;
  const detail = isCritical
    ? `Peor punto: ${worstBucket?.date ?? '—'} con ${fmtCurrency(worstBucket?.closingCash ?? 0)}. Los egresos LOCKED (IMSS, convenio, fideicomiso, proveedores críticos) exceden el flujo disponible incluso tras diferir todo lo flexible.`
    : `Caja mínima ${fmtCurrency(run.summary.finalCash)} · piso ${fmtCurrency(run.summary.minimumCashRequired)}. ${worstBucket?.date ? `Punto más bajo ${worstBucket.date}.` : ''}`;

  return (
    <div
      className={`flex flex-col gap-2 rounded-xl border-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${palette.container}`}
      role="alert"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className={`mt-0.5 h-5 w-5 shrink-0 ${palette.icon}`} strokeWidth={2} />
        <div className="space-y-0.5">
          <div className={`text-[13px] font-semibold ${palette.title}`}>
            {headline} · {scenarioName}
          </div>
          <div className={`text-[12px] leading-snug ${palette.body}`}>
            {detail}
          </div>
        </div>
      </div>
      {onClickDetail && (
        <button
          type="button"
          onClick={onClickDetail}
          className={`shrink-0 self-start rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors sm:self-auto ${palette.button}`}
        >
          Ver detalle
        </button>
      )}
    </div>
  );
}
