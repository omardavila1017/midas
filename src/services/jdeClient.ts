/**
 * Cliente HTTP para los APIs de JD Edwards.
 *
 * Configuración:
 *   VITE_JDE_BASE_URL   — base URL (default: "/api/jde" → proxy Vite)
 *   VITE_JDE_TOKEN      — Bearer token de autenticación
 *
 * En desarrollo el `base` default ("/api/jde") es reescrito por el proxy
 * configurado en vite.config.ts hacia http://srv-desarrollo:90/JDEdwards.
 * En producción, apuntar VITE_JDE_BASE_URL al host correcto (una vez que
 * JDE publique la URL productiva).
 */

import { JdeApiError } from './jdeTypes';

export interface JdeClientConfig {
  /** Base URL sin trailing slash. Default: import.meta.env.VITE_JDE_BASE_URL || "/api/jde". */
  baseUrl?: string;
  /** Bearer token. Default: import.meta.env.VITE_JDE_TOKEN. */
  token?: string;
  /** Timeout por request en ms. Default: 30_000. */
  timeoutMs?: number;
}

// Cada request a JDE tarda ~60s en producción. 90s estaba al filo y a veces
// reventaba con AbortError antes de que respondiera. 180s da margen real
// sin dejar requests colgados eternamente si algo se cuelga del lado server.
const DEFAULT_TIMEOUT_MS = 180_000;

function resolveBaseUrl(override?: string): string {
  const fromEnv = import.meta.env.VITE_JDE_BASE_URL as string | undefined;
  const raw = override ?? fromEnv ?? '/api/jde';
  return raw.replace(/\/+$/, '');
}

function resolveToken(override?: string): string | undefined {
  return override ?? (import.meta.env.VITE_JDE_TOKEN as string | undefined);
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  config: JdeClientConfig,
): Promise<T> {
  const baseUrl = resolveBaseUrl(config.baseUrl);
  const token = resolveToken(config.token);
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  if (!token) {
    throw new JdeApiError(
      'Falta VITE_JDE_TOKEN — configura el Bearer token en .env.local',
      401,
      path,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new JdeApiError(`Timeout llamando ${path}`, 408, path);
    }
    throw new JdeApiError(
      `Error de red llamando ${path}: ${e instanceof Error ? e.message : String(e)}`,
      0,
      path,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    let errBody: unknown;
    try { errBody = await res.json(); } catch { errBody = await res.text().catch(() => undefined); }
    throw new JdeApiError(
      `JDE ${path} respondió ${res.status} ${res.statusText}`,
      res.status,
      path,
      errBody,
    );
  }

  try {
    return (await res.json()) as T;
  } catch (e) {
    throw new JdeApiError(
      `Respuesta no es JSON válido (${path}): ${e instanceof Error ? e.message : String(e)}`,
      res.status,
      path,
    );
  }
}

export const jdeClient = {
  get:  <T>(path: string, config: JdeClientConfig = {}): Promise<T> =>
    request<T>('GET', path, undefined, config),
  post: <T>(path: string, body: unknown, config: JdeClientConfig = {}): Promise<T> =>
    request<T>('POST', path, body, config),
};
