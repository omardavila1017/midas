/**
 * Cliente HTTP para los APIs de JD Edwards.
 *
 * Configuración:
 *   VITE_JDE_BASE_URL   — base URL (default: "/api/jde" via apiConfig)
 *   VITE_JDE_TOKEN      — Bearer credential. En localhost queda embebido
 *                         en el bundle; al migrar a servidor con proxy real
 *                         el token debe regresar a un namespace server-side.
 *
 * El `base` default ("/api/jde") es reescrito por el proxy configurado en
 * vite.config.ts hacia https://api.gruposenda.com/v1/erp/tesoreria.
 */

import { JdeApiError } from './jdeTypes';
import { apiConfig } from '../config/api.config';

export interface JdeClientConfig {
  /** Base URL sin trailing slash. Default: import.meta.env.VITE_JDE_BASE_URL || "/api/jde". */
  baseUrl?: string;
  /** Bearer credential override. Default: import.meta.env.VITE_JDE_TOKEN. */
  authValue?: string;
  /** Timeout por request en ms. Default: 30_000. */
  timeoutMs?: number;
  /**
   * Intentos extra si el server responde 502/503/504/408 o hay timeout/red.
   * Default: 2 (3 intentos totales). Backoff exponencial con jitter.
   * Solo aplica a errores transitorios — 4xx no se reintenta.
   */
  retries?: number;
}

// JDE tarda ~60s típico. 120s da margen sin secuestrar el slot 3min+.
// Retries con backoff 0..4s. Si 3 intentos fallan, mejor degradar UI que
// quemar 8min en un sólo endpoint colgado.
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRIES = 2;
const RETRY_STATUSES = new Set([408, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number): number {
  const base = 1000;
  const cap = 4000;
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

function resolveBaseUrl(override?: string): string {
  // Usamos `||` en vez de `??` porque `apiConfig.jde.baseUrl` puede llegar
  // como string vacío si la env var existe pero sin valor; en ese caso
  // queremos caer al default "/api/jde" y no a rutas absolutas tipo
  // `/empresas` que no resuelven.
  const raw = override || apiConfig.jde.baseUrl || '/api/jde';
  return raw.replace(/\/+$/, '');
}

function resolveAuthValue(override?: string): string | undefined {
  return override ?? apiConfig.jde.authValue;
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  config: JdeClientConfig,
): Promise<T> {
  const baseUrl = resolveBaseUrl(config.baseUrl);
  const authValue = resolveAuthValue(config.authValue);
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  // Si `baseUrl` apunta al proxy interno (`/api/jde` o relativo), el header
  // Authorization viaja igual desde el cliente (Vite no inyecta nada). Solo
  // saltamos el guard cuando no hay credencial Y no hay host externo, para
  // dejar pasar el caso de proxy interno con auth inyectada a futuro.
  const isInternalProxy = /^\/(?!\/)/.test(baseUrl) || baseUrl === '';
  if (!authValue && !isInternalProxy) {
    throw new JdeApiError(
      'Falta credencial JDE — configura VITE_JDE_TOKEN',
      401,
      path,
    );
  }

  const maxRetries = config.retries ?? DEFAULT_RETRIES;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(authValue ? { Authorization: `Bearer ${authValue}` } : {}),
          Accept: 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      const isAbort = e instanceof DOMException && e.name === 'AbortError';
      lastErr = isAbort
        ? new JdeApiError(`Timeout llamando ${path}`, 408, path)
        : new JdeApiError(
            `Error de red llamando ${path}: ${e instanceof Error ? e.message : String(e)}`,
            0,
            path,
          );
      if (attempt < maxRetries) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastErr;
    }
    clearTimeout(timeout);

    if (!res.ok) {
      let errBody: unknown;
      try { errBody = await res.json(); } catch { errBody = await res.text().catch(() => undefined); }
      const err = new JdeApiError(
        `JDE ${path} respondió ${res.status} ${res.statusText}`,
        res.status,
        path,
        errBody,
      );
      if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
        lastErr = err;
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw err;
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

  throw lastErr ?? new JdeApiError(`JDE ${path} falló sin error`, 0, path);
}

export const jdeClient = {
  get:  <T>(path: string, config: JdeClientConfig = {}): Promise<T> =>
    request<T>('GET', path, undefined, config),
  post: <T>(path: string, body: unknown, config: JdeClientConfig = {}): Promise<T> =>
    request<T>('POST', path, body, config),
};
