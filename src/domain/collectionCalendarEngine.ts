import type { CashFlowAssumptions, Client, CollectionEvent } from './types';
import { eventKey } from './types';
import { projectYear } from './collectionEngine';
import { resolveRealPaymentDate, toISODate } from './calendar';
import { isNonOperatingDay } from './bankHolidays';
import { normalizeClientText } from './clientGrouping';
import type { CobranzaRecord } from '../services/jdeTypes';
import type {
  AbonoEnrichment,
  MatchTier,
  RealReconciliationMatch,
  RealReconciliationResult,
} from './realReconciliationEngine';

export type CollectionCalendarEventSource =
  | 'BANK_MATCHED'
  | 'BANK_UNMATCHED'
  | 'JDE_PAID_UNMATCHED'
  | 'JDE_OPEN_PROJECTED'
  | 'CLIENT_PROJECTED';

export type CollectionCalendarSourceFilter =
  | 'all'
  | 'bank'
  | 'bank_unmatched'
  | 'jde'
  | 'cxc'
  | 'projected'
  | 'unruled';

export interface CollectionCalendarFactura {
  cia: string;
  noFactura: string;
  noCliente: string;
  nombreCliente: string;
  importeBruto: number;
  importePendiente: number;
  fechaFactura: string;
  fechaVence: string;
  fechaCobro: string;
}

export interface CollectionCalendarBankInfo {
  cia: string;
  cuenta: string;
  fechaOperacion: string;
  importe: number;
  concepto: string;
  referencia: string;
  matchTier?: MatchTier;
  confidence?: number;
}

export interface CollectionCalendarRuleInfo {
  clientId: string;
  clientName: string;
  ruleApplied: string;
  matchConfidence: number;
  invoiceDate: string;
  theoreticalDate: string;
}

export interface CollectionCalendarEvent {
  id: string;
  source: CollectionCalendarEventSource;
  date: string;
  amount: number;
  cia?: string;
  clientId?: string;
  clientName: string;
  noCliente?: string;
  noFactura?: string;
  statusLabel: string;
  dateReason: string;
  ruleApplied: string;
  confidence?: number;
  facturas: CollectionCalendarFactura[];
  bank?: CollectionCalendarBankInfo;
  rule?: CollectionCalendarRuleInfo;
  projected?: CollectionEvent;
}

export interface CollectionCalendarSourceSummary {
  count: number;
  amount: number;
}

export interface BuildCollectionCalendarInput {
  clients: Client[];
  assumptions: CashFlowAssumptions;
  cobranzaRecords: CobranzaRecord[];
  reconciliation: RealReconciliationResult;
}

export interface BuildCollectionCalendarResult {
  events: CollectionCalendarEvent[];
  summaryBySource: Record<CollectionCalendarEventSource, CollectionCalendarSourceSummary>;
}

const DAY_MS = 86_400_000;

export const COLLECTION_CALENDAR_SOURCE_LABELS: Record<CollectionCalendarEventSource, string> = {
  BANK_MATCHED: 'Banco cruzado',
  BANK_UNMATCHED: 'Banco sin factura',
  JDE_PAID_UNMATCHED: 'JDE cobrado',
  JDE_OPEN_PROJECTED: 'Factura JDE por cobrar',
  CLIENT_PROJECTED: 'Proyección sin factura',
};

const SOURCE_ORDER: CollectionCalendarEventSource[] = [
  'BANK_MATCHED',
  'BANK_UNMATCHED',
  'JDE_PAID_UNMATCHED',
  'JDE_OPEN_PROJECTED',
  'CLIENT_PROJECTED',
];

export function emptyCollectionCalendarSummary(): Record<CollectionCalendarEventSource, CollectionCalendarSourceSummary> {
  return SOURCE_ORDER.reduce((acc, source) => {
    acc[source] = { count: 0, amount: 0 };
    return acc;
  }, {} as Record<CollectionCalendarEventSource, CollectionCalendarSourceSummary>);
}

export function calendarEventMatchesSourceFilter(
  event: CollectionCalendarEvent,
  filter: CollectionCalendarSourceFilter,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'bank':
      return event.source === 'BANK_MATCHED';
    case 'bank_unmatched':
      return event.source === 'BANK_UNMATCHED';
    case 'jde':
      return event.source === 'JDE_PAID_UNMATCHED';
    case 'cxc':
      return event.source === 'JDE_OPEN_PROJECTED';
    case 'projected':
      return event.source === 'CLIENT_PROJECTED';
    case 'unruled':
      return event.source === 'JDE_OPEN_PROJECTED' && !event.rule;
  }
}

export function buildCollectionCalendar(input: BuildCollectionCalendarInput): BuildCollectionCalendarResult {
  const { clients, assumptions, cobranzaRecords, reconciliation } = input;
  const events: CollectionCalendarEvent[] = [];
  const clientLookup = buildClientLookup(clients);
  const matchByFactura = new Map<string, RealReconciliationMatch>();
  for (const match of reconciliation.matches) {
    matchByFactura.set(facturaKey(match.cia, match.noFactura), match);
  }

  const cobranzaByFactura = new Map<string, CobranzaRecord>();
  for (const record of cobranzaRecords) {
    cobranzaByFactura.set(facturaKey(record.cia, record.noFactura), record);
  }

  const consumedByBank = new Set<string>();
  for (const abono of reconciliation.abonoEnrichments) {
    events.push(eventFromAbono(abono, cobranzaByFactura));
    for (const factura of abono.facturas ?? []) {
      consumedByBank.add(facturaKey(factura.cia, factura.noFactura));
    }
  }

  const clientMatchByFactura = new Map<string, CollectionCalendarClientMatch | null>();
  const cxcCoverageByClientMonth = new Map<string, Set<string>>();

  for (const record of cobranzaRecords) {
    const key = facturaKey(record.cia, record.noFactura);
    const clientMatch = findClientForCobranza(record, clientLookup);
    clientMatchByFactura.set(key, clientMatch);
    if (clientMatch && record.fechaFactura) {
      addCoveredMonth(cxcCoverageByClientMonth, clientMatch.client.id, record.fechaFactura.slice(0, 7));
    }

    if (consumedByBank.has(key)) continue;

    const match = matchByFactura.get(key);
    if (match?.status === 'cobrada-banco') continue;

    if (record.importePendientePesos <= 0 && record.fechaCobro) {
      events.push(eventFromJdePaid(record));
      continue;
    }

    if (record.importePendientePesos > 0 && clientMatch) {
      events.push(eventFromJdeOpenProjected(record, clientMatch, assumptions));
      continue;
    }

    if (record.importePendientePesos > 0) {
      events.push(eventFromJdeOpenProjected(record, null, assumptions));
    }
  }

  for (const projected of projectYear(clients, assumptions)) {
    const coveredMonths = cxcCoverageByClientMonth.get(projected.clientId);
    if (coveredMonths?.has(projected.invoiceDate.slice(0, 7))) continue;
    const client = clientLookup.byId.get(projected.clientId);
    events.push(eventFromProjection(projected, client));
  }

  events.sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    if (byDate !== 0) return byDate;
    return sourceRank(a.source) - sourceRank(b.source) || b.amount - a.amount;
  });

  return {
    events,
    summaryBySource: summarizeBySource(events),
  };
}

function facturaKey(cia: string, noFactura: string): string {
  return `${cia}::${noFactura}`;
}

function eventFromAbono(
  abono: AbonoEnrichment,
  cobranzaByFactura: Map<string, CobranzaRecord>,
): CollectionCalendarEvent {
  const source: CollectionCalendarEventSource = abono.status === 'factura-cobrada'
    ? 'BANK_MATCHED'
    : 'BANK_UNMATCHED';
  const facturas = (abono.facturas ?? []).map(f => {
    const record = cobranzaByFactura.get(facturaKey(f.cia, f.noFactura));
    return facturaFromRecord(record) ?? {
      cia: f.cia,
      noFactura: f.noFactura,
      noCliente: f.noCliente,
      nombreCliente: f.nombreCliente,
      importeBruto: f.importeBruto,
      importePendiente: 0,
      fechaFactura: '',
      fechaVence: '',
      fechaCobro: '',
    };
  });
  const firstFactura = facturas[0];
  return {
    id: `bank:${abono.movementKey}`,
    source,
    date: abono.fechaOperacion,
    amount: abono.importe,
    cia: abono.cia,
    clientName: firstFactura?.nombreCliente ?? 'Abono bancario sin factura',
    noCliente: firstFactura?.noCliente,
    noFactura: firstFactura?.noFactura,
    statusLabel: source === 'BANK_MATCHED' ? 'Real banco cruzado' : 'Real banco sin factura',
    dateReason: 'Fecha del movimiento bancario.',
    ruleApplied: source === 'BANK_MATCHED'
      ? `Cruce ${abono.matchTier ?? 'exact'}`
      : 'Sin factura CXC asociada',
    confidence: abono.confidence,
    facturas,
    bank: {
      cia: abono.cia,
      cuenta: abono.cuenta,
      fechaOperacion: abono.fechaOperacion,
      importe: abono.importe,
      concepto: abono.concepto,
      referencia: abono.referencia,
      matchTier: abono.matchTier,
      confidence: abono.confidence,
    },
  };
}

function eventFromJdePaid(record: CobranzaRecord): CollectionCalendarEvent {
  return {
    id: `jde:${record.cia}:${record.noFactura}`,
    source: 'JDE_PAID_UNMATCHED',
    date: record.fechaCobro,
    amount: record.importeBrutoPesos,
    cia: record.cia,
    clientName: record.nombreCliente || 'Cliente sin nombre',
    noCliente: record.noCliente,
    noFactura: record.noFactura,
    statusLabel: 'Cobrado en JDE sin banco cruzado',
    dateReason: 'Fecha_Pago del API de cobranza.',
    ruleApplied: 'Fecha confirmada por JDE',
    facturas: [facturaFromRecord(record)],
  };
}

function eventFromJdeOpenProjected(
  record: CobranzaRecord,
  clientMatch: CollectionCalendarClientMatch | null,
  assumptions: CashFlowAssumptions,
): CollectionCalendarEvent {
  const resolved = clientMatch
    ? resolveCobranzaRuleDate(record, clientMatch.client, assumptions)
    : null;
  const fallbackDate = record.fechaVence || record.fechaFactura || new Date().toISOString().slice(0, 10);
  return {
    id: `jde-open:${record.cia}:${record.noFactura}`,
    source: 'JDE_OPEN_PROJECTED',
    date: resolved?.calendarDate ?? fallbackDate,
    amount: record.importePendientePesos,
    cia: record.cia,
    clientId: clientMatch?.client.id,
    clientName: record.nombreCliente || clientMatch?.client.name || 'Cliente sin regla',
    noCliente: record.noCliente,
    noFactura: record.noFactura,
    statusLabel: 'Factura JDE emitida por cobrar',
    dateReason: resolved?.reason ?? (
      record.fechaVence
        ? 'Sin cliente/regla confiable; se usa fecha de vencimiento JDE.'
        : 'Sin cliente/regla confiable ni vencimiento; se usa fecha de factura JDE.'
    ),
    ruleApplied: clientMatch ? clientRuleLabel(clientMatch.client) : 'Sin regla confiable',
    confidence: clientMatch?.confidence,
    facturas: [facturaFromRecord(record)],
    rule: clientMatch && resolved
      ? {
          clientId: clientMatch.client.id,
          clientName: clientMatch.client.name,
          ruleApplied: clientRuleLabel(clientMatch.client),
          matchConfidence: clientMatch.confidence,
          invoiceDate: resolved.invoiceDate,
          theoreticalDate: resolved.theoreticalDate,
        }
      : undefined,
  };
}

function eventFromProjection(projected: CollectionEvent, client: Client | undefined): CollectionCalendarEvent {
  return {
    id: `projected:${eventKey(projected)}`,
    source: 'CLIENT_PROJECTED',
    date: projected.realDate,
    amount: projected.amount,
    clientId: projected.clientId,
    clientName: client?.name ?? projected.clientId,
    statusLabel: 'Proyección sin factura JDE emitida',
    dateReason: 'Fecha calculada por collectionEngine desde calendario del cliente.',
    ruleApplied: client ? clientRuleLabel(client) : 'Regla de cliente',
    facturas: [],
    projected,
    rule: client
      ? {
          clientId: client.id,
          clientName: client.name,
          ruleApplied: clientRuleLabel(client),
          matchConfidence: 1,
          invoiceDate: projected.invoiceDate,
          theoreticalDate: projected.theoreticalDate,
        }
      : undefined,
  };
}

function facturaFromRecord(record: CobranzaRecord): CollectionCalendarFactura;
function facturaFromRecord(record: CobranzaRecord | undefined): CollectionCalendarFactura | null;
function facturaFromRecord(record: CobranzaRecord | undefined): CollectionCalendarFactura | null {
  if (!record) return null;
  return {
    cia: record.cia,
    noFactura: record.noFactura,
    noCliente: record.noCliente,
    nombreCliente: record.nombreCliente,
    importeBruto: record.importeBrutoPesos,
    importePendiente: record.importePendientePesos,
    fechaFactura: record.fechaFactura,
    fechaVence: record.fechaVence,
    fechaCobro: record.fechaCobro,
  };
}

function summarizeBySource(events: CollectionCalendarEvent[]): Record<CollectionCalendarEventSource, CollectionCalendarSourceSummary> {
  const summary = emptyCollectionCalendarSummary();
  for (const event of events) {
    summary[event.source].count++;
    summary[event.source].amount += event.amount;
  }
  return summary;
}

function sourceRank(source: CollectionCalendarEventSource): number {
  const idx = SOURCE_ORDER.indexOf(source);
  return idx >= 0 ? idx : SOURCE_ORDER.length;
}

export interface CollectionCalendarClientMatch {
  client: Client;
  confidence: number;
}

export interface CollectionCalendarClientLookup {
  byId: Map<string, Client>;
  byDigits: Map<string, Client[]>;
  byToken: Map<string, Client[]>;
}

export function buildClientLookup(clients: Client[]): CollectionCalendarClientLookup {
  const byId = new Map<string, Client>();
  const byDigits = new Map<string, Client[]>();
  const byToken = new Map<string, Client[]>();
  for (const client of clients) {
    byId.set(client.id, client);
    const digits = onlyDigits(client.id);
    if (digits) addClientLookup(byDigits, digits, client);
    for (const value of [client.name, client.legalName, client.commercialGroupName]) {
      for (const token of significantTokens(normalizeClientText(value ?? ''))) {
        addClientLookup(byToken, token, client);
      }
    }
  }
  return { byId, byDigits, byToken };
}

function addClientLookup(map: Map<string, Client[]>, key: string, client: Client): void {
  const list = map.get(key) ?? [];
  if (!list.some(c => c.id === client.id)) list.push(client);
  map.set(key, list);
}

export function findClientForCobranza(
  record: CobranzaRecord,
  lookup: CollectionCalendarClientLookup,
): CollectionCalendarClientMatch | null {
  const candidateMap = new Map<string, Client>();
  const noCliente = onlyDigits(record.noCliente);
  for (const client of lookup.byDigits.get(noCliente) ?? []) candidateMap.set(client.id, client);
  for (const token of significantTokens(normalizeClientText(record.nombreCliente))) {
    for (const client of lookup.byToken.get(token) ?? []) candidateMap.set(client.id, client);
  }
  const candidates = candidateMap.size > 0 ? Array.from(candidateMap.values()) : Array.from(lookup.byId.values());
  let best: CollectionCalendarClientMatch | null = null;
  for (const client of candidates) {
    const confidence = clientMatchConfidence(record, client);
    if (confidence < 0.62) continue;
    if (!best || confidence > best.confidence) {
      best = { client, confidence };
    }
  }
  return best;
}

function clientMatchConfidence(record: CobranzaRecord, client: Client): number {
  const noCliente = onlyDigits(record.noCliente);
  if (noCliente && onlyDigits(client.id) === noCliente) return 1;

  const recordName = normalizeClientText(record.nombreCliente);
  const candidates = [
    client.name,
    client.legalName,
    client.commercialGroupName,
  ].map(normalizeClientText).filter(Boolean);

  let best = 0;
  for (const candidate of candidates) {
    if (candidate === recordName && candidate.length >= 4) best = Math.max(best, 0.98);
    else if (candidate.length >= 8 && recordName.includes(candidate)) best = Math.max(best, 0.9);
    else if (recordName.length >= 8 && candidate.includes(recordName)) best = Math.max(best, 0.88);
    else best = Math.max(best, tokenOverlap(recordName, candidate));
  }
  return best;
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

function tokenOverlap(a: string, b: string): number {
  const aTokens = significantTokens(a);
  const bTokens = significantTokens(b);
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const bSet = new Set(bTokens);
  const matches = aTokens.filter(t => bSet.has(t)).length;
  const denom = Math.min(aTokens.length, bTokens.length);
  if (matches < 2 && denom > 1) return matches > 0 ? 0.45 : 0;
  return matches / denom;
}

const GENERIC_CLIENT_TOKENS = new Set([
  'SA', 'CV', 'SAB', 'SAPI', 'SC', 'AC', 'RL', 'DE', 'DEL', 'EL', 'LA', 'LAS',
  'LOS', 'Y', 'GRUPO', 'CLIENTE', 'SERVICIOS', 'TRANSPORTES', 'MEXICO',
]);

function significantTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .filter(token => token.length >= 3 && !GENERIC_CLIENT_TOKENS.has(token));
}

function addCoveredMonth(map: Map<string, Set<string>>, clientId: string, yearMonth: string): void {
  const set = map.get(clientId) ?? new Set<string>();
  set.add(yearMonth);
  map.set(clientId, set);
}

export function resolveCobranzaRuleDate(
  record: CobranzaRecord,
  client: Client,
  assumptions: CashFlowAssumptions,
): { calendarDate: string; invoiceDate: string; theoreticalDate: string; reason: string } {
  const invoiceDate = record.fechaFactura || record.fechaVence || new Date().toISOString().slice(0, 10);
  const invoice = parseIsoDate(invoiceDate);
  const theoretical = record.fechaFactura
    ? addDays(invoice, client.creditDays)
    : parseIsoDate(record.fechaVence || invoiceDate);
  let real: Date;
  let reason: string;
  if (client.factoraje) {
    real = addDays(invoice, assumptions.factorajeDays);
    while (isNonOperatingDay(real)) real = addDays(real, 1);
    reason = `Factoraje: factura + ${assumptions.factorajeDays} dias.`;
  } else {
    real = resolveRealPaymentDate(theoretical, client.paymentDay, client.frequency);
    reason = `Regla cliente: ${client.creditDays} dias credito + ${client.paymentDayRaw || client.paymentDay.kind}.`;
  }
  return {
    calendarDate: toISODate(real),
    invoiceDate: toISODate(invoice),
    theoreticalDate: toISODate(theoretical),
    reason,
  };
}

export function clientRuleLabel(client: Client): string {
  const payment = client.paymentDayRaw || client.paymentDay.kind;
  return `${client.frequency} · ${client.creditDays}d credito · ${payment}${client.factoraje ? ' · factoraje' : ''}`;
}

function parseIsoDate(value: string): Date {
  const raw = value.length >= 10 ? value.slice(0, 10) : value;
  const [year, month, day] = raw.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  }
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}
