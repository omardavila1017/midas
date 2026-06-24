import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchGet, deleteDoc, getDoc, isRemoteStoreEnabled, listManifest, putDoc } from './remoteStore';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => 'application/json' },
  } as unknown as Response;
}

describe('remoteStore', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('disabled (default)', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_STORE_ENABLED', '');
    });

    it('isRemoteStoreEnabled is false and no network is touched', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      expect(isRemoteStoreEnabled()).toBe(false);
      expect(await getDoc('planning', 'scenarios')).toBeNull();
      expect(await putDoc('planning', 'scenarios', [1, 2])).toBe(false);
      expect(await deleteDoc('planning', 'scenarios')).toBe(false);
      expect(await listManifest('cache')).toEqual([]);
      expect(await batchGet('cache', ['a'])).toEqual({});
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('enabled', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_STORE_ENABLED', 'true');
      vi.stubEnv('VITE_STORE_BASE_URL', '/api/store');
    });

    it('getDoc parses { value, updatedAt }', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({ value: [{ id: 's1' }], updatedAt: '2026-06-23T00:00:00Z' }));
      vi.stubGlobal('fetch', fetchMock);

      const doc = await getDoc<{ id: string }[]>('planning', 'scenarios');
      expect(doc).toEqual({ value: [{ id: 's1' }], updatedAt: '2026-06-23T00:00:00Z' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/store/planning/scenarios');
      expect(init.method).toBe('GET');
    });

    it('getDoc tolerates a raw value (no wrapper)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ id: 'x' }])));
      const doc = await getDoc<{ id: string }[]>('planning', 'scenarios');
      expect(doc).toEqual({ value: [{ id: 'x' }], updatedAt: '' });
    });

    it('getDoc returns null on 404', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'not found' }, 404)));
      expect(await getDoc('planning', 'missing')).toBeNull();
    });

    it('putDoc wraps the value and returns true on 2xx', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
      vi.stubGlobal('fetch', fetchMock);

      expect(await putDoc('planning', 'adjustments', [{ id: 'a1' }])).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/store/planning/adjustments');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toEqual({ value: [{ id: 'a1' }] });
    });

    it('putDoc returns false on a non-retried server error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500)));
      expect(await putDoc('planning', 'adjustments', [])).toBe(false);
    });

    it('deleteDoc returns true on 2xx', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true })));
      expect(await deleteDoc('cache', 'cobranzaRecords')).toBe(true);
    });

    it('listManifest filters to valid entries', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse([{ key: 'scenarios', updatedAt: 'x' }, { bogus: true }, { key: 'adjustments', updatedAt: 'y' }]),
        ),
      );
      const manifest = await listManifest('planning');
      expect(manifest).toEqual([
        { key: 'scenarios', updatedAt: 'x' },
        { key: 'adjustments', updatedAt: 'y' },
      ]);
    });

    it('batchGet posts keys and returns the map; empty keys short-circuit', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ a: 1, b: 2 }));
      vi.stubGlobal('fetch', fetchMock);

      expect(await batchGet('cache', [])).toEqual({});
      expect(fetchMock).not.toHaveBeenCalled();

      const map = await batchGet<number>('cache', ['a', 'b']);
      expect(map).toEqual({ a: 1, b: 2 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/store/cache/batch-get');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ keys: ['a', 'b'] });
    });

    it('encodes keys with colons into a single path segment', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ value: [] }));
      vi.stubGlobal('fetch', fetchMock);
      await getDoc('cache', 'cobranzaRecords::3');
      expect(fetchMock.mock.calls[0][0]).toBe('/api/store/cache/cobranzaRecords%3A%3A3');
    });

    it('returns null after exhausting retries on network failure', async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
      vi.stubGlobal('fetch', fetchMock);

      const pending = getDoc('cache', 'cobranzaRecords');
      await vi.runAllTimersAsync();
      expect(await pending).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + DEFAULT_RETRIES
    });
  });
});
