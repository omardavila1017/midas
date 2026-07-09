import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDoc, isRemoteStoreEnabled } from './remoteStore';
import { saveHeavyRecords, saveBankJdeStatementsToIDB } from './heavyStoreIDB';
import {
  getLocalSnapshotVersion,
  getSnapshotPointer,
  hydrateHeavyStoreFromSnapshot,
  isSnapshotEnabled,
  type SnapshotPointer,
} from './snapshotRemoteSync';

vi.mock('./remoteStore', () => ({
  isRemoteStoreEnabled: vi.fn(() => true),
  getDoc: vi.fn(async () => null),
}));

// Los writers reales de heavyStoreIDB tocan IndexedDB; se stubean para asertar
// el contrato (qué colección se escribe con qué registros) sin depender de IDB.
// Mismo patrón que storageRegistry.cacheClear.test.ts.
vi.mock('./heavyStoreIDB', async (importActual) => {
  const actual = await importActual<typeof import('./heavyStoreIDB')>();
  return {
    ...actual,
    saveHeavyRecords: vi.fn(async () => undefined),
    saveBankJdeStatementsToIDB: vi.fn(async () => undefined),
  };
});

function pointer(overrides: Partial<SnapshotPointer> = {}): SnapshotPointer {
  return {
    version: 'v1',
    builtAt: '2026-07-08T15:00:00Z',
    schema: 1,
    collections: {
      cxpRecords: { shardCount: 2, total: 3 },
      bankJdeStatements: { shardCount: 1, total: 1 },
    },
    ...overrides,
  };
}

/** Enruta getDoc: pointer + shards según un mapa key→value. */
function routeGetDoc(map: Record<string, unknown>) {
  vi.mocked(getDoc).mockImplementation(async (_ns: string, key: string) => {
    if (key in map) return { value: map[key], updatedAt: '' } as never;
    return null;
  });
}

describe('snapshotRemoteSync', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  describe('isSnapshotEnabled', () => {
    it('is false when the store is disabled', () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(false);
      expect(isSnapshotEnabled()).toBe(false);
    });
    it('is true by default when the store is enabled', () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
      expect(isSnapshotEnabled()).toBe(true);
    });
    it("is false when VITE_SNAPSHOT_ENABLED === 'false' even with the store on", () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
      vi.stubEnv('VITE_SNAPSHOT_ENABLED', 'false');
      expect(isSnapshotEnabled()).toBe(false);
    });
  });

  describe('getSnapshotPointer', () => {
    it('returns null and does not fetch when disabled', async () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(false);
      expect(await getSnapshotPointer()).toBeNull();
      expect(getDoc).not.toHaveBeenCalled();
    });

    it('returns null when there is no snapshot (404 → null)', async () => {
      vi.mocked(getDoc).mockResolvedValue(null);
      expect(await getSnapshotPointer()).toBeNull();
    });

    it('reads and normalizes the pointer', async () => {
      routeGetDoc({ 'snapshot.current': pointer() });
      const p = await getSnapshotPointer();
      expect(p?.version).toBe('v1');
      expect(p?.collections.cxpRecords?.shardCount).toBe(2);
      expect(getDoc).toHaveBeenCalledWith('cache', 'snapshot.current');
    });

    it('rejects a malformed pointer', async () => {
      routeGetDoc({ 'snapshot.current': { nope: true } });
      expect(await getSnapshotPointer()).toBeNull();
    });
  });

  describe('hydrateHeavyStoreFromSnapshot', () => {
    it('writes each collection once with concatenated shards and bumps the marker', async () => {
      routeGetDoc({
        'snapshot.current': pointer(),
        'snapshot.v1.cxpRecords.0': [{ id: 'a' }, { id: 'b' }],
        'snapshot.v1.cxpRecords.1': [{ id: 'c' }],
        'snapshot.v1.bankJdeStatements.0': [{ id: 'bank1' }],
      });
      const result = await hydrateHeavyStoreFromSnapshot(pointer());

      expect(result.hydrated).toContain('cxpRecords');
      expect(result.hydrated).toContain('bankJdeStatements');
      expect(result.failed).toEqual([]);
      // cxp: los 2 shards concatenados en orden.
      expect(saveHeavyRecords).toHaveBeenCalledWith('cxpRecords', [
        { id: 'a' },
        { id: 'b' },
        { id: 'c' },
      ]);
      // bank: writer dedicado (fuera de HEAVY_KEYS).
      expect(saveBankJdeStatementsToIDB).toHaveBeenCalledWith([{ id: 'bank1' }]);
      expect(getLocalSnapshotVersion()).toBe('v1');
    });

    it('skips a collection with a missing shard and does NOT bump the marker', async () => {
      routeGetDoc({
        // cxpRecords.1 falta → colección incompleta.
        'snapshot.v1.cxpRecords.0': [{ id: 'a' }],
        'snapshot.v1.bankJdeStatements.0': [{ id: 'bank1' }],
      });
      const result = await hydrateHeavyStoreFromSnapshot(pointer());

      expect(result.failed).toContain('cxpRecords');
      expect(saveHeavyRecords).not.toHaveBeenCalledWith('cxpRecords', expect.anything());
      // La colección buena SÍ se escribe (todo-o-nada es POR colección).
      expect(saveBankJdeStatementsToIDB).toHaveBeenCalledWith([{ id: 'bank1' }]);
      // Con una colección fallida, el marker NO sube (fuerza re-descarga al re-entrar).
      expect(getLocalSnapshotVersion()).toBeNull();
    });

    it('skips collections with shardCount 0 (anti-wipe) without writing them', async () => {
      const p = pointer({ collections: { cxpRecords: { shardCount: 0, total: 0 } } });
      routeGetDoc({});
      const result = await hydrateHeavyStoreFromSnapshot(p);

      expect(saveHeavyRecords).not.toHaveBeenCalled();
      expect(result.hydrated).toEqual([]);
      expect(result.failed).toEqual([]);
      // Ninguna colección falló → el marker sube (nada que hidratar).
      expect(getLocalSnapshotVersion()).toBe('v1');
    });
  });
});
