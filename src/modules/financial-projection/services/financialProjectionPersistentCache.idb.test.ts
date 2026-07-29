/**
 * Ramas de persistencia real (IndexedDB), invalidación de índice y payloads
 * corruptos de financialProjectionPersistentCache. jsdom no trae IndexedDB,
 * así que se instala el fake en memoria (src/test/fakeIndexedDb.ts) y se
 * reimporta el módulo por test (vi.resetModules) porque cachea dbPromise a
 * nivel de módulo. El test hermano (financialProjectionPersistentCache.test.ts)
 * cubre el camino sin IDB (pending-writes) y los fingerprints de source.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScenarioForecastRun } from '../../financial-planning/services/scenarioForecastRun';
import { FakeIndexedDB, installFakeIndexedDb, uninstallFakeIndexedDb } from '../../../test/fakeIndexedDb';

const DB_NAME = 'midas-financial-projection-cache';
const STORE_NAME = 'entries';
const INDEX_KEY = 'midas.financialProjection.cache.index.v1';

type CacheModule = typeof import('./financialProjectionPersistentCache');

let fake: FakeIndexedDB;

async function freshModule(): Promise<CacheModule> {
  vi.resetModules();
  return import('./financialProjectionPersistentCache');
}

function scenarioRun(marker: string): ScenarioForecastRun {
  return { marker } as unknown as ScenarioForecastRun;
}

async function flushWrites(): Promise<void> {
  // El fake encadena microtasks (open → put → oncomplete); un macrotask basta
  // para drenarlas y que saveEntry borre su pending-write.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function idbEntries(): Map<string, unknown> {
  return fake.databases.get(DB_NAME)?.stores.get(STORE_NAME) ?? new Map();
}

describe('financialProjectionPersistentCache — persistencia IDB', () => {
  beforeEach(() => {
    localStorage.clear();
    fake = installFakeIndexedDb();
  });

  afterEach(() => {
    uninstallFakeIndexedDb();
    vi.restoreAllMocks();
  });

  it('scenario-run escribe a IDB y se lee de vuelta (kind sin cache de sesión)', async () => {
    const mod = await freshModule();
    mod.saveScenarioRunToPersistentCache('raw-key-1', scenarioRun('persisted-run'));
    await flushWrites();

    // El registro quedó físicamente en el object store:
    const key = mod.scenarioRunPersistentCacheKey('raw-key-1');
    expect(idbEntries().has(key)).toBe(true);

    await expect(mod.loadScenarioRunFromPersistentCache('raw-key-1'))
      .resolves.toEqual({ marker: 'persisted-run' });
  });

  it('sobrevive a un "boot" nuevo: otro import del módulo lee lo que el anterior guardó', async () => {
    const first = await freshModule();
    first.saveScenarioRunToPersistentCache('boot-key', scenarioRun('cross-boot'));
    await flushWrites();

    // Boot nuevo = módulo fresco, mismo IDB + mismo localStorage.
    const second = await freshModule();
    await expect(second.loadScenarioRunFromPersistentCache('boot-key'))
      .resolves.toEqual({ marker: 'cross-boot' });
  });

  it('índice corrupto (JSON inválido) invalida el cache aunque IDB tenga el valor', async () => {
    const mod = await freshModule();
    mod.saveScenarioRunToPersistentCache('raw-key-2', scenarioRun('orphaned'));
    await flushWrites();

    localStorage.setItem(INDEX_KEY, '{not-json');
    await expect(mod.loadScenarioRunFromPersistentCache('raw-key-2')).resolves.toBeNull();
  });

  it('índice con schemaVersion viejo se trata como vacío', async () => {
    const mod = await freshModule();
    mod.saveScenarioRunToPersistentCache('raw-key-3', scenarioRun('old-schema'));
    await flushWrites();

    const raw = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '{}') as { entries: unknown[] };
    localStorage.setItem(INDEX_KEY, JSON.stringify({ schemaVersion: 1, entries: raw.entries }));
    await expect(mod.loadScenarioRunFromPersistentCache('raw-key-3')).resolves.toBeNull();
  });

  it('entrada de índice con kind equivocado no sirve el valor', async () => {
    const mod = await freshModule();
    mod.saveScenarioRunToPersistentCache('raw-key-4', scenarioRun('kind-drift'));
    await flushWrites();

    const raw = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '{}') as {
      schemaVersion: number;
      entries: Array<{ key: string; kind: string; savedAt: string }>;
    };
    localStorage.setItem(INDEX_KEY, JSON.stringify({
      schemaVersion: raw.schemaVersion,
      entries: raw.entries.map((entry) => ({ ...entry, kind: 'probabilistic-forecast' })),
    }));
    await expect(mod.loadScenarioRunFromPersistentCache('raw-key-4')).resolves.toBeNull();
  });

  it('payload corrupto en IDB (kind mutado) regresa null en vez de propagar basura', async () => {
    const mod = await freshModule();
    mod.saveScenarioRunToPersistentCache('raw-key-5', scenarioRun('to-corrupt'));
    await flushWrites();

    const key = mod.scenarioRunPersistentCacheKey('raw-key-5');
    const stored = idbEntries().get(key) as { kind: string };
    expect(stored).toBeDefined();
    idbEntries().set(key, { ...stored, kind: 'projection-source' });

    await expect(mod.loadScenarioRunFromPersistentCache('raw-key-5')).resolves.toBeNull();
  });

  it('IDB que no abre (failOpen): save no lanza y load degrada a null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.failOpen = true;
    const mod = await freshModule();

    expect(() => mod.saveScenarioRunToPersistentCache('raw-key-6', scenarioRun('no-idb'))).not.toThrow();
    await flushWrites();

    await expect(mod.loadScenarioRunFromPersistentCache('raw-key-6')).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('el índice LRU de probabilistic-forecast (límite 8) evicta al más viejo', async () => {
    const mod = await freshModule();
    for (let i = 1; i <= 9; i++) {
      mod.saveProbabilisticForecastToPersistentCache(`prob-${i}`, { marker: `run-${i}` });
    }
    await flushWrites();

    // El primero salió del índice → miss aunque su valor siga en IDB:
    await expect(mod.loadProbabilisticForecastFromPersistentCache('prob-1')).resolves.toBeNull();
    expect(idbEntries().has(mod.probabilisticForecastPersistentCacheKey('prob-1'))).toBe(true);
    // Los 8 más recientes siguen servibles (el 2 ya no está en session cache
    // —límite 2— así que este hit ejercita el read de IDB del kind):
    await expect(mod.loadProbabilisticForecastFromPersistentCache('prob-2'))
      .resolves.toEqual({ marker: 'run-2' });
    await expect(mod.loadProbabilisticForecastFromPersistentCache('prob-9'))
      .resolves.toEqual({ marker: 'run-9' });
  });

  it('__clearFinancialProjectionPersistentCacheForTests vacía el índice → todo es miss', async () => {
    const mod = await freshModule();
    mod.saveScenarioRunToPersistentCache('raw-key-7', scenarioRun('cleared'));
    await flushWrites();
    await expect(mod.loadScenarioRunFromPersistentCache('raw-key-7'))
      .resolves.toEqual({ marker: 'cleared' });

    mod.__clearFinancialProjectionPersistentCacheForTests();
    await expect(mod.loadScenarioRunFromPersistentCache('raw-key-7')).resolves.toBeNull();
  });
});
