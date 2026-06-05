const DEFAULT_TIMEOUT_MS = 300_000;

export interface ApiProxyRequest {
  method?: string;
  url?: string;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ApiProxyResponse {
  status(code: number): ApiProxyResponse;
  setHeader(name: string, value: string): ApiProxyResponse;
  send(body: unknown): void;
  json(body: unknown): void;
}

export interface ApiProxyOptions {
  label: string;
  upstreamEnvVar: string;
  defaultUpstream: string;
  tokenEnvVar: string;
  fallbackTokenEnvVar?: string;
  extraHeaders?: Record<string, string | undefined>;
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function pathFromQuery(query: ApiProxyRequest['query']): string {
  const rawPath = query?.path;
  const segments = Array.isArray(rawPath) ? rawPath : rawPath ? [rawPath] : [];
  return segments.map(encodeURIComponent).join('/');
}

function resolveTimeoutMs(label: string): number {
  const scoped = process.env[`${label.toUpperCase()}_PROXY_TIMEOUT_MS`];
  const shared = process.env.API_PROXY_TIMEOUT_MS;
  const raw = scoped ?? shared;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_TIMEOUT_MS;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

export function createApiProxy(options: ApiProxyOptions) {
  return async function apiProxy(req: ApiProxyRequest, res: ApiProxyResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      res.status(405).json({ error: `Method ${method} not allowed` });
      return;
    }

    const token = process.env[options.tokenEnvVar] || (
      options.fallbackTokenEnvVar ? process.env[options.fallbackTokenEnvVar] : undefined
    );
    const upstreamBase = (process.env[options.upstreamEnvVar] ?? options.defaultUpstream).replace(/\/+$/, '');
    if (!token || !upstreamBase) {
      res.status(500).json({ error: `${options.label} proxy not configured` });
      return;
    }

    const subPath = pathFromQuery(req.query);
    const fullUrl = req.url ?? '';
    const queryIndex = fullUrl.indexOf('?');
    const query = queryIndex >= 0 ? fullUrl.slice(queryIndex) : '';
    const targetUrl = `${upstreamBase}/${subPath}${query}`;

    const outgoingHeaders: Record<string, string> = {
      Authorization: ['Bearer', token].join(' '),
      Accept: 'application/json',
    };
    const contentType = req.headers?.['content-type'];
    if (typeof contentType === 'string' && contentType) outgoingHeaders['Content-Type'] = contentType;
    for (const [key, value] of Object.entries(options.extraHeaders ?? {})) {
      if (value) outgoingHeaders[key] = value;
    }

    const timeoutMs = resolveTimeoutMs(options.label);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const upstreamRes = await fetch(targetUrl, {
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
      clearTimeout(timer);

      res.setHeader('Content-Type', upstreamRes.headers.get('content-type') ?? 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.status(upstreamRes.status);
      res.send(await upstreamRes.text());
    } catch (error) {
      clearTimeout(timer);
      const timeout = error instanceof Error && error.name === 'AbortError';
      res.status(timeout ? 504 : 502).json({
        error: timeout ? `${options.label} upstream timeout after ${timeoutMs}ms` : `${options.label} upstream unreachable`,
      });
    }
  };
}
