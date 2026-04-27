/**
 * Vercel Serverless Function — proxy JDE.
 *
 * Por qué existe:
 *   El frontend NO debe llevar el Bearer del JDE en su bundle. Si lo lleva
 *   (con el prefijo `VITE_`), Vite lo "inlinea" en JavaScript público y
 *   cualquier visitante puede extraerlo desde DevTools y golpear directo a
 *   api.gruposenda.com con privilegios de tesorería.
 *
 *   Esta function corre en Vercel (entorno server-side) y:
 *     1. Lee el token desde `JDE_TOKEN` (env var SIN prefijo VITE_, no llega
 *        al cliente).
 *     2. Reescribe la ruta /api/jde/<path> → <JDE_UPSTREAM>/<path>.
 *     3. Inyecta el header Authorization: Bearer <JDE_TOKEN> hacia el upstream.
 *     4. Reenvía cuerpo, status y JSON al cliente.
 *
 * Compatibilidad:
 *   - En desarrollo (`npm run dev`) la function NO se ejecuta; el proxy de
 *     Vite (vite.config.ts) sigue haciendo el rewrite. Para dev local los
 *     desarrolladores siguen usando .env.local con VITE_JDE_TOKEN.
 *   - En producción (Vercel) esta function reemplaza el rewrite directo del
 *     vercel.json anterior. El frontend NUNCA ve el token.
 *
 * Variables de entorno requeridas en Vercel (Project → Settings → Env Vars):
 *   JDE_TOKEN        — Bearer credential (server-side, sin VITE_)
 *   JDE_UPSTREAM     — base URL del JDE (default: api.gruposenda.com/v1/erp/tesoreria)
 *
 * NOTA SEGURIDAD: esta function debe colocarse detrás de auth de Vercel
 * (Vercel Authentication o middleware) para que solo usuarios autenticados
 * de la app puedan invocarla. De lo contrario el endpoint público actuaría
 * como "open relay" hacia JDE.
 */

const DEFAULT_UPSTREAM = 'https://api.gruposenda.com/v1/erp/tesoreria';
const DEFAULT_TIMEOUT_MS = 180_000;

interface VercelRequest {
  method?: string;
  url?: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface VercelResponse {
  status(code: number): VercelResponse;
  setHeader(name: string, value: string): VercelResponse;
  send(body: unknown): void;
  json(body: unknown): void;
  end(body?: unknown): void;
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  const token = process.env.JDE_TOKEN;
  if (!token) {
    res.status(500).json({
      error: 'JDE proxy not configured',
      detail:
        'Define JDE_TOKEN (server-side, sin prefijo VITE_) en las env vars de Vercel.',
    });
    return;
  }

  const upstreamBase = (process.env.JDE_UPSTREAM ?? DEFAULT_UPSTREAM).replace(
    /\/+$/,
    '',
  );

  // Vercel pasa la wildcard `[...path]` como `req.query.path` (string[]).
  const rawPath = req.query.path;
  const pathSegments = Array.isArray(rawPath)
    ? rawPath
    : rawPath
    ? [rawPath]
    : [];
  const subPath = pathSegments.map(encodeURIComponent).join('/');

  // Conserva la querystring original que el cliente haya mandado
  // (Vercel no incluye `?` en req.url cuando viene del rewrite).
  const fullUrl = req.url ?? '';
  const qIdx = fullUrl.indexOf('?');
  const query = qIdx >= 0 ? fullUrl.slice(qIdx) : '';

  const targetUrl = `${upstreamBase}/${subPath}${query}`;

  // El método y el body vienen del cliente; el header Authorization se
  // sobrescribe con el secret server-side. El resto de headers seguros se
  // reenvían (Accept, Content-Type).
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
    // Log para Vercel logs: ayuda a distinguir entre maxDuration cortado por
    // Vercel (no llegamos aquí, la function muere) y AbortError nuestro a
    // los 180s. Si vuelven a aparecer 504s en backfill, revisar maxDuration.
    // eslint-disable-next-line no-console
    console.error(
      `[jde-proxy] ${method} ${subPath} → ${
        isAbort ? 'timeout 180s' : 'unreachable'
      }: ${e instanceof Error ? e.message : String(e)}`,
    );
    res.status(isAbort ? 504 : 502).json({
      error: isAbort ? 'JDE upstream timeout' : 'JDE upstream unreachable',
    });
    return;
  }
  clearTimeout(timer);

  // Reenviar Content-Type del upstream cuando exista; si no, asumir JSON.
  const upstreamCt = upstreamRes.headers.get('content-type') ?? 'application/json';
  res.setHeader('Content-Type', upstreamCt);
  res.setHeader('Cache-Control', 'no-store');

  const buf = await upstreamRes.arrayBuffer();
  res.status(upstreamRes.status);
  res.send(Buffer.from(buf));
}

export const config = {
  // Vercel Edge no expone Node Buffer y limita tamaño de respuesta. Tesorería
  // a veces devuelve 5–15 MB de movimientos bancarios → usamos Node runtime.
  runtime: 'nodejs',
  // CRÍTICO: cada request a /bancos en JDE tarda ~60s. Sin maxDuration la
  // function se mata con el default de Vercel (10–15s) y el backfill anual
  // pierde casi todos los días — el frontend ve solo 2–3 días recientes.
  // 300s es el máximo del plan Pro y deja margen real sobre el timeout
  // interno del fetch (180s).
  maxDuration: 300,
};
