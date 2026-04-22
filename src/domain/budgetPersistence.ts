// ─────────────────────────────────────────────────────────────────────────
// budgetPersistence — carga/guarda el presupuesto activo en localStorage.
//
// El budget es una entidad "global" (no depende de compañía) hoy. Si en el
// futuro se quiere por-compañía, habría que switchear el key por cia.
// ─────────────────────────────────────────────────────────────────────────

import type { Budget } from './budget';

const BUDGET_KEY = 'flowsense.budget.v1';

export function loadBudget(): Budget | null {
  try {
    const raw = localStorage.getItem(BUDGET_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isBudget(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveBudget(b: Budget | null): void {
  try {
    if (b === null) localStorage.removeItem(BUDGET_KEY);
    else localStorage.setItem(BUDGET_KEY, JSON.stringify(b));
  } catch {
    // quota o serialization — ignoramos, el budget se pierde al recargar.
  }
}

function isBudget(v: unknown): v is Budget {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.year === 'number' &&
    typeof o.scale === 'string' &&
    Array.isArray(o.incomeTotal) &&
    Array.isArray(o.expenseTotal) &&
    Array.isArray(o.incomeByConcept) &&
    Array.isArray(o.expenseByConcept)
  );
}
