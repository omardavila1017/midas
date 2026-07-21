/**
 * Cliente de la API de Usuarios/Seguridad — `WS/midas/usuarios` (backend .NET).
 *
 * El browser NUNCA habla directo con el backend: pega al proxy same-origin
 * `/api/midas/*` (default `VITE_MIDAS_BASE_URL`), que inyecta el Bearer
 * server-side. Aquí vive:
 *   - Los 5 endpoints (GET / POST / PUT / DELETE `/usuarios`, POST
 *     `/usuarios/validate`) sobre el **sobre común** de respuesta.
 *   - El mapeo de rol API ↔ interno (`Administrador`/`Usuario` ↔ `admin`/`user`).
 *   - El mapeo de permisos CSV ↔ `AppTabId[]` (ver `permissionModules.ts`).
 *   - El mapeo de códigos HTTP → `AuthApiError` (ver la tabla de errores).
 *
 * Contrato: las contraseñas viajan como HASH SHA-256 hex (calculado por el
 * caller vía `passwordHash.ts`), nunca en claro. `contrasena` es el nombre del
 * campo en el backend (sin ñ).
 */

import { apiConfig } from '../config/api.config';
import type { Role } from '../config/roles';
import type { AppTabId } from '../modules/shared-finance/components/NavigationContext';
import { parsePermissionsCsv, serializePermissionsCsv } from '../config/permissionModules';
import { AuthApiError } from './authError';

const BASE_URL = apiConfig.midas.baseUrl.replace(/\/+$/, '');

/** Rol tal como lo maneja el backend. */
export type UsuarioRolApi = 'Administrador' | 'Usuario';

/** Registro de usuario del backend (`UsuarioApi`). */
export interface UsuarioApi {
  usuario: string;
  contrasena: string;
  rol: string;
  permisos: string | null;
  b_Activo: boolean;
}

/** Identidad devuelta por `POST /usuarios/validate` (sin contraseña). */
export interface ValidatedUsuario {
  usuario: string;
  role: Role;
  permissions: AppTabId[];
  activo: boolean;
}

// ── Mapeos rol / permisos ─────────────────────────────────────────────────────

/** Interno (`admin`/`user`) → API (`Administrador`/`Usuario`). */
export function roleToApi(role: 'admin' | 'user'): UsuarioRolApi {
  return role === 'admin' ? 'Administrador' : 'Usuario';
}

/** API (`Administrador`/`Usuario`) → interno. Desconocido/vacío → `none`. */
export function roleFromApi(rol: unknown): Role {
  if (rol === 'Administrador') return 'admin';
  if (rol === 'Usuario') return 'user';
  return 'none';
}

// ── Sobre de respuesta + errores ──────────────────────────────────────────────

interface Envelope {
  status?: number;
  success?: boolean;
  message?: string;
  date?: string;
  data?: unknown;
}

function messageFrom(envelope: Envelope | null, fallback: string): string {
  const msg = envelope?.message;
  return typeof msg === 'string' && msg.trim() ? msg.trim() : fallback;
}

/**
 * Mapeo de códigos HTTP → `AuthApiError`. Alineado con la tabla de errores del
 * contrato: 401 credenciales/inactivo · 404 no existe · 406 duplicado ·
 * 400/422 validación · resto → unknown.
 */
function errorForStatus(status: number, envelope: Envelope | null): AuthApiError {
  if (status === 401) {
    return new AuthApiError('invalid_credentials', 'Correo o contraseña incorrectos.', status);
  }
  if (status === 404) {
    return new AuthApiError('not_found', messageFrom(envelope, 'El usuario no existe.'), status);
  }
  if (status === 406) {
    return new AuthApiError('duplicate', messageFrom(envelope, 'Ese usuario ya existe (duplicado).'), status);
  }
  if (status === 400 || status === 422) {
    return new AuthApiError('validation', messageFrom(envelope, 'Los datos no son válidos.'), status);
  }
  return new AuthApiError('unknown', messageFrom(envelope, 'No se pudo completar la solicitud.'), status);
}

async function parseEnvelope(res: Response): Promise<Envelope | null> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;
  try {
    const payload = await res.json();
    return payload && typeof payload === 'object' ? (payload as Envelope) : null;
  } catch {
    return null;
  }
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new AuthApiError('network', 'No se pudo conectar con el servicio de usuarios.', 0);
  }

  const envelope = await parseEnvelope(res);
  if (!res.ok) {
    throw errorForStatus(res.status, envelope);
  }
  return envelope?.data ?? null;
}

// ── Normalización de registros ────────────────────────────────────────────────

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toUsuarioApi(raw: unknown): UsuarioApi | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const usuario = typeof r.usuario === 'string' ? normalizeEmail(r.usuario) : '';
  if (!usuario) return null;
  return {
    usuario,
    contrasena: typeof r.contrasena === 'string' ? r.contrasena : '',
    rol: typeof r.rol === 'string' ? r.rol : '',
    permisos: typeof r.permisos === 'string' ? r.permisos : null,
    // Tolera `b_Activo`/`bActivo`/`activo`; ausente → activo (true).
    b_Activo: r.b_Activo === false || r.bActivo === false || r.activo === false ? false : true,
  };
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

/** `GET /usuarios[?usuario=]` — listado (o filtrado por correo). */
export async function listUsuarios(filterEmail?: string): Promise<UsuarioApi[]> {
  const query = filterEmail ? `?usuario=${encodeURIComponent(normalizeEmail(filterEmail))}` : '';
  const data = await request(`/usuarios${query}`);
  const list = Array.isArray(data) ? data : data ? [data] : [];
  return list.map(toUsuarioApi).filter((u): u is UsuarioApi => u !== null);
}

/** `GET /usuarios?usuario=` — un solo registro (o `null` si no existe). */
export async function getUsuario(email: string): Promise<UsuarioApi | null> {
  const target = normalizeEmail(email);
  const list = await listUsuarios(target);
  return list.find((u) => u.usuario === target) ?? list[0] ?? null;
}

export interface CreateUsuarioInput {
  usuario: string;
  /** Hash SHA-256 hex de la contraseña inicial. */
  contrasena: string;
  role: 'admin' | 'user';
  permissions?: AppTabId[];
}

/** `POST /usuarios` — alta. 406 = duplicado. */
export async function createUsuario(input: CreateUsuarioInput): Promise<UsuarioApi> {
  const body: UsuarioApi = {
    usuario: normalizeEmail(input.usuario),
    contrasena: input.contrasena,
    rol: roleToApi(input.role),
    permisos: input.role === 'admin' ? null : serializePermissionsCsv(input.permissions ?? []),
    b_Activo: true,
  };
  const data = await request('/usuarios', { method: 'POST', body: JSON.stringify(body) });
  return toUsuarioApi(data) ?? body;
}

/**
 * `PUT /usuarios` — modifica columnas. Recibe el registro COMPLETO. Para no
 * cambiar la contraseña, pasa el `contrasena` (hash) ya almacenado que devuelve
 * `getUsuario`; para cambiarla, pasa el hash nuevo.
 */
export async function updateUsuario(record: UsuarioApi): Promise<UsuarioApi> {
  const body: UsuarioApi = {
    usuario: normalizeEmail(record.usuario),
    contrasena: record.contrasena,
    rol: record.rol,
    permisos: record.permisos,
    b_Activo: record.b_Activo,
  };
  const data = await request('/usuarios', { method: 'PUT', body: JSON.stringify(body) });
  return toUsuarioApi(data) ?? body;
}

/** `DELETE /usuarios/{usuario}` — baja. 404 si no existe. */
export async function deleteUsuario(email: string): Promise<void> {
  await request(`/usuarios/${encodeURIComponent(normalizeEmail(email))}`, { method: 'DELETE' });
}

/**
 * `POST /usuarios/validate` — login / validación de credenciales. `contrasena`
 * es el hash SHA-256 hex. Credenciales inválidas o usuario inactivo → 401.
 */
export async function validateUsuario(email: string, contrasenaHash: string): Promise<ValidatedUsuario> {
  const data = await request('/usuarios/validate', {
    method: 'POST',
    body: JSON.stringify({ usuario: normalizeEmail(email), contrasena: contrasenaHash }),
  });
  const record = (data ?? {}) as Record<string, unknown>;
  const role = roleFromApi(record.rol);
  return {
    usuario: typeof record.usuario === 'string' ? normalizeEmail(record.usuario) : normalizeEmail(email),
    role,
    permissions: role === 'admin' ? [] : parsePermissionsCsv(typeof record.permisos === 'string' ? record.permisos : null),
    activo: record.b_Activo === false ? false : true,
  };
}
