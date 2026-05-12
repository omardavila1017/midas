import { AlertOctagon, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fmtCompact, fmtCurrency } from '../../../formatters';

const STORAGE_KEY_PREFIX = 'midas.troughBannerDismissed.v1';

interface Props {
  scenarioId: string;
  scenarioName: string;
  deficitDays: number;
  minCash: number;
  maxRiskDate?: string;
  creditRequired: number;
  minimumCashRequired: number;
}

export function CashTroughAlertBanner({
  scenarioId,
  scenarioName,
  deficitDays,
  minCash,
  maxRiskDate,
  creditRequired,
  minimumCashRequired,
}: Props) {
  const storageKey = `${STORAGE_KEY_PREFIX}.${scenarioId}`;
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });

  useEffect(() => {
    setDismissed(false);
  }, [scenarioId]);

  const isCritical = deficitDays > 0;
  const isWarning = !isCritical && minCash < minimumCashRequired;

  useEffect(() => {
    if (!dismissed) return;
    try { localStorage.setItem(storageKey, '1'); } catch { /* ignore */ }
  }, [dismissed, storageKey]);

  if (dismissed) return null;
  if (!isCritical && !isWarning) return null;

  const tone = isCritical ? 'critical' : 'warning';
  const accent = tone === 'critical' ? 'var(--danger)' : 'var(--warning)';
  const bg = tone === 'critical' ? 'var(--danger-muted)' : 'var(--warning-muted)';
  const headline = tone === 'critical'
    ? `Caja proyectada bajo el umbral en ${deficitDays} día${deficitDays === 1 ? '' : 's'}`
    : `Caja mínima cerca del umbral`;
  const detail = tone === 'critical'
    ? `${scenarioName} cae a ${fmtCurrency(minCash)}${maxRiskDate ? ` el ${formatDateMx(maxRiskDate)}` : ''}. Crédito requerido: ${fmtCompact(creditRequired)}.`
    : `${scenarioName}: caja mínima ${fmtCurrency(minCash)} (umbral ${fmtCurrency(minimumCashRequired)}).`;

  return (
    <section
      role="alert"
      className="flex items-start gap-3 rounded-[var(--radius-lg)] border px-4 py-3 animate-card-in"
      style={{
        borderColor: `color-mix(in oklch, ${accent} 25%, transparent)`,
        background: bg,
      }}
    >
      <span
        className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)]"
        style={{ background: accent, color: 'white' }}
        aria-hidden="true"
      >
        <AlertOctagon className="h-4 w-4" strokeWidth={1.5} />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-bold leading-tight" style={{ color: accent }}>
          {headline}
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--gray-700)]">{detail}</p>
      </div>
      <button
        type="button"
        aria-label="Descartar alerta"
        onClick={() => setDismissed(true)}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--gray-500)] transition-colors duration-150 hover:bg-[var(--gray-100)] hover:text-[var(--gray-900)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/30"
      >
        <X className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>
    </section>
  );
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
