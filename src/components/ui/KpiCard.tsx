import React from 'react';
import { ArrowUpRight } from 'lucide-react';

/**
 * Tarjeta KPI canónica del producto. Vive aquí (componente compartido) en
 * lugar de estar embebida en Dashboard.tsx para que el resto de los módulos
 * (Proyección Financiera, Planeación Financiera) hereden el mismo lenguaje
 * visual sin duplicar markup ni divergir en spacing/tipografía.
 *
 * Senda DS:
 *   - Roboto 400/500/700.
 *   - Tokens del DS (var(--gray-*), var(--warning), …). Cero tailwind raw.
 *   - 4pt spacing scale. Radius `--radius` (0.625rem).
 *   - Hover sutil (border + transición 150ms) — no glow, no transform.
 *   - Breakdown alineado en grid 2-col para que las cifras siempre
 *     terminen contra el mismo borde derecho.
 *
 * Nueva responsabilidad: KPIs pueden ser "navegables". Cuando se le pasa
 * `onClick`, la tarjeta se convierte en un <button> con affordance discreto
 * (ArrowUpRight). Esto es lo que mapea el número al módulo destino sin
 * inventar UI extra — el número *es* el link.
 */
export interface KpiBreakdownItem {
  label: string;
  value: string;
  valueColor?: string;
}

export interface KpiCardProps {
  label: string;
  /** Valor formateado como string. El caller decide currency/compact/etc. */
  value: string;
  icon?: React.ReactNode;
  /** Color CSS del valor principal — usar tokens del DS. */
  color?: string;
  sublabel?: string;
  breakdown?: KpiBreakdownItem[];
  /** Tono del card; controla borde + fondo. Default neutro. */
  tone?: 'neutral' | 'warning' | 'danger' | 'success';
  /**
   * Click handler. Cuando se especifica, la tarjeta se renderiza como
   * `<button>` con hover lift + ArrowUpRight glyph que insinúa el jump.
   */
  onClick?: () => void;
  /** Tooltip / aria-label adicional cuando es navegable. */
  navHint?: string;
}

const TONE_SURFACE: Record<NonNullable<KpiCardProps['tone']>, { border: string; bg: string }> = {
  neutral: { border: 'var(--gray-200)', bg: 'var(--surface)' },
  warning: {
    border: 'color-mix(in oklch, var(--warning) 30%, var(--gray-200))',
    bg: 'var(--warning-muted)',
  },
  danger: {
    border: 'color-mix(in oklch, var(--danger) 25%, var(--gray-200))',
    bg: 'var(--danger-muted)',
  },
  success: {
    border: 'color-mix(in oklch, var(--success) 25%, var(--gray-200))',
    bg: 'var(--success-muted)',
  },
};

export const KpiCard: React.FC<KpiCardProps> = ({
  label,
  value,
  icon,
  color = 'var(--gray-950)',
  sublabel,
  breakdown,
  tone = 'neutral',
  onClick,
  navHint,
}) => {
  const navHintId = React.useId();
  const surfaceStyles = {
    ...TONE_SURFACE[tone],
    backgroundImage: tone === 'neutral' ? 'var(--skeuo-linen)' : undefined,
    boxShadow: 'var(--skeuo-emboss-md)',
  };
  const isInteractive = typeof onClick === 'function';

  const body = (
    <>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p
          className="truncate text-[11px] font-medium uppercase tracking-[0.06em]"
          style={{ color: 'var(--gray-500)' }}
        >
          {label}
        </p>
        <div className="flex items-center gap-1 shrink-0">
          {icon && (
            <span
              className="inline-flex h-5 w-5 items-center justify-center"
              style={{ color }}
              aria-hidden="true"
            >
              {icon}
            </span>
          )}
          {isInteractive && (
            // Affordance must be visible on touch devices (no hover state).
            // Desktop: opacity 0 → 100 on hover/focus for a calmer scan.
            // Coarse pointer (mobile/tablet): persistent at 60% so it's
            // discoverable without a hover gesture.
            <ArrowUpRight
              className="kpi-nav-glyph h-3.5 w-3.5 transition-opacity duration-150"
              style={{ color: 'var(--gray-400)' }}
              strokeWidth={1.75}
              aria-hidden="true"
            />
          )}
        </div>
      </div>
      <p
        className="text-[22px] font-bold tabular-nums leading-[1.1] skeuo-letterpress"
        style={{ color }}
      >
        {value}
      </p>
      {sublabel && (
        <p
          className="mt-1 text-[11px] leading-snug"
          style={{ color: 'var(--gray-500)' }}
        >
          {sublabel}
        </p>
      )}
      {breakdown && breakdown.length > 0 && (
        <dl
          className="mt-3 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 border-t pt-2.5 text-[11px]"
          style={{ borderColor: 'var(--gray-100)' }}
        >
          {breakdown.map((item, idx) => (
            <React.Fragment key={idx}>
              <dt className="truncate" style={{ color: 'var(--gray-500)' }}>
                {item.label}
              </dt>
              <dd
                className="text-right font-medium tabular-nums"
                style={{ color: item.valueColor ?? 'var(--gray-950)' }}
              >
                {item.value}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </>
  );

  const baseClasses =
    `group flex flex-col rounded-[var(--radius-lg)] border p-4 text-left transition-all duration-150${
      tone === 'neutral' ? ' skeuo-brackets' : ''
    }`;
  const interactiveClasses = isInteractive
    ? 'cursor-pointer hover:border-[var(--accent-blue)] hover:-translate-y-[1px] hover:shadow-[var(--shadow-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)] focus-visible:ring-offset-2'
    : 'hover:border-[var(--gray-300)]';

  if (isInteractive) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-describedby={navHint ? navHintId : undefined}
        title={navHint}
        className={`${baseClasses} ${interactiveClasses}`}
        style={surfaceStyles}
      >
        {body}
        {navHint && (
          <span
            id={navHintId}
            className="sr-only"
          >
            {navHint}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className={`${baseClasses} ${interactiveClasses}`} style={surfaceStyles}>
      {body}
    </div>
  );
};

export default KpiCard;
