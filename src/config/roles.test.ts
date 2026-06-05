import { describe, expect, it } from 'vitest';
import {
  ROLES,
  ROLE_IDS,
  ASSIGNABLE_ROLE_IDS,
  LEGACY_ROLE_TABS,
  isRole,
  coerceRole,
  roleCanAccess,
  allowedTabsForRole,
} from './roles';
import type { AppTabId } from '../modules/shared-finance/components/NavigationContext';

// Conjunto canónico de tabs usado para expandir el acceso de `admin`.
const ALL_TABS: AppTabId[] = [
  'financialProjection',
  'financialPlanning',
  'taxes',
  'payroll',
  'operating',
  'netflow',
  'venta',
  'collections',
  'fideicomiso',
  'cxp',
  'concursoMercantil',
  'compras',
  'pagos',
  'clients',
  'providers',
  'bancos',
  'kpisObjectives',
  'users',
  'permisos',
];

describe('roles catalog (admin/user/none)', () => {
  it('only admin, user and none are valid roles', () => {
    for (const id of ROLE_IDS) {
      expect(isRole(id)).toBe(true);
    }
    expect(ROLE_IDS.sort()).toEqual(['admin', 'none', 'user']);
    expect(isRole('cobranza')).toBe(false);
    expect(isRole('not-a-role')).toBe(false);
    expect(isRole(42)).toBe(false);
  });

  it('admin can see every tab', () => {
    for (const tab of ALL_TABS) {
      expect(roleCanAccess('admin', tab)).toBe(true);
    }
    expect(allowedTabsForRole('admin', ALL_TABS)).toEqual(ALL_TABS);
  });

  it('user has NO access by role — access comes from the permissions layer', () => {
    for (const tab of ALL_TABS) {
      expect(roleCanAccess('user', tab)).toBe(false);
    }
    expect(allowedTabsForRole('user', ALL_TABS)).toEqual([]);
  });

  it('none has no access to anything', () => {
    for (const tab of ALL_TABS) {
      expect(roleCanAccess('none', tab)).toBe(false);
    }
    expect(allowedTabsForRole('none', ALL_TABS)).toEqual([]);
  });

  it('exposes only admin and user as assignable roles', () => {
    expect(ASSIGNABLE_ROLE_IDS).toEqual(['admin', 'user']);
  });

  it('labels exist for each role', () => {
    expect(ROLES.admin.label).toBeTruthy();
    expect(ROLES.user.label).toBeTruthy();
    expect(ROLES.none.label).toBeTruthy();
  });
});

describe('coerceRole', () => {
  it('preserves admin and user', () => {
    expect(coerceRole('admin')).toBe('admin');
    expect(coerceRole('user')).toBe('user');
  });

  it('collapses legacy granular roles to user', () => {
    for (const legacy of ['abastos', 'contaduria', 'fiscal', 'cobranza', 'mesa_ayuda']) {
      expect(coerceRole(legacy)).toBe('user');
    }
  });

  it('maps unknown/empty values to none', () => {
    expect(coerceRole('wizard')).toBe('none');
    expect(coerceRole('')).toBe('none');
    expect(coerceRole(undefined)).toBe('none');
    expect(coerceRole(null)).toBe('none');
  });
});

describe('LEGACY_ROLE_TABS (migration seed)', () => {
  it('only lists known tabs', () => {
    for (const tabs of Object.values(LEGACY_ROLE_TABS)) {
      for (const tab of tabs) {
        expect(ALL_TABS).toContain(tab);
      }
    }
  });
});
