/**
 * Cliente HTTP para los APIs de JD Edwards.
 *
 * Configuración:
 *   VITE_JDE_BASE_URL   — base URL (default: "/api/jde" via apiConfig)
 *   VITE_JDE_TOKEN      — local-dev fallback only. For `/api/jde` and
 *                         `/api/tress`, the browser delegates auth to the
 *                         Atlas/backend proxy.
 *
 * El `base` default ("/api/jde") es reescrito por el proxy configurado en
 * vite.config.ts hacia https://api.gruposenda.com/JDEdwards.
 */

import { JdeApiError } from './jdeTypes';
import { apiConfig } from '../config/api.config';

export interface JdeClientConfig {
  /** Base URL sin trailing slash. Default: import.meta.env.VITE_JDE_BASE_URL || "/api/jde". */
  baseUrl?: string;
  /** Bearer credential override for explicit external base URLs only. */
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

// ── Semáforo global de concurrencia ─────────────────────────────────────
//
// JDE backend trona cuando el boot lanza 12+ requests en paralelo (CXP ×
// cias + cobranza × cias × 2 endpoints + compras + pagoproveedor + banks
// + nómina + antigüedades). El servidor responde 504 cuando se satura,
// lo que dispara retries en cliente y empeora el storm.
//
// Solución: cap GLOBAL de requests concurrentes a JDE. Los endpoints
// siguen lanzando sus tareas en paralelo internamente, pero el cuello
// está aquí — solo MAX_CONCURRENT cruzan la red a la vez. El resto
// espera en FIFO.
//
// Default 3 = balance entre throughput y no romper JDE. Sube si el
// upstream demuestra que aguanta más, baja si sigue tronando.
const MAX_CONCURRENT_JDE = (() => {
  const raw = (import.meta.env?.VITE_JDE_MAX_CONCURRENT as string | undefined) ?? '3';
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();

let activeJdeRequests = 0;
const jdeWaitQueue: Array<() => void> = [];

function acquireJdeSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeJdeRequests < MAX_CONCURRENT_JDE) {
      activeJdeRequests += 1;
      resolve();
    } else {
      jdeWaitQueue.push(() => {
        activeJdeRequests += 1;
        resolve();
      });
    }
  });
}

function releaseJdeSlot(): void {
  activeJdeRequests = Math.max(0, activeJdeRequests - 1);
  const next = jdeWaitQueue.shift();
  if (next) next();
}

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

function isInternalProxy(baseUrl: string): boolean {
  return /^\/(?!\/)/.test(baseUrl) || baseUrl === '';
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  config: JdeClientConfig,
): Promise<T> {
  const baseUrl = resolveBaseUrl(config.baseUrl);
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const delegateAuthToProxy = isInternalProxy(baseUrl);
  const authValue = delegateAuthToProxy ? undefined : resolveAuthValue(config.authValue);
  if (!authValue && !delegateAuthToProxy) {
    throw new JdeApiError(
      'Falta credencial JDE para endpoint externo',
      401,
      path,
    );
  }

  const maxRetries = config.retries ?? DEFAULT_RETRIES;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // El semáforo va POR ATTEMPT — soltamos slot durante el backoff para
    // que otra request no quede bloqueada esperando un retry dormido.
    await acquireJdeSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(authValue ? { Authorization: ['Bearer', authValue].join(' ') } : {}),
          Accept: 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      releaseJdeSlot();
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
      releaseJdeSlot();
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
      const json = (await res.json()) as T;
      releaseJdeSlot();
      return json;
    } catch (e) {
      releaseJdeSlot();
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
