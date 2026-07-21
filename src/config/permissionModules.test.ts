import { describe, expect, it } from 'vitest';
import {
  PERMISSION_MODULE_IDS,
  isPermissionModule,
  parsePermissionsCsv,
  serializePermissionsCsv,
} from './permissionModules';
import { GRANTABLE_TABS } from './appTabs';

describe('permissionModules', () => {
  it('lists exactly the 17 modules of the backend CSV contract', () => {
    expect(PERMISSION_MODULE_IDS).toHaveLength(17);
    expect(new Set(PERMISSION_MODULE_IDS).size).toBe(17); // sin duplicados
  });

  it('matches GRANTABLE_TABS minus the temporary fuentes* tabs', () => {
    const grantableStable = GRANTABLE_TABS.filter((t) => !t.startsWith('fuentes')).sort();
    expect([...PERMISSION_MODULE_IDS].sort()).toEqual(grantableStable);
  });

  it('validates membership via isPermissionModule', () => {
    expect(isPermissionModule('cxp')).toBe(true);
    expect(isPermissionModule('kpisObjectives')).toBe(true);
    expect(isPermissionModule('users')).toBe(false); // admin-only, no otorgable
    expect(isPermissionModule('fuentesBancos')).toBe(false); // temporal, fuera de contrato
    expect(isPermissionModule('inventado')).toBe(false);
  });

  it('parses a CSV, trimming, dedup and dropping unknown tokens', () => {
    expect(parsePermissionsCsv('cxp, bancos ,taxes')).toEqual(['cxp', 'bancos', 'taxes']);
    expect(parsePermissionsCsv('cxp,cxp,bancos')).toEqual(['cxp', 'bancos']);
    expect(parsePermissionsCsv('cxp,users,basura,fuentesBancos')).toEqual(['cxp']);
  });

  it('treats null / empty as no modules', () => {
    expect(parsePermissionsCsv(null)).toEqual([]);
    expect(parsePermissionsCsv(undefined)).toEqual([]);
    expect(parsePermissionsCsv('')).toEqual([]);
    expect(parsePermissionsCsv('   ')).toEqual([]);
  });

  it('serializes only valid modules, dedup, order preserved', () => {
    expect(serializePermissionsCsv(['cxp', 'bancos'])).toBe('cxp,bancos');
    expect(serializePermissionsCsv(['cxp', 'cxp', 'bancos'])).toBe('cxp,bancos');
    // tabs fuera de contrato se descartan
    expect(serializePermissionsCsv(['cxp', 'users', 'fuentesBancos'] as never)).toBe('cxp');
    expect(serializePermissionsCsv([])).toBe('');
  });

  it('round-trips parse ∘ serialize', () => {
    const tabs = parsePermissionsCsv('taxes,payroll,clients');
    expect(parsePermissionsCsv(serializePermissionsCsv(tabs))).toEqual(tabs);
  });
});
