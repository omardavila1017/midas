import React from 'react';

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
  tone?: 'neutral' | 'warning';
}

export const KpiCard: React.FC<KpiCardProps> = ({
  label,
  value,
  icon,
  color = 'var(--gray-950)',
  sublabel,
  breakdown,
  tone = 'neutral',
}) => {
  const surfaceStyles =
    tone === 'warning'
      ? {
          borderColor: 'color-mix(in oklch, var(--warning) 30%, var(--gray-200))',
          background: 'var(--warning-muted)',
        }
      : {
          borderColor: 'var(--gray-200)',
          background: 'var(--surface)',
        };

  return (
    <div
      className="group flex flex-col rounded-[var(--radius-lg)] border p-4 transition-colors duration-150 hover:border-[var(--gray-300)]"
      style={surfaceStyles}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p
          className="truncate text-[11px] font-medium uppercase tracking-[0.06em]"
          style={{ color: 'var(--gray-500)' }}
        >
          {label}
        </p>
        {icon && (
          <span
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center"
            style={{ color }}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
      </div>
      <p
        className="text-[22px] font-bold tabular-nums leading-[1.1]"
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
    </div>
  );
};

export default KpiCard;
