import { afterEach, describe, expect, it, vi } from 'vitest';
import { callOpenAI, isOpenAIConfigured } from './openaiClient';

afterEach(() => {
  vi.unstubAllGlobals();
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
});
