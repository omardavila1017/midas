import { AlertTriangle, CheckCircle2, Info, TrendingDown } from 'lucide-react';
import type { Insight, InsightTone } from '../services/insights';

interface Props {
  insights: Insight[];
}

/**
 * Senda DS:
 *   - Card blanca sólida, radius `--radius-lg`, borde gray-200.
 *   - Iconos Lucide con stroke 1.5; fondos muted del DS (color-mix
 *     contra el token de tono, no Tailwind raw).
 *   - Tipografía 12 / 11 con leading-snug — densa pero respirando.
 *   - Lista con divisores tenues — el lector escanea verticalmente.
 */
export function InsightsCard({ insights }: Props) {
  if (insights.length === 0) return null;

  return (
    <section
      role="region"
      aria-label="Observaciones del escenario"
      className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-[var(--surface)] p-3 animate-card-in"
    >
      <header className="mb-2 flex items-center justify-between px-1">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-500)]">
          Observaciones
        </span>
        <span className="tabular-nums text-[10px] font-medium text-[var(--gray-400)]">
          {insights.length}
        </span>
      </header>
      <ul role="list" className="divide-y divide-[var(--gray-100)]">
        {insights.map((insight) => (
          <InsightRow key={insight.id} insight={insight} />
        ))}
      </ul>
    </section>
  );
}

function InsightRow({ insight }: { insight: Insight }) {
  const palette = paletteFor(insight.tone);
  const Icon = iconFor(insight.tone);
  return (
    <li className="flex items-start gap-2.5 px-1 py-2 transition-colors duration-150 hover:bg-[var(--surface-alt)]">
      <span
        aria-hidden="true"
        className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-md)]"
        style={{ background: palette.bg, color: palette.fg }}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium leading-tight text-[var(--gray-950)]">{insight.title}</p>
        <p className="mt-1 text-[11px] leading-snug text-[var(--gray-600)]">{insight.detail}</p>
      </div>
    </li>
  );
}

function paletteFor(tone: InsightTone): { bg: string; fg: string } {
  switch (tone) {
    case 'critical':
      return { bg: 'var(--danger-muted)', fg: 'var(--danger)' };
    case 'warning':
      return { bg: 'var(--warning-muted)', fg: 'var(--warning)' };
    case 'positive':
      return { bg: 'var(--success-muted)', fg: 'var(--success)' };
    case 'neutral':
    default:
      return { bg: 'var(--gray-100)', fg: 'var(--gray-700)' };
  }
}

function iconFor(tone: InsightTone) {
  switch (tone) {
    case 'critical':
      return TrendingDown;
    case 'warning':
      return AlertTriangle;
    case 'positive':
      return CheckCircle2;
    case 'neutral':
    default:
      return Info;
  }
}
