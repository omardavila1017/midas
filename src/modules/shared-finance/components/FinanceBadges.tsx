import type { ConfidenceBand, FinancialDataStatus } from '../types';

const confidenceLabel: Record<ConfidenceBand, string> = {
  CONFIRMED: 'Confirmado',
  HIGH: 'Alta',
  MEDIUM: 'Media',
  LOW: 'Baja',
  EXPLORATORY: 'Exploratorio',
};

const confidenceClass: Record<ConfidenceBand, string> = {
  CONFIRMED: 'border-[var(--success)]/30 bg-[var(--success-muted)] text-[var(--success)]',
  HIGH: 'border-[var(--success)]/20 bg-[var(--success-muted)] text-[var(--success)]',
  MEDIUM: 'border-[var(--warning)]/25 bg-[var(--warning-muted)] text-[var(--warning)]',
  LOW: 'border-[var(--danger)]/20 bg-[var(--danger-muted)] text-[var(--danger)]',
  EXPLORATORY: 'border-[var(--border)] bg-[var(--surface-alt)] text-[var(--gray-500)]',
};

const statusLabel: Record<FinancialDataStatus, string> = {
  REAL: 'Real',
  PROJECTED_BASE: 'Base proyectado',
  ADJUSTED: 'Ajustado',
  APPROVED: 'Aprobado',
  EXECUTED: 'Ejecutado',
  CANCELLED: 'Cancelado',
};

const statusClass: Record<FinancialDataStatus, string> = {
  REAL: 'border-[var(--primary)]/20 bg-[var(--primary-muted)] text-[var(--gray-950)]',
  PROJECTED_BASE: 'border-[var(--border)] bg-white text-[var(--gray-600)]',
  ADJUSTED: 'border-[var(--warning)]/25 bg-[var(--warning-muted)] text-[var(--warning)]',
  APPROVED: 'border-[var(--success)]/25 bg-[var(--success-muted)] text-[var(--success)]',
  EXECUTED: 'border-[var(--primary)]/20 bg-[var(--primary-muted)] text-[var(--gray-950)]',
  CANCELLED: 'border-[var(--danger)]/20 bg-[var(--danger-muted)] text-[var(--danger)]',
};

export function ConfidenceBadge({ band, score }: { band: ConfidenceBand; score?: number }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${confidenceClass[band]}`}>
      {confidenceLabel[band]}
      {typeof score === 'number' && <span className="tabular-nums opacity-80">{Math.round(score)}</span>}
    </span>
  );
}

export function StatusBadge({ status }: { status: FinancialDataStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusClass[status]}`}>
      {statusLabel[status]}
    </span>
  );
}

export function ApprovalBadge({ status }: { status: string }) {
  const tone = status === 'APPROVED' || status === 'PUBLISHED' || status === 'EXECUTED'
    ? 'border-[var(--success)]/25 bg-[var(--success-muted)] text-[var(--success)]'
    : status === 'REJECTED'
      ? 'border-[var(--danger)]/20 bg-[var(--danger-muted)] text-[var(--danger)]'
      : status === 'IN_REVIEW'
        ? 'border-[var(--warning)]/25 bg-[var(--warning-muted)] text-[var(--warning)]'
        : 'border-[var(--border)] bg-white text-[var(--gray-500)]';
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>{status}</span>;
}
