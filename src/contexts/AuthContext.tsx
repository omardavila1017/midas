/**
 * AuthContext — identidad del usuario actual + helper de autorización `can()`.
 *
 * IMPORTANTE (ver `AUTH.md`): el frontend NO es una frontera de seguridad. La
 * autenticación real la hace Atlas SSO / el backend; este contexto solo decide
 * qué módulos MOSTRAR para una UX limpia. La autorización vinculante sobre los
 * datos vive en el proxy `/api/*`.
 *
 * Fuente de identidad: hoy NO hay un claim de sesión expuesto al frontend
 * (revisado `api/_lib/atlasProxy.ts` — solo inyecta tokens server-side, no
 * devuelve el email del usuario). Como puente temporal de desarrollo leemos el
 * correo de `import.meta.env.VITE_CURRENT_USER_EMAIL`. Reemplazar por la
 * identidad real cuando Atlas la exponga (ver TODO abajo).
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { getRoleForEmail } from '../config/userRoles';
import { roleCanAccess, type Role } from '../config/roles';
import type { AppTabId } from '../modules/shared-finance/components/NavigationContext';

interface AuthContextValue {
  /** Correo del usuario actual (o `null` si no hay identidad resuelta). */
  email: string | null;
  /** Rol resuelto a partir del correo (default si no está mapeado). */
  role: Role;
  /** ¿Puede el usuario actual ver este tab/módulo? */
  can: (tab: AppTabId) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Resuelve el correo del usuario actual.
 *
 * TODO(auth): conectar con la identidad real de Atlas SSO. Hoy se inyecta el
 * email mock vía `VITE_CURRENT_USER_EMAIL` (DEV ONLY) — cuando el backend
 * exponga un claim de sesión / header, leerlo aquí en lugar del env var.
 */
function resolveCurrentEmail(): string | null {
  // DEV ONLY: reemplazar por identidad real de Atlas/backend.
  const fromEnv = import.meta.env.VITE_CURRENT_USER_EMAIL;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return null;
}

export function AuthProvider({
  children,
  /** Override explícito de correo (tests / Storybook). */
  email: emailOverride,
}: {
  children: ReactNode;
  email?: string | null;
}) {
  const [email] = useState<string | null>(
    () => (emailOverride !== undefined ? emailOverride : resolveCurrentEmail()),
  );

  const role = useMemo<Role>(() => getRoleForEmail(email), [email]);
  const can = useCallback((tab: AppTabId) => roleCanAccess(role, tab), [role]);

  const value = useMemo<AuthContextValue>(() => ({ email, role, can }), [email, role, can]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Identidad + `can()` del usuario actual. Si no hay `AuthProvider` montado
 * (tests aislados), degrada a "sin acceso" en vez de tronar.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx) return ctx;
  return {
    email: null,
    role: 'none',
    can: () => false,
  };
}
