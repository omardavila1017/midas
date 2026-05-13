/**
 * Factory compartida para los proxies serverless hacia JD Edwards / TRESS.
 *
 * Por qué existe:
 *   El frontend NO debe llevar el Bearer del JDE en su bundle (ver
 *   notas en api/jde/[...path].ts). Tenemos dos namespaces upstream:
 *     - /v1/erp/tesoreria (CXP, bancos, cobranza)   → /api/jde/*
 *     - /v1/erp/tress     (nómina)                  → /api/tress/*
 *   Ambos comparten host, token y semántica de proxy. Esta factory captura
 *   el handler común; cada proxy concreto sólo declara su env var y upstream.
 *
 * Compatibilidad:
 *   - En desarrollo el proxy de Vite (vite.config.ts) hace el rewrite y la
 *     factory no se ejecuta.
 *   - En producción (Vercel) la factory inyecta el `Bearer` desde un secret
 *     server-side. Ambos namespaces comparten el mismo token `JDE_TOKEN`.
 */

const DEFAULT_TIMEOUT_MS = 180_000;

export interface VercelRequest {
  method?: string;
  url?: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface VercelResponse {
  status(code: number): VercelResponse;
  setHeader(name: string, value: string): VercelResponse;
  send(body: unknown): void;
  json(body: unknown): void;
  end(body?: unknown): void;
}

export interface JdeProxyOptions {
  /** Nombre de la env var server-side que apunta al upstream. */
  upstreamEnvVar: string;
  /** Upstream usado si la env var no está definida. */
  defaultUpstream: string;
  /** Etiqueta corta usada en logs (ej. "jde", "tress"). */
  label: string;
}

type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void>;

export function createJdeProxy(options: JdeProxyOptions): Handler {
  const { upstreamEnvVar, defaultUpstream, label } = options;

  return async function handler(req, res): Promise<void> {
    const token = process.env.JDE_TOKEN;
    if (!token) {
      res.status(500).json({
        error: `${label} proxy not configured`,
        detail:
          'Define JDE_TOKEN (server-side, sin prefijo VITE_) en las env vars de Vercel.',
      });
      return;
    }

    const upstreamBase = (process.env[upstreamEnvVar] ?? defaultUpstream).replace(
      /\/+$/,
      '',
    );

    const rawPath = req.query.path;
    const pathSegments = Array.isArray(rawPath)
      ? rawPath
      : rawPath
      ? [rawPath]
      : [];
    const subPath = pathSegments.map(encodeURIComponent).join('/');

    const fullUrl = req.url ?? '';
    const qIdx = fullUrl.indexOf('?');
    const query = qIdx >= 0 ? fullUrl.slice(qIdx) : '';

    const targetUrl = `${upstreamBase}/${subPath}${query}`;

    const method = (req.method ?? 'GET').toUpperCase();
    const allowedMethods = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
    if (!allowedMethods.has(method)) {
      res.status(405).json({ error: `Método ${method} no permitido` });
      return;
    }

    const outgoingHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
    const ct = req.headers['content-type'];
    if (typeof ct === 'string' && ct) outgoingHeaders['Content-Type'] = ct;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(targetUrl, {
        method,
        headers: outgoingHeaders,
        body:
          method === 'GET' || method === 'DELETE' || req.body === undefined
            ? undefined
            : typeof req.body === 'string'
            ? req.body
            : JSON.stringify(req.body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const isAbort = e instanceof Error && e.name === 'AbortError';
      // eslint-disable-next-line no-console
      console.error(
        `[${label}-proxy] ${method} ${subPath} → ${
          isAbort ? 'timeout 180s' : 'unreachable'
        }: ${e instanceof Error ? e.message : String(e)}`,
      );
      res.status(isAbort ? 504 : 502).json({
        error: isAbort
          ? `${label} upstream timeout`
          : `${label} upstream unreachable`,
      });
      return;
    }
    clearTimeout(timer);

    const upstreamCt = upstreamRes.headers.get('content-type') ?? 'application/json';
    res.setHeader('Content-Type', upstreamCt);
    res.setHeader('Cache-Control', 'no-store');

    const buf = await upstreamRes.arrayBuffer();
    res.status(upstreamRes.status);
    res.send(Buffer.from(buf));
  };
}

export const proxyConfig = {
  // Vercel Edge no expone Node Buffer y limita tamaño de respuesta. Tesorería
  // a veces devuelve 5–15 MB de movimientos bancarios → usamos Node runtime.
  runtime: 'nodejs' as const,
  // CRÍTICO: cada request a /bancos en JDE tarda ~60s. Sin maxDuration la
  // function se mata con el default de Vercel (10–15s) y el backfill anual
  // pierde casi todos los días — el frontend ve solo 2–3 días recientes.
  // 300s es el máximo del plan Pro y deja margen real sobre el timeout
  // interno del fetch (180s).
  maxDuration: 300,
};
