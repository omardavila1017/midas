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
 * Fetch and parse clientes-db.json from /public/.
 * Returns empty array on failure (network error, missing file, bad JSON).
 */
export async function loadClientsCatalog(): Promise<Client[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}clientes-db.json`);
    if (!res.ok) return [];
    // Lee como texto primero para poder hashear antes del JSON.parse —
    // permite saltarse parse + regex × N si el cache tiene el mismo hash.
    const rawText = await res.text();
    const hash = fastHash(rawText);
    const cached = readClientsCatalogCache(hash);
    if (cached) return cached;
    const data = JSON.parse(rawText) as CatalogJSON;
    if (!Array.isArray(data.clientes)) return [];
    const clients = data.clientes
      .filter(c => c.active !== false)
      .map((c, i) => rawToClient(c, i));
    writeClientsCatalogCache(hash, clients);
    return clients;
  } catch {
    return [];
  }
}
