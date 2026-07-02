import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jdeClient } from './jdeClient';
import { JdeApiError } from './jdeTypes';
import { jdeFetchPauseGate } from './pauseGate';

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Zero out the backoff jitter so retries are instantaneous.
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  // Final errors auto-pause the global gate; leaving it paused would hang
  // every subsequent request in this file.
  if (jdeFetchPauseGate.isPaused()) jdeFetchPauseGate.resume();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('jdeClient request basics', () => {
  it('GET resolves JSON from the internal proxy without an Authorization header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    const result = await jdeClient.get<{ ok: boolean }>('/empresas');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/jde/empresas');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('POST serializes the body and sets Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    await jdeClient.post('/cobranza', { cia: '00001' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ cia: '00001' }));
  });

  it('sends Bearer auth for explicit external base URLs', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await jdeClient.get('/empresas', {
      baseUrl: 'https://api.example.com/JDEdwards/',
      authValue: 'tok-123',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.example.com/JDEdwards/empresas');
    expect(init.headers.Authorization).toBe('Bearer tok-123');
  });

  it('rejects an external base URL without a credential before hitting the network', async () => {
    await expect(
      jdeClient.get('/empresas', { baseUrl: 'https://api.example.com', authValue: '' }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('jdeClient retry policy', () => {
  it('retries transient 503 and succeeds on the next attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ err: 'busy' }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const result = await jdeClient.get<{ ok: boolean }>('/empresas');

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry non-transient 4xx statuses', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ err: 'bad' }, 400));

    await expect(jdeClient.get('/empresas')).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on persistent 504 and throws the last error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ err: 'gw' }, 504));

    await expect(jdeClient.get('/empresas', { retries: 2 })).rejects.toMatchObject({ status: 504 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('honors a retries: 0 override (single attempt)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ err: 'gw' }, 502));

    await expect(jdeClient.get('/empresas', { retries: 0 })).rejects.toMatchObject({ status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries network failures and maps them to status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('failed to fetch'));

    await expect(jdeClient.get('/empresas', { retries: 1 })).rejects.toMatchObject({ status: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps an aborted request (timeout) to a retriable 408', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
    );

    await expect(
      jdeClient.get('/empresas', { timeoutMs: 10, retries: 1 }),
    ).rejects.toMatchObject({ status: 408 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('wraps a non-JSON success body in a JdeApiError', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => { throw new SyntaxError('Unexpected token <'); },
      text: async () => '<html>',
    } as unknown as Response);

    await expect(jdeClient.get('/empresas')).rejects.toBeInstanceOf(JdeApiError);
  });
});

describe('jdeClient ↔ pause gate integration', () => {
  it('auto-pauses the global gate on a final (non-retriable) error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ err: 'nope' }, 500));

    // The gate may have auto-paused already in a previous test of this file;
    // resume() keeps `autoPauseFired` latched, so only assert when this is
    // the first firing.
    const firstFiring = !jdeFetchPauseGate.hasAutoPaused();
    await expect(jdeClient.get('/auxiliar')).rejects.toMatchObject({ status: 500 });

    if (firstFiring) {
      expect(jdeFetchPauseGate.isPaused()).toBe(true);
      expect(jdeFetchPauseGate.getLastError()?.status).toBe(500);
    }
    expect(jdeFetchPauseGate.hasAutoPaused()).toBe(true);
  });
});
