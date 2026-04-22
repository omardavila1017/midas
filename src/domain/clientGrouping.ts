import {
  CashFlowAssumptions,
  Client,
  ConfirmedPayment,
  eventKey,
} from './types';
import { projectClientMonth, projectYear } from './collectionEngine';

export type ClientGroupSource = 'manual' | 'rfc' | 'domain' | 'address' | 'name' | 'single';
export type ClientRisk = 'Alto' | 'Medio' | 'Bajo';

export interface ClientAccountNode {
  client: Client;
  annualSales: number;
  projectedReceivable: number;
  pendingInvoices: number;
  confirmedCollections: number;
  confirmedInvoices: number;
  avgLagDays: number;
  realCreditDays: number;
  risk: ClientRisk;
  riskReason: string;
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
  realCreditDays: number;
  risk: ClientRisk;
  riskReason: string;
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

function groupSignalForClient(client: Client): GroupSignal {
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

function riskForMetrics(realCreditDays: number, avgLagDays: number, projectedReceivable: number): { risk: ClientRisk; reason: string } {
  if (realCreditDays >= 90 || avgLagDays > 20 || projectedReceivable >= 5_000_000) {
    return { risk: 'Alto', reason: 'crédito real alto, lag relevante o saldo proyectado material' };
  }
  if (realCreditDays >= 60 || avgLagDays > 7 || projectedReceivable >= 1_000_000) {
    return { risk: 'Medio', reason: 'requiere seguimiento por crédito, lag o saldo proyectado' };
  }
  return { risk: 'Bajo', reason: 'crédito y saldo proyectado dentro de rango normal' };
}

function accountNode(
  client: Client,
  assumptions: CashFlowAssumptions,
  confirmedSet: Set<string>,
  today: string,
): ClientAccountNode {
  const yearEvents = projectYear([client], assumptions);
  const pendingEvents = yearEvents.filter((event) => event.realDate >= today && !confirmedSet.has(eventKey(event)));
  const confirmedEvents = yearEvents.filter((event) => confirmedSet.has(eventKey(event)));
  const avgLagDays = yearEvents.length > 0
    ? yearEvents.reduce((sum, event) => sum + event.lagDays, 0) / yearEvents.length
    : projectClientMonth(client, assumptions.year, new Date(`${today}T12:00:00`).getMonth(), assumptions)
        .reduce((sum, event, _, arr) => sum + event.lagDays / Math.max(arr.length, 1), 0);
  const realCreditDays = client.creditDays + Math.max(0, Math.round(avgLagDays));
  const projectedReceivable = pendingEvents.reduce((sum, event) => sum + event.amount, 0);
  const risk = riskForMetrics(realCreditDays, avgLagDays, projectedReceivable);

  return {
    client,
    annualSales: annualSales(client),
    projectedReceivable,
    pendingInvoices: pendingEvents.length,
    confirmedCollections: confirmedEvents.reduce((sum, event) => sum + event.amount, 0),
    confirmedInvoices: confirmedEvents.length,
    avgLagDays,
    realCreditDays,
    risk: risk.risk,
    riskReason: risk.reason,
  };
}

function maxRisk(a: ClientRisk, b: ClientRisk): ClientRisk {
  const order: Record<ClientRisk, number> = { Bajo: 0, Medio: 1, Alto: 2 };
  return order[b] > order[a] ? b : a;
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
  const realCredit = accounts.length
    ? Math.round(accounts.reduce((sum, account) => sum + account.realCreditDays, 0) / accounts.length)
    : 0;
  const risk = accounts.reduce<ClientRisk>((current, account) => maxRisk(current, account.risk), 'Bajo');
  const riskReason = riskForMetrics(realCredit, avgLag, receivable).reason;

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
    realCreditDays: realCredit,
    risk,
    riskReason,
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

  const groups = new Map<string, { signal: GroupSignal; accounts: ClientAccountNode[] }>();

  for (const client of clients) {
    const signal = groupSignalForClient(client);
    const current = groups.get(signal.id) ?? { signal, accounts: [] };
    current.accounts.push(accountNode(client, assumptions, confirmedSet, today));
    if (signal.source === 'manual') current.signal = signal;
    groups.set(signal.id, current);
  }

  return Array.from(groups.values())
    .map((group) => finalizeGroup(group.signal, group.accounts))
    .sort((a, b) => b.annualSales - a.annualSales || a.name.localeCompare(b.name, 'es'));
}
