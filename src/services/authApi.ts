import { apiConfig } from '../config/api.config';
import { coerceRole, type Role } from '../config/roles';
import { getRegistryRole } from '../modules/users/services/accessControlStore';
import { AuthApiError, type AuthErrorCode } from './authError';
import {
  clearLocalSession,
  getLocalUserRole,
  hasLocalPassword,
  isLocalAuthEnabled,
  localChangePassword,
  openLocalSession,
  readLocalSession,
  setLocalPassword,
  verifyLocalPassword,
} from './localAuth';

// Re-export para no romper a los consumidores que importan `AuthApiError` /
// `AuthErrorCode` desde `../services/authApi` (Login.tsx, ChangePasswordModal…).
export { AuthApiError, type AuthErrorCode };

export interface AuthSessionResponse {
  authenticated: boolean;
  email: string | null;
  role: Role;
  expiresAt?: string;
}

export interface LoginResponse {
  email: string;
  role: Role;
  expiresAt?: string;
  passwordExpired?: boolean;
}

// Base del backend de auth, resuelta desde `VITE_AUTH_BASE_URL` (api.config).
// Antes estaba hardcodeada a `/api/auth`, lo que ignoraba la variable de
// entorno y dejaba el login/cambio de contraseña sin backend si el deploy
// servía auth en otra ruta/host. Normalizamos el trailing slash para no
// concatenar `//` con los paths (`/login`, `/session`, …).
const AUTH_BASE_URL = apiConfig.auth.baseUrl.replace(/\/+$/, '');

function normalizeEmail(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeRole(value: unknown): Role {
  // Colapsa roles granulares legacy del backend (`cobranza`, …) a admin/user.
  return coerceRole(value);
}

// Extrae un mensaje legible del cuerpo de error del backend (claves comunes en
// APIs REST). Permite que la razón real (p. ej. "la contraseña no cumple la
// política" o "no puedes reutilizar una contraseña anterior") llegue a la UI en
// vez de tragarla con un genérico.
function messageFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'description'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function errorForStatus(status: number, backendMessage: string | null): AuthApiError {
  if (status === 401) return new AuthApiError('invalid_credentials', 'Credenciales incorrectas.', status);
  if (status === 403) return new AuthApiError('forbidden', 'Tu cuenta no tiene acceso a Midas.', status);
  if (status === 423) return new AuthApiError('password_expired', 'Debes cambiar tu contraseña para continuar.', status);
  if (status === 429) return new AuthApiError('rate_limited', 'Demasiados intentos. Intenta de nuevo más tarde.', status);
  // 400 / 422 = la solicitud llegó pero el backend la rechazó por validación
  // (contraseña débil, reutilizada, token mal formado, etc.). Surface su motivo.
  if (status === 400 || status === 422) {
    return new AuthApiError('validation', backendMessage ?? 'Los datos enviados no son válidos.', status);
  }
  return new AuthApiError('unknown', backendMessage ?? 'No se pudo completar la solicitud.', status);
}

async function parseJson(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${AUTH_BASE_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new AuthApiError('network', 'No hay conexión con autenticación.', 0);
  }

  if (!res.ok) {
    const payload = await parseJson(res);
    const code = typeof payload === 'object' && payload && 'code' in payload ? String(payload.code) : '';
    if (code === 'invalid_token') {
      throw new AuthApiError('invalid_token', 'La liga ya expiró o no es válida.', res.status);
    }
    throw errorForStatus(res.status, messageFromPayload(payload));
  }

  return parseJson(res);
}

export async function getAuthSession(): Promise<AuthSessionResponse> {
  if (isLocalAuthEnabled()) {
    const session = readLocalSession();
    if (session) {
      return { authenticated: true, email: session.email, role: session.role, expiresAt: session.expiresAt };
    }
    return { authenticated: false, email: null, role: 'none' };
  }
  try {
    const payload = await request('/session');
    if (!payload || typeof payload !== 'object') {
      return { authenticated: false, email: null, role: 'none' };
    }
    const raw = payload as Record<string, unknown>;
    const email = normalizeEmail(raw.email);
    const role = normalizeRole(raw.role);
    return {
      authenticated: Boolean(raw.authenticated) && Boolean(email),
      email,
      role,
      expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : undefined,
    };
  } catch (error) {
    if (error instanceof AuthApiError && error.status === 401) {
      return { authenticated: false, email: null, role: 'none' };
    }
    throw error;
  }
}

// ── Modo auth LOCAL: identidad combinada JSON + registro de usuarios ──────────
// El JSON (`authLocalUsers.json`) trae usuarios semilla; el registro
// (`accessControlStore`) trae además los que da de alta un admin. Un correo es
// "conocido" si está en cualquiera de los dos. El rol efectivo lo manda el
// registro (un admin pudo promover/asignar) y, si no hay, el del JSON.

function localNormalize(email: string): string {
  return email.trim().toLowerCase();
}

function isKnownLocalUser(email: string): boolean {
  const normalized = localNormalize(email);
  return getLocalUserRole(normalized) !== null || getRegistryRole(normalized) !== null;
}

function resolveLocalRole(email: string): Role {
  const normalized = localNormalize(email);
  return getRegistryRole(normalized) ?? getLocalUserRole(normalized) ?? 'none';
}

function localLoginResponse(email: string, role: Role): LoginResponse {
  const session = openLocalSession(email, role);
  return { email: session.email, role: session.role, expiresAt: session.expiresAt, passwordExpired: false };
}

/**
 * ¿El correo necesita definir su contraseña en el primer ingreso? Solo en modo
 * local: es un usuario conocido (registrado por un admin / sembrado) que aún no
 * tiene contraseña. En modo backend siempre `false` (el backend gestiona su
 * propio primer ingreso). Síncrono: la UI lo usa para enrutar el login.
 */
export function requiresPasswordSetup(email: string): boolean {
  if (!isLocalAuthEnabled()) return false;
  const normalized = localNormalize(email);
  return isKnownLocalUser(normalized) && !hasLocalPassword(normalized);
}

/**
 * Resultado de evaluar si un correo puede "crear su cuenta" (definir contraseña
 * en un primer ingreso explícito, estilo Atlas). Permite a la UI dar un mensaje
 * preciso en vez del genérico de credenciales:
 *   - `eligible`            → pre-registrado por un admin y sin contraseña: puede
 *                             definirla ahora y quedar registrado.
 *   - `already_registered`  → ya tiene contraseña: debe iniciar sesión.
 *   - `not_pre_registered`  → un admin no lo ha dado de alta todavía.
 *   - `backend_managed`     → en modo backend el alta la gestiona el servidor.
 */
export type RegistrationEligibility =
  | 'eligible'
  | 'already_registered'
  | 'not_pre_registered'
  | 'backend_managed';

/**
 * ¿Puede este correo crear su cuenta (primer ingreso explícito)? Síncrono: la UI
 * lo usa para decidir el mensaje del formulario de "Crear cuenta". Reusa la misma
 * fuente de verdad que `requiresPasswordSetup` (registro de admin + JSON local).
 */
export function checkRegistrationEligibility(email: string): RegistrationEligibility {
  if (!isLocalAuthEnabled()) return 'backend_managed';
  const normalized = localNormalize(email);
  if (!isKnownLocalUser(normalized)) return 'not_pre_registered';
  if (hasLocalPassword(normalized)) return 'already_registered';
  return 'eligible';
}

/**
 * ¿Está disponible el auto-registro "tipo Atlas" en la UI? Solo en modo local: el
 * usuario pre-registrado por un admin define su contraseña y queda activo. En
 * modo backend el alta para iniciar sesión la hace el servidor, así que la UI
 * oculta la entrada de "Crear cuenta".
 */
export function isRegistrationAvailable(): boolean {
  return isLocalAuthEnabled();
}

/**
 * Primer ingreso "tipo register": un usuario registrado sin contraseña define la
 * suya y queda con sesión iniciada. Solo modo local (el backend lo resuelve por
 * su cuenta vía la liga de restablecimiento).
 */
export async function completeFirstLogin(email: string, newPassword: string): Promise<LoginResponse> {
  if (!isLocalAuthEnabled()) {
    throw new AuthApiError('validation', 'El primer ingreso se completa con el backend de autenticación.', 400);
  }
  const normalized = localNormalize(email);
  if (!isKnownLocalUser(normalized)) {
    throw new AuthApiError('invalid_credentials', 'Tu cuenta no está registrada. Pide a un administrador que te dé de alta.', 401);
  }
  if (hasLocalPassword(normalized)) {
    throw new AuthApiError('validation', 'Tu cuenta ya tiene contraseña. Inicia sesión normalmente.', 409);
  }
  await setLocalPassword(normalized, newPassword);
  return localLoginResponse(normalized, resolveLocalRole(normalized));
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  if (isLocalAuthEnabled()) {
    const normalized = localNormalize(email);
    if (!isKnownLocalUser(normalized)) {
      throw new AuthApiError('invalid_credentials', 'Credenciales incorrectas.', 401);
    }
    if (!hasLocalPassword(normalized)) {
      // Registrado pero sin contraseña: la UI debe mandarlo a definirla.
      throw new AuthApiError('password_setup_required', 'Define tu contraseña para activar tu cuenta.', 409);
    }
    if (!(await verifyLocalPassword(normalized, password))) {
      throw new AuthApiError('invalid_credentials', 'Credenciales incorrectas.', 401);
    }
    return localLoginResponse(normalized, resolveLocalRole(normalized));
  }
  const payload = await request('/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const raw = (payload ?? {}) as Record<string, unknown>;
  const normalizedEmail = normalizeEmail(raw.email);
  if (!normalizedEmail) throw new AuthApiError('unknown', 'La respuesta de autenticación no incluyó correo.', 500);
  return {
    email: normalizedEmail,
    role: normalizeRole(raw.role),
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : undefined,
    passwordExpired: Boolean(raw.passwordExpired),
  };
}

export async function logout(): Promise<void> {
  if (isLocalAuthEnabled()) {
    clearLocalSession();
    return;
  }
  await request('/logout', { method: 'POST' });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  if (isLocalAuthEnabled()) {
    await localChangePassword(currentPassword, newPassword);
    return;
  }
  await request('/password/change', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function requestPasswordReset(email: string): Promise<void> {
  if (isLocalAuthEnabled()) {
    // En modo local no hay envío de correo; resolvemos sin filtrar si el correo
    // existe (mismo contrato que el backend: respuesta genérica).
    return;
  }
  await request('/password/reset/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function completePasswordReset(token: string, newPassword: string): Promise<void> {
  if (isLocalAuthEnabled()) {
    throw new AuthApiError(
      'validation',
      'El restablecimiento por liga no aplica en modo local. Usa "Cambiar contraseña" dentro de la app.',
      400,
    );
  }
  await request('/password/reset/complete', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  });
}

/**
 * Un admin fija directamente la contraseña de otro usuario (sin liga de correo).
 * En modo local escribe el overlay; en backend hace POST al endpoint de admin.
 */
export async function adminSetPassword(email: string, newPassword: string): Promise<void> {
  if (isLocalAuthEnabled()) {
    await setLocalPassword(localNormalize(email), newPassword);
    return;
  }
  await request(`/users/${encodeURIComponent(email)}/password`, {
    method: 'POST',
    body: JSON.stringify({ newPassword }),
  });
}

export async function sendUserPasswordReset(email: string): Promise<void> {
  if (isLocalAuthEnabled()) {
    // Sin backend de correo en modo local: no-op (el módulo de usuarios muestra
    // su toast de éxito; las contraseñas se gestionan editando el JSON).
    return;
  }
  await request(`/users/${encodeURIComponent(email)}/password-reset`, { method: 'POST' });
}
