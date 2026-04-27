/**
 * Cliente HTTP para los APIs de JD Edwards.
 *
 * Configuración:
 *   VITE_JDE_BASE_URL   — base URL (default: "/api/jde" via apiConfig)
 *   VITE_JDE_TOKEN      — Bearer credential (SOLO desarrollo local).
 *                         En producción el token vive en `JDE_TOKEN`
 *                         (server-side, sin prefijo VITE_) y lo inyecta la
 *                         Vercel Function `api/jde/[...path].ts`. Si la var
 *                         de entorno está vacía, este cliente delega la
 *                         autorización al proxy y NO manda Authorization
 *                         desde el navegador — así evitamos exponer la
 *                         credencial en el bundle público.
 *
 * En desarrollo el `base` default ("/api/jde") es reescrito por el proxy
 * configurado en vite.config.ts hacia https://api.gruposenda.com/v1/erp/tesoreria.
 * En producción, una serverless function (api/jde/[...path].ts) resuelve la
 * llamada inyectando el Bearer desde el secret server-side.
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
}

// Cada request a JDE tarda ~60s en producción. 90s estaba al filo y a veces
// reventaba con AbortError antes de que respondiera. 180s da margen real
// sin dejar requests colgados eternamente si algo se cuelga del lado server.
const DEFAULT_TIMEOUT_MS = 180_000;

function resolveBaseUrl(override?: string): string {
  // Usamos `||` en vez de `??` porque `apiConfig.jde.baseUrl` puede llegar
  // como string vacío si la env var existe pero está sin valor en Vercel.
  // Con `??` ese empty string ganaría y el cliente terminaría llamando a
  // rutas absolutas tipo `/empresas` que en producción cae en el rewrite
  // SPA y devuelve `index.html` (la app se quedaba cargando para siempre).
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

  // Cuando `baseUrl` apunta al proxy interno (`/api/jde` o similar relativo),
  // la credencial puede inyectarla la Vercel Function server-side. En ese caso
  // omitir el header Authorization es deliberado: evita filtrar el token al
  // navegador. Solo exigimos credencial si llamamos a un host externo directo.
  const isInternalProxy = /^\/(?!\/)/.test(baseUrl) || baseUrl === '';
  if (!authValue && !isInternalProxy) {
    throw new JdeApiError(
      'Falta credencial JDE — configura JDE_TOKEN (server-side) o VITE_JDE_TOKEN (solo dev)',
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
        ...(authValue ? { Authorization: `Bearer ${authValue}` } : {}),
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
