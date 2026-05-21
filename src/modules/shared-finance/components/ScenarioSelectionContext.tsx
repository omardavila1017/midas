import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { FinancialScenario } from '../types';

/**
 * App-wide active-scenario selection.
 *
 * Before: every Proyección module (Dashboard, Proyección Financiera,
 * Planeación, Impuestos) owned its own local `activeScenarioId` useState, so
 * switching scenario in one tab did nothing to the others and there was no
 * single "you pick the scenario up here" affordance.
 *
 * Now: a single provider near the app shell owns the active scenario id
 * (persisted) plus the scenario list shown in the global header selector.
 * Modules read/write through `useScenarioSelection()`. The hook returns
 * `null` when no provider is mounted (isolation tests / Operación tabs), so
 * callers fall back to local state and never crash standalone.
 */

const ACTIVE_SCENARIO_STORAGE_KEY = 'midas.activeScenarioId';
const FALLBACK_ACTIVE_SCENARIO_ID = 'approved';

export interface ScenarioSelectionContextValue {
  /** Globally selected scenario id (drives every Proyección tab). */
  activeScenarioId: string;
  setActiveScenarioId: (scenarioId: string) => void;
  /** Scenario list rendered in the global header dropdown. */
  scenarios: FinancialScenario[];
  /**
   * Modules call this with their freshly bootstrapped scenario list so the
   * header selector reflects real drafts (and renamed/added/discarded ones).
   */
  registerScenarios: (scenarios: FinancialScenario[]) => void;
}

const ScenarioSelectionContext = createContext<ScenarioSelectionContextValue | null>(null);

function readStoredActiveScenarioId(): string {
  try {
    return localStorage.getItem(ACTIVE_SCENARIO_STORAGE_KEY) ?? FALLBACK_ACTIVE_SCENARIO_ID;
  } catch {
    return FALLBACK_ACTIVE_SCENARIO_ID;
  }
}

export function ScenarioSelectionProvider({
  initialScenarios,
  children,
}: {
  initialScenarios: FinancialScenario[];
  children: ReactNode;
}) {
  const [activeScenarioId, setActiveScenarioIdState] = useState<string>(readStoredActiveScenarioId);
  const [scenarios, setScenarios] = useState<FinancialScenario[]>(initialScenarios);

  const setActiveScenarioId = useCallback((scenarioId: string) => {
    setActiveScenarioIdState(scenarioId);
    try {
      localStorage.setItem(ACTIVE_SCENARIO_STORAGE_KEY, scenarioId);
    } catch {
      /* private mode / quota — selection still works in-session */
    }
  }, []);

  const registerScenarios = useCallback((next: FinancialScenario[]) => {
    setScenarios((prev) => (sameScenarioList(prev, next) ? prev : next));
  }, []);

  // Snap to Approved if the active scenario vanished (draft discarded /
  // archived in another tab). Mirrors the per-module guards that existed
  // before the lift.
  useEffect(() => {
    if (scenarios.length === 0) return;
    const stillThere = scenarios.some((s) => s.id === activeScenarioId && !s.archivedAt);
    if (stillThere) return;
    const approved = scenarios.find((s) => s.kind === 'APPROVED' && !s.archivedAt);
    const base = scenarios.find((s) => s.kind === 'BASE' && !s.archivedAt);
    const fallback = approved?.id ?? base?.id ?? scenarios[0]?.id;
    if (fallback && fallback !== activeScenarioId) setActiveScenarioId(fallback);
  }, [scenarios, activeScenarioId, setActiveScenarioId]);

  const value = useMemo<ScenarioSelectionContextValue>(
    () => ({ activeScenarioId, setActiveScenarioId, scenarios, registerScenarios }),
    [activeScenarioId, setActiveScenarioId, scenarios, registerScenarios],
  );

  return (
    <ScenarioSelectionContext.Provider value={value}>
      {children}
    </ScenarioSelectionContext.Provider>
  );
}

/**
 * Returns the scenario selection context, or `null` when no provider is
 * mounted. Modules pattern: `ctx?.activeScenarioId ?? localState`.
 */
export function useScenarioSelection(): ScenarioSelectionContextValue | null {
  return useContext(ScenarioSelectionContext);
}

function sameScenarioList(a: FinancialScenario[], b: FinancialScenario[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.kind !== y.kind ||
      x.archivedAt !== y.archivedAt
    ) {
      return false;
    }
  }
  return true;
}
