/**
 * authSession — sesión de identidad del usuario (login de UX).
 *
 * IMPORTANTE (ver `AUTH.md`): el frontend NO es una frontera de seguridad. La
 * autenticación vinculante la hace Atlas SSO / el backend en `/api/*`. Esta
 * "sesión" solo recuerda QUIÉN dijo ser el usuario para resolver su rol de UI
 * (RBAC declarativo, ver `config/roles.ts`) y personalizar la experiencia. No
 * guarda token ni secreto alguno — es una preferencia, no una credencial.
 *
 * Precedencia de la identidad:
 *   1. Sesión guardada en localStorage (lo que el usuario tecleó en el login).
 *   2. `VITE_CURRENT_USER_EMAIL` — identidad inyectada por el entorno
 *      (Atlas/prod o el puente de desarrollo). Si existe, el usuario ya viene
 *      autenticado por el entorno y la pantalla de login NO se muestra.
 *
 * Helpers puros para que tanto `components/Login.tsx` (gate + pantalla) como
 * `contexts/AuthContext.tsx` (identidad + `can()`) lean/escriban la MISMA key.
 */

/** Registrada en `domain/storageRegistry.ts`. Si la cambias, actualízala ahí. */
export const AUTH_SESSION_KEY = 'midas.auth.session.v1';

export interface AuthSession {
  /** Correo con el que el usuario inició sesión (normalizado a minúsculas). */
  email: string;
  /** Marca de tiempo ISO del login. */
  signedInAt: string;
}

/** Email inyectado por el entorno (Atlas/prod o dev bridge), o `null`. */
function readEnvEmail(): string | null {
  const raw = import.meta.env.VITE_CURRENT_USER_EMAIL;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** Sesión guardada, o `null` si no hay / está corrupta / storage no disponible. */
export function readAuthSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    if (parsed && typeof parsed.email === 'string' && parsed.email.trim()) {
      return {
        email: parsed.email.trim().toLowerCase(),
        signedInAt:
          typeof parsed.signedInAt === 'string' ? parsed.signedInAt : new Date().toISOString(),
      };
    }
  } catch {
    // Storage corrupto / bloqueado → sin sesión (degradamos a login).
  }
  return null;
}

/** Persiste la sesión. Tolerante a storage lleno/bloqueado (no truena). */
export function writeAuthSession(email: string): AuthSession {
  const session: AuthSession = {
    email: email.trim().toLowerCase(),
    signedInAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
  } catch {
    // El storage puede estar lleno/bloqueado; la identidad sigue en memoria.
  }
  return session;
}

/** Borra la sesión guardada (logout / reset). */
export function clearAuthSession(): void {
  try {
    localStorage.removeItem(AUTH_SESSION_KEY);
  } catch {
    // Ignorar — nada que limpiar si el storage no está disponible.
  }
}

/** Correo resuelto: sesión guardada primero, luego el email del entorno. */
export function resolveSessionEmail(): string | null {
  return readAuthSession()?.email ?? readEnvEmail();
}

/**
 * ¿Mostrar la pantalla de login? Solo cuando no hay identidad alguna: ni
 * sesión guardada ni email inyectado por el entorno. Si Atlas/prod inyecta
 * `VITE_CURRENT_USER_EMAIL`, el usuario ya viene autenticado y no se le pide
 * login otra vez ("primero login, después carga" aplica al caso sin entorno).
 */
export function needsLogin(): boolean {
  return resolveSessionEmail() === null;
}
