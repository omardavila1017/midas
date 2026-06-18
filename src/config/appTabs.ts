/**
 * Catálogo declarativo de los tabs/módulos de la app — etiquetas legibles y
 * agrupación para la UI de **Permisos**.
 *
 * Fuente única de verdad de los textos es-MX por `AppTabId`. La navegación real
 * (orden del sidebar, iconos) sigue viviendo en `AppCore.tsx` (`SECTIONS` +
 * `SUB_TABS`); esto solo provee labels + qué tabs son habilitables por permiso.
 * Mantener `APP_TAB_LABELS` en sync con `SUB_TABS` de `AppCore.tsx`.
 */

import type { AppTabId } from '../modules/shared-finance/components/NavigationContext';

/** Etiquetas legibles (es-MX) de cada tab/módulo. */
export const APP_TAB_LABELS: Record<AppTabId, string> = {
  financialProjection: 'Proyección Financiera',
  financialPlanning: 'Planeación Financiera',
  taxes: 'Impuestos',
  payroll: 'Nómina',
  operating: 'Operación',
  netflow: 'Flujo Neto',
  venta: 'Venta',
  collections: 'Cobranza',
  fideicomiso: 'Fideicomiso Dina',
  cxp: 'Antigüedad de Saldo',
  concursoMercantil: 'Concurso Mercantil',
  compras: 'Órdenes de Compras',
  pasivoDistribuir: 'Pasivo por Distribuir',
  pagos: 'Pagos',
  clients: 'Clientes',
  providers: 'Proveedores',
  bancos: 'Bancos',
  kpisObjectives: 'KPIs y Objetivos',
  users: 'Usuarios',
  permisos: 'Permisos',
};

export function tabLabel(tab: AppTabId): string {
  return APP_TAB_LABELS[tab] ?? tab;
}

/**
 * Tabs reservados a administradores. NO son habilitables por permiso a un
 * `user` — sería un footgun de escalación (gestionar usuarios/permisos). Solo
 * el rol `admin` los ve (ver `accessControlStore.canAccess`).
 */
export const ADMIN_ONLY_TABS: AppTabId[] = ['users', 'permisos'];

export function isAdminOnlyTab(tab: AppTabId): boolean {
  return ADMIN_ONLY_TABS.includes(tab);
}

/**
 * Permisos habilitables por sección, en el orden del sidebar. Esto es lo que
 * el módulo de Permisos pinta como switches. Excluye los tabs admin-only y el
 * legacy `operating` (no montado en la navegación).
 */
export const PERMISSION_GROUPS: { section: string; tabs: AppTabId[] }[] = [
  { section: 'Dashboard', tabs: ['financialProjection', 'financialPlanning', 'concursoMercantil', 'fideicomiso'] },
  { section: 'Ingresos', tabs: ['netflow', 'venta', 'collections'] },
  { section: 'Egresos', tabs: ['cxp', 'compras', 'pasivoDistribuir', 'pagos', 'payroll', 'taxes'] },
  { section: 'Catálogos', tabs: ['clients', 'providers', 'bancos'] },
  { section: 'Objetivos', tabs: ['kpisObjectives'] },
];

/** Lista plana de todos los tabs habilitables por permiso (orden de sidebar). */
export const GRANTABLE_TABS: AppTabId[] = PERMISSION_GROUPS.flatMap((g) => g.tabs);
