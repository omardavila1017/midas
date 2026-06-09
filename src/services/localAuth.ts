/**
 * Auth LOCAL (dev/interno) — login contra un JSON de usuarios embebido.
 *
 * ⚠️ NO ES UNA FRONTERA DE SEGURIDAD. Todo lo que viaja al navegador es público:
 * la lista de usuarios y este código son legibles por cualquiera con acceso al
 * sitio. Las contraseñas no se guardan en texto plano (se guarda el SHA-256 de
 * `${salt}:${password}`), pero eso es ofuscación, no cifrado: sirve para no
 * dejar `12345` a la vista, no para resistir a un atacante. El backend real
 * `/api/auth/*` sigue siendo el camino correcto para producción.
 *
 * Se activa con `enabled: true` en `src/config/authLocalUsers.json`. Cuando está
 * activo, `authApi.ts` delega aquí en vez de pegarle al backend. La sesión vive
 * en `localStorage` (no hay cookie HttpOnly de backend) con un TTL configurable.
 */

import rawConfig from '../config/authLocalUsers.json';
import { coerceRole, isRole, type Role } from '../config/roles';
import { AuthApiError } from './authError';

interface LocalUser {
  email: string;
  role: string;
  passwordHash: string;
}

interface LocalAuthConfig {
  enabled: boolean;
  salt: string;
  sessionTtlHours: number;
  users: LocalUser[];
}

const config = rawConfig as unknown as LocalAuthConfig;

/** Sesión local persistida (sustituye a la cookie HttpOnly del backend). */
export const LOCAL_SESSION_KEY = 'midas.auth.localSession.v1';
/** Overlay de contraseñas cambiadas en el cliente (email → hash). */
export const LOCAL_OVERRIDES_KEY = 'midas.auth.localOverrides.v1';

export interface LocalSession {
  email: string;
  role: Role;
  expiresAt: string;
}

// Override de habilitación SOLO para tests (permite ejercitar el path de backend
// sin que el modo local lo intercepte). `null` = usar el flag del JSON.
let enabledOverride: boolean | null = null;
export function __setLocalAuthEnabledForTests(value: boolean | null): void {
  enabledOverride = value;
}

export function isLocalAuthEnabled(): boolean {
  if (enabledOverride !== null) return enabledOverride;
  return config.enabled === true;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function localStorageSafe(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Hash de la contraseña con el salt del JSON. Útil para generar entradas. */
export async function hashLocalPassword(password: string): Promise<string> {
  return sha256Hex(`${config.salt}:${password}`);
}

function readOverrides(): Record<string, string> {
  try {
    const raw = localStorageSafe()?.getItem(LOCAL_OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeOverride(email: string, hash: string): void {
  try {
    const overrides = readOverrides();
    overrides[normalizeEmail(email)] = hash;
    localStorageSafe()?.setItem(LOCAL_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    // Sin storage el cambio simplemente no persiste — no es crítico en dev.
  }
}

function findUser(email: string): LocalUser | undefined {
  const target = normalizeEmail(email);
  return config.users.find((u) => normalizeEmail(u.email) === target);
}

function roleForUser(user: LocalUser): Role {
  // El JSON puede traer roles granulares legacy (`cobranza`, `fiscal`, …);
  // `coerceRole` los colapsa al modelo admin/user.
  return coerceRole(user.role);
}

/**
 * Rol del usuario tal como vive en el JSON local (coaccionado a admin/user), o
 * `null` si el correo NO está en el JSON. Los usuarios dados de alta por un
 * admin (registro en `accessControlStore`) no están aquí — su rol lo resuelve
 * el registro, no este archivo.
 */
export function getLocalUserRole(email: string): Role | null {
  const user = findUser(email);
  return user ? roleForUser(user) : null;
}

/**
 * Lista cruda de usuarios del JSON local (correo + rol tal cual viene en el
 * archivo, que puede ser granular legacy). Solo para SEMBRAR el registro de
 * usuarios/permisos cuando el modo local está activo. Vacío si está deshabilitado.
 */
export function listLocalUsers(): { email: string; role: string }[] {
  if (!isLocalAuthEnabled()) return [];
  return config.users.map((u) => ({ email: normalizeEmail(u.email), role: u.role }));
}

/**
 * Hash de contraseña vigente para un correo: overlay del cliente (contraseña
 * cambiada / definida en el primer ingreso / fijada por un admin) si existe; si
 * no, el del JSON. `null` si el usuario no está en el JSON y no tiene overlay
 * (p.ej. un usuario registrado por un admin que aún no define su contraseña).
 */
function currentHashForEmail(email: string): string | null {
  const overlay = readOverrides()[normalizeEmail(email)];
  if (overlay) return overlay;
  return findUser(email)?.passwordHash ?? null;
}

/**
 * ¿El correo tiene una contraseña local definida? `true` para usuarios del JSON
 * (traen hash semilla) o para cualquier correo con overlay. `false` para un
 * usuario registrado por un admin que todavía no completa su primer ingreso.
 */
export function hasLocalPassword(email: string): boolean {
  return currentHashForEmail(email) !== null;
}

/** Compara una contraseña en claro contra el hash vigente del correo. */
export async function verifyLocalPassword(email: string, password: string): Promise<boolean> {
  const expected = currentHashForEmail(email);
  if (!expected) return false;
  return (await hashLocalPassword(password)) === expected;
}

/**
 * Fija la contraseña de un correo (overlay en `localStorage`). Sirve para tres
 * caminos: el usuario cambia la suya, un admin la fija, o un usuario registrado
 * la define en su primer ingreso. No exige que el correo esté en el JSON.
 */
export async function setLocalPassword(email: string, newPassword: string): Promise<void> {
  writeOverride(email, await hashLocalPassword(newPassword));
}

function computeExpiry(): string {
  const hours = Number.isFinite(config.sessionTtlHours) && config.sessionTtlHours > 0
    ? config.sessionTtlHours
    : 12;
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

export function readLocalSession(): LocalSession | null {
  try {
    const raw = localStorageSafe()?.getItem(LOCAL_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalSession>;
    if (!parsed || typeof parsed.email !== 'string' || !isRole(parsed.role)) return null;
    if (typeof parsed.expiresAt === 'string' && Date.parse(parsed.expiresAt) <= Date.now()) {
      clearLocalSession();
      return null;
    }
    return { email: parsed.email, role: parsed.role, expiresAt: parsed.expiresAt ?? computeExpiry() };
  } catch {
    return null;
  }
}

function writeLocalSession(session: LocalSession): void {
  try {
    localStorageSafe()?.setItem(LOCAL_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Sin storage la sesión no sobrevive a un reload — login sigue funcionando.
  }
}

/** Abre (persiste) una sesión local para un correo + rol ya resueltos. */
export function openLocalSession(email: string, role: Role): LocalSession {
  const session: LocalSession = { email: normalizeEmail(email), role, expiresAt: computeExpiry() };
  writeLocalSession(session);
  return session;
}

export function clearLocalSession(): void {
  try {
    localStorageSafe()?.removeItem(LOCAL_SESSION_KEY);
  } catch {
    // Ignorar.
  }
}

/**
 * Valida credenciales contra el JSON local y abre sesión. Lanza `AuthApiError`
 * con códigos equivalentes a los del backend para que la UI los muestre igual.
 */
export async function localLogin(email: string, password: string): Promise<LocalSession> {
  const user = findUser(email);
  // Mismo mensaje para usuario inexistente o contraseña incorrecta (no revelar
  // si el correo existe). En dev igual es público, pero mantenemos el contrato.
  // Nota: este path es JSON-only; el login que también admite usuarios
  // registrados por un admin (sin entrada en el JSON) vive en `authApi.login`.
  if (!user) throw new AuthApiError('invalid_credentials', 'Credenciales incorrectas.', 401);

  if (!(await verifyLocalPassword(email, password))) {
    throw new AuthApiError('invalid_credentials', 'Credenciales incorrectas.', 401);
  }

  return openLocalSession(user.email, roleForUser(user));
}

/** Cambia la contraseña del usuario en sesión (overlay en localStorage). */
export async function localChangePassword(currentPassword: string, newPassword: string): Promise<void> {
  const session = readLocalSession();
  if (!session) throw new AuthApiError('forbidden', 'No hay una sesión local activa.', 403);

  if (!(await verifyLocalPassword(session.email, currentPassword))) {
    throw new AuthApiError('invalid_credentials', 'La contraseña actual no es correcta.', 401);
  }

  await setLocalPassword(session.email, newPassword);
}
