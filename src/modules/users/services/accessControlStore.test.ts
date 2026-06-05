import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetAccessRegistryForTests,
  canAccess,
  getGrantedTabs,
  getManagedUser,
  listManagedUsers,
  removeUser,
  setPermission,
  setUserRole,
  upsertUser,
} from './accessControlStore';

// Sembrado desde el JSON local (authLocalUsers.json, enabled): este usuario
// trae rol granular legacy "cobranza" → user con permisos por defecto.
const ADMIN = 'agustin.blanco@gruposenda.com';
const SEEDED_USER = 'blanca.reyes@gruposenda.com';

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
    const seeded = getManagedUser(SEEDED_USER);
    expect(seeded?.role).toBe('user');
    // El rol legacy "cobranza" sembró estos tabs por defecto.
    expect(seeded?.permissions).toEqual(expect.arrayContaining(['collections', 'venta', 'clients', 'bancos']));
  });
});

describe('canAccess', () => {
  it('lets admin see everything, including admin-only tabs', () => {
    expect(canAccess(ADMIN, 'admin', 'bancos')).toBe(true);
    expect(canAccess(ADMIN, 'admin', 'users')).toBe(true);
    expect(canAccess(ADMIN, 'admin', 'permisos')).toBe(true);
  });

  it('registry admin role overrides a weaker session role', () => {
    expect(canAccess(ADMIN, 'none', 'financialProjection')).toBe(true);
  });

  it('limits a user to granted tabs and blocks admin-only tabs', () => {
    expect(canAccess(SEEDED_USER, 'user', 'collections')).toBe(true);
    expect(canAccess(SEEDED_USER, 'user', 'taxes')).toBe(false);
    expect(canAccess(SEEDED_USER, 'user', 'users')).toBe(false);
    expect(canAccess(SEEDED_USER, 'user', 'permisos')).toBe(false);
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
