/**
 * AuthContext — identidad del usuario actual + helper de autorización `can()`.
 *
 * IMPORTANTE (ver `AUTH.md`): el frontend NO es una frontera de seguridad. La
 * autenticación real la hace el backend / SSO; este contexto solo decide
 * qué módulos MOSTRAR para una UX limpia. La autorización vinculante sobre los
 * datos vive en el proxy `/api/*`.
 *
 * Modelo de acceso (2026-06-05): dos roles (`admin` / `user`). `admin` ve todo;
 * `user` ve solo los tabs que un admin le habilita en el módulo de Permisos
 * (`accessControlStore`). `can()` se reevalúa en vivo cuando cambian permisos.
 *
 * Fuente de identidad: sesión resuelta por `/api/auth/session` o
 * `/api/auth/login` antes de montar AppCore. No guarda tokens en el cliente;
 * el backend mantiene la cookie HttpOnly.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getRoleForEmail } from '../config/userRoles';
import { isRole, type Role } from '../config/roles';
import { isMidasUsersEnabled } from '../config/midasUsers';
import {
  canAccess,
  canAccessWithPermissions,
  effectiveRole,
  subscribeAccessChanged,
} from '../modules/users/services/accessControlStore';
import { getCurrentAuthSession } from './authSession';
import type { AppTabId } from '../modules/shared-finance/components/NavigationContext';

interface AuthContextValue {
  /** Correo del usuario actual (o `null` si no hay identidad resuelta). */
  email: string | null;
  /** Rol efectivo (override del registro si existe, si no el de la sesión). */
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

  // Modo ONLINE (WS/midas): la identidad y los permisos los manda la sesión de la
  // API (marcador `midas.auth.session.v2`), NO el registro local ni el roster
  // hardcodeado. En modo local (kill-switch off) se usa `accessControlStore`.
  const midas = isMidasUsersEnabled();
  const sessionPermissions = useMemo<AppTabId[]>(
    () => session?.permissions ?? [],
    [session?.permissions],
  );

  // Rol de la sesión (sin considerar el registro local de permisos).
  const sessionRole = useMemo<Role>(() => {
    if (roleOverride) return roleOverride;
    if (session?.role && isRole(session.role)) return session.role;
    return getRoleForEmail(email);
  }, [email, roleOverride, session?.role]);

  // Bump al cambiar el registro/permisos → recomputa rol efectivo y `can()`.
  const [accessVersion, setAccessVersion] = useState(0);
  useEffect(() => subscribeAccessChanged(() => setAccessVersion((v) => v + 1)), []);

  // Rol efectivo. ONLINE: el rol de la sesión (API) es autoritativo. Local: un
  // admin hardcodeado del roster manda; si no, el override del registro; si no,
  // la sesión. Ver `effectiveRole` en accessControlStore.
  const role = useMemo<Role>(() => {
    if (midas) return sessionRole;
    return effectiveRole(email, sessionRole);
    // accessVersion fuerza recálculo cuando cambia el registro.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, sessionRole, accessVersion, midas]);

  const can = useCallback(
    (tab: AppTabId) =>
      midas
        ? canAccessWithPermissions(sessionRole, sessionPermissions, tab)
        : canAccess(email, sessionRole, tab),
    // accessVersion fuerza un closure nuevo cuando cambian los permisos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [email, sessionRole, sessionPermissions, accessVersion, midas],
  );

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
