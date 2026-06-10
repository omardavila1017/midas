import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callOpenAI, checkOpenAIConnection, diagnoseOpenAIFailure, isOpenAIConfigured } from './openaiClient';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openaiClient', () => {
  it('calls the internal OpenAI proxy without sending browser Authorization', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenAI({
      systemPrompt: 'system',
      history: [{ role: 'user', content: 'hello' }],
    });

    expect(isOpenAIConfigured()).toBe(true);
    expect(result.text).toBe('ok');
    expect(fetchMock).toHaveBeenCalledWith('/api/openai/chat/completions', expect.objectContaining({
      method: 'POST',
    }));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('parses tool calls from the response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          content: 'propongo un ajuste',
          tool_calls: [{
            id: 'tc1',
            type: 'function',
            function: { name: 'propose_adjustment', arguments: '{"name":"x","deltaDays":7}' },
          }],
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await callOpenAI({ systemPrompt: 's', history: [] });
    expect(result.functionCalls).toEqual([{ name: 'propose_adjustment', args: { name: 'x', deltaDays: 7 } }]);
  });

  it('404 with HTML body → explains the proxy route is missing in the deploy', async () => {
    const fetchMock = vi.fn(async () => new Response('<!DOCTYPE html><html>Not Found</html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenAI({ systemPrompt: 's', history: [] })).rejects.toThrow(
      /OpenAI 404: la ruta proxy "\/api\/openai\/chat\/completions" no existe en este despliegue/,
    );
    expect(console.error).toHaveBeenCalledWith('[midas-ai] OpenAI request falló', expect.objectContaining({ status: 404 }));
  });

  it('404 model_not_found → names the configured model', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "The model 'gpt-4o-mini' does not exist or you do not have access to it.", code: 'model_not_found', type: 'invalid_request_error' },
    }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenAI({ systemPrompt: 's', history: [] })).rejects.toThrow(
      /no existe o la API key no tiene acceso/,
    );
  });

  it('404 Invalid URL → points at OPENAI_UPSTREAM missing /v1', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Invalid URL (POST /chat/completions)', type: 'invalid_request_error' },
    }), { status: 404, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenAI({ systemPrompt: 's', history: [] })).rejects.toThrow(/OPENAI_UPSTREAM debe incluir el path \/v1/);
  });

  it('401 → points at the server-side OPENAI_API_KEY', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Incorrect API key provided', code: 'invalid_api_key' },
    }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(callOpenAI({ systemPrompt: 's', history: [] })).rejects.toThrow(/OPENAI_API_KEY falta o es inválida/);
  });

  it('checkOpenAIConnection reports ok on 200 and diagnoses 404', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ok = await checkOpenAIConnection();
    expect(ok.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/openai/models', { method: 'GET' });

    const fetch404 = vi.fn(async () => new Response('<html>404</html>', { status: 404 }));
    vi.stubGlobal('fetch', fetch404);
    const bad = await checkOpenAIConnection();
    expect(bad.ok).toBe(false);
    expect(bad.status).toBe(404);
    expect(bad.detail).toMatch(/no existe en este despliegue/);
  });
});

describe('diagnoseOpenAIFailure', () => {
  const base = { url: '/api/openai/chat/completions', model: 'gpt-4o-mini' };

  it('500 proxy not configured → missing server-side key', () => {
    const msg = diagnoseOpenAIFailure({ ...base, status: 500, rawBody: '{"error":"openai proxy not configured"}' });
    expect(msg).toMatch(/no tiene OPENAI_API_KEY configurada server-side/);
  });

  it('429 → quota message', () => {
    const msg = diagnoseOpenAIFailure({ ...base, status: 429, rawBody: '', error: { message: 'Rate limit reached' } });
    expect(msg).toMatch(/límite de uso o cuota/);
  });

  it('unknown status falls back to the upstream message', () => {
    const msg = diagnoseOpenAIFailure({ ...base, status: 400, rawBody: '', error: { message: 'max_tokens is too large' } });
    expect(msg).toBe('max_tokens is too large');
  });
});
