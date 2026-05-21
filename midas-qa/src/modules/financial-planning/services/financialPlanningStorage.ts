import type { AuditEvent, FinancialAdjustment, FinancialScenario } from '../../shared-finance/types';

const SCENARIOS_KEY = 'midas.financialPlanning.scenarios.v1';
const ADJUSTMENTS_KEY = 'midas.financialPlanning.adjustments.v1';
const AUDIT_KEY = 'midas.financialPlanning.audit.v1';

export function loadPlanningScenarios(fallback: FinancialScenario[]): FinancialScenario[] {
  return loadArray<FinancialScenario>(SCENARIOS_KEY, fallback, isScenario);
}

export function savePlanningScenarios(scenarios: FinancialScenario[]): void {
  saveArray(SCENARIOS_KEY, scenarios);
}

export function loadPlanningAdjustments(fallback: FinancialAdjustment[]): FinancialAdjustment[] {
  return loadArray<FinancialAdjustment>(ADJUSTMENTS_KEY, fallback, isAdjustment);
}

export function savePlanningAdjustments(adjustments: FinancialAdjustment[]): void {
  saveArray(ADJUSTMENTS_KEY, adjustments);
}

export function loadPlanningAudit(fallback: AuditEvent[] = []): AuditEvent[] {
  return loadArray<AuditEvent>(AUDIT_KEY, fallback, isAuditEvent);
}

export function savePlanningAudit(events: AuditEvent[]): void {
  saveArray(AUDIT_KEY, events.slice(0, 200));
}

function loadArray<T>(key: string, fallback: T[], guard: (value: unknown) => value is T): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    const valid = parsed.filter(guard);
    return valid.length > 0 ? valid : fallback;
  } catch {
    return fallback;
  }
}

function saveArray<T>(key: string, value: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota errors */
  }
}

function isScenario(value: unknown): value is FinancialScenario {
  return Boolean(value && typeof value === 'object' && typeof (value as FinancialScenario).id === 'string');
}

function isAdjustment(value: unknown): value is FinancialAdjustment {
  return Boolean(value && typeof value === 'object' && typeof (value as FinancialAdjustment).id === 'string');
}

function isAuditEvent(value: unknown): value is AuditEvent {
  return Boolean(value && typeof value === 'object' && typeof (value as AuditEvent).id === 'string');
}
