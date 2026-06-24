import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchGet, isRemoteStoreEnabled, putDoc } from '../../../services/remoteStore';
import { hydratePlanningFromServer, pushPlanningDoc } from './planningRemoteSync';
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

    it('pushes the doc when the store is enabled', () => {
      vi.mocked(isRemoteStoreEnabled).mockReturnValue(true);
      pushPlanningDoc('scenarios', [{ id: 's1' }]);
      expect(putDoc).toHaveBeenCalledWith('planning', 'scenarios', [{ id: 's1' }]);
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
