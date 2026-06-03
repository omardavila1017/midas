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
import { isRole, type Role } from '../config/roles';
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
  return isRole(user.role) ? user.role : 'none';
}

/** Hash vigente del usuario: overlay del cliente si existe, si no el del JSON. */
function currentHashFor(user: LocalUser): string {
  const overlay = readOverrides()[normalizeEmail(user.email)];
  return overlay ?? user.passwordHash;
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
  if (!user) throw new AuthApiError('invalid_credentials', 'Credenciales incorrectas.', 401);

  const incoming = await hashLocalPassword(password);
  if (incoming !== currentHashFor(user)) {
    throw new AuthApiError('invalid_credentials', 'Credenciales incorrectas.', 401);
  }

  const role = roleForUser(user);
  const session: LocalSession = { email: normalizeEmail(user.email), role, expiresAt: computeExpiry() };
  writeLocalSession(session);
  return session;
}

/** Cambia la contraseña del usuario en sesión (overlay en localStorage). */
export async function localChangePassword(currentPassword: string, newPassword: string): Promise<void> {
  const session = readLocalSession();
  if (!session) throw new AuthApiError('forbidden', 'No hay una sesión local activa.', 403);

  const user = findUser(session.email);
  if (!user) throw new AuthApiError('forbidden', 'El usuario en sesión ya no existe.', 403);

  const incoming = await hashLocalPassword(currentPassword);
  if (incoming !== currentHashFor(user)) {
    throw new AuthApiError('invalid_credentials', 'La contraseña actual no es correcta.', 401);
  }

  writeOverride(user.email, await hashLocalPassword(newPassword));
}
