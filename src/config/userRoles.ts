/**
 * RBAC — parser del mapeo correo → rol.
 *
 * El mapeo NO vive en código (cambia con la organización y es sensible). Vive
 * en `.env` como `VITE_USER_ROLES`, en formato CSV `email:rol` separado por
 * comas, p.ej.:
 *
 *   VITE_USER_ROLES="ana@ej.com:admin,beto@ej.com:cobranza"
 *
 * `import.meta.env` embebe los `VITE_*` en el bundle del navegador, así que
 * `.env` queda fuera del repo (ya en `.gitignore`) para no filtrar correos a
 * git — NO para ocultarlos al cliente. La autorización vinculante sigue siendo
 * del backend (ver `AUTH.md`).
 *
 * Si el correo logueado no está en la lista → `VITE_DEFAULT_ROLE` (o `'none'`).
 */

import { isRole, type Role } from './roles';

/** Rol por defecto seguro cuando no hay configuración. */
const FALLBACK_ROLE: Role = 'none';

/** Normaliza un correo para comparación: trim + lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Parsea el CSV `email:rol` en un `Map<emailNormalizado, Role>`.
 * Tolerante: ignora entradas vacías o mal formadas; los roles desconocidos se
 * descartan con `console.warn` (nunca truena la app).
 */
export function parseUserRoles(raw: string | undefined | null): Map<string, Role> {
  const map = new Map<string, Role>();
  if (!raw) return map;

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // Solo el primer ':' separa email de rol — el rol nunca lleva ':'.
    const sep = trimmed.indexOf(':');
    if (sep === -1) {
      console.warn(`[userRoles] entrada sin ':' ignorada: "${trimmed}"`);
      continue;
    }

    const email = normalizeEmail(trimmed.slice(0, sep));
    const role = trimmed.slice(sep + 1).trim();

    if (!email) {
      console.warn(`[userRoles] entrada con correo vacío ignorada: "${trimmed}"`);
      continue;
    }
    if (!isRole(role)) {
      console.warn(`[userRoles] rol desconocido "${role}" para "${email}" — ignorado.`);
      continue;
    }

    map.set(email, role);
  }

  return map;
}

/** Resuelve el rol por defecto desde `VITE_DEFAULT_ROLE`, validándolo. */
export function resolveDefaultRole(raw: string | undefined | null): Role {
  if (!raw) return FALLBACK_ROLE;
  const trimmed = raw.trim();
  if (isRole(trimmed)) return trimmed;
  console.warn(`[userRoles] VITE_DEFAULT_ROLE "${raw}" inválido — se usa "${FALLBACK_ROLE}".`);
  return FALLBACK_ROLE;
}

/** Mapa correo → rol leído UNA vez del entorno (cacheado a nivel módulo). */
let cachedMap: Map<string, Role> | null = null;
let cachedDefault: Role | null = null;

function getMap(): Map<string, Role> {
  if (cachedMap === null) {
    cachedMap = parseUserRoles(import.meta.env.VITE_USER_ROLES);
  }
  return cachedMap;
}

function getDefaultRole(): Role {
  if (cachedDefault === null) {
    cachedDefault = resolveDefaultRole(import.meta.env.VITE_DEFAULT_ROLE);
  }
  return cachedDefault;
}

/**
 * Rol del correo dado. Si no está en `VITE_USER_ROLES`, regresa el rol por
 * defecto (`VITE_DEFAULT_ROLE` o `'none'`). `null`/vacío → default.
 */
export function getRoleForEmail(email: string | null | undefined): Role {
  if (!email) return getDefaultRole();
  return getMap().get(normalizeEmail(email)) ?? getDefaultRole();
}

/** Lista de `{ email, role }` configurados (para el módulo de usuarios). */
export function listConfiguredUsers(): { email: string; role: Role }[] {
  return Array.from(getMap().entries())
    .map(([email, role]) => ({ email, role }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/** Solo para tests: limpia la cache de módulo. */
export function __resetUserRolesCache(): void {
  cachedMap = null;
  cachedDefault = null;
}
