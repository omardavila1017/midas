import type { AuditEvent } from '../types';

export function createAuditEvent(input: Omit<AuditEvent, 'id' | 'createdAt'>): AuditEvent {
  return {
    ...input,
    id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };
}

export function appendAuditEvent(events: AuditEvent[], event: Omit<AuditEvent, 'id' | 'createdAt'>): AuditEvent[] {
  return [createAuditEvent(event), ...events];
}
