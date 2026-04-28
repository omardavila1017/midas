import type { AuditEvent } from '../../shared-finance/types';

export function AuditTrailPanel({ events }: { events: AuditEvent[] }) {
  return (
    <section className="rounded-xl border border-[var(--border)] bg-white shadow-[var(--shadow-card)]">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Historial</h2>
        <p className="mt-1 text-[12px] text-[var(--gray-500)]">Quién cambió, qué cambió y cuándo.</p>
      </div>
      <div className="max-h-[320px] divide-y divide-[var(--border)] overflow-y-auto">
        {events.length === 0 ? (
          <div className="px-4 py-6 text-[12px] text-[var(--gray-500)]">Sin eventos de auditoría todavía.</div>
        ) : events.map((event) => (
          <div key={event.id} className="px-4 py-3 text-[12px]">
            <div className="flex items-start justify-between gap-3">
              <div className="font-medium text-[var(--gray-950)]">{event.action} · {event.entityType}</div>
              <div className="shrink-0 text-[11px] text-[var(--gray-400)]">{event.createdAt.slice(0, 16).replace('T', ' ')}</div>
            </div>
            <div className="mt-1 text-[11px] text-[var(--gray-400)]">{event.entityId} · {event.userId}</div>
            {event.comment && <p className="mt-2 text-[12px] text-[var(--gray-600)]">{event.comment}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}
