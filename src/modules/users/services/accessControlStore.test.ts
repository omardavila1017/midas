import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetAccessRegistryForTests,
  canAccess,
  effectiveRole,
  exportRegistryJson,
  getGrantedTabs,
  getManagedUser,
  listManagedUsers,
  removeUser,
  setPermission,
  setUserRole,
  upsertUser,
} from './accessControlStore';

// Sembrado desde el JSON local (authLocalUsers.json, enabled). El roster está
// hardcodeado con roles admin/user + permisos por usuario.
const ADMIN = 'agustin.blanco@gruposenda.com';
// `user` con permisos hardcodeados (Fideicomiso/Venta/Cobranza/Clientes).
const SEEDED_USER = 'blanca.reyes@gruposenda.com';
// `user` hardcodeado con un set ACOTADO de permisos (Compras/Pagos/Proveedores)
// — NO incluye Cobranza, así que sirve para probar el alta de un permiso nuevo.
const SEEDED_USER_LIMITED = 'jesus.villarreal@gruposenda.com';

beforeEach(() => {
  localStorage.clear();
  __resetAccessRegistryForTests();
});

afterEach(() => {
  localStorage.clear();
});

describe('accessControlStore seeding', () => {
  it('seeds known users from the local auth source', () => {
    const users = listManagedUsers();
    expect(users.length).toBeGreaterThan(0);
    expect(getManagedUser(ADMIN)?.role).toBe('admin');
    const seeded = getManagedUser(SEEDED_USER_LIMITED);
    expect(seeded?.role).toBe('user');
    // Permisos hardcodeados en authLocalUsers.json (orden no garantizado).
    expect([...(seeded?.permissions ?? [])].sort()).toEqual(
      ['compras', 'pagos', 'providers'].sort(),
    );
  });

  it('seeds the hardcoded per-user permissions from the JSON roster', () => {
    const blanca = getManagedUser(SEEDED_USER);
    expect(blanca?.role).toBe('user');
    // Permisos hardcodeados en authLocalUsers.json (orden no garantizado).
    expect([...(blanca?.permissions ?? [])].sort()).toEqual(
      ['clients', 'collections', 'fideicomiso', 'netflow', 'venta'].sort(),
    );
  });
});

describe('canAccess', () => {
  it('lets admin see everything, including admin-only tabs', () => {
    expect(canAccess(ADMIN, 'admin', 'bancos')).toBe(true);
    expect(canAccess(ADMIN, 'admin', 'users')).toBe(true);
    expect(canAccess(ADMIN, 'admin', 'permisos')).toBe(true);
  });

  it('hardcoded admin role overrides a weaker session role', () => {
    expect(canAccess(ADMIN, 'none', 'financialProjection')).toBe(true);
  });

  it('a hardcoded admin can always enter even with a stale/demoted registry', () => {
    // Simula un registro corrupto que degrada al admin a `user` sin permisos
    // (la causa del bug "los admins no pueden entrar"): el rol hardcodeado manda.
    setUserRole(ADMIN, 'user');
    expect(effectiveRole(ADMIN, 'none')).toBe('admin');
    expect(canAccess(ADMIN, 'none', 'financialProjection')).toBe(true);
    expect(canAccess(ADMIN, 'user', 'users')).toBe(true);
  });

  it('serves the hardcoded permissions to a seeded user', () => {
    expect(canAccess(SEEDED_USER, 'user', 'collections')).toBe(true);
    expect(canAccess(SEEDED_USER, 'user', 'venta')).toBe(true);
    expect(canAccess(SEEDED_USER, 'user', 'taxes')).toBe(false);
  });

  it('limits a user to granted tabs and blocks admin-only tabs', () => {
    // No tiene `collections` hardcodeado; un admin se lo prende desde el portal.
    expect(canAccess(SEEDED_USER_LIMITED, 'user', 'collections')).toBe(false);
    setPermission(SEEDED_USER_LIMITED, 'collections', true);
    expect(canAccess(SEEDED_USER_LIMITED, 'user', 'collections')).toBe(true);
    expect(canAccess(SEEDED_USER_LIMITED, 'user', 'taxes')).toBe(false);
    expect(canAccess(SEEDED_USER_LIMITED, 'user', 'users')).toBe(false);
    expect(canAccess(SEEDED_USER_LIMITED, 'user', 'permisos')).toBe(false);
  });

  it('falls back to the session role for emails not in the registry', () => {
    expect(canAccess('stranger@x.com', 'admin', 'bancos')).toBe(true);
    expect(canAccess('stranger@x.com', 'user', 'bancos')).toBe(false);
    expect(canAccess(null, 'admin', 'bancos')).toBe(true);
    expect(canAccess(null, 'user', 'bancos')).toBe(false);
  });
});

describe('mutations', () => {
  it('registers a new user as a permissionless user', () => {
    upsertUser('nuevo@x.com', 'user');
    const u = getManagedUser('nuevo@x.com');
    expect(u?.role).toBe('user');
    expect(u?.permissions).toEqual([]);
    expect(canAccess('nuevo@x.com', 'user', 'bancos')).toBe(false);
  });

  it('grants and revokes a single permission', () => {
    upsertUser('nuevo@x.com', 'user');
    setPermission('nuevo@x.com', 'bancos', true);
    expect(getGrantedTabs('nuevo@x.com')).toContain('bancos');
    expect(canAccess('nuevo@x.com', 'user', 'bancos')).toBe(true);
    setPermission('nuevo@x.com', 'bancos', false);
    expect(getGrantedTabs('nuevo@x.com')).not.toContain('bancos');
  });

  it('never grants admin-only tabs as permissions', () => {
    upsertUser('nuevo@x.com', 'user');
    setPermission('nuevo@x.com', 'users', true);
    setPermission('nuevo@x.com', 'permisos', true);
    expect(getGrantedTabs('nuevo@x.com')).toEqual([]);
  });

  it('promoting to admin grants full access; demoting drops it', () => {
    upsertUser('nuevo@x.com', 'user');
    setUserRole('nuevo@x.com', 'admin');
    expect(canAccess('nuevo@x.com', 'user', 'taxes')).toBe(true);
    setUserRole('nuevo@x.com', 'user');
    expect(canAccess('nuevo@x.com', 'user', 'taxes')).toBe(false);
  });

  it('removes a user', () => {
    upsertUser('temp@x.com', 'user');
    expect(getManagedUser('temp@x.com')).not.toBeNull();
    removeUser('temp@x.com');
    expect(getManagedUser('temp@x.com')).toBeNull();
  });
});

describe('exportRegistryJson', () => {
  it('serializes role + permissions in a stable, hardcodeable shape', () => {
    upsertUser('export@x.com', 'user');
    setPermission('export@x.com', 'bancos', true);
    const parsed = JSON.parse(exportRegistryJson()) as Record<
      string,
      { role: string; permissions: string[] }
    >;
    expect(parsed['export@x.com']).toEqual({ role: 'user', permissions: ['bancos'] });
    expect(parsed[ADMIN]).toEqual({ role: 'admin', permissions: [] });
  });
});
