import type { Role } from '../config/roles';
import type { AppTabId } from '../modules/shared-finance/components/NavigationContext';

export const AUTH_LAST_EMAIL_KEY = 'midas.auth.lastEmail.v1';
export const LEGACY_AUTH_SESSION_KEY = 'midas.auth.session.v1';

export interface CurrentAuthSession {
  email: string;
  role: Role;
  expiresAt?: string;
  /**
   * Módulos concedidos por la sesión. Solo poblado en el modo ONLINE
   * (WS/midas/usuarios), donde los permisos los manda la API (no el registro
   * local). En modo local queda `undefined` y el gate usa `accessControlStore`.
   */
  permissions?: AppTabId[];
}

let currentSession: CurrentAuthSession | null = null;

function localStore(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function sessionStore(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function readEnvEmail(): string | null {
  const raw = import.meta.env.VITE_CURRENT_USER_EMAIL;
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function setCurrentAuthSession(session: CurrentAuthSession | null): void {
  currentSession = session
    ? { ...session, email: normalizeEmail(session.email) }
    : null;
  if (session?.email) rememberLastEmail(session.email);
}

export function getCurrentAuthSession(): CurrentAuthSession | null {
  return currentSession;
}

export function rememberLastEmail(email: string): void {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  try {
    localStore()?.setItem(AUTH_LAST_EMAIL_KEY, normalized);
    localStore()?.removeItem(LEGACY_AUTH_SESSION_KEY);
  } catch {
    // Storage no disponible: el prefill simplemente no persiste.
  }
}

export function clearAuthSession(): void {
  currentSession = null;
  try {
    localStore()?.removeItem(LEGACY_AUTH_SESSION_KEY);
  } catch {
    // Ignorar.
  }
  try {
    sessionStore()?.removeItem(LEGACY_AUTH_SESSION_KEY);
  } catch {
    // Ignorar.
  }
}

export function getPrefillEmail(): string {
  try {
    const last = localStore()?.getItem(AUTH_LAST_EMAIL_KEY);
    if (last?.trim()) return normalizeEmail(last);
  } catch {
    // Ignorar.
  }
  return readEnvEmail() ?? '';
}
