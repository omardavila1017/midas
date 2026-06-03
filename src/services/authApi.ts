import { isRole, type Role } from '../config/roles';

export type AuthErrorCode =
  | 'invalid_credentials'
  | 'forbidden'
  | 'password_expired'
  | 'rate_limited'
  | 'invalid_token'
  | 'network'
  | 'unknown';

export class AuthApiError extends Error {
  code: AuthErrorCode;
  status: number;

  constructor(code: AuthErrorCode, message: string, status: number = 0) {
    super(message);
    this.name = 'AuthApiError';
    this.code = code;
    this.status = status;
  }
}

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

const AUTH_BASE_URL = '/api/auth';

function normalizeEmail(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function normalizeRole(value: unknown): Role {
  return isRole(value) ? value : 'none';
}

function errorForStatus(status: number): AuthApiError {
  if (status === 401) return new AuthApiError('invalid_credentials', 'Credenciales incorrectas.', status);
  if (status === 403) return new AuthApiError('forbidden', 'Tu cuenta no tiene acceso a Midas.', status);
  if (status === 423) return new AuthApiError('password_expired', 'Debes cambiar tu contraseña para continuar.', status);
  if (status === 429) return new AuthApiError('rate_limited', 'Demasiados intentos. Intenta de nuevo más tarde.', status);
  return new AuthApiError('unknown', 'No se pudo completar la solicitud.', status);
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
    throw errorForStatus(res.status);
  }

  return parseJson(res);
}

export async function getAuthSession(): Promise<AuthSessionResponse> {
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
  await request('/logout', { method: 'POST' });
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request('/password/change', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function requestPasswordReset(email: string): Promise<void> {
  await request('/password/reset/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function completePasswordReset(token: string, newPassword: string): Promise<void> {
  await request('/password/reset/complete', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  });
}

export async function sendUserPasswordReset(email: string): Promise<void> {
  await request(`/users/${encodeURIComponent(email)}/password-reset`, { method: 'POST' });
}
