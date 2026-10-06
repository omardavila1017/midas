import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchGet, isRemoteStoreEnabled, putDoc } from '../../../services/remoteStore';
import {
  __resetPlanningRemoteSyncForTests,
  hydratePlanningFromServer,
  pushPlanningDoc,
} from './planningRemoteSync';
import { PLANNING_DOC_CHANGED_EVENT } from './planningDocSync';
import { PLANNING_ADJUSTMENTS_KEY, PLANNING_SCENARIOS_KEY } from './planningStorageKeys';

vi.mock('../../../services/remoteStore', () => ({
  isRemoteStoreEnabled: vi.fn(() => false),
  putDoc: vi.fn(async () => true),
  batchGet: vi.fn(async () => ({})),
}));

describe('planningRemoteSync', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(batchGet).mockResolvedValue({});
    __resetPlanningRemoteSyncForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('pushPlanningDoc (write-through)', () => {
    it('is a no-op when the store is disabled', () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(false);
      pushPlanningDoc('scenarios', [{ id: 's1' }]);
      expect(putDoc).not.toHaveBeenCalled();
    });

    it('pushes the doc once this session has read the server', async () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
      await hydratePlanningFromServer();
      pushPlanningDoc('scenarios', [{ id: 's1' }]);
      expect(putDoc).toHaveBeenCalledWith('planning', 'scenarios', [{ id: 's1' }]);
    });

    it('NO publica antes de leer el servidor: el persist del montaje no pisa el trabajo de otros', async () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
      let release: (value: Record<string, unknown>) => void = () => {};
      vi.mocked(batchGet).mockReturnValue(new Promise((resolve) => { release = resolve; }));
      pushPlanningDoc('scenarios', [{ id: 'stale-local' }]);
      expect(putDoc).not.toHaveBeenCalled();
      // La escritura dispara la hidratación, que es la que decide.
      expect(batchGet).toHaveBeenCalledTimes(1);
      release({ scenarios: [{ id: 'org' }] });
      await hydratePlanningFromServer();
      await Promise.resolve();
      expect(putDoc).not.toHaveBeenCalledWith('planning', 'scenarios', [{ id: 'stale-local' }]);
    });
  });

  describe('hydratePlanningFromServer', () => {
    it('returns false and touches nothing when disabled', async () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(false);
      expect(await hydratePlanningFromServer()).toBe(false);
      expect(batchGet).not.toHaveBeenCalled();
    });

    it('writes server docs into the local mirror and reports a change', async () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
      vi.mocked(batchGet).mockResolvedValue({
        scenarios: [{ id: 's-remote' }],
        adjustments: [{ id: 'a-remote' }],
      });

      const changed = await hydratePlanningFromServer();
      expect(changed).toBe(true);
      expect(JSON.parse(localStorage.getItem(PLANNING_SCENARIOS_KEY)!)).toEqual([{ id: 's-remote' }]);
      expect(JSON.parse(localStorage.getItem(PLANNING_ADJUSTMENTS_KEY)!)).toEqual([{ id: 'a-remote' }]);
    });

    it('seeds local data up to the server when a server doc is missing', async () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
      vi.mocked(batchGet).mockResolvedValue({}); // server empty
      localStorage.setItem(PLANNING_SCENARIOS_KEY, JSON.stringify([{ id: 's-local' }]));

      const changed = await hydratePlanningFromServer();
      expect(changed).toBe(false); // local unchanged
      expect(putDoc).toHaveBeenCalledWith('planning', 'scenarios', [{ id: 's-local' }]);
    });

    it('una lectura FALLIDA no siembra ni abre la compuerta', async () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
      vi.mocked(batchGet).mockResolvedValue(null);
      localStorage.setItem(PLANNING_SCENARIOS_KEY, JSON.stringify([{ id: 's-local' }]));

      expect(await hydratePlanningFromServer()).toBe(false);
      expect(putDoc).not.toHaveBeenCalled();
      // El espejo local se conserva y nada sube mientras no se haya leído.
      expect(JSON.parse(localStorage.getItem(PLANNING_SCENARIOS_KEY)!)).toEqual([{ id: 's-local' }]);
      pushPlanningDoc('scenarios', [{ id: 's-local' }]);
      expect(putDoc).not.toHaveBeenCalled();
    });

    it('tras un fallo no reintenta en cada escritura (a lo más una vez por minuto)', async () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
      vi.mocked(batchGet).mockResolvedValue(null);
      await hydratePlanningFromServer();
      pushPlanningDoc('scenarios', []);
      pushPlanningDoc('scenarios', []);
      expect(batchGet).toHaveBeenCalledTimes(1);
    });

    it('lee una sola vez por sesión, aunque la pidan los dos tableros a la vez', async () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
      await Promise.all([hydratePlanningFromServer(), hydratePlanningFromServer()]);
      await hydratePlanningFromServer();
      expect(batchGet).toHaveBeenCalledTimes(1);
    });

    it('avisa a los tableros SÓLO las llaves que cambió el servidor', async () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
      vi.mocked(batchGet).mockResolvedValue({ scenarios: [{ id: 's-remote' }] });
      const keys: string[] = [];
      const listener = (event: Event) => keys.push((event as CustomEvent<{ key: string }>).detail.key);
      window.addEventListener(PLANNING_DOC_CHANGED_EVENT, listener);
      try {
        await hydratePlanningFromServer();
      } finally {
        window.removeEventListener(PLANNING_DOC_CHANGED_EVENT, listener);
      }
      expect(keys).toEqual(['planning.scenarios']);
    });

    it('clears the local mirror when the server doc is empty', async () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
      vi.mocked(batchGet).mockResolvedValue({ scenarios: [] });
      localStorage.setItem(PLANNING_SCENARIOS_KEY, JSON.stringify([{ id: 'stale' }]));

      const changed = await hydratePlanningFromServer();
      expect(changed).toBe(true);
      expect(localStorage.getItem(PLANNING_SCENARIOS_KEY)).toBeNull();
    });
  });
});
