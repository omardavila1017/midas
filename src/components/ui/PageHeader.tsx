import React from 'react';

interface PageHeaderProps {
  title: string;
  /** Pre-title kicker (small caps). Use for module / section context. */
  meta?: string;
  /** One-line context under the title (white/85 % opacity). */
  subtitle?: string;
  actions?: React.ReactNode;
}

/**
 * PageHeader vive sobre canvas claro. La versión previa asumía un shell
 * oscuro (texto blanco sobre slate-900) — se eliminó el dark skin global
 * por feedback del usuario. Ahora todo es slate-950 sobre superficie clara.
 *
 * Senda DS:
 *   - Tipografía Roboto, weights 400 / 500 / 700.
 *   - Title 22px / 700 con tracking-tight para densidad.
 *   - Meta 11px / 500 uppercase letter-spacing 0.08em — kicker discreto.
 *   - Subtitle 12px / 400 — context sin gritar.
 *   - Items-start en lugar de items-end: cuando las actions crecen
 *     verticalmente (e.g. dos botones apilados en mobile) el title
 *     no flota suspendido en el aire.
 */
export default function PageHeader({ title, meta, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 flex-1">
        {meta && (
          <p
            className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em]"
            style={{ color: 'var(--gray-500)' }}
          >
            {meta}
          </p>
        )}
        <h1
          className="truncate text-[22px] font-bold leading-tight tracking-tight"
          style={{ color: 'var(--gray-950)' }}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            className="mt-1 text-[12px] font-normal leading-snug"
            style={{ color: 'var(--gray-500)' }}
          >
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
