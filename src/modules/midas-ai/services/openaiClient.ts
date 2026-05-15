import { apiConfig } from '../../../config/api.config';
import { PROPOSE_ADJUSTMENT_TOOL } from './midasPromptTemplates';

export interface OpenAITurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface OpenAIChatRequest {
  systemPrompt: string;
  history: OpenAITurn[];
}

export interface OpenAIResponse {
  text: string;
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

export function isOpenAIConfigured(): boolean {
  return Boolean(apiConfig.openai.baseUrl);
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIChoice {
  message?: {
    content?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason?: string;
}

interface OpenAIError {
  message?: string;
  code?: string;
  type?: string;
}

export async function callOpenAI(req: OpenAIChatRequest): Promise<OpenAIResponse> {
  const { model, baseUrl } = apiConfig.openai;

  const messages = [
    { role: 'system' as const, content: req.systemPrompt },
    ...req.history.map((t) => ({ role: t.role, content: t.content })),
  ];

  const body = {
    model,
    messages,
    tools: [
      {
        type: 'function',
        function: {
          name: PROPOSE_ADJUSTMENT_TOOL.name,
          description: PROPOSE_ADJUSTMENT_TOOL.description,
          parameters: PROPOSE_ADJUSTMENT_TOOL.parameters,
        },
      },
    ],
    tool_choice: 'auto',
    temperature: 0.4,
    max_tokens: 2048,
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    let parsed: { error?: OpenAIError } = {};
    try {
      parsed = JSON.parse(errBody);
    } catch {
      // not JSON
    }
    const detail = parsed.error?.message ?? errBody.slice(0, 300);
    throw new Error(`OpenAI ${res.status}: ${detail}`);
  }

  const json = (await res.json()) as { choices?: OpenAIChoice[] };
  const choice = json.choices?.[0]?.message;
  const text = (choice?.content ?? '').trim();
  const functionCalls = (choice?.tool_calls ?? [])
    .filter((tc) => tc.type === 'function')
    .map((tc) => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        // leave args empty; parser downstream rejects invalid shapes
      }
      return { name: tc.function.name, args };
    });

  return { text, functionCalls };
}
