import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Circle,
  CircleCheck,
  CircleSlash,
  type LucideIcon,
} from 'lucide-react';
import type { ConfidenceBand, FinancialDataStatus, ApprovalStatus } from '../types';

/**
 * Badges institucionales para estados financieros.
 *
 * Senda DS:
 *   - Pill base: 11px / 500, rounded-full, padding 2px·8px, gap 1.5.
 *   - Lucide stroke 1.5 — siempre. Iconos discretos, no decorativos.
 *   - Borde + fondo muted + foreground a tono. Cero gradientes, cero
 *     glow, cero side-stripes.
 *   - Opacidades uniformadas (border/25 en todos los tonos).
 */

const PILL_BASE =
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none';

interface PillSpec {
  icon: LucideIcon;
  className: string;
}

const confidenceSpec: Record<ConfidenceBand, { label: string } & PillSpec> = {
  CONFIRMED: {
    label: 'Confirmado',
    icon: CircleCheck,
    className: 'border-[var(--success)]/25 bg-[var(--success-muted)] text-[var(--success)]',
  },
  HIGH: {
    label: 'Confianza alta',
    icon: CheckCircle2,
    className: 'border-[var(--success)]/25 bg-[var(--success-muted)] text-[var(--success)]',
  },
  MEDIUM: {
    label: 'Confianza media',
    icon: AlertTriangle,
    className: 'border-[var(--warning)]/25 bg-[var(--warning-muted)] text-[var(--warning)]',
  },
  LOW: {
    label: 'Confianza baja',
    icon: AlertTriangle,
    className: 'border-[var(--danger)]/25 bg-[var(--danger-muted)] text-[var(--danger)]',
  },
  EXPLORATORY: {
    label: 'Exploratorio',
    icon: CircleDashed,
    className: 'border-[var(--gray-200)] bg-[var(--gray-50)] text-[var(--gray-500)]',
  },
};

const statusSpec: Record<FinancialDataStatus, { label: string } & PillSpec> = {
  REAL: {
    label: 'Real',
    icon: CircleCheck,
    className: 'border-[var(--primary)]/25 bg-[var(--primary-muted)] text-[var(--gray-950)]',
  },
  PROJECTED_BASE: {
    label: 'Proyectado',
    icon: Circle,
    className: 'border-[var(--gray-200)] bg-white text-[var(--gray-600)]',
  },
  ADJUSTED: {
    label: 'Ajustado',
    icon: AlertTriangle,
    className: 'border-[var(--warning)]/25 bg-[var(--warning-muted)] text-[var(--warning)]',
  },
  APPROVED: {
    label: 'Aprobado',
    icon: CheckCircle2,
    className: 'border-[var(--success)]/25 bg-[var(--success-muted)] text-[var(--success)]',
  },
  EXECUTED: {
    label: 'Ejecutado',
    icon: CircleCheck,
    className: 'border-[var(--primary)]/25 bg-[var(--primary-muted)] text-[var(--gray-950)]',
  },
  CANCELLED: {
    label: 'Cancelado',
    icon: CircleSlash,
    className: 'border-[var(--danger)]/25 bg-[var(--danger-muted)] text-[var(--danger)]',
  },
};

const approvalLabel: Record<ApprovalStatus, string> = {
  DRAFT: 'Borrador',
  IN_REVIEW: 'En revisión',
  APPROVED: 'Aprobado',
  REJECTED: 'Rechazado',
  PUBLISHED: 'Publicado',
  EXECUTED: 'Ejecutado',
};

const approvalSpec: Record<ApprovalStatus, PillSpec> = {
  DRAFT: {
    icon: Circle,
    className: 'border-[var(--gray-200)] bg-white text-[var(--gray-500)]',
  },
  IN_REVIEW: {
    icon: AlertTriangle,
    className: 'border-[var(--warning)]/25 bg-[var(--warning-muted)] text-[var(--warning)]',
  },
  APPROVED: {
    icon: CheckCircle2,
    className: 'border-[var(--success)]/25 bg-[var(--success-muted)] text-[var(--success)]',
  },
  REJECTED: {
    icon: CircleSlash,
    className: 'border-[var(--danger)]/25 bg-[var(--danger-muted)] text-[var(--danger)]',
  },
  PUBLISHED: {
    icon: CircleCheck,
    className: 'border-[var(--success)]/25 bg-[var(--success-muted)] text-[var(--success)]',
  },
  EXECUTED: {
    icon: CircleCheck,
    className: 'border-[var(--primary)]/25 bg-[var(--primary-muted)] text-[var(--gray-950)]',
  },
};

export function ConfidenceBadge({
  band,
  score,
  showIcon = true,
}: {
  band: ConfidenceBand;
  score?: number;
  showIcon?: boolean;
}) {
  const spec = confidenceSpec[band];
  const Icon = spec.icon;
  return (
    <span className={`${PILL_BASE} ${spec.className}`}>
      {showIcon && <Icon className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />}
      {spec.label}
      {typeof score === 'number' && (
        <span className="tabular-nums opacity-80">{Math.round(score)}</span>
      )}
    </span>
  );
}

export function StatusBadge({
  status,
  showIcon = true,
}: {
  status: FinancialDataStatus;
  showIcon?: boolean;
}) {
  const spec = statusSpec[status];
  const Icon = spec.icon;
  return (
    <span className={`${PILL_BASE} ${spec.className}`}>
      {showIcon && <Icon className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />}
      {spec.label}
    </span>
  );
}

export function ApprovalBadge({
  status,
  showIcon = true,
}: {
  status: string;
  showIcon?: boolean;
}) {
  const approvalStatus = status as ApprovalStatus;
  const label = approvalLabel[approvalStatus] ?? status;
  const spec = approvalSpec[approvalStatus] ?? {
    icon: Circle,
    className: 'border-[var(--gray-200)] bg-white text-[var(--gray-500)]',
  };
  const Icon = spec.icon;
  return (
    <span className={`${PILL_BASE} ${spec.className}`}>
      {showIcon && <Icon className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />}
      {label}
    </span>
  );
}
