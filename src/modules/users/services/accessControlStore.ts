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

// v3 (2026-06-10): re-siembra forzada tras hardcodear los PERMISOS por usuario
// en `authLocalUsers.json` (antes solo el rol). Subir la versión abandona el
// registro `v2` previo para que TODOS los navegadores vuelvan a sembrar del JSON
// nuevo (correos + roles + permisos por módulo) en vez de quedarse con el roster
// viejo en cache. Sube esta versión cada vez que cambies roles/permisos en el JSON.
// v4 (2026-06-10): alta de jesus.villarreal@gruposenda.com (compras + pagos + providers).
// v5 (2026-06-10): alta de maximiliano.rodriguez@gruposenda.com (admin).
// v6 (2026-06-16): alta de david.betancourt@gruposenda.com (user, solo taxes) +
// antonio.palomo@gruposenda.com pasa de admin a user con todos los módulos funcionales.
// v7 (2026-06-23): blanca.reyes@gruposenda.com gana acceso a TODO Ingresos (se agrega netflow).
export const ACCESS_REGISTRY_KEY = 'midas.users.registry.v7';
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

/**
 * Rol HARDCODEADO del roster (`authLocalUsers.json`), o `null` si el correo no
 * está en él (o el modo local está deshabilitado). Es la fuente autoritativa del
 * rol: un correo listado como `admin` SIEMPRE es admin, sin importar el estado
 * del registro en localStorage. Esto blinda el acceso de los admins contra un
 * registro stale/corrupto (causa del bug "los admins no pueden entrar").
 */
function hardcodedRoleFor(email: string): ManagedRole | null {
  const key = normalizeEmail(email);
  for (const u of listLocalUsers()) {
    if (u.email === key) {
      const role = coerceRole(u.role);
      return role === 'admin' || role === 'user' ? role : null;
    }
  }
  return null;
}

/**
 * Rol EFECTIVO de un correo para decisiones de acceso. Un admin hardcodeado del
 * roster manda sobre cualquier cosa (no se puede degradar desde el registro);
 * si no, el override del registro (p.ej. un admin promovió a un user dado de alta
 * en el portal) y, si tampoco, el rol de la sesión backend.
 */
export function effectiveRole(email: string | null, sessionRole: Role): Role {
  if (email && hardcodedRoleFor(email) === 'admin') return 'admin';
  const registryRole = email ? getRegistryRole(email) : null;
  return registryRole ?? sessionRole;
}

/**
 * Permisos HARDCODEADOS del roster (`authLocalUsers.json`) para un `user`, o `[]`
 * si el correo no está en el JSON, es admin, o el modo local está deshabilitado.
 *
 * Es un **piso autoritativo**: mismo blindaje que `hardcodedRoleFor` da al rol
 * admin, pero para los módulos de un `user`. El registro por-navegador
 * (`localStorage`) sólo se SIEMBRA una vez por versión, así que un registro
 * stale/parcial (sembrado antes de un cambio en el JSON, o tocado en el portal)
 * dejaba a un usuario sin acceso a un módulo que el JSON sí le concede — sin
 * auto-reparación. Al tratar el JSON como piso, un `user` SIEMPRE ve sus módulos
 * hardcodeados en TODOS los navegadores; el portal de Permisos sólo puede
 * AGREGAR extras encima (no quitar el piso — para eso se edita el JSON).
 */
export function getHardcodedFloorTabs(email: string | null): AppTabId[] {
  if (!email) return [];
  const key = normalizeEmail(email);
  for (const u of listLocalUsers()) {
    if (u.email === key) {
      // Un admin del roster ve todo — no necesita piso de permisos.
      if (coerceRole(u.role) === 'admin') return [];
      return sanitizePermissions(u.permissions);
    }
  }
  return [];
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
  // En modo local-auth el JSON trae rol + permisos hardcodeados; si no, `.env`.
  const localUsers = listLocalUsers();
  const seedSource: { email: string; role: string; permissions?: string[] }[] =
    localUsers.length > 0
      ? localUsers
      : listConfiguredUsers().map((u) => ({ email: u.email, role: u.role }));

  const registry: Registry = {};
  for (const { email, role: rawRole, permissions } of seedSource) {
    const key = normalizeEmail(email);
    if (!key) continue;
    const role = coerceRole(rawRole);
    if (role === 'none') continue;
    if (role === 'admin') {
      registry[key] = { role: 'admin', permissions: [] };
    } else {
      // Permisos hardcodeados del roster local (`authLocalUsers.json`). En modo
      // env/backend (sin permisos en la fuente) caemos al mapeo del rol granular
      // legacy para no tumbar el acceso de los usuarios ya conocidos al migrar.
      const seeded = permissions ?? LEGACY_ROLE_TABS[rawRole] ?? [];
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

/**
 * Tabs concedidos a un correo (vacío si es admin — ve todo por otra vía).
 *
 * Unión de dos fuentes: el **piso hardcodeado** del JSON (`getHardcodedFloorTabs`,
 * autoritativo/auto-reparable) y los **extras del registro** por-navegador (lo
 * que un admin agregó en el portal de Permisos). Así un `user` nunca pierde
 * acceso a un módulo que el JSON le concede aunque su registro esté stale.
 */
export function getGrantedTabs(email: string): AppTabId[] {
  const stored = loadRegistry()[normalizeEmail(email)];
  if (stored?.role === 'admin') return [];
  const floor = getHardcodedFloorTabs(email);
  const registryTabs = stored?.role === 'user' ? stored.permissions : [];
  return [...new Set<AppTabId>([...floor, ...registryTabs])];
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
  const role = effectiveRole(email, sessionRole);
  if (role === 'admin') return true;
  if (isAdminOnlyTab(tab)) return false;
  if (role === 'user') {
    if (!email) return false;
    return getGrantedTabs(email).includes(tab);
  }
  return false;
}

/**
 * Decisión de visibilidad para el modo ONLINE (WS/midas): el rol y los permisos
 * vienen de la SESIÓN (API), no del registro local. No consulta `localStorage`
 * ni el roster hardcodeado — es una función pura testeable.
 *   - admin → todo (incluidos los tabs admin-only).
 *   - tab admin-only → solo admin.
 *   - user → solo los tabs de `permissions`.
 *   - none → nada.
 */
export function canAccessWithPermissions(role: Role, permissions: AppTabId[], tab: AppTabId): boolean {
  if (role === 'admin') return true;
  if (isAdminOnlyTab(tab)) return false;
  if (role === 'user') return permissions.includes(tab);
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

/**
 * Serializa el registro completo (correo → rol + permisos) a JSON legible.
 *
 * Pensado para el flujo "configura en el portal → exporta → hardcodea": un admin
 * arma todos los permisos con los switches, exporta este JSON y se vuelve la
 * semilla hardcodeada. Mismo shape que el almacén interno (`Registry`), con
 * correos y permisos ordenados para un diff estable.
 */
export function exportRegistryJson(): string {
  const registry = loadRegistry();
  const ordered: Registry = {};
  for (const email of Object.keys(registry).sort()) {
    const { role, permissions } = registry[email];
    ordered[email] = { role, permissions: [...permissions].sort() };
  }
  return JSON.stringify(ordered, null, 2);
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
