/**
 * Marcador de sesión del modo ONLINE de usuarios (`midas.auth.session.v2`).
 *
 * El backend `WS/midas` NO expone endpoint de sesión (solo `POST
 * /usuarios/validate`). Tras un login exitoso guardamos aquí un marcador en
 * `localStorage` con la IDENTIDAD y su expiración — es lo ÚNICO que vive en el
 * navegador:
 *
 *   { email, role, permissions[], expiresAt }
 *
 * NUNCA guarda la contraseña, el hash, el token ni el listado de usuarios. El
 * TTL (default 12 h, `VITE_MIDAS_SESSION_TTL_HOURS`) acota su vigencia; al leerlo
 * expirado se borra solo. NO es una frontera de seguridad (localStorage es
 * legible/editable por el cliente): la autorización vinculante la hace el backend.
 */

import type { Role } from '../config/roles';
import { isRole } from '../config/roles';
import type { AppTabId } from '../modules/shared-finance/components/NavigationContext';
import { midasSessionTtlHours } from '../config/midasUsers';
import { parsePermissionsCsv, serializePermissionsCsv } from '../config/permissionModules';

/** Clave del marcador. Registrada en `storageRegistry.ts`. */
export const MIDAS_SESSION_KEY = 'midas.auth.session.v2';

export interface MidasSessionMarker {
  email: string;
  role: Role;
  permissions: AppTabId[];
  expiresAt: string;
}

function store(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function computeExpiry(): string {
  return new Date(Date.now() + midasSessionTtlHours() * 60 * 60 * 1000).toISOString();
}

/** Abre (persiste) un marcador de sesión para una identidad ya validada. */
export function writeMidasSession(
  email: string,
  role: Role,
  permissions: AppTabId[],
): MidasSessionMarker {
  // Sanea los permisos vía el vocabulario del contrato (descarta tokens inválidos).
  const clean = parsePermissionsCsv(serializePermissionsCsv(permissions));
  const marker: MidasSessionMarker = {
    email: normalizeEmail(email),
    role,
    permissions: clean,
    expiresAt: computeExpiry(),
  };
  try {
    store()?.setItem(MIDAS_SESSION_KEY, JSON.stringify(marker));
  } catch {
    // Sin storage el marcador no sobrevive a un reload — el login sigue funcionando.
  }
  return marker;
}

/** Lee el marcador vigente, o `null` si no existe / está expirado / corrupto. */
export function readMidasSession(): MidasSessionMarker | null {
  let raw: string | null;
  try {
    raw = store()?.getItem(MIDAS_SESSION_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MidasSessionMarker>;
    if (!parsed || typeof parsed.email !== 'string' || !isRole(parsed.role)) return null;
    if (typeof parsed.expiresAt !== 'string' || Date.parse(parsed.expiresAt) <= Date.now()) {
      clearMidasSession();
      return null;
    }
    return {
      email: normalizeEmail(parsed.email),
      role: parsed.role,
      permissions: Array.isArray(parsed.permissions)
        ? parsePermissionsCsv(parsed.permissions.join(','))
        : [],
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export function clearMidasSession(): void {
  try {
    store()?.removeItem(MIDAS_SESSION_KEY);
  } catch {
    // Ignorar.
  }
}
