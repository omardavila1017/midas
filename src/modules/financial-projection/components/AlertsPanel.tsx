import { AlertOctagon, AlertTriangle, Info } from 'lucide-react';
import type { ProjectionAlert } from '../../shared-finance/types';

export interface AlertsPanelProps {
  alerts: ProjectionAlert[];
  onSelect?: (alert: ProjectionAlert) => void;
}

export function AlertsPanel({ alerts, onSelect }: AlertsPanelProps) {
  if (alerts.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-[var(--gray-400)]">
        Sin alertas en el rango. La caja se mantiene encima del mínimo y la confianza es alta.
      </div>
    );
  }

  const sorted = [...alerts].sort((a, b) => {
    const severityRank = { CRITICAL: 0, WARNING: 1, INFO: 2 } as const;
    const diff = severityRank[a.severity] - severityRank[b.severity];
    if (diff !== 0) return diff;
    return a.date.localeCompare(b.date);
  });

  return (
    <ul className="divide-y divide-[var(--gray-100)]">
      {sorted.map((alert) => (
        <li key={alert.id}>
          <button
            type="button"
            onClick={() => onSelect?.(alert)}
            className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-[var(--gray-50)] transition-colors"
          >
            <SeverityIcon severity={alert.severity} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-semibold text-[var(--gray-950)]">{alert.title}</span>
                <SeverityBadge severity={alert.severity} />
              </div>
              <p className="mt-0.5 text-[12px] text-[var(--gray-600)] leading-snug">{alert.description}</p>
              <div className="mt-1 text-[10.5px] uppercase tracking-wider text-[var(--gray-400)] tabular-nums">
                {alert.date}
              </div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SeverityIcon({ severity }: { severity: ProjectionAlert['severity'] }) {
  if (severity === 'CRITICAL') {
    return <AlertOctagon className="h-5 w-5 shrink-0 text-[var(--danger)]" strokeWidth={1.5} />;
  }
  if (severity === 'WARNING') {
    return <AlertTriangle className="h-5 w-5 shrink-0 text-[var(--warning)]" strokeWidth={1.5} />;
  }
  return <Info className="h-5 w-5 shrink-0 text-[var(--gray-500)]" strokeWidth={1.5} />;
}

function SeverityBadge({ severity }: { severity: ProjectionAlert['severity'] }) {
  const config = severity === 'CRITICAL'
    ? { label: 'Crítica', bg: 'var(--danger)', color: 'white' }
    : severity === 'WARNING'
      ? { label: 'Atención', bg: 'var(--warning-muted)', color: 'var(--warning)' }
      : { label: 'Info', bg: 'var(--gray-100)', color: 'var(--gray-600)' };
  return (
    <span
      className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
      style={{ background: config.bg, color: config.color }}
    >
      {config.label}
    </span>
  );
}
