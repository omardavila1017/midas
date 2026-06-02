/**
 * RBAC — catálogo declarativo de roles.
 *
 * Esto NO es secreto: define qué TABS puede ver cada rol. El mapeo
 * correo → rol (que sí es información sensible / cambiante) vive en `.env`
 * (`VITE_USER_ROLES`) y se parsea en `userRoles.ts`. Aquí NO hay correos ni
 * identidades reales — solo la matriz rol → módulos.
 *
 * Los `allowedTabs` usan `AppTabId` (la fuente canónica de IDs de tab vive en
 * `shared-finance/components/NavigationContext.tsx` y se refleja en `TabId`
 * de `types.ts`). `'*'` = acceso total (solo `admin`).
 *
 * Recordatorio de seguridad (ver `AUTH.md`): el frontend NO es una frontera de
 * seguridad. Este gate mejora la UX (oculta módulos irrelevantes) pero la
 * autorización vinculante la hace el backend/proxy `/api/*`.
 */

import type { AppTabId } from '../modules/shared-finance/components/NavigationContext';

/** Roles válidos del sistema. `none` = autenticado pero sin acceso a nada. */
export type Role =
  | 'admin'
  | 'abastos'
  | 'contaduria'
  | 'fiscal'
  | 'cobranza'
  | 'mesa_ayuda'
  | 'none';

export interface RoleDefinition {
  /** Etiqueta legible (es-MX) para la UI del módulo de usuarios. */
  label: string;
  /** Descripción corta del alcance del rol. */
  description: string;
  /** Tabs visibles. `'*'` = acceso total (todos los tabs, incluido `users`). */
  allowedTabs: AppTabId[] | '*';
}

/**
 * Catálogo de roles. Las descripciones son funcionales (qué hace el rol), NO
 * identidades — nada de nombres ni correos reales aquí.
 */
export const ROLES: Record<Role, RoleDefinition> = {
  admin: {
    label: 'Administrador',
    description: 'Acceso total a todos los módulos, incluido el de usuarios.',
    allowedTabs: '*',
  },
  abastos: {
    label: 'Abastos',
    description: 'Cuentas por pagar, órdenes de compra y catálogo de proveedores.',
    allowedTabs: ['cxp', 'compras', 'providers'],
  },
  contaduria: {
    label: 'Contaduría',
    description: 'Conciliaciones: cruce de cobranza, cruce de pagos y bancos.',
    allowedTabs: ['collections', 'pagos', 'bancos'],
  },
  fiscal: {
    label: 'Fiscal',
    description: 'Impuestos.',
    allowedTabs: ['taxes'],
  },
  cobranza: {
    label: 'Cobranza',
    description: 'Cobranza / cartera, calendario de cobros, cruce de cobranza y bancos.',
    allowedTabs: ['collections', 'bancos'],
  },
  mesa_ayuda: {
    label: 'Mesa de Ayuda',
    description: 'Solo el módulo de usuarios (sin acceso a módulos financieros).',
    allowedTabs: ['users'],
  },
  none: {
    label: 'Sin acceso',
    description: 'Usuario autenticado sin rol asignado. No ve ningún módulo.',
    allowedTabs: [],
  },
};

/** Lista de los roles válidos (incluye `none`). */
export const ROLE_IDS = Object.keys(ROLES) as Role[];

/** Type guard: ¿es `value` un rol válido del catálogo? */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLE_IDS as string[]).includes(value);
}

/**
 * ¿Puede `role` ver el tab `tab`? `admin` (`allowedTabs === '*'`) puede todo.
 * Cualquier otro rol solo los tabs listados explícitamente.
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
