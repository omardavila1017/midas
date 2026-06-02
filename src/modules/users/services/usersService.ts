/**
 * Servicio del módulo de Usuarios.
 *
 * Deriva, a partir del parser de `.env` (`userRoles`) y del catálogo de roles
 * (`roles`), las filas que la tabla de usuarios muestra: correo, rol y módulos
 * visibles. NO contiene correos ni identidades hardcodeadas — todo sale de la
 * configuración en runtime.
 */

import { listConfiguredUsers } from '../../../config/userRoles';
import { ROLES, type Role } from '../../../config/roles';
import type { AppTabId } from '../../shared-finance/components/NavigationContext';

/**
 * Etiquetas legibles (es-MX) de cada tab/módulo, para mostrar qué ve un rol.
 * Mantener en sync con `SUB_TABS` de `AppCore.tsx`.
 */
export const TAB_LABELS: Record<AppTabId, string> = {
  financialProjection: 'Proyección Financiera',
  financialPlanning: 'Planeación Financiera',
  taxes: 'Impuestos',
  payroll: 'Nómina',
  operating: 'Operación',
  netflow: 'Flujo Neto',
  collections: 'Cobranza',
  fideicomiso: 'Fideicomiso Dina',
  cxp: 'Antigüedad de Saldo',
  concursoMercantil: 'Concurso Mercantil',
  compras: 'Órdenes de Compras',
  pagos: 'Pagos',
  clients: 'Clientes',
  providers: 'Proveedores',
  bancos: 'Bancos',
  kpisObjectives: 'KPIs y Objetivos',
  users: 'Usuarios',
};

/** Orden canónico de tabs para mostrar la lista de módulos de admin (`'*'`). */
const ALL_TABS = Object.keys(TAB_LABELS) as AppTabId[];

export interface UserRow {
  email: string;
  role: Role;
  roleLabel: string;
  /** `true` si el rol ve todo (admin). */
  fullAccess: boolean;
  /** Tabs concretos visibles (vacío para `none`). */
  tabs: AppTabId[];
  /** Etiquetas legibles de los tabs visibles. */
  tabLabels: string[];
}

function tabsForRole(role: Role): AppTabId[] {
  const def = ROLES[role];
  if (def.allowedTabs === '*') return [...ALL_TABS];
  return def.allowedTabs.filter((t) => ALL_TABS.includes(t));
}

/** Construye una fila de la tabla para un par (correo, rol). */
export function buildUserRow(email: string, role: Role): UserRow {
  const def = ROLES[role];
  const fullAccess = def.allowedTabs === '*';
  const tabs = tabsForRole(role);
  return {
    email,
    role,
    roleLabel: def.label,
    fullAccess,
    tabs,
    tabLabels: tabs.map((t) => TAB_LABELS[t]),
  };
}

/** Filas para todos los usuarios configurados en `.env`. */
export function buildUsersView(): UserRow[] {
  return listConfiguredUsers().map(({ email, role }) => buildUserRow(email, role));
}
