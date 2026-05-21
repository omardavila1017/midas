import {
  CashFlowAssumptions,
  Client,
  ConfirmedPayment,
  eventKey,
} from './types';
import { projectClientMonth, projectYear } from './collectionEngine';
import type { CobranzaRecord } from '../services/jdeTypes';

/**
 * Source de la agrupación. Ordenado por autoridad (mayor a menor):
 *   'jde-padre' → autoridad JDE (Nombre_Cliente_Padre); no editable.
 *   'manual'    → override del usuario; gana sobre heurística pero no sobre JDE.
 *   'rfc' / 'domain' / 'address' / 'name' → heurística automática.
 *   'single'    → cuenta sola, sin grupo detectable.
 */
export type ClientGroupSource = 'jde-padre' | 'manual' | 'rfc' | 'domain' | 'address' | 'name' | 'single';

/**
 * `49080179` "Resto Clientes" es un bucket genérico de JDE para huérfanos sin
 * padre real asignado. NO debe colapsar todos esos clientes en un solo grupo;
 * los tratamos como individuales.
 */
const RESTO_CLIENTES_PADRE_ID = '49080179';

export interface ClientAccountNode {
  client: Client;
  annualSales: number;
  projectedReceivable: number;
  pendingInvoices: number;
  confirmedCollections: number;
  confirmedInvoices: number;
  /** Lag promedio en días (puede ser fraccional). Histórico cuando hay paid invoices, proyección sino. */
  avgLagDays: number;
  /** Días de crédito según JDE (Dias_Credito) o catálogo si no hay API. */
  creditDaysApi: number;
  /** Días extra sobre crédito contractual = max(0, realCreditDays - creditDaysApi). */
  lagDaysExtra: number;
  /** Días totales hasta cobro real = creditDaysApi + lagDaysExtra. */
  realCreditDays: number;
  /** Día de pago preferido (Nombre_Dia_Pago_CC13), p.ej. "Viernes". Vacío si no API. */
  paymentDayName: string;
}

export interface ClientGroupNode {
  id: string;
  name: string;
  source: ClientGroupSource;
  confidence: number;
  signal: string;
  accounts: ClientAccountNode[];
  annualSales: number;
  projectedReceivable: number;
  pendingInvoices: number;
  confirmedCollections: number;
  confirmedInvoices: number;
  avgLagDays: number;
  /** Promedio de creditDaysApi de las cuentas del grupo. */
  creditDaysApi: number;
  lagDaysExtra: number;
  realCreditDays: number;
}

interface GroupSignal {
  id: string;
  name: string;
  source: ClientGroupSource;
  confidence: number;
  signal: string;
}

export interface BuildClientHierarchyOptions {
  assumptions?: CashFlowAssumptions;
  confirmedPayments?: ConfirmedPayment[];
  today?: string;
  /**
   * Cobranza records — fuente de verdad para Nombre_Cliente_Padre,
   * Dias_Credito numérico, día de pago preferido, y lag real de cobro.
   * Cuando un cliente tiene jdeAccounts matched con cobranza, la agrupación
   * pasa a source 'jde-padre' (autoridad JDE) y los días de crédito vienen
   * del API en vez del catálogo manual.
   */
  cobranzaRecords?: CobranzaRecord[];
}

/**
 * Datos derivados por (cia, noCliente) desde cobranza. Indexado por la llave
 * compuesta `${cia}::${noCliente}` que usa el matcher. Las llaves padre se
 * comparten entre múltiples cuentas — el lookup devuelve el primer match.
 */
interface CobranzaAccountInfo {
  noClientePadre?: string;
  nombreClientePadre?: string;
  diasCredito?: number;
  diaPagoNombre?: string;
  /** Samples de (Fecha_Pago - Fecha_Factura) en días para facturas pagadas. */
  lagSamples: number[];
}

function buildCobranzaAccountInfo(records: CobranzaRecord[]): Map<string, CobranzaAccountInfo> {
  const map = new Map<string, CobranzaAccountInfo>();
  for (const rec of records) {
    if (!rec.cia || !rec.noCliente) continue;
    const key = `${rec.cia}::${rec.noCliente}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { lagSamples: [] };
      map.set(key, entry);
    }
    // Tomar el más reciente que esté poblado — los registros se procesan en
    // orden cronológico arbitrario; el último gana cuando hay conflicto.
    if (rec.noClientePadre && !entry.noClientePadre) entry.noClientePadre = rec.noClientePadre;
    if (rec.nombreClientePadre && !entry.nombreClientePadre) entry.nombreClientePadre = rec.nombreClientePadre;
    if (rec.diasCredito && !entry.diasCredito) entry.diasCredito = rec.diasCredito;
    if (rec.diaPagoNombre && !entry.diaPagoNombre) entry.diaPagoNombre = rec.diaPagoNombre;
    // Lag sample: factura cobrada con ambas fechas válidas.
    if (rec.fechaFactura && rec.fechaCobro && rec.importePendientePesos === 0) {
      const facturaMs = Date.parse(rec.fechaFactura);
      const cobroMs = Date.parse(rec.fechaCobro);
      if (Number.isFinite(facturaMs) && Number.isFinite(cobroMs) && cobroMs >= facturaMs) {
        const lag = Math.round((cobroMs - facturaMs) / 86_400_000);
        if (lag >= 0 && lag <= 365) entry.lagSamples.push(lag);
      }
    }
  }
  return map;
}

/**
 * Combina la info JDE de todas las cuentas matched del cliente. Para campos
 * únicos (padre, creditDays, diaPago) toma del primero poblado. Para lag,
 * concatena samples de todas las cuentas.
 */
function infoForClient(
  client: Client,
  byAccount: Map<string, CobranzaAccountInfo>,
): CobranzaAccountInfo | null {
  const links = client.jdeAccounts ?? [];
  if (links.length === 0) return null;
  let noClientePadre: string | undefined;
  let nombreClientePadre: string | undefined;
  let diasCredito: number | undefined;
  let diaPagoNombre: string | undefined;
  const lagSamples: number[] = [];
  let anyFound = false;
  for (const link of links) {
    const entry = byAccount.get(`${link.cia}::${link.noCliente}`);
    if (!entry) continue;
    anyFound = true;
    if (entry.noClientePadre && !noClientePadre) noClientePadre = entry.noClientePadre;
    if (entry.nombreClientePadre && !nombreClientePadre) nombreClientePadre = entry.nombreClientePadre;
    if (entry.diasCredito && !diasCredito) diasCredito = entry.diasCredito;
    if (entry.diaPagoNombre && !diaPagoNombre) diaPagoNombre = entry.diaPagoNombre;
    lagSamples.push(...entry.lagSamples);
  }
  if (!anyFound) return null;
  return { noClientePadre, nombreClientePadre, diasCredito, diaPagoNombre, lagSamples };
}

const KNOWN_BRANDS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b3M\b/, label: '3M' },
  { pattern: /\bABB\b/, label: 'ABB' },
  { pattern: /\bAPTIV\b/, label: 'Aptiv' },
  { pattern: /\bCARRIER\b/, label: 'Carrier' },
  { pattern: /\bCATERPILLAR\b/, label: 'Caterpillar' },
  { pattern: /\bCEMEX\b/, label: 'Cemex' },
  { pattern: /\bCORNING\b/, label: 'Corning' },
  { pattern: /\bCUMMINS\b/, label: 'Cummins' },
  { pattern: /\bDAIMLER\b/, label: 'Daimler' },
  { pattern: /\bDENSO\b/, label: 'Denso' },
  { pattern: /\bFEMSA\b/, label: 'Femsa' },
  { pattern: /\bGENERAL MOTORS\b|\bGM\b/, label: 'General Motors' },
  { pattern: /\bJOHNSON CONTROLS\b/, label: 'Johnson Controls' },
  { pattern: /\bKIA\b/, label: 'Kia' },
  { pattern: /\bLEAR\b/, label: 'Lear' },
  { pattern: /\bMAGNA\b/, label: 'Magna' },
  { pattern: /\bNEMAK\b/, label: 'Nemak' },
  { pattern: /\bPEPSICO\b|\bPEPSI\b/, label: 'Pepsico' },
  { pattern: /\bTERNIUM\b/, label: 'Ternium' },
  { pattern: /\bTOYOTA\b/, label: 'Toyota' },
  { pattern: /\bWHIRLPOOL\b/, label: 'Whirlpool' },
  { pattern: /\bYAZAKI\b/, label: 'Yazaki' },
];

const LEGAL_WORDS = new Set([
  'A', 'AC', 'AS', 'C', 'CV', 'DE', 'DEL', 'EL', 'EN', 'LA', 'LAS', 'LOS', 'MI',
  'MEX', 'MEXICO', 'MEXICANA', 'MEXICANO', 'MEXICANOS', 'NACIONAL', 'NORTE',
  'OF', 'PARA', 'POR', 'S', 'SA', 'SAB', 'SAPI', 'SC', 'SNC', 'SOFOM', 'SRL',
]);

const GENERIC_PREFIXES = new Set([
  'ASOCIACION', 'BANCA', 'BANCO', 'CENTRO', 'COMERCIAL', 'COMERCIALIZADORA',
  'COMPANIA', 'CONSORCIO', 'CONSTRUCTORA', 'CORPORACION', 'DISTRIBUIDORA',
  'EMPRESA', 'ENVASES', 'FABRICA', 'FUNDACION', 'GRUPO', 'INDUSTRIAS',
  'INDUSTRIAL', 'INSTITUTO', 'LOGISTICA', 'OPERADORA', 'SERVICIOS',
  'SISTEMAS', 'TRANSPORTES',
]);

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'hotmail.com', 'outlook.com', 'live.com', 'yahoo.com',
]);

function removeDiacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeClientText(value: string | undefined | null): string {
  if (!value) return '';
  return removeDiacritics(value)
    .toUpperCase()
    .replace(/&/g, ' Y ')
    .replace(/[^A-Z0-9\s.]/g, ' ')
    .replace(/\bS\.?\s*A\.?\s*(DE)?\s*C\.?\s*V\.?\b/g, ' ')
    .replace(/\bS\.?\s*DE\s*R\.?\s*L\.?\b/g, ' ')
    .replace(/\bS\.?\s*A\.?\s*P\.?\s*I\.?\b/g, ' ')
    .replace(/\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function commercialGroupId(name: string): string {
  const slug = normalizeClientText(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `client-group-${slug || 'sin-nombre'}`;
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (word.length <= 3 && /\d/.test(word)) return word.toUpperCase();
      if (word.length <= 3 && word === word.toUpperCase()) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

function normalizeRfc(value: string | undefined): string {
  return normalizeClientText(value).replace(/\s+/g, '');
}

function normalizeDomain(value: string | undefined): string {
  if (!value) return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('@')
    .pop() ?? '';
}

function findKnownBrand(normalizedName: string): string | null {
  for (const entry of KNOWN_BRANDS) {
    if (entry.pattern.test(normalizedName)) return entry.label;
  }
  return null;
}

function significantTokens(value: string): string[] {
  return normalizeClientText(value)
    .split(/\s+/)
    .filter((token) => token.length > 1 && !LEGAL_WORDS.has(token));
}

function inferNameSignal(client: Client): GroupSignal {
  const normalized = normalizeClientText(client.legalName || client.name);
  const knownBrand = findKnownBrand(normalized);
  if (knownBrand) {
    return {
      id: commercialGroupId(knownBrand),
      name: knownBrand,
      source: 'name',
      confidence: 0.86,
      signal: `marca detectada: ${knownBrand}`,
    };
  }

  const tokens = significantTokens(client.legalName || client.name);
  if (tokens.length === 0) {
    return {
      id: commercialGroupId(client.name),
      name: client.name,
      source: 'single',
      confidence: 0.35,
      signal: 'sin tokens suficientes',
    };
  }

  const [first, second, third] = tokens;
  const groupTokens = GENERIC_PREFIXES.has(first) && second
    ? [first, second, third].filter(Boolean)
    : [first];
  const name = titleCase(groupTokens.join(' '));

  return {
    id: commercialGroupId(name),
    name,
    source: 'name',
    confidence: groupTokens.length > 1 ? 0.64 : 0.7,
    signal: `nombre: ${groupTokens.join(' ')}`,
  };
}

function groupSignalForClient(client: Client, jdeInfo: CobranzaAccountInfo | null): GroupSignal {
  // Autoridad JDE: padre comercial declarado por el API gana sobre todo,
  // excepto el bucket genérico "Resto Clientes" que se trata como individual.
  if (jdeInfo?.noClientePadre && jdeInfo.noClientePadre !== RESTO_CLIENTES_PADRE_ID && jdeInfo.nombreClientePadre) {
    return {
      id: `client-padre-${jdeInfo.noClientePadre}`,
      name: titleCase(jdeInfo.nombreClientePadre),
      source: 'jde-padre',
      confidence: 1,
      signal: `JDE padre ${jdeInfo.noClientePadre}`,
    };
  }

  if (client.commercialGroupName?.trim()) {
    const name = client.commercialGroupName.trim();
    return {
      id: client.commercialGroupId || commercialGroupId(name),
      name,
      source: 'manual',
      confidence: 1,
      signal: 'corregido manualmente',
    };
  }

  const rfc = normalizeRfc(client.rfc);
  if (rfc.length >= 10) {
    return {
      id: `client-rfc-${rfc}`,
      name: titleCase(significantTokens(client.legalName || client.name).slice(0, 2).join(' ') || client.name),
      source: 'rfc',
      confidence: 0.97,
      signal: `RFC ${rfc}`,
    };
  }

  const domain = normalizeDomain(client.emailDomain);
  if (domain && !FREE_EMAIL_DOMAINS.has(domain)) {
    const label = domain.split('.')[0];
    return {
      id: `client-domain-${domain.replace(/[^a-z0-9]+/g, '-')}`,
      name: titleCase(label),
      source: 'domain',
      confidence: 0.9,
      signal: `dominio ${domain}`,
    };
  }

  const address = normalizeClientText(client.address);
  if (address.length >= 24) {
    return {
      id: `client-address-${address.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48)}`,
      name: titleCase(significantTokens(client.legalName || client.name).slice(0, 2).join(' ') || client.name),
      source: 'address',
      confidence: 0.55,
      signal: 'dirección fiscal similar',
    };
  }

  return inferNameSignal(client);
}

function annualSales(client: Client): number {
  return client.monthlyBilling.reduce((sum, value) => sum + value, 0);
}

function accountNode(
  client: Client,
  assumptions: CashFlowAssumptions,
  confirmedSet: Set<string>,
  today: string,
  jdeInfo: CobranzaAccountInfo | null,
): ClientAccountNode {
  const yearEvents = projectYear([client], assumptions);
  const pendingEvents = yearEvents.filter((event) => event.realDate >= today && !confirmedSet.has(eventKey(event)));
  const confirmedEvents = yearEvents.filter((event) => confirmedSet.has(eventKey(event)));

  // Días de crédito: prioriza API JDE. Fallback al catálogo manual del cliente.
  const creditDaysApi = jdeInfo?.diasCredito ?? client.creditDays;

  // Lag real desde cobranza histórica:
  // realCreditDays = avg(Fecha_Pago - Fecha_Factura) cuando hay samples reales.
  // Sin samples cae al lag proyectado por el motor (regla teórica de día pago).
  let realCreditDays: number;
  let avgLagDays: number;
  if (jdeInfo && jdeInfo.lagSamples.length >= 3) {
    // 3+ facturas pagadas → confiable usar promedio real.
    const meanLag = jdeInfo.lagSamples.reduce((s, v) => s + v, 0) / jdeInfo.lagSamples.length;
    realCreditDays = Math.round(meanLag);
    avgLagDays = Math.max(0, realCreditDays - creditDaysApi);
  } else {
    // Sin samples reales: usa motor de proyección (snap a día semanal).
    avgLagDays = yearEvents.length > 0
      ? yearEvents.reduce((sum, event) => sum + event.lagDays, 0) / yearEvents.length
      : projectClientMonth(client, assumptions.year, new Date(`${today}T12:00:00`).getMonth(), assumptions)
          .reduce((sum, event, _, arr) => sum + event.lagDays / Math.max(arr.length, 1), 0);
    realCreditDays = creditDaysApi + Math.max(0, Math.round(avgLagDays));
  }

  const lagDaysExtra = Math.max(0, realCreditDays - creditDaysApi);
  const projectedReceivable = pendingEvents.reduce((sum, event) => sum + event.amount, 0);

  return {
    client,
    annualSales: annualSales(client),
    projectedReceivable,
    pendingInvoices: pendingEvents.length,
    confirmedCollections: confirmedEvents.reduce((sum, event) => sum + event.amount, 0),
    confirmedInvoices: confirmedEvents.length,
    avgLagDays,
    creditDaysApi,
    lagDaysExtra,
    realCreditDays,
    paymentDayName: jdeInfo?.diaPagoNombre ?? client.paymentDayName ?? '',
  };
}

function finalizeGroup(signal: GroupSignal, accounts: ClientAccountNode[]): ClientGroupNode {
  accounts.sort((a, b) => b.annualSales - a.annualSales || a.client.name.localeCompare(b.client.name, 'es'));

  const annual = accounts.reduce((sum, account) => sum + account.annualSales, 0);
  const receivable = accounts.reduce((sum, account) => sum + account.projectedReceivable, 0);
  const pending = accounts.reduce((sum, account) => sum + account.pendingInvoices, 0);
  const confirmedCollections = accounts.reduce((sum, account) => sum + account.confirmedCollections, 0);
  const confirmedInvoices = accounts.reduce((sum, account) => sum + account.confirmedInvoices, 0);
  const avgLag = accounts.length
    ? accounts.reduce((sum, account) => sum + account.avgLagDays, 0) / accounts.length
    : 0;
  const creditApi = accounts.length
    ? Math.round(accounts.reduce((sum, account) => sum + account.creditDaysApi, 0) / accounts.length)
    : 0;
  const realCredit = accounts.length
    ? Math.round(accounts.reduce((sum, account) => sum + account.realCreditDays, 0) / accounts.length)
    : 0;
  const lagExtra = Math.max(0, realCredit - creditApi);

  return {
    ...signal,
    source: accounts.length === 1 && signal.source === 'name' ? 'single' : signal.source,
    confidence: accounts.length === 1 && signal.source === 'name' ? Math.min(signal.confidence, 0.45) : signal.confidence,
    accounts,
    annualSales: annual,
    projectedReceivable: receivable,
    pendingInvoices: pending,
    confirmedCollections,
    confirmedInvoices,
    avgLagDays: avgLag,
    creditDaysApi: creditApi,
    lagDaysExtra: lagExtra,
    realCreditDays: realCredit,
  };
}

export function buildClientHierarchy(
  clients: Client[],
  options: BuildClientHierarchyOptions = {},
): ClientGroupNode[] {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const assumptions = options.assumptions ?? {
    year: Number(today.slice(0, 4)),
    globalCompliance: 1,
    factorajeDays: 30,
  };
  const confirmedSet = new Set((options.confirmedPayments ?? []).map((payment) => payment.key));
  const cobranzaByAccount = buildCobranzaAccountInfo(options.cobranzaRecords ?? []);

  const groups = new Map<string, { signal: GroupSignal; accounts: ClientAccountNode[] }>();

  for (const client of clients) {
    const jdeInfo = infoForClient(client, cobranzaByAccount);
    const signal = groupSignalForClient(client, jdeInfo);
    const current = groups.get(signal.id) ?? { signal, accounts: [] };
    current.accounts.push(accountNode(client, assumptions, confirmedSet, today, jdeInfo));
    // JDE-padre gana sobre cualquier otra señal del grupo (autoridad API).
    if (signal.source === 'jde-padre') current.signal = signal;
    else if (signal.source === 'manual' && current.signal.source !== 'jde-padre') current.signal = signal;
    groups.set(signal.id, current);
  }

  return Array.from(groups.values())
    .map((group) => finalizeGroup(group.signal, group.accounts))
    .sort((a, b) => b.annualSales - a.annualSales || a.name.localeCompare(b.name, 'es'));
}
