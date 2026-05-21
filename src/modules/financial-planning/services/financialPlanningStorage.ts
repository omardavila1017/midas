import type { FinancialAdjustment, FinancialScenario } from '../../shared-finance/types';

const SCENARIOS_KEY = 'midas.financialPlanning.scenarios.v1';
const ADJUSTMENTS_KEY = 'midas.financialPlanning.adjustments.v1';

// Legacy: el log de auditoría write-only (`midas.financialPlanning.audit.v1`)
// se retiró al unificar el historial en el ChangeLogDrawer. Lo purgamos al
// cargar el módulo para no dejar basura en localStorage.
try {
  localStorage.removeItem('midas.financialPlanning.audit.v1');
} catch {
  /* ignore */
}

export function loadPlanningScenarios(fallback: FinancialScenario[]): FinancialScenario[] {
  return loadArray<FinancialScenario>(SCENARIOS_KEY, fallback, isScenario);
}

/**
 * Cheap scenario list for the global header selector — no heavy projection
 * compute. Returns Base + Approved (synthesized if not yet persisted) plus
 * any stored, non-archived drafts. Once a Proyección module mounts it
 * registers the fully-bootstrapped list, which supersedes this seed.
 */
export function listHeaderScenarios(): FinancialScenario[] {
  const stored = loadPlanningScenarios([]);
  const now = new Date().toISOString();
  const synth = (
    id: string,
    kind: 'BASE' | 'APPROVED',
    name: string,
  ): FinancialScenario => ({
    id,
    name,
    kind,
    adjustmentIds: [],
    status: 'APPROVED',
    isBase: kind === 'BASE',
    createdBy: 'system@senda.local',
    createdAt: now,
    updatedAt: now,
  });
  const base =
    stored.find((s) => s.kind === 'BASE' && !s.archivedAt) ??
    synth('base', 'BASE', 'Escenario Base');
  const approved =
    stored.find((s) => s.kind === 'APPROVED' && !s.archivedAt) ??
    synth('approved', 'APPROVED', 'Escenario Aprobado');
  const drafts = stored.filter((s) => s.kind === 'DRAFT' && !s.archivedAt);
  return [base, approved, ...drafts];
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
