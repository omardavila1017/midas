/**
 * authSession — sesión de identidad del usuario (login de UX).
 *
 * IMPORTANTE (ver `AUTH.md`): el frontend NO es una frontera de seguridad. La
 * autenticación vinculante la hace Atlas SSO / el backend en `/api/*`. Esta
 * "sesión" solo recuerda QUIÉN dijo ser el usuario para resolver su rol de UI
 * (RBAC declarativo, ver `config/roles.ts`) y personalizar la experiencia. No
 * guarda token ni secreto alguno — es una preferencia, no una credencial.
 *
 * Regla de acceso ("primero login, después carga"):
 *   - La pantalla de login SIEMPRE se muestra al entrar, EXCEPTO cuando ya hay
 *     una sesión iniciada en este equipo.
 *   - "Recordar este equipo" (checkbox del login) decide la durabilidad:
 *       · marcado    → la sesión se guarda en localStorage y AUTO-ENTRA en
 *                      próximas visitas (incluso tras cerrar el navegador).
 *       · sin marcar → la sesión vive solo en sessionStorage: sobrevive
 *                      recargas dentro de la misma pestaña/navegador, pero al
 *                      cerrar el navegador se pierde y se vuelve a pedir login.
 *
 * `VITE_CURRENT_USER_EMAIL` YA NO salta el login (era un puente DEV que dejaba
 * al usuario encerrado sin rol y sin poder cerrar sesión). Ahora solo se usa
 * para PRE-LLENAR el campo de correo como conveniencia.
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
  /** ¿El usuario pidió recordar este equipo? (auto-entrar en el futuro). */
  remember: boolean;
}

/** Email inyectado por el entorno (dev bridge), solo para pre-llenar el campo. */
function readEnvEmail(): string | null {
  const raw = import.meta.env.VITE_CURRENT_USER_EMAIL;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** Lee y valida una sesión cruda desde un Storage dado. */
function readFrom(store: Storage | undefined, remember: boolean): AuthSession | null {
  if (!store) return null;
  try {
    const raw = store.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    if (parsed && typeof parsed.email === 'string' && parsed.email.trim()) {
      return {
        email: parsed.email.trim().toLowerCase(),
        signedInAt:
          typeof parsed.signedInAt === 'string' ? parsed.signedInAt : new Date().toISOString(),
        remember: typeof parsed.remember === 'boolean' ? parsed.remember : remember,
      };
    }
  } catch {
    // Storage corrupto / bloqueado → sin sesión (degradamos a login).
  }
  return null;
}

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

/**
 * Sesión vigente, o `null` si no hay / está corrupta / storage no disponible.
 * Precedencia: la sesión RECORDADA (localStorage) primero, luego la de la
 * pestaña actual (sessionStorage).
 */
export function readAuthSession(): AuthSession | null {
  return readFrom(localStore(), true) ?? readFrom(sessionStore(), false);
}

/**
 * Persiste la sesión. `remember=true` la guarda en localStorage (auto-entra en
 * el futuro); `remember=false` la guarda solo en sessionStorage (vive lo que
 * dure el navegador abierto). Limpia el otro almacén para no dejar rastros.
 * Tolerante a storage lleno/bloqueado (no truena).
 */
export function writeAuthSession(email: string, remember: boolean = false): AuthSession {
  const session: AuthSession = {
    email: email.trim().toLowerCase(),
    signedInAt: new Date().toISOString(),
    remember,
  };
  const payload = JSON.stringify(session);
  const target = remember ? localStore() : sessionStore();
  const other = remember ? sessionStore() : localStore();
  try {
    target?.setItem(AUTH_SESSION_KEY, payload);
  } catch {
    // El storage puede estar lleno/bloqueado; la identidad sigue en memoria.
  }
  try {
    other?.removeItem(AUTH_SESSION_KEY);
  } catch {
    // Ignorar.
  }
  return session;
}

/** Borra la sesión guardada (logout / reset) en AMBOS almacenes. */
export function clearAuthSession(): void {
  try {
    localStore()?.removeItem(AUTH_SESSION_KEY);
  } catch {
    // Ignorar — nada que limpiar si el storage no está disponible.
  }
  try {
    sessionStore()?.removeItem(AUTH_SESSION_KEY);
  } catch {
    // Ignorar.
  }
}

/** Correo resuelto SOLO desde la sesión guardada (NO desde el entorno). */
export function resolveSessionEmail(): string | null {
  return readAuthSession()?.email ?? null;
}

/**
 * Correo para PRE-LLENAR el campo de login (conveniencia): el de la última
 * sesión si existe, o el inyectado por el entorno. Nunca salta el login.
 */
export function getPrefillEmail(): string {
  return readAuthSession()?.email ?? readEnvEmail() ?? '';
}

/**
 * ¿Mostrar la pantalla de login? Solo se salta cuando ya hay una sesión
 * iniciada en este equipo (recordada en localStorage o vigente en la pestaña).
 * Sin sesión → login ("primero login, después carga").
 */
export function needsLogin(): boolean {
  return resolveSessionEmail() === null;
}
