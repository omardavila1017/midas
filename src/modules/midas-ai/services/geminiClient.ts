import { apiConfig } from '../../../config/api.config';
import { PROPOSE_ADJUSTMENT_TOOL } from './midasPromptTemplates';

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GeminiTurn {
  role: 'user' | 'model';
  text?: string;
  functionCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

export interface GeminiResponse {
  text: string;
  functionCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

export interface GeminiChatRequest {
  systemPrompt: string;
  history: GeminiTurn[];
}

export function isGeminiConfigured(): boolean {
  return Boolean(apiConfig.gemini.apiKey);
}

export async function callGemini(req: GeminiChatRequest): Promise<GeminiResponse> {
  const { apiKey, model, baseUrl } = apiConfig.gemini;
  if (!apiKey) {
    throw new Error('VITE_GEMINI_API_KEY no configurada.');
  }

  const contents: GeminiContent[] = req.history.map((turn) => ({
    role: turn.role,
    parts: buildPartsForTurn(turn),
  }));

  const body = {
    systemInstruction: { role: 'user', parts: [{ text: req.systemPrompt }] },
    contents,
    tools: [{ functionDeclarations: [PROPOSE_ADJUSTMENT_TOOL] }],
    generationConfig: {
      temperature: 0.4,
      topP: 0.95,
      maxOutputTokens: 2048,
    },
  };

  const url = `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
    promptFeedback?: { blockReason?: string };
  };

  if (json.promptFeedback?.blockReason) {
    throw new Error(`Bloqueado por filtro de seguridad: ${json.promptFeedback.blockReason}`);
  }

  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => p.text ?? '')
    .filter(Boolean)
    .join('\n')
    .trim();
  const functionCalls = parts
    .map((p) => p.functionCall)
    .filter((fc): fc is { name: string; args: Record<string, unknown> } => Boolean(fc));

  return { text, functionCalls };
}

function buildPartsForTurn(turn: GeminiTurn): GeminiPart[] {
  const parts: GeminiPart[] = [];
  if (turn.text) parts.push({ text: turn.text });
  if (turn.functionCalls) {
    for (const fc of turn.functionCalls) parts.push({ functionCall: fc });
  }
  if (parts.length === 0) parts.push({ text: '' });
  return parts;
}
