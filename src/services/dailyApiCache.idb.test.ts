import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDb, uninstallFakeIndexedDb, type FakeIndexedDB } from '../test/fakeIndexedDb';

/**
 * Paths de IndexedDB del daily cache — antes intesteados (jsdom no trae IDB,
 * así que la suite previa solo cubría el fallback memory-only).
 */

type CacheModule = typeof import('./dailyApiCache');

let fake: FakeIndexedDB;

async function freshCache(): Promise<CacheModule> {
  vi.resetModules();
  return import('./dailyApiCache');
}

// Deja drenar las micro/macro-tasks de las escrituras fire-and-forget.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const PAST_DAY = '2026-06-15';
const TODAY = '2026-07-28';

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fake = installFakeIndexedDb();
});

afterEach(() => {
  uninstallFakeIndexedDb();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('dailyApiCache — persistencia IDB', () => {
  it('persists a past day across module reloads (new session)', async () => {
    const first = await freshCache();
    await first.primeDailyCache();
    expect(first.isDailyCachePersistent()).toBe(true);
    first.setDailyCached('bancos', PAST_DAY, [{ id: 1 }], '00150', TODAY);
    await settle();

    const second = await freshCache();
    await second.primeDailyCache();
    expect(second.hasDailyCached('bancos', PAST_DAY, '00150')).toBe(true);
    expect(await second.getDailyCachedAsync('bancos', PAST_DAY, '00150')).toEqual([{ id: 1 }]);
  });

  it('never caches today or future days', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();
    mod.setDailyCached('bancos', TODAY, [{ id: 1 }], undefined, TODAY);
    mod.setDailyCached('bancos', '2026-12-31', [{ id: 2 }], undefined, TODAY);
    expect(mod.hasDailyCached('bancos', TODAY)).toBe(false);
    expect(mod.hasDailyCached('bancos', '2026-12-31')).toBe(false);
  });

  it('serves the write-through buffer before the IDB commit resolves', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();
    mod.setDailyCached('pagos', PAST_DAY, [{ id: 9 }], undefined, TODAY);
    // Sin settle: el commit IDB aún no confirma — debe leer del buffer
    expect(await mod.getDailyCachedAsync('pagos', PAST_DAY)).toEqual([{ id: 9 }]);
  });

  it('deleteDailyCached removes the entry from index and disk', async () => {
    const first = await freshCache();
    await first.primeDailyCache();
    first.setDailyCached('bancos', PAST_DAY, [{ id: 1 }], undefined, TODAY);
    await settle();
    first.deleteDailyCached('bancos', PAST_DAY);
    await settle();
    expect(first.hasDailyCached('bancos', PAST_DAY)).toBe(false);

    const second = await freshCache();
    await second.primeDailyCache();
    expect(second.hasDailyCached('bancos', PAST_DAY)).toBe(false);
  });

  it('clearDailyCache removes only the targeted api/cia prefix and reports the count', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();
    mod.setDailyCached('bancos', PAST_DAY, [{ id: 1 }], '00150', TODAY);
    mod.setDailyCached('bancos', '2026-06-16', [{ id: 2 }], '00033', TODAY);
    mod.setDailyCached('compras', PAST_DAY, [{ id: 3 }], '00150', TODAY);
    await settle();

    expect(await mod.clearDailyCache('bancos', '00150')).toBe(1);
    expect(mod.hasDailyCached('bancos', PAST_DAY, '00150')).toBe(false);
    expect(mod.hasDailyCached('bancos', '2026-06-16', '00033')).toBe(true);
    expect(mod.hasDailyCached('compras', PAST_DAY, '00150')).toBe(true);

    expect(await mod.clearDailyCache('bancos')).toBe(1); // la cía restante
    expect(mod.hasDailyCached('bancos', '2026-06-16', '00033')).toBe(false);
  });

  it('getMaxCachedDay and dailyCacheStats read from the persisted key index', async () => {
    const mod = await freshCache();
    await mod.primeDailyCache();
    mod.setDailyCached('bancos', '2026-06-10', [], '00150', TODAY);
    mod.setDailyCached('bancos', '2026-06-20', [], '00150', TODAY);
    expect(mod.getMaxCachedDay('bancos', '00150')).toBe('2026-06-20');
    expect(mod.dailyCacheStats('bancos', '00150')).toEqual({
      count: 2,
      days: ['2026-06-10', '2026-06-20'],
    });
  });
});

describe('dailyApiCache — prune de retención', () => {
  it('drops entries older than the 800-day retention window on prime', async () => {
    // Siembra una entry viejísima directo en el fake IDB (simula años de uso)
    const first = await freshCache();
    await first.primeDailyCache();
    first.setDailyCached('bancos', PAST_DAY, [{ id: 1 }], undefined, TODAY);
    await settle();
    const store = fake.databases.get('midas-daily-cache')!.stores.get('entries')!;
    store.set('bancos.__all__.2020-01-01', {
      key: 'bancos.__all__.2020-01-01',
      day: '2020-01-01',
      records: [{ id: 0 }],
    });

    const second = await freshCache();
    await second.primeDailyCache();
    await settle();
    expect(second.hasDailyCached('bancos', '2020-01-01')).toBe(false);
    expect(second.hasDailyCached('bancos', PAST_DAY)).toBe(true);
    expect(store.has('bancos.__all__.2020-01-01')).toBe(false);
  });
});

describe('dailyApiCache — migración legacy localStorage', () => {
  it('migrates midas.daily.* keys from localStorage into IDB and removes them', async () => {
    localStorage.setItem(
      `midas.daily.bancos.__all__.${PAST_DAY}`,
      JSON.stringify({ records: [{ id: 77 }] }),
    );
    const mod = await freshCache();
    await mod.primeDailyCache();
    await settle();
    expect(mod.hasDailyCached('bancos', PAST_DAY)).toBe(true);
    expect(await mod.getDailyCachedAsync('bancos', PAST_DAY)).toEqual([{ id: 77 }]);
    expect(localStorage.getItem(`midas.daily.bancos.__all__.${PAST_DAY}`)).toBe(null);
  });
});

describe('dailyApiCache — fallback memory-only', () => {
  it('reports non-persistent and still serves the in-session buffer without indexedDB', async () => {
    uninstallFakeIndexedDb();
    const mod = await freshCache();
    await mod.primeDailyCache();
    expect(mod.isDailyCachePersistent()).toBe(false);
    mod.setDailyCached('bancos', PAST_DAY, [{ id: 5 }], undefined, TODAY);
    expect(mod.hasDailyCached('bancos', PAST_DAY)).toBe(true);
    expect(await mod.getDailyCachedAsync('bancos', PAST_DAY)).toEqual([{ id: 5 }]);
  });

  it('degrades to memory-only when open() errors hard', async () => {
    fake.failOpen = true;
    const mod = await freshCache();
    await mod.primeDailyCache();
    expect(mod.isDailyCachePersistent()).toBe(false);
    mod.setDailyCached('bancos', PAST_DAY, [{ id: 6 }], undefined, TODAY);
    expect(await mod.getDailyCachedAsync('bancos', PAST_DAY)).toEqual([{ id: 6 }]);
  });
});
