/**
 * Servicio del módulo de Usuarios.
 *
 * El registro de usuarios y sus permisos vive en `accessControlStore.ts`. Aquí
 * solo quedan helpers transversales del módulo (gestión de contraseñas). Las
 * etiquetas de tabs viven en `src/config/appTabs.ts` (`APP_TAB_LABELS`).
 */

import type { Role } from '../../../config/roles';

/**
 * ¿Puede este rol enviar ligas de restablecimiento de contraseña? Tras el
 * rediseño solo el admin gestiona contraseñas de otros usuarios.
 */
export function canManagePasswordReset(role: Role): boolean {
  return role === 'admin';
}
