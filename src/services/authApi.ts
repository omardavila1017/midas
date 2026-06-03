import { apiConfig } from '../config/api.config';
import { isRole, type Role } from '../config/roles';
import { AuthApiError, type AuthErrorCode } from './authError';
import {
  clearLocalSession,
  isLocalAuthEnabled,
  localChangePassword,
  localLogin,
  readLocalSession,
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
  return isRole(value) ? value : 'none';
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

export async function login(email: string, password: string): Promise<LoginResponse> {
  if (isLocalAuthEnabled()) {
    const session = await localLogin(email, password);
    return { email: session.email, role: session.role, expiresAt: session.expiresAt, passwordExpired: false };
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

export async function sendUserPasswordReset(email: string): Promise<void> {
  if (isLocalAuthEnabled()) {
    // Sin backend de correo en modo local: no-op (el módulo de usuarios muestra
    // su toast de éxito; las contraseñas se gestionan editando el JSON).
    return;
  }
  await request(`/users/${encodeURIComponent(email)}/password-reset`, { method: 'POST' });
}
