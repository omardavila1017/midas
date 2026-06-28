import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiProxy, type ApiProxyResponse } from './apiProxy';

function makeRes() {
  const out = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
  };
  const res: ApiProxyResponse = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    setHeader(name, value) {
      out.headers[name] = value;
      return res;
    },
    send(body) {
      out.body = body;
    },
    json(body) {
      out.body = body;
    },
  };
  return { res, out };
}

describe('createApiProxy (openai)', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
    delete process.env.OPENAI_UPSTREAM;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const handler = () =>
    createApiProxy({
      label: 'openai',
      upstreamEnvVar: 'OPENAI_UPSTREAM',
      defaultUpstream: 'https://api.openai.com/v1',
      tokenEnvVar: 'OPENAI_API_KEY',
    });

  it('forwards catch-all array path segments to the upstream with Bearer auth', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { res, out } = makeRes();

    await handler()(
      { method: 'POST', url: '/api/openai/chat/completions', query: { path: ['chat', 'completions'] }, headers: { 'content-type': 'application/json' }, body: { model: 'gpt-4o-mini' } },
      res,
    );

    expect(out.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('does NOT percent-encode slashes when the runtime delivers path as one string', async () => {
    // Regresión del 404: "chat/completions" como string único producía
    // "chat%2Fcompletions" en el upstream.
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { res } = makeRes();

    await handler()({ method: 'POST', url: '/api/openai/chat/completions', query: { path: 'chat/completions' }, body: {} }, res);

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('drops "." and ".." segments so the path cannot escape the upstream base', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { res } = makeRes();

    await handler()({ method: 'GET', url: '/api/openai/../admin/keys', query: { path: ['..', 'admin', '.', 'keys'] } }, res);

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.openai.com/v1/admin/keys');
  });

  it('returns 500 with a clear error when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    const { res, out } = makeRes();

    await handler()({ method: 'POST', query: { path: ['chat', 'completions'] }, body: {} }, res);

    expect(out.statusCode).toBe(500);
    expect(out.body).toEqual({ error: 'openai proxy not configured' });
    expect(console.error).toHaveBeenCalledWith('[api-proxy:openai] proxy not configured', expect.objectContaining({ hasToken: false }));
  });

  it('passes through upstream error status and logs it for audit', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"nope"}}', { status: 404, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { res, out } = makeRes();

    await handler()({ method: 'POST', query: { path: ['chat', 'completions'] }, body: {} }, res);

    expect(out.statusCode).toBe(404);
    expect(console.error).toHaveBeenCalledWith('[api-proxy:openai] upstream 404', expect.objectContaining({
      targetUrl: 'https://api.openai.com/v1/chat/completions',
    }));
  });

  it('does NOT leak the query string into audit logs', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    const { res } = makeRes();

    await handler()(
      { method: 'GET', url: '/api/openai/models?secret=shh&token=abc', query: { path: ['models'] } },
      res,
    );

    // El upstream SÍ recibe el query string…
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://api.openai.com/v1/models?secret=shh&token=abc');
    // …pero el log de auditoría NO debe contenerlo.
    expect(console.error).toHaveBeenCalledWith('[api-proxy:openai] upstream 404', expect.objectContaining({
      targetUrl: 'https://api.openai.com/v1/models',
    }));
  });
});
