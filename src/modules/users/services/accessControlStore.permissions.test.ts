import { describe, expect, it } from 'vitest';
import { canAccessWithPermissions } from './accessControlStore';

// Gate del modo ONLINE (WS/midas): rol + permisos vienen de la sesión (API), no
// del registro local. Función pura, sin localStorage.
describe('canAccessWithPermissions (modo ONLINE)', () => {
  it('admin ve todo, incluidos los tabs admin-only', () => {
    expect(canAccessWithPermissions('admin', [], 'cxp')).toBe(true);
    expect(canAccessWithPermissions('admin', [], 'users')).toBe(true);
    expect(canAccessWithPermissions('admin', [], 'permisos')).toBe(true);
  });

  it('user ve solo sus permisos', () => {
    expect(canAccessWithPermissions('user', ['cxp', 'bancos'], 'cxp')).toBe(true);
    expect(canAccessWithPermissions('user', ['cxp', 'bancos'], 'taxes')).toBe(false);
  });

  it('user nunca ve los tabs admin-only aunque estén en permisos', () => {
    expect(canAccessWithPermissions('user', ['users'], 'users')).toBe(false);
    expect(canAccessWithPermissions('user', ['permisos'], 'permisos')).toBe(false);
  });

  it('none no ve nada', () => {
    expect(canAccessWithPermissions('none', ['cxp'], 'cxp')).toBe(false);
  });
});
