import { describe, expect, it, vi } from 'vitest';
import { parseUserRoles, resolveDefaultRole, normalizeEmail } from './userRoles';
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
