/**
 * Load clients from the local clientes-db.json catalog.
 *
 * The JSON lives in /public/clientes-db.json and is served by Vite at the
 * configured base path.
 * runtime. Each entry has: name, payDay, cycle, sales, creditDays, active.
 *
 * This loader converts raw JSON records into fully typed Client objects
 * with parsed PaymentDayPattern, so the collection engine can consume them.
 */

import { Client, Frequency, PaymentDayPattern } from './types';
import { parsePaymentDay, detectsFactoraje } from './parsePaymentDay';

interface RawClient {
  name: string;
  legalName?: string;
  rfc?: string;
  commercialGroupName?: string;
  commercialGroupId?: string;
  emailDomain?: string;
  address?: string;
  payDay: string;
  cycle: string;
  sales: number;
  creditDays: number;
  active?: boolean;
}

interface CatalogJSON {
  _meta?: Record<string, unknown>;
  clientes: RawClient[];
}

export function normalizeFrequency(cycle: string): Frequency {
  const c = cycle.toLowerCase().trim();
  if (c.includes('semanal') && !c.includes('quincenal')) return 'Semanal';
  if (c.includes('quincenal')) return 'Quincenal';
  if (c.includes('mensual')) return 'Mensual';
  // Match parseFrequencyStrict — accept any cadena containing "contado"
  // ("pago de contado", etc.), not only the exact word. Without this the
  // catalog said 'Mensual' for the same string the API overlay called
  // 'Contado', and the two layers disagreed on cadence.
  if (c.includes('contado')) return 'Contado';
  return 'Mensual';
}

/**
 * Como `normalizeFrequency` pero devuelve `null` cuando la cadena no contiene
 * ninguna cadencia reconocible (en vez de caer al default 'Mensual'). Útil
 * cuando la fuente es autoridad (API): no queremos pisar el catálogo con un
 * 'Mensual' por defecto si el API mandó algo no clasificable.
 */
export function parseFrequencyStrict(cycle: string): Frequency | null {
  const c = cycle.toLowerCase().trim();
  if (c.includes('semanal') && !c.includes('quincenal')) return 'Semanal';
  if (c.includes('quincenal')) return 'Quincenal';
  if (c.includes('mensual')) return 'Mensual';
  if (c === 'contado' || c.includes('contado')) return 'Contado';
  return null;
}

function rawToClient(raw: RawClient, index: number): Client {
  const pattern: PaymentDayPattern = parsePaymentDay(raw.payDay) ?? { kind: 'ANY' };
  const frequency = normalizeFrequency(raw.cycle);
  const monthlySales = raw.sales;

  // Spread sales evenly across 12 months (no seasonality from JSON)
  const monthlyBilling = new Array(12).fill(monthlySales);

  return {
    id: `catalog-${index}-${raw.name.slice(0, 20).replace(/\s+/g, '-').toLowerCase()}`,
    name: raw.name,
    legalName: raw.legalName,
    rfc: raw.rfc,
    commercialGroupName: raw.commercialGroupName,
    commercialGroupId: raw.commercialGroupId,
    emailDomain: raw.emailDomain,
    address: raw.address,
    paymentDayRaw: raw.payDay || undefined,
    paymentDay: pattern,
    frequency,
    creditDays: raw.creditDays,
    monthlyBilling,
    factoraje: detectsFactoraje(raw.payDay),
    complianceRate: undefined,
    notes: undefined,
  };
}

// Cache key (registrada en storageRegistry.ts).
// El parse del catálogo entero corre regex × N clientes (~52ms de RegExp
// reportados en el perf trace). El JSON es estático en /public/, así que
// cacheamos el Client[] ya parseado y lo reusamos cuando el hash del raw
// text coincide. Primer boot paga el parse; siguientes leen directo.
const CLIENTS_CATALOG_CACHE_KEY = 'midas.clientsCatalog.cache.v1';

interface ClientsCatalogCacheEntry {
  hash: string;
  parsedAt: string;
  clients: Client[];
}

/** Hash rápido del raw text (FNV-1a, suficiente como invalidador). */
function fastHash(value: string): string {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36) + ':' + value.length;
}

function readClientsCatalogCache(hash: string): Client[] | null {
  try {
    const raw = localStorage.getItem(CLIENTS_CATALOG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClientsCatalogCacheEntry;
    if (parsed.hash !== hash || !Array.isArray(parsed.clients)) return null;
    return parsed.clients;
  } catch {
    return null;
  }
}

function writeClientsCatalogCache(hash: string, clients: Client[]): void {
  try {
    const entry: ClientsCatalogCacheEntry = {
      hash,
      parsedAt: new Date().toISOString(),
      clients,
    };
    localStorage.setItem(CLIENTS_CATALOG_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Best-effort. Quota / storage disabled → seguimos sin cache.
  }
}

/**
 * Descarga el texto crudo de `clientes-db.json`.
 *
 * Prueba primero el `BASE_URL` configurado (p.ej. `/midas/clientes-db.json`)
 * y, si falla, cae al **root** del sitio (`/clientes-db.json`). Sin ese
 * fallback, un despliegue servido bajo un base distinto al que Vite bakea
 * (preview builds, un host que ignora `base`) hacía 404 y el catálogo quedaba
 * vacío para siempre — el bug "fetch roto en el catálogo de clientes". Si
 * NINGÚN candidato responde, **lanza** (antes se tragaba el error y regresaba
 * `[]`, indistinguible de un catálogo legítimamente vacío → el boot reportaba
 * "listo" con cero clientes y sin señal de error).
 */
async function fetchClientsCatalogText(): Promise<string> {
  const candidates = Array.from(
    new Set([
      `${import.meta.env.BASE_URL}clientes-db.json`,
      '/clientes-db.json',
      'clientes-db.json',
    ]),
  );
  let lastError: unknown;
  for (const url of candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        lastError = new Error(`clientes-db.json: HTTP ${res.status} en ${url}`);
        continue;
      }
      return await res.text();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('clientes-db.json: no se pudo descargar de ningún path candidato');
}

/**
 * Fetch and parse clientes-db.json.
 *
 * **Lanza** ante un fallo real (red, 404 en todos los paths, JSON inválido o
 * shape inesperado) para que el caller lo pueda distinguir de un catálogo
 * legítimamente vacío y surfacear el estado de error (boot slot / Salud de
 * datos) en vez de bootear en silencio con cero clientes. Un catálogo válido
 * pero sin clientes activos regresa `[]` sin lanzar.
 */
export async function loadClientsCatalog(): Promise<Client[]> {
  // Lee como texto primero para poder hashear antes del JSON.parse —
  // permite saltarse parse + regex × N si el cache tiene el mismo hash.
  const rawText = await fetchClientsCatalogText();
  const hash = fastHash(rawText);
  const cached = readClientsCatalogCache(hash);
  if (cached) return cached;

  let data: CatalogJSON;
  try {
    data = JSON.parse(rawText) as CatalogJSON;
  } catch {
    throw new Error('clientes-db.json: JSON inválido');
  }
  if (!Array.isArray(data.clientes)) {
    throw new Error('clientes-db.json: falta el arreglo "clientes"');
  }

  const clients = data.clientes
    .filter(c => c.active !== false)
    .map((c, i) => rawToClient(c, i));
  writeClientsCatalogCache(hash, clients);
  return clients;
}
