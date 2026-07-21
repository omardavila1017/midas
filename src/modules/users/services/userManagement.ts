/**
 * Adaptador de administración de usuarios para el modo ONLINE (WS/midas).
 *
 * Los tableros de **Usuarios** y **Permisos** usan estos helpers cuando el modo
 * online está activo (`isMidasUsersEnabled()`), de modo que el alta/baja/edición
 * y los switches de permisos le peguen a la API real (`usuariosApi`) en vez del
 * registro local (`accessControlStore`). Traduce entre el shape interno de la UI
 * (`ManagedUser`) y el contrato del backend (`UsuarioApi` + permisos CSV).
 *
 * En modo local (kill-switch off) los tableros NO usan este módulo — siguen con
 * el registro sincrónico de `accessControlStore`.
 */

import type { AppTabId } from '../../shared-finance/components/NavigationContext';
import { parsePermissionsCsv, serializePermissionsCsv } from '../../../config/permissionModules';
import { hashPassword } from '../../../services/passwordHash';
import { AuthApiError } from '../../../services/authError';
import {
  createUsuario,
  deleteUsuario,
  getUsuario,
  listUsuarios,
  roleFromApi,
  roleToApi,
  updateUsuario,
  type UsuarioApi,
} from '../../../services/usuariosApi';
import type { ManagedRole, ManagedUser } from './accessControlStore';

/**
 * Contraseña inicial de la migración. Un usuario nuevo se da de alta con este
 * hash y la define/cambia después (o un admin se la fija). Ver documentación.
 */
const INITIAL_PASSWORD = 'Senda123';

function toManagedUser(record: UsuarioApi): ManagedUser {
  const role: ManagedRole = roleFromApi(record.rol) === 'admin' ? 'admin' : 'user';
  return {
    email: record.usuario,
    role,
    permissions: role === 'admin' ? [] : parsePermissionsCsv(record.permisos),
  };
}

async function requireRecord(email: string): Promise<UsuarioApi> {
  const record = await getUsuario(email);
  if (!record) throw new AuthApiError('not_found', 'El usuario no existe.', 404);
  return record;
}

/** Listado de admin (`GET /usuarios`), ordenado por correo. */
export async function fetchManagedUsers(): Promise<ManagedUser[]> {
  const list = await listUsuarios();
  return list.map(toManagedUser).sort((a, b) => a.email.localeCompare(b.email));
}

/** Alta de usuario con contraseña inicial (`POST /usuarios`). 406 = duplicado. */
export async function createManagedUser(email: string, role: ManagedRole): Promise<void> {
  await createUsuario({
    usuario: email,
    contrasena: await hashPassword(INITIAL_PASSWORD),
    role,
    permissions: [],
  });
}

/** Baja de usuario (`DELETE /usuarios/{usuario}`). */
export async function removeManagedUser(email: string): Promise<void> {
  await deleteUsuario(email);
}

/** Cambio de rol (`PUT /usuarios`). Al promover a admin se limpian los permisos. */
export async function updateManagedUserRole(email: string, role: ManagedRole): Promise<void> {
  const record = await requireRecord(email);
  await updateUsuario({
    ...record,
    rol: roleToApi(role),
    permisos: role === 'admin' ? null : record.permisos,
  });
}

/** Prende/apaga un módulo para un usuario (`PUT /usuarios` con el CSV nuevo). */
export async function setManagedUserPermission(
  email: string,
  tab: AppTabId,
  enabled: boolean,
): Promise<void> {
  const record = await requireRecord(email);
  const current = parsePermissionsCsv(record.permisos);
  const next = enabled
    ? [...current, tab]
    : current.filter((t) => t !== tab);
  await updateUsuario({ ...record, permisos: serializePermissionsCsv(next) });
}

/** Reemplaza el set completo de permisos de un usuario (`PUT /usuarios`). */
export async function setManagedUserPermissions(email: string, tabs: AppTabId[]): Promise<void> {
  const record = await requireRecord(email);
  await updateUsuario({ ...record, permisos: serializePermissionsCsv(tabs) });
}

/** Mensaje legible de un error de la API de usuarios para toasts. */
export function managementErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AuthApiError && error.message) return error.message;
  return fallback;
}
