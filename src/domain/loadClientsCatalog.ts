/**
 * Load clients from the local clientes-db.json catalog.
 *
 * The JSON lives in /public/clientes-db.json and is served by Vite at
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

/**
 * Fetch and parse clientes-db.json from /public/.
 * Returns empty array on failure (network error, missing file, bad JSON).
 */
export async function loadClientsCatalog(): Promise<Client[]> {
  try {
    const res = await fetch('/clientes-db.json');
    if (!res.ok) return [];
    const data: CatalogJSON = await res.json();
    if (!Array.isArray(data.clientes)) return [];
    return data.clientes
      .filter(c => c.active !== false)
      .map((c, i) => rawToClient(c, i));
  } catch {
    return [];
  }
}
