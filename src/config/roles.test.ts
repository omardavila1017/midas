import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_IDS, isRole, roleCanAccess, allowedTabsForRole } from './roles';
import type { AppTabId } from '../modules/shared-finance/components/NavigationContext';

// Conjunto canónico de tabs usado para expandir el acceso de `admin`.
const ALL_TABS: AppTabId[] = [
  'financialProjection',
  'financialPlanning',
  'taxes',
  'payroll',
  'operating',
  'netflow',
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
];

describe('roles catalog', () => {
  it('marks every catalog id as a valid role', () => {
    for (const id of ROLE_IDS) {
      expect(isRole(id)).toBe(true);
    }
    expect(isRole('not-a-role')).toBe(false);
    expect(isRole(42)).toBe(false);
  });

  it('admin can see every tab, including users', () => {
    for (const tab of ALL_TABS) {
      expect(roleCanAccess('admin', tab)).toBe(true);
    }
    expect(allowedTabsForRole('admin', ALL_TABS)).toEqual(ALL_TABS);
  });

  it('mesa_ayuda can ONLY see the users module', () => {
    expect(roleCanAccess('mesa_ayuda', 'users')).toBe(true);
    const forbidden = ALL_TABS.filter((t) => t !== 'users');
    for (const tab of forbidden) {
      expect(roleCanAccess('mesa_ayuda', tab)).toBe(false);
    }
    expect(allowedTabsForRole('mesa_ayuda', ALL_TABS)).toEqual(['users']);
  });

  it('the users module is visible ONLY to admin and mesa_ayuda', () => {
    const canSeeUsers = ROLE_IDS.filter((r) => roleCanAccess(r, 'users'));
    expect(canSeeUsers.sort()).toEqual(['admin', 'mesa_ayuda']);
  });

  it('none has no access to anything', () => {
    for (const tab of ALL_TABS) {
      expect(roleCanAccess('none', tab)).toBe(false);
    }
    expect(allowedTabsForRole('none', ALL_TABS)).toEqual([]);
  });

  it('financial roles never expose the users module', () => {
    for (const role of ['abastos', 'contaduria', 'fiscal', 'cobranza'] as const) {
      expect(roleCanAccess(role, 'users')).toBe(false);
      expect(ROLES[role].allowedTabs).not.toBe('*');
    }
  });

  it('every non-admin role only lists known tabs', () => {
    for (const id of ROLE_IDS) {
      const def = ROLES[id];
      if (def.allowedTabs === '*') continue;
      for (const tab of def.allowedTabs) {
        expect(ALL_TABS).toContain(tab);
      }
    }
  });
});
