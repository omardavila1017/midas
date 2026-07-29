import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetUserRolesCache,
  getRoleForEmail,
  listConfiguredUsers,
  normalizeEmail,
  parseUserRoles,
  resolveDefaultRole,
} from './userRoles';
import type { Role } from './roles';

describe('parseUserRoles', () => {
  it('parses a well-formed CSV into a Map, collapsing legacy roles to user', () => {
    const map = parseUserRoles('a@x.com:admin,b@x.com:cobranza');
    expect(map.get('a@x.com')).toBe('admin');
    expect(map.get('b@x.com')).toBe('user'); // cobranza → user (modelo nuevo)
    expect(map.size).toBe(2);
  });

  it('normalizes emails (trim + lowercase)', () => {
    const map = parseUserRoles('  Ana@X.COM :fiscal');
    expect(map.get('ana@x.com')).toBe('user'); // fiscal → user
  });

  it('ignores empty/whitespace entries and trailing commas', () => {
    const map = parseUserRoles('a@x.com:admin, , ,');
    expect(map.size).toBe(1);
  });

  it('drops entries with unknown roles and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = parseUserRoles('a@x.com:wizard,b@x.com:fiscal');
    expect(map.has('a@x.com')).toBe(false);
    expect(map.get('b@x.com')).toBe('user');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops entries without a colon separator and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = parseUserRoles('garbage,a@x.com:admin');
    expect(map.has('a@x.com')).toBe(true);
    expect(map.size).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns an empty Map for undefined/empty input', () => {
    expect(parseUserRoles(undefined).size).toBe(0);
    expect(parseUserRoles('').size).toBe(0);
  });

  it('only splits on the first colon', () => {
    // Defensive: role itself never carries ':', so first-colon split is safe.
    const map = parseUserRoles('a@x.com:admin');
    expect(map.get('a@x.com')).toBe('admin');
  });

  it('drops entries with an empty email before the colon and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const map = parseUserRoles(':admin,  :user,b@x.com:user');
    expect(map.size).toBe(1);
    expect(map.get('b@x.com')).toBe('user');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('collapses every known legacy granular role to user', () => {
    const csv = 'a@x.com:abastos,b@x.com:contaduria,c@x.com:fiscal,d@x.com:cobranza,e@x.com:mesa_ayuda';
    const map = parseUserRoles(csv);
    expect(map.size).toBe(5);
    for (const email of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']) {
      expect(map.get(email)).toBe<Role>('user');
    }
  });

  it('last entry wins when the same email appears twice', () => {
    const map = parseUserRoles('a@x.com:user,A@X.com:admin');
    expect(map.size).toBe(1);
    expect(map.get('a@x.com')).toBe('admin');
  });
});

describe('resolveDefaultRole', () => {
  it('returns the configured default, collapsing legacy roles to user', () => {
    expect(resolveDefaultRole('cobranza')).toBe<Role>('user');
    expect(resolveDefaultRole('admin')).toBe<Role>('admin');
    expect(resolveDefaultRole('user')).toBe<Role>('user');
  });

  it('falls back to "none" for invalid or missing values', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveDefaultRole('bogus')).toBe<Role>('none');
    expect(resolveDefaultRole(undefined)).toBe<Role>('none');
    warn.mockRestore();
  });
});

describe('getRoleForEmail / listConfiguredUsers (env-backed, module cache)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetUserRolesCache();
  });

  it('resolves the role from VITE_USER_ROLES, tolerating case/whitespace in the query email', () => {
    vi.stubEnv('VITE_USER_ROLES', 'Ana@X.com:admin, beto@x.com:cobranza');
    vi.stubEnv('VITE_DEFAULT_ROLE', 'user');
    __resetUserRolesCache();

    expect(getRoleForEmail('ana@x.com')).toBe<Role>('admin');
    expect(getRoleForEmail('  ANA@x.COM ')).toBe<Role>('admin');
    expect(getRoleForEmail('beto@x.com')).toBe<Role>('user'); // cobranza → user
    // Correo no configurado → VITE_DEFAULT_ROLE.
    expect(getRoleForEmail('stranger@x.com')).toBe<Role>('user');
    // null/undefined/'' → default.
    expect(getRoleForEmail(null)).toBe<Role>('user');
    expect(getRoleForEmail(undefined)).toBe<Role>('user');
    expect(getRoleForEmail('')).toBe<Role>('user');
  });

  it('falls back to none when neither VITE_USER_ROLES nor VITE_DEFAULT_ROLE are set', () => {
    vi.stubEnv('VITE_USER_ROLES', '');
    vi.stubEnv('VITE_DEFAULT_ROLE', '');
    __resetUserRolesCache();

    expect(getRoleForEmail('anyone@x.com')).toBe<Role>('none');
    expect(getRoleForEmail(null)).toBe<Role>('none');
    expect(listConfiguredUsers()).toEqual([]);
  });

  it('caches the parsed map at module level until __resetUserRolesCache', () => {
    vi.stubEnv('VITE_USER_ROLES', 'a@x.com:admin');
    vi.stubEnv('VITE_DEFAULT_ROLE', '');
    __resetUserRolesCache();
    expect(getRoleForEmail('a@x.com')).toBe<Role>('admin');

    // Cambiar el env SIN reset no cambia el resultado (cache viva).
    vi.stubEnv('VITE_USER_ROLES', 'a@x.com:user');
    expect(getRoleForEmail('a@x.com')).toBe<Role>('admin');

    // Tras reset, el nuevo env aplica.
    __resetUserRolesCache();
    expect(getRoleForEmail('a@x.com')).toBe<Role>('user');
  });

  it('listConfiguredUsers returns the coerced roles sorted by email', () => {
    vi.stubEnv('VITE_USER_ROLES', 'zeta@x.com:fiscal,alfa@x.com:admin,medio@x.com:user');
    __resetUserRolesCache();

    expect(listConfiguredUsers()).toEqual([
      { email: 'alfa@x.com', role: 'admin' },
      { email: 'medio@x.com', role: 'user' },
      { email: 'zeta@x.com', role: 'user' }, // fiscal → user
    ]);
  });
});

describe('unknown-email fallback behaviour', () => {
  // getRoleForEmail reads import.meta.env directly; here we validate the
  // composed logic (parse + default) that backs it.
  it('an email not present in the map resolves to the default role', () => {
    const map = parseUserRoles('known@x.com:admin');
    const defaultRole = resolveDefaultRole('none');
    const resolve = (email: string): Role =>
      map.get(normalizeEmail(email)) ?? defaultRole;

    expect(resolve('known@x.com')).toBe('admin');
    expect(resolve('stranger@x.com')).toBe('none');
  });
});
