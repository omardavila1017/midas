import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeIndexedDb, uninstallFakeIndexedDb, type FakeIndexedDB } from '../test/fakeIndexedDb';

type HeavyModule = typeof import('./heavyStoreIDB');

let fake: FakeIndexedDB;
let mod: HeavyModule;

async function freshModule(): Promise<HeavyModule> {
  vi.resetModules();
  return import('./heavyStoreIDB');
}

beforeEach(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fake = installFakeIndexedDb();
  mod = await freshModule();
});

afterEach(() => {
  uninstallFakeIndexedDb();
  vi.restoreAllMocks();
});

function rec(i: number): { id: number } {
  return { id: i };
}

describe('heavyStoreIDB — roundtrip y chunking', () => {
  it('roundtrips a small collection through save/load', async () => {
    await mod.saveHeavyRecords('cxpRecords', [rec(1), rec(2)]);
    const loaded = await mod.loadHeavyRecords('cxpRecords');
    expect(loaded).toEqual([rec(1), rec(2)]);
  });

  it('chunks collections above 1000 records and reassembles them in order', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => rec(i));
    await mod.saveHeavyRecords('cobranzaRecords', many);

    const db = fake.databases.get('midas-heavy-store')!;
    const meta = db.stores.get('records')!.get('cobranzaRecords') as { chunked: boolean; chunkCount: number; total: number };
    expect(meta).toMatchObject({ chunked: true, chunkCount: 3, total: 2500 });

    const loaded = await mod.loadHeavyRecords('cobranzaRecords');
    expect(loaded.length).toBe(2500);
    expect(loaded[0]).toEqual(rec(0));
    expect(loaded[2499]).toEqual(rec(2499));
  });

  it('deletes stale trailing chunks when a shorter collection overwrites a longer one', async () => {
    await mod.saveHeavyRecords('comprasRecords', Array.from({ length: 2500 }, (_, i) => rec(i)));
    await mod.saveHeavyRecords('comprasRecords', Array.from({ length: 500 }, (_, i) => rec(i)));

    const db = fake.databases.get('midas-heavy-store')!;
    const chunks = db.stores.get('recordChunks')!;
    expect(chunks.has('comprasRecords::0')).toBe(true);
    expect(chunks.has('comprasRecords::1')).toBe(false);
    expect(chunks.has('comprasRecords::2')).toBe(false);

    const loaded = await mod.loadHeavyRecords('comprasRecords');
    expect(loaded.length).toBe(500);
  });

  it('returns [] for a key never saved', async () => {
    expect(await mod.loadHeavyRecords('rolRecords')).toEqual([]);
  });

  it('loadHeavyStore hydrates every key', async () => {
    await mod.saveHeavyRecords('cxpRecords', [rec(1)]);
    await mod.saveHeavyRecords('nominaRecords', [rec(2), rec(3)]);
    const store = await mod.loadHeavyStore();
    expect(store.cxpRecords.length).toBe(1);
    expect(store.nominaRecords.length).toBe(2);
    expect(store.cobranzaRecords).toEqual([]);
  });
});

describe('heavyStoreIDB — anti-wipe', () => {
  it('saveHeavyStore skips entirely when every collection is empty', async () => {
    await mod.saveHeavyRecords('cxpRecords', [rec(1)]);
    await mod.saveHeavyStore(mod.emptyHeavyStore());
    expect(await mod.loadHeavyRecords('cxpRecords')).toEqual([rec(1)]);
  });

  it('saveHeavyStore never overwrites a persisted collection with an empty array', async () => {
    await mod.saveHeavyRecords('cxpRecords', [rec(1)]);
    const store = mod.emptyHeavyStore();
    store.cobranzaRecords = [rec(9)] as never;
    await mod.saveHeavyStore(store);
    // cxpRecords venía vacío en el state — debe conservar lo persistido
    expect(await mod.loadHeavyRecords('cxpRecords')).toEqual([rec(1)]);
    expect(await mod.loadHeavyRecords('cobranzaRecords')).toEqual([rec(9)]);
  });

  it('saveBankJdeStatementsToIDB skips empty state but supplemental persists empty', async () => {
    await mod.saveBankJdeStatementsToIDB([rec(1)]);
    await mod.saveBankJdeStatementsToIDB([]);
    expect((await mod.loadBankStatementsFromIDB()).jde).toEqual([rec(1)]);

    await mod.saveBankSupplementalStatementsToIDB([rec(2)]);
    await mod.saveBankSupplementalStatementsToIDB([]);
    expect((await mod.loadBankStatementsFromIDB()).supplemental).toEqual([]);
  });
});

describe('heavyStoreIDB — clears', () => {
  it('clearHeavyKeys removes only the targeted keys including their chunks', async () => {
    await mod.saveHeavyRecords('cxpRecords', Array.from({ length: 1500 }, (_, i) => rec(i)));
    await mod.saveHeavyRecords('rolRecords', [rec(7)]);
    await mod.saveBankSupplementalStatementsToIDB([rec(8)]);

    await mod.clearHeavyKeys(['cxpRecords']);

    expect(await mod.loadHeavyRecords('cxpRecords')).toEqual([]);
    expect(await mod.loadHeavyRecords('rolRecords')).toEqual([rec(7)]);
    expect((await mod.loadBankStatementsFromIDB()).supplemental).toEqual([rec(8)]);
    const chunks = fake.databases.get('midas-heavy-store')!.stores.get('recordChunks')!;
    expect(chunks.has('cxpRecords::0')).toBe(false);
    expect(chunks.has('cxpRecords::1')).toBe(false);
  });

  it('clearHeavyStore wipes both stores', async () => {
    await mod.saveHeavyRecords('cxpRecords', [rec(1)]);
    await mod.clearHeavyStore();
    expect(await mod.loadHeavyRecords('cxpRecords')).toEqual([]);
  });
});

describe('heavyStoreIDB — sin IndexedDB', () => {
  it('degrades gracefully when indexedDB is unavailable', async () => {
    uninstallFakeIndexedDb();
    const bare = await freshModule();
    await bare.saveHeavyRecords('cxpRecords', [rec(1)]);
    expect(await bare.loadHeavyRecords('cxpRecords')).toEqual([]);
    await bare.saveHeavyStore(bare.emptyHeavyStore());
    await bare.clearHeavyStore();
    await bare.clearHeavyKeys(['cxpRecords']);
    expect((await bare.loadBankStatementsFromIDB()).jde).toEqual([]);
  });

  it('degrades gracefully when open() fails', async () => {
    fake.failOpen = true;
    const failing = await freshModule();
    await failing.saveHeavyRecords('cxpRecords', [rec(1)]);
    expect(await failing.loadHeavyRecords('cxpRecords')).toEqual([]);
  });
});
