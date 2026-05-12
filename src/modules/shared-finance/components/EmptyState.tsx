import type { ReactNode } from 'react';

/**
 * Canonical empty state shared across the 4 dashboards.
 *
 * Replaces 4 ad-hoc implementations that varied in padding (p-3 vs p-10),
 * icon treatment, and copy tone. Use the `tone` prop to pick between an
 * informational neutral and a warning treatment.
 *
 * Layout philosophy: left-aligned by default for app contexts (treasury
 * users scan top-left → bottom-right); pass `align="center"` only for
 * full-page first-run states.
 */
export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'warning' | 'info';
  align?: 'left' | 'center';
  /** Compact = inline banner (p-3). Default = full card. */
  density?: 'compact' | 'default';
  /**
   * When true, announces the state via aria-live for screen readers. Use
   * for *transient* states (a warning that appears after an action, an
   * error returned by the server). For *static* empty states that are
   * present on first render, leave this off — otherwise screen readers
   * re-announce the same message on every navigation.
   */
  live?: boolean;
}

const TONE_SURFACE: Record<NonNullable<EmptyStateProps['tone']>, { bg: string; border: string; iconColor: string }> = {
  neutral: {
    bg: 'var(--surface)',
    border: 'var(--gray-200)',
    iconColor: 'var(--gray-500)',
  },
  warning: {
    bg: 'var(--warning-muted)',
    border: 'color-mix(in oklch, var(--warning) 25%, var(--gray-200))',
    iconColor: 'var(--warning)',
  },
  info: {
    bg: 'var(--surface-alt)',
    border: 'var(--gray-200)',
    iconColor: 'var(--gray-400)',
  },
};

export default function EmptyState({
  icon,
  title,
  description,
  action,
  tone = 'neutral',
  align = 'left',
  density = 'default',
  live = false,
}: EmptyStateProps) {
  const t = TONE_SURFACE[tone];
  const isCompact = density === 'compact';
  const isCenter = align === 'center';

  return (
    <div
      role={live ? 'status' : 'region'}
      aria-live={live ? 'polite' : undefined}
      aria-label={live ? undefined : title}
      className={[
        'rounded-[var(--radius-lg)] border animate-fade-in',
        isCompact ? 'p-3' : 'p-6 sm:p-8',
        isCenter ? 'text-center' : 'text-left',
      ].join(' ')}
      style={{ background: t.bg, borderColor: t.border }}
    >
      <div
        className={[
          'flex gap-3',
          isCompact ? 'items-start' : 'flex-col',
          isCenter ? 'items-center' : '',
        ].join(' ')}
      >
        {icon && (
          <span
            className={[
              'inline-flex shrink-0 items-center justify-center rounded-[var(--radius-md)]',
              isCompact ? 'h-5 w-5 mt-0.5' : 'h-10 w-10',
              isCompact ? '' : tone === 'warning' ? 'bg-[var(--warning-muted)]' : 'bg-[var(--gray-50)]',
            ].join(' ')}
            style={{ color: t.iconColor }}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        <div className={isCenter ? 'mx-auto max-w-[480px]' : 'min-w-0 flex-1'}>
          <h2
            className={
              isCompact
                ? 'text-[12px] font-medium leading-snug'
                : 'text-[15px] font-bold leading-tight text-[var(--gray-950)]'
            }
            style={isCompact ? { color: 'var(--gray-700)' } : undefined}
          >
            {title}
          </h2>
          {description && (
            <p
              className={[
                isCompact ? 'text-[12px]' : 'mt-1.5 text-[12px]',
                'leading-relaxed text-[var(--gray-500)]',
              ].join(' ')}
            >
              {description}
            </p>
          )}
          {action && <div className={isCompact ? 'mt-2' : 'mt-4'}>{action}</div>}
        </div>
      </div>
    </div>
  );
}
