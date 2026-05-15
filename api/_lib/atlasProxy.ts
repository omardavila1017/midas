const DEFAULT_TIMEOUT_MS = 180_000;

export interface AtlasProxyRequest {
  method?: string;
  url?: string;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface AtlasProxyResponse {
  status(code: number): AtlasProxyResponse;
  setHeader(name: string, value: string): AtlasProxyResponse;
  send(body: unknown): void;
  json(body: unknown): void;
}

export interface AtlasProxyOptions {
  label: string;
  upstreamEnvVar: string;
  defaultUpstream: string;
  tokenEnvVar: string;
  extraHeaders?: Record<string, string | undefined>;
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function pathFromQuery(query: AtlasProxyRequest['query']): string {
  const rawPath = query?.path;
  const segments = Array.isArray(rawPath) ? rawPath : rawPath ? [rawPath] : [];
  return segments.map(encodeURIComponent).join('/');
}

export function createAtlasProxy(options: AtlasProxyOptions) {
  return async function atlasProxy(req: AtlasProxyRequest, res: AtlasProxyResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      res.status(405).json({ error: `Method ${method} not allowed` });
      return;
    }

    const token = process.env[options.tokenEnvVar];
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

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
        error: timeout ? `${options.label} upstream timeout` : `${options.label} upstream unreachable`,
      });
    }
  };
}
