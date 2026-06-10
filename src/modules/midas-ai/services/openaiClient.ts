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

/**
 * Traduce un fallo HTTP del proxy/upstream a un mensaje accionable. Un 404
 * tiene TRES causas distintas que sin esto son indistinguibles para el
 * usuario y para soporte:
 *   a) el despliegue no tiene la ruta /api/openai (rewrite/función ausente)
 *      → el body es HTML o texto no-JSON del host estático;
 *   b) OPENAI_UPSTREAM server-side está mal (sin /v1) → OpenAI responde
 *      JSON "Invalid URL (POST /chat/completions)";
 *   c) el modelo configurado no existe o la API key no tiene acceso
 *      → JSON con code=model_not_found.
 */
export function diagnoseOpenAIFailure(args: {
  status: number;
  rawBody: string;
  error?: OpenAIError;
  url: string;
  model: string;
}): string {
  const { status, rawBody, error, url, model } = args;
  const isJsonError = error !== undefined && (error.message !== undefined || error.code !== undefined);

  if (status === 404) {
    if (!isJsonError) {
      return (
        `la ruta proxy "${url}" no existe en este despliegue. ` +
        'El servidor que sirve la app no tiene configurado el proxy /api/openai ' +
        '(falta la función serverless api/openai o la regla de rewrite del host). ' +
        'En dev: arrancar con `npm run dev` (el proxy de Vite la sirve). ' +
        'En prod: pedir a infra la regla /api/openai → OPENAI_UPSTREAM con OPENAI_API_KEY server-side.'
      );
    }
    if (error?.code === 'model_not_found' || /model/i.test(error?.message ?? '')) {
      return (
        `el modelo "${model}" no existe o la API key no tiene acceso a él ` +
        `(${error?.message ?? 'model_not_found'}). Revisar VITE_OPENAI_MODEL y los permisos del proyecto OpenAI.`
      );
    }
    if (/invalid url/i.test(error?.message ?? '')) {
      return (
        `el upstream de OpenAI está mal configurado server-side (${error?.message}). ` +
        'OPENAI_UPSTREAM debe incluir el path /v1 (ej. https://api.openai.com/v1).'
      );
    }
    return error?.message ?? rawBody.slice(0, 300);
  }
  if (status === 401) {
    return (
      'credencial rechazada por OpenAI. OPENAI_API_KEY falta o es inválida en el ' +
      'servidor proxy (la key nunca viaja desde el browser). ' +
      (error?.message ? `Detalle: ${error.message}` : '')
    ).trim();
  }
  if (status === 429) {
    return `límite de uso o cuota de OpenAI alcanzados. ${error?.message ?? ''}`.trim();
  }
  if (status === 500 && /proxy not configured/i.test(error?.message ?? rawBody)) {
    return 'el proxy /api/openai existe pero no tiene OPENAI_API_KEY configurada server-side.';
  }
  return error?.message ?? rawBody.slice(0, 300);
}

/**
 * Healthcheck ligero de la cadena browser → proxy → OpenAI. GET /models no
 * consume tokens y distingue: 200 conexión OK · 404 ruta proxy ausente ·
 * 401 key inválida · 5xx upstream caído. Disponible en consola como
 * `window.__midas__.openai.check()`.
 */
export async function checkOpenAIConnection(): Promise<{
  ok: boolean;
  status: number;
  detail: string;
}> {
  const { baseUrl, model } = apiConfig.openai;
  const url = `${baseUrl}/models`;
  try {
    const res = await fetch(url, { method: 'GET' });
    const rawBody = await res.text().catch(() => '');
    if (res.ok) {
      return { ok: true, status: res.status, detail: `Conexión OpenAI OK (modelo configurado: ${model}).` };
    }
    let parsed: { error?: OpenAIError } = {};
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      // body no-JSON (HTML del host) — lo maneja el diagnóstico
    }
    const detail = diagnoseOpenAIFailure({ status: res.status, rawBody, error: parsed.error, url, model });
    console.error('[midas-ai] healthcheck falló', { url, status: res.status, detail });
    return { ok: false, status: res.status, detail };
  } catch (err) {
    const detail = `no se pudo alcanzar ${url}: ${err instanceof Error ? err.message : String(err)}`;
    console.error('[midas-ai] healthcheck falló', { url, detail });
    return { ok: false, status: 0, detail };
  }
}

export async function callOpenAI(req: OpenAIChatRequest): Promise<OpenAIResponse> {
  const { model, baseUrl } = apiConfig.openai;
  const url = `${baseUrl}/chat/completions`;

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

  const startedAt = Date.now();
  const res = await fetch(url, {
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
    const detail = diagnoseOpenAIFailure({
      status: res.status,
      rawBody: errBody,
      error: parsed.error,
      url,
      model,
    });
    console.error('[midas-ai] OpenAI request falló', {
      url,
      model,
      status: res.status,
      ms: Date.now() - startedAt,
      errorCode: parsed.error?.code,
      errorType: parsed.error?.type,
      detail,
    });
    throw new Error(`OpenAI ${res.status}: ${detail}`);
  }

  const json = (await res.json()) as { choices?: OpenAIChoice[]; usage?: Record<string, unknown> };
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

  console.info('[midas-ai] OpenAI OK', {
    model,
    ms: Date.now() - startedAt,
    toolCalls: functionCalls.length,
    usage: json.usage,
  });

  return { text, functionCalls };
}

// Diagnóstico de consola (patrón window.__midas__ del resto del app).
declare global {
  interface Window {
    __midas__?: Record<string, unknown>;
  }
}
if (typeof window !== 'undefined') {
  const ns = (window.__midas__ = window.__midas__ ?? {});
  ns.openai = { check: checkOpenAIConnection, config: () => ({ ...apiConfig.openai }) };
}
