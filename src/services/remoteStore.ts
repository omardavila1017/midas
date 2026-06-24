/**
 * Cliente del store compartido server-side (deployment de Omar Dávila).
 *
 * Por qué existe: hoy TODO el estado de Midas vive en localStorage + IndexedDB
 * por navegador, así que (a) los datos JDE/TRESS cacheados derivan entre
 * usuarios ("datos incorrectos / atorados") y (b) el trabajo capturado
 * (escenarios, propuestas, overrides) sólo existe en un navegador. Este cliente
 * habla con un store de documentos genérico server-side para volver esa data
 * la fuente compartida de verdad.
 *
 * Contrato (mismo-origen `/api/store`, proxy en api/store/[...path].ts →
 * STORE_UPSTREAM del deployment de Omar):
 *   GET    /api/store/{ns}/{key}        → { value, updatedAt } | 404
 *   PUT    /api/store/{ns}/{key}        → body { value }, upsert
 *   DELETE /api/store/{ns}/{key}
 *   GET    /api/store/{ns}              → manifest [{ key, updatedAt }]
 *   POST   /api/store/{ns}/batch-get    → body { keys } → { [key]: value }
 *
 * Diseño BEST-EFFORT: NINGÚN método tira excepciones ni bloquea el boot. Si el
 * store está apagado (VITE_STORE_ENABLED != 'true') o no responde, las lecturas
 * regresan null/[]/{} y las escrituras `false`, para que el caller caiga al
 * mirror local (localStorage/IDB) — misma filosofía que dailyApiCache/heavyStore.
 *
 * Toggle: `VITE_STORE_ENABLED='true'` enciende el store. OFF por default → la
 * app se comporta EXACTAMENTE como hoy (sin tocar la red de `/api/store`).
 */

export type StoreNamespace = 'planning' | 'cache';

export interface StoredDoc<T> {
  value: T;
  /** ISO timestamp del último upsert server-side. '' si el backend no lo expone. */
  updatedAt: string;
}

export interface ManifestEntry {
  key: string;
  updatedAt: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const RETRY_STATUSES = new Set([408, 502, 503, 504]);

// Se leen de `import.meta.env` en cada llamada (no se snapshotean en módulo)
// para que los tests puedan alternar con `vi.stubEnv` y para soportar un
// kill-switch sin rebuild en el deployment.
function storeEnabled(): boolean {
  return import.meta.env.VITE_STORE_ENABLED === 'true';
}

function storeBaseUrl(): string {
  const raw = (import.meta.env.VITE_STORE_BASE_URL as string | undefined) || '/api/store';
  return raw.replace(/\/+$/, '');
}

/** Las keys traen puntos/dos-puntos (no slashes en el scope actual). Se
 * encodean a UN solo segmento de path; el proxy las re-encoda por segmento. */
function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number): number {
  const base = 500;
  const cap = 4000;
  const exp = Math.min(cap, base * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

/**
 * Fetch con timeout + retry (solo estatus transitorios). Regresa el `Response`
 * o `null` si la red falla tras agotar reintentos. NUNCA tira.
 */
async function doFetch(method: string, subPath: string, body?: unknown): Promise<Response | null> {
  const url = `${storeBaseUrl()}/${subPath}`;
  for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // El proxy mismo-origen inyecta el token; mandamos la cookie de sesión.
        credentials: 'include',
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (RETRY_STATUSES.has(res.status) && attempt < DEFAULT_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      return res;
    } catch (error) {
      clearTimeout(timer);
      if (attempt < DEFAULT_RETRIES) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      // eslint-disable-next-line no-console
      console.warn('[remoteStore] request failed', {
        method,
        subPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as ManifestEntry).key === 'string',
  );
}

/** Lee un documento. `null` = apagado, ausente (404) o fallo de red. */
export async function getDoc<T>(ns: StoreNamespace, key: string): Promise<StoredDoc<T> | null> {
  if (!storeEnabled()) return null;
  const res = await doFetch('GET', `${enc(ns)}/${enc(key)}`);
  if (!res || !res.ok) return null;
  try {
    const json = (await res.json()) as unknown;
    // Tolerante al shape: { value, updatedAt } o el valor crudo directo.
    if (json && typeof json === 'object' && 'value' in (json as Record<string, unknown>)) {
      const doc = json as { value: T; updatedAt?: string };
      return { value: doc.value, updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : '' };
    }
    return { value: json as T, updatedAt: '' };
  } catch {
    return null;
  }
}

/** Upsert. `true` si el server confirmó (2xx). `false` = apagado o fallo. */
export async function putDoc<T>(ns: StoreNamespace, key: string, value: T): Promise<boolean> {
  if (!storeEnabled()) return false;
  const res = await doFetch('PUT', `${enc(ns)}/${enc(key)}`, { value });
  return Boolean(res && res.ok);
}

/** Borra un documento. `true` si el server confirmó. */
export async function deleteDoc(ns: StoreNamespace, key: string): Promise<boolean> {
  if (!storeEnabled()) return false;
  const res = await doFetch('DELETE', `${enc(ns)}/${enc(key)}`);
  return Boolean(res && res.ok);
}

/** Manifiesto liviano (key→updatedAt) para diffear sin bajar payloads pesados. */
export async function listManifest(ns: StoreNamespace): Promise<ManifestEntry[]> {
  if (!storeEnabled()) return [];
  const res = await doFetch('GET', `${enc(ns)}`);
  if (!res || !res.ok) return [];
  try {
    const json = (await res.json()) as unknown;
    if (Array.isArray(json)) return json.filter(isManifestEntry);
    return [];
  } catch {
    return [];
  }
}

/** Lectura por lote. `{}` = apagado, sin keys o fallo. */
export async function batchGet<T>(
  ns: StoreNamespace,
  keys: string[],
): Promise<Record<string, T>> {
  if (!storeEnabled() || keys.length === 0) return {};
  const res = await doFetch('POST', `${enc(ns)}/batch-get`, { keys });
  if (!res || !res.ok) return {};
  try {
    const json = (await res.json()) as unknown;
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      return json as Record<string, T>;
    }
    return {};
  } catch {
    return {};
  }
}

/** ¿El store compartido está encendido en este entorno? */
export function isRemoteStoreEnabled(): boolean {
  return storeEnabled();
}
