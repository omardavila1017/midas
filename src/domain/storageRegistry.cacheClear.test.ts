import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the two heavy clears but keep the REAL key constants (HEAVY_KEYS,
// BANK_JDE_IDB_KEY, BANK_SUPPLEMENTAL_IDB_KEY) so the test asserts the actual
// preserve/clear contract, not a fixture.
vi.mock('../services/heavyStoreIDB', async (importActual) => {
  const actual = await importActual<typeof import('../services/heavyStoreIDB')>();
  return { ...actual, clearHeavyKeys: vi.fn(async () => undefined) };
});
vi.mock('../services/dailyApiCache', async (importActual) => {
  const actual = await importActual<typeof import('../services/dailyApiCache')>();
  return { ...actual, clearAllDailyCache: vi.fn(async () => 0) };
});

import { BANK_JDE_IDB_KEY, BANK_SUPPLEMENTAL_IDB_KEY, HEAVY_KEYS, clearHeavyKeys } from '../services/heavyStoreIDB';
import { clearAllDailyCache } from '../services/dailyApiCache';
import { clearCacheStorageOnEntry } from './storageRegistry';

describe('clearCacheStorageOnEntry — clear-on-entry selectivo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal('indexedDB', { deleteDatabase: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('borra las colecciones JDE/TRESS + estados de cuenta JDE, pero PRESERVA las cargas manuales', async () => {
    await clearCacheStorageOnEntry();

    expect(clearHeavyKeys).toHaveBeenCalledTimes(1);
    const clearedKeys = vi.mocked(clearHeavyKeys).mock.calls[0][0] as readonly string[];
    // Las 10 colecciones JDE/TRESS + los estados de cuenta JDE se borran.
    for (const k of HEAVY_KEYS) expect(clearedKeys).toContain(k);
    expect(clearedKeys).toContain(BANK_JDE_IDB_KEY);
    // Las cargas manuales del usuario NO se tocan.
    expect(clearedKeys).not.toContain(BANK_SUPPLEMENTAL_IDB_KEY);
  });

  it('limpia el cache diario y borra la base de proyección', async () => {
    await clearCacheStorageOnEntry();
    expect(clearAllDailyCache).toHaveBeenCalledTimes(1);
    expect((globalThis.indexedDB as unknown as { deleteDatabase: ReturnType<typeof vi.fn> }).deleteDatabase)
      .toHaveBeenCalledWith('midas-financial-projection-cache');
  });

  it('NO toca localStorage (el trabajo capturado por el usuario sobrevive)', async () => {
    localStorage.setItem('midas.financialPlanning.scenarios.v1', '[{"id":"s1"}]');
    localStorage.setItem('midas.taxes.v1', '{"adjustments":[]}');
    localStorage.setItem('midas.users.registry.v6', '{"a@b.com":{"role":"admin"}}');

    await clearCacheStorageOnEntry();

    expect(localStorage.getItem('midas.financialPlanning.scenarios.v1')).toBe('[{"id":"s1"}]');
    expect(localStorage.getItem('midas.taxes.v1')).toBe('{"adjustments":[]}');
    expect(localStorage.getItem('midas.users.registry.v6')).toBe('{"a@b.com":{"role":"admin"}}');
  });
});
