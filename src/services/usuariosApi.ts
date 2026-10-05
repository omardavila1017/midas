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

/**
 * Resultado de leer el cuerpo de la respuesta. Son TRES casos, no dos, y la
 * distinción es lo que impide que un fallo pase por éxito:
 *
 *   • `json`     — el sobre .NET. Único caso del que se puede leer `data`.
 *   • `empty`    — 204, cuerpo vacío o un primitivo JSON. El servicio contestó
 *                  en su propio lenguaje sin datos que devolver (una baja).
 *   • `non-json` — HAY cuerpo y NO es JSON. El servicio NO contestó: es el
 *                  fallback SPA de un host estático sin la ruta `/api/midas`
 *                  (HTTP 200 + `index.html`), el MISMO modo de falla que ya
 *                  costó un diagnóstico equivocado en `/api/openai`.
 *
 * Se juzga por el CONTENIDO, no por el `content-type`: un backend que mande
 * `text/json` sigue siendo válido, y el HTML no parsea en ningún caso.
 */
type EnvelopeResult =
  | { kind: 'json'; envelope: Envelope }
  | { kind: 'empty' }
  | { kind: 'non-json' };

async function parseEnvelope(res: Response): Promise<EnvelopeResult> {
  if (res.status === 204) return { kind: 'empty' };
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { kind: 'non-json' };
  }
  if (!text.trim()) return { kind: 'empty' };
  try {
    const payload: unknown = JSON.parse(text);
    // Un primitivo (`true`, `"ok"`) no es el sobre pero sí es una respuesta del
    // servicio: se trata como `empty` para no romper una baja que conteste así.
    if (payload && typeof payload === 'object') return { kind: 'json', envelope: payload as Envelope };
    return { kind: 'empty' };
  } catch {
    return { kind: 'non-json' };
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

  const parsed = await parseEnvelope(res);
  const envelope = parsed.kind === 'json' ? parsed.envelope : null;
  if (!res.ok) {
    throw errorForStatus(res.status, envelope);
  }
  // Un 2xx cuyo cuerpo NO es JSON no es una respuesta de este servicio. Sin
  // esto `request` devolvía `null` y los writes lo leían como éxito:
  // `createUsuario`/`updateUsuario` hacen `toUsuarioApi(null) ?? body` y
  // `deleteUsuario` ignora el resultado — o sea que un alta, una baja, un
  // cambio de rol/permisos o una contraseña fijada por un admin se reportaban
  // APLICADOS sin haber salido del navegador. Es el hermano por la otra puerta
  // del `success:false` de abajo: mismo modo de falla, distinta forma del
  // cuerpo.
  if (parsed.kind === 'non-json') {
    throw new AuthApiError(
      'network',
      'El servicio de usuarios respondió algo que no es su contrato (revisa que la ruta /api/midas esté desplegada).',
      res.status,
    );
  }
  // El sobre puede reportar fallo lógico con HTTP 2xx (`success:false`) — no
  // tratarlo como éxito (p.ej. un PUT rechazado se leería como aplicado).
  if (envelope?.success === false) {
    const status = typeof envelope.status === 'number' ? envelope.status : res.status;
    throw errorForStatus(status, envelope);
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
  // SOLO match exacto (ambos lados ya normalizados). Sin fallback a `list[0]`:
  // si el backend filtrara laxo, regresar otro registro haría que los writes
  // GET→PUT (changePassword/adminSetPassword/permisos) mutaran la cuenta equivocada.
  return list.find((u) => u.usuario === target) ?? null;
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
