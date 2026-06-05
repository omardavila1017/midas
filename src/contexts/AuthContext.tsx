/**
 * AuthContext — identidad del usuario actual + helper de autorización `can()`.
 *
 * IMPORTANTE (ver `AUTH.md`): el frontend NO es una frontera de seguridad. La
 * autenticación real la hace el backend / SSO; este contexto solo decide
 * qué módulos MOSTRAR para una UX limpia. La autorización vinculante sobre los
 * datos vive en el proxy `/api/*`.
 *
 * Fuente de identidad: sesión resuelta por `/api/auth/session` o
 * `/api/auth/login` antes de montar AppCore. No guarda tokens en el cliente;
 * el backend mantiene la cookie HttpOnly.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { getRoleForEmail } from '../config/userRoles';
import { isRole, roleCanAccess, type Role } from '../config/roles';
import { getCurrentAuthSession } from './authSession';
import type { AppTabId } from '../modules/shared-finance/components/NavigationContext';

interface AuthContextValue {
  /** Correo del usuario actual (o `null` si no hay identidad resuelta). */
  email: string | null;
  /** Rol resuelto a partir del correo (default si no está mapeado). */
  role: Role;
  /** Expiración reportada por backend, si existe. */
  expiresAt?: string;
  /** ¿Puede el usuario actual ver este tab/módulo? */
  can: (tab: AppTabId) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  /** Override explícito de correo (tests / Storybook). */
  email: emailOverride,
  role: roleOverride,
}: {
  children: ReactNode;
  email?: string | null;
  role?: Role;
}) {
  const [session] = useState(() => getCurrentAuthSession());
  const [email] = useState<string | null>(() => (
    emailOverride !== undefined ? emailOverride : session?.email ?? null
  ));

  const role = useMemo<Role>(() => {
    if (roleOverride) return roleOverride;
    if (session?.role && isRole(session.role)) return session.role;
    return getRoleForEmail(email);
  }, [email, roleOverride, session?.role]);
  const can = useCallback((tab: AppTabId) => roleCanAccess(role, tab), [role]);

  const value = useMemo<AuthContextValue>(
    () => ({ email, role, expiresAt: session?.expiresAt, can }),
    [email, role, session?.expiresAt, can],
  );

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
    expiresAt: undefined,
    can: () => false,
  };
}
