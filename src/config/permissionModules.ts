/**
 * Vocabulario de PERMISOS (contrato CSV con el backend `WS/midas/usuarios`).
 *
 * Los módulos que ve un `Usuario` se serializan como lista separada por comas en
 * la columna `permisos`. Este archivo es la **fuente única** de ese vocabulario
 * (17 módulos) + los helpers para parsear/serializar/validar el CSV. Está aislado
 * en su propio módulo para poder migrarlo a una tabla dedicada más adelante sin
 * tocar la UI ni el login (ver documentación de la entrega de Usuarios/Seguridad).
 *
 * Los IDs son `AppTabId` reales (misma fuente que la navegación / `appTabs.ts`),
 * así que el permiso concedido por la API mapea 1:1 al gate `can(tab)` de la UI.
 * Los tabs administrativos (`users`, `permisos`) NO son otorgables — solo el rol
 * `Administrador` los ve — por eso no están aquí. Los tabs temporales de
 * diagnóstico (`fuentes*`) tampoco son parte del contrato del backend.
 */

import type { AppTabId } from '../modules/shared-finance/components/NavigationContext';

/**
 * Los 17 módulos otorgables por permiso, en el orden de las secciones del
 * sidebar. Debe coincidir con `GRANTABLE_TABS` de `appTabs.ts` (menos los tabs
 * temporales `fuentes*`); `permissionModules.test.ts` lo verifica.
 */
export const PERMISSION_MODULE_IDS: readonly AppTabId[] = [
  // Dashboard
  'financialProjection',
  'financialPlanning',
  'concursoMercantil',
  'fideicomiso',
  // Ingresos
  'netflow',
  'venta',
  'collections',
  // Egresos
  'cxp',
  'compras',
  'pasivoDistribuir',
  'pagos',
  'payroll',
  'taxes',
  // Catálogos
  'clients',
  'providers',
  'bancos',
  // Objetivos
  'kpisObjectives',
];

const PERMISSION_MODULE_SET: ReadonlySet<string> = new Set(PERMISSION_MODULE_IDS);

/** Type guard: ¿es `value` uno de los módulos válidos del contrato CSV? */
export function isPermissionModule(value: string): value is AppTabId {
  return PERMISSION_MODULE_SET.has(value);
}

/**
 * Parsea el CSV `permisos` del backend a `AppTabId[]`. Tolerante: recorta
 * espacios, ignora tokens vacíos, dedup, y **descarta cualquier token que no
 * esté en el vocabulario** (basura o módulos retirados no conceden acceso).
 * `null`/vacío → `[]` (sin módulos).
 */
export function parsePermissionsCsv(csv: string | null | undefined): AppTabId[] {
  if (!csv) return [];
  const out: AppTabId[] = [];
  for (const raw of csv.split(',')) {
    const token = raw.trim();
    if (token && isPermissionModule(token) && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * Serializa un set de tabs al CSV `permisos`. Filtra los que no están en el
 * vocabulario (p.ej. `users`/`permisos`/`fuentes*`) y dedup, para nunca escribir
 * un token inválido en el backend. Orden de entrada preservado.
 */
export function serializePermissionsCsv(tabs: readonly AppTabId[]): string {
  const seen = new Set<string>();
  const out: AppTabId[] = [];
  for (const tab of tabs) {
    if (isPermissionModule(tab) && !seen.has(tab)) {
      seen.add(tab);
      out.push(tab);
    }
  }
  return out.join(',');
}
