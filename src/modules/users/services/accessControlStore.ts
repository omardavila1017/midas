/**
 * accessControlStore — registro de usuarios + permisos por usuario (capa UX).
 *
 * Reemplaza el modelo de roles granulares por: dos roles (`admin` / `user`) y,
 * para `user`, un set de tabs habilitados por un admin con switches (módulo de
 * Permisos). `admin` ve todo. Los tabs admin-only (`users`, `permisos`) NUNCA
 * son habilitables por permiso — solo `admin` los ve.
 *
 * ⚠️ NO es una frontera de seguridad (ver `AUTH.md`): vive en `localStorage`,
 * legible/editable por el cliente. La autorización vinculante la hace el
 * backend. Esto solo decide qué módulos MOSTRAR.
 *
 * Persistencia: `midas.users.registry.v1` (registrada en `storageRegistry.ts`).
 * Se SIEMBRA una vez desde la fuente de auth conocida (JSON local o
 * `VITE_USER_ROLES`), mapeando el rol granular previo a permisos por defecto
 * (`LEGACY_ROLE_TABS`) para que nadie pierda acceso al migrar.
 */

import type { AppTabId } from '../../shared-finance/components/NavigationContext';
import { coerceRole, LEGACY_ROLE_TABS, type Role } from '../../../config/roles';
import { GRANTABLE_TABS, isAdminOnlyTab } from '../../../config/appTabs';
import { listLocalUsers } from '../../../services/localAuth';
import { listConfiguredUsers } from '../../../config/userRoles';

export const ACCESS_REGISTRY_KEY = 'midas.users.registry.v1';
const ACCESS_CHANGED_EVENT = 'midas:access-changed';

/** Rol del registro: nunca `none` (un usuario registrado es admin o user). */
export type ManagedRole = Exclude<Role, 'none'>;

export interface ManagedUser {
  email: string;
  role: ManagedRole;
  /** Tabs habilitados (solo relevante para `user`; `admin` ve todo). */
  permissions: AppTabId[];
}

interface StoredUser {
  role: ManagedRole;
  permissions: AppTabId[];
}
type Registry = Record<string, StoredUser>;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function sanitizePermissions(tabs: unknown): AppTabId[] {
  if (!Array.isArray(tabs)) return [];
  const allowed = new Set<AppTabId>(GRANTABLE_TABS);
  const out: AppTabId[] = [];
  for (const t of tabs) {
    if (typeof t === 'string' && allowed.has(t as AppTabId) && !out.includes(t as AppTabId)) {
      out.push(t as AppTabId);
    }
  }
  return out;
}

/** Construye la siembra inicial desde la fuente de auth conocida. */
function buildSeed(): Registry {
  // En modo local-auth el JSON trae roles granulares legacy; si no, `.env`.
  const localUsers = listLocalUsers();
  const seedSource: { email: string; role: string }[] =
    localUsers.length > 0
      ? localUsers
      : listConfiguredUsers().map((u) => ({ email: u.email, role: u.role }));

  const registry: Registry = {};
  for (const { email, role: rawRole } of seedSource) {
    const key = normalizeEmail(email);
    if (!key) continue;
    const role = coerceRole(rawRole);
    if (role === 'none') continue;
    if (role === 'admin') {
      registry[key] = { role: 'admin', permissions: [] };
    } else {
      // Siembra permisos por defecto desde el rol granular previo, para no
      // tumbar el acceso de los usuarios ya conocidos en la migración.
      const seeded = LEGACY_ROLE_TABS[rawRole] ?? [];
      registry[key] = { role: 'user', permissions: sanitizePermissions(seeded) };
    }
  }
  return registry;
}

function persist(registry: Registry): void {
  try {
    storage()?.setItem(ACCESS_REGISTRY_KEY, JSON.stringify(registry));
  } catch {
    /* sin storage el cambio no persiste — no es crítico en la capa UX */
  }
}

/**
 * Lee el registro. Si nunca se ha sembrado, lo siembra y persiste (idempotente).
 */
function loadRegistry(): Registry {
  const raw = (() => {
    try {
      return storage()?.getItem(ACCESS_REGISTRY_KEY) ?? null;
    } catch {
      return null;
    }
  })();

  if (raw == null) {
    const seed = buildSeed();
    persist(seed);
    return seed;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const registry: Registry = {};
    for (const [email, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const role: ManagedRole = v.role === 'admin' ? 'admin' : 'user';
      registry[normalizeEmail(email)] = { role, permissions: sanitizePermissions(v.permissions) };
    }
    return registry;
  } catch {
    return {};
  }
}

function notifyChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(ACCESS_CHANGED_EVENT));
  } catch {
    /* sin window (tests node puro) no hay a quién notificar */
  }
}

function writeRegistry(registry: Registry): void {
  persist(registry);
  notifyChanged();
}

// ── Lecturas ────────────────────────────────────────────────────────────────

function toManagedUser(email: string, stored: StoredUser): ManagedUser {
  return { email, role: stored.role, permissions: [...stored.permissions] };
}

/** Lista de usuarios registrados, ordenada por correo. */
export function listManagedUsers(): ManagedUser[] {
  const registry = loadRegistry();
  return Object.entries(registry)
    .map(([email, stored]) => toManagedUser(email, stored))
    .sort((a, b) => a.email.localeCompare(b.email));
}

export function getManagedUser(email: string): ManagedUser | null {
  const key = normalizeEmail(email);
  const stored = loadRegistry()[key];
  return stored ? toManagedUser(key, stored) : null;
}

/** Rol del registro para un correo (override de la capa UX), o `null`. */
export function getRegistryRole(email: string): ManagedRole | null {
  return loadRegistry()[normalizeEmail(email)]?.role ?? null;
}

/** Tabs concedidos a un correo (vacío si es admin o no existe). */
export function getGrantedTabs(email: string): AppTabId[] {
  const stored = loadRegistry()[normalizeEmail(email)];
  if (!stored || stored.role === 'admin') return [];
  return [...stored.permissions];
}

/**
 * Decisión central de visibilidad para un (correo, rol de sesión, tab). El rol
 * efectivo combina el override del registro con el rol de la sesión backend.
 *   - admin → todo.
 *   - tab admin-only → solo admin.
 *   - user → solo los tabs concedidos.
 *   - none → nada.
 */
export function canAccess(email: string | null, sessionRole: Role, tab: AppTabId): boolean {
  const registryRole = email ? getRegistryRole(email) : null;
  const effectiveRole: Role = registryRole ?? sessionRole;
  if (effectiveRole === 'admin') return true;
  if (isAdminOnlyTab(tab)) return false;
  if (effectiveRole === 'user') {
    if (!email) return false;
    return getGrantedTabs(email).includes(tab);
  }
  return false;
}

// ── Escrituras ──────────────────────────────────────────────────────────────

/** Alta o actualización de rol de un usuario. Permisos nuevos arrancan vacíos. */
export function upsertUser(email: string, role: ManagedRole): ManagedUser {
  const key = normalizeEmail(email);
  const registry = loadRegistry();
  const prev = registry[key];
  const next: StoredUser = {
    role,
    permissions: role === 'admin' ? [] : sanitizePermissions(prev?.permissions ?? []),
  };
  registry[key] = next;
  writeRegistry(registry);
  return toManagedUser(key, next);
}

export function removeUser(email: string): void {
  const key = normalizeEmail(email);
  const registry = loadRegistry();
  if (!(key in registry)) return;
  delete registry[key];
  writeRegistry(registry);
}

export function setUserRole(email: string, role: ManagedRole): void {
  upsertUser(email, role);
}

/** Habilita/deshabilita un tab para un usuario (no-op en tabs admin-only). */
export function setPermission(email: string, tab: AppTabId, enabled: boolean): void {
  if (isAdminOnlyTab(tab)) return;
  if (!GRANTABLE_TABS.includes(tab)) return;
  const key = normalizeEmail(email);
  const registry = loadRegistry();
  const prev = registry[key];
  if (!prev) return;
  const current = new Set(prev.permissions);
  if (enabled) current.add(tab);
  else current.delete(tab);
  registry[key] = { role: prev.role, permissions: sanitizePermissions([...current]) };
  writeRegistry(registry);
}

/** Reemplaza el set completo de permisos de un usuario. */
export function setPermissions(email: string, tabs: AppTabId[]): void {
  const key = normalizeEmail(email);
  const registry = loadRegistry();
  const prev = registry[key];
  if (!prev) return;
  registry[key] = { role: prev.role, permissions: sanitizePermissions(tabs) };
  writeRegistry(registry);
}

// ── Reactividad ───────────────────────────────────────────────────────────────

/**
 * Suscribe a cambios del registro (mismo tab vía CustomEvent, otros tabs vía
 * `storage`). Devuelve la función de baja.
 */
export function subscribeAccessChanged(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onCustom = () => callback();
  const onStorage = (e: StorageEvent) => {
    if (e.key === ACCESS_REGISTRY_KEY) callback();
  };
  window.addEventListener(ACCESS_CHANGED_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(ACCESS_CHANGED_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

/** Solo para tests: borra el registro persistido. */
export function __resetAccessRegistryForTests(): void {
  try {
    storage()?.removeItem(ACCESS_REGISTRY_KEY);
  } catch {
    /* ignore */
  }
}
