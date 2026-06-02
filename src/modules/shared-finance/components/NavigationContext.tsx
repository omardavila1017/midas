import { createContext, useContext, useMemo, type ReactNode } from 'react';

/**
 * Canonical app tab identifiers. Mirrors `TabId` in App.tsx — kept in sync
 * by hand because we don't want shared-finance to import from App.
 */
export type AppTabId =
  | 'financialProjection'
  | 'financialPlanning'
  | 'taxes'
  | 'payroll'
  | 'operating'
  | 'netflow'
  | 'collections'
  | 'fideicomiso'
  | 'cxp'
  | 'concursoMercantil'
  | 'compras'
  | 'pagos'
  | 'clients'
  | 'providers'
  | 'bancos'
  | 'kpisObjectives'
  | 'users';

/**
 * Deep-link target for a cross-module jump. The `tab` is required; `focus`
 * is an optional hint that the destination dashboard can read from URL hash
 * or sessionStorage to scroll to / pre-select a section.
 */
export interface NavTarget {
  tab: AppTabId;
  focus?: string;
}

interface NavigationContextValue {
  goTo: (target: AppTabId | NavTarget) => void;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function NavigationProvider({
  goTo,
  children,
}: {
  goTo: NavigationContextValue['goTo'];
  children: ReactNode;
}) {
  const value = useMemo(() => ({ goTo }), [goTo]);
  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/**
 * Returns `goTo` if a NavigationProvider is mounted, else a no-op. Components
 * that want to be "navigable when wired, inert when not" can call this
 * unconditionally without crashing in isolation tests.
 */
export function useNavigateToTab(): NavigationContextValue['goTo'] {
  const ctx = useContext(NavigationContext);
  return ctx?.goTo ?? (() => undefined);
}
