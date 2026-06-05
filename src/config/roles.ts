/**
 * RBAC — catálogo declarativo de roles.
 *
 * Modelo (rediseño 2026-06-05): SOLO existen dos roles operativos, `admin` y
 * `user`, más `none` (autenticado sin acceso). El acceso a módulos ya NO se
 * decide por rol granular: `admin` ve todo, y un `user` ve únicamente los tabs
 * que un admin le habilita con switches en el módulo de **Permisos** (ver
 * `src/modules/users/services/accessControlStore.ts`). El rol solo distingue
 * "acceso total" (admin) de "acceso por permisos" (user).
 *
 * Los `allowedTabs` usan `AppTabId` (la fuente canónica de IDs de tab vive en
 * `shared-finance/components/NavigationContext.tsx` y se refleja en `TabId`
 * de `types.ts`). `'*'` = acceso total (solo `admin`); `user`/`none` no listan
 * tabs aquí — su acceso lo resuelve la capa de permisos.
 *
 * Recordatorio de seguridad (ver `AUTH.md`): el frontend NO es una frontera de
 * seguridad. Este gate mejora la UX (oculta módulos irrelevantes) pero la
 * autorización vinculante la hace el backend/proxy `/api/*`.
 */

import type { AppTabId } from '../modules/shared-finance/components/NavigationContext';

/** Roles válidos del sistema. `none` = autenticado pero sin acceso a nada. */
export type Role = 'admin' | 'user' | 'none';

export interface RoleDefinition {
  /** Etiqueta legible (es-MX) para la UI del módulo de usuarios. */
  label: string;
  /** Descripción corta del alcance del rol. */
  description: string;
  /** Tabs visibles. `'*'` = acceso total (todos los tabs). `[]` = por permisos. */
  allowedTabs: AppTabId[] | '*';
}

/**
 * Catálogo de roles. `user` no enumera tabs: su acceso lo otorga el admin
 * tab-por-tab en el módulo de Permisos. Nada de identidades aquí.
 */
export const ROLES: Record<Role, RoleDefinition> = {
  admin: {
    label: 'Administrador',
    description: 'Acceso total a todos los módulos, incluido el de usuarios y permisos.',
    allowedTabs: '*',
  },
  user: {
    label: 'Usuario',
    description: 'Acceso por permisos individuales que define un administrador.',
    allowedTabs: [],
  },
  none: {
    label: 'Sin acceso',
    description: 'Usuario autenticado sin rol asignado. No ve ningún módulo.',
    allowedTabs: [],
  },
};

/** Lista de los roles válidos (incluye `none`). */
export const ROLE_IDS = Object.keys(ROLES) as Role[];

/** Roles que el admin puede asignar a un usuario en la UI (sin `none`). */
export const ASSIGNABLE_ROLE_IDS: Role[] = ['admin', 'user'];

/** Type guard: ¿es `value` un rol válido del catálogo nuevo? */
export function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'user' || value === 'none';
}

/**
 * Mapeo de roles GRANULARES legacy → tabs (su `allowedTabs` previo). Solo se
 * usa para SEMBRAR permisos por defecto de los usuarios ya conocidos cuando se
 * migra del modelo de roles al de permisos, para que nadie pierda acceso de
 * golpe. NO es un rol del sistema — es un diccionario de migración.
 */
export const LEGACY_ROLE_TABS: Record<string, AppTabId[]> = {
  abastos: ['cxp', 'compras', 'providers'],
  contaduria: ['collections', 'pagos', 'bancos'],
  fiscal: ['taxes'],
  cobranza: ['collections', 'venta', 'clients', 'bancos'],
  // `mesa_ayuda` era solo el módulo de usuarios, que ahora es admin-only: sin
  // tabs financieros que sembrar.
  mesa_ayuda: [],
};

/**
 * Normaliza cualquier rol entrante (incluido un rol granular legacy del backend
 * o del JSON local) al modelo binario admin/user. `admin` se preserva; un
 * `none`/vacío se preserva como `none` (bloquea acceso); cualquier rol granular
 * conocido o `user` cae a `user`. Lo desconocido → `none` (no concede acceso).
 */
export function coerceRole(value: unknown): Role {
  if (value === 'admin') return 'admin';
  if (value === 'user') return 'user';
  if (typeof value === 'string' && value in LEGACY_ROLE_TABS) return 'user';
  return 'none';
}

/**
 * ¿Puede `role` ver el tab `tab` POR SU ROL? Solo `admin` (`allowedTabs === '*'`)
 * concede acceso por rol. Para `user` el acceso real lo decide la capa de
 * permisos (`accessControlStore`), no esta función.
 */
export function roleCanAccess(role: Role, tab: AppTabId): boolean {
  const def = ROLES[role];
  if (!def) return false;
  if (def.allowedTabs === '*') return true;
  return def.allowedTabs.includes(tab);
}

/** Tabs concretos visibles para un rol, expandiendo `'*'` (admin). */
export function allowedTabsForRole(role: Role, allTabs: AppTabId[]): AppTabId[] {
  const def = ROLES[role];
  if (!def) return [];
  if (def.allowedTabs === '*') return [...allTabs];
  return def.allowedTabs.filter((t) => allTabs.includes(t));
}
