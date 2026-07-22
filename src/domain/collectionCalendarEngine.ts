import type { CashFlowAssumptions, Client, Frequency } from './types';
import { parseFrequencyStrict } from './loadClientsCatalog';
import { resolveRealPaymentDate, toISODate } from './calendar';
import { parseCc13PaymentDay } from './parsePaymentDay';
import { isNonOperatingDay } from './bankHolidays';
import { isInternalCounterparty } from './netCashFlowEngine';
import { normalizeClientText } from './clientGrouping';
import type { CobranzaRecord } from '../services/jdeTypes';
import { todayISO } from '../formatters';
import type {
  AbonoEnrichment,
  MatchTier,
  RealReconciliationMatch,
  RealReconciliationResult,
} from './realReconciliationEngine';
// Type-only: `rolProjectionEngine` importa funciones de este módulo; un import
// de solo-tipos no crea ciclo en runtime. El RESULTADO se calcula afuera
// (UI/canónico) y entra precomputado por `BuildCollectionCalendarInput`.
import type { RolProjectionResult } from './rolProjectionEngine';

export type CollectionCalendarEventSource =
  | 'BANK_MATCHED'
  | 'BANK_FEDERAL'
  | 'BANK_UNMATCHED'
  | 'JDE_PAID_UNMATCHED'
  | 'JDE_OPEN_PROJECTED'
  | 'ROL_PROJECTED';

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
  /** Promesa de pago capturada en JDE — informativa, NO altera el fechado. */
  fechaPromesaPago?: string;
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
  /** Fecha esperada por la regla del cliente (factura + creditDays alineado al calendario). */
  expectedPayDate?: string;
  /** Diferencia en días entre fecha real de pago y la esperada. >0 tarde, <0 temprano. */
  paymentLagDays?: number;
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
  /**
   * Proyección ROL precomputada (`buildRolProjectedInflows`): viajes
   * ejecutados aún no facturados, fechados por la regla del cliente. Emite
   * eventos `ROL_PROJECTED` — la ÚNICA capa de proyección sin factura del
   * calendario (la proyección genérica de catálogo `CLIENT_PROJECTED` se
   * eliminó 2026-06-10: estimaba montos sin viaje ejecutado detrás).
   */
  rolProjection?: RolProjectionResult;
}

export interface BuildCollectionCalendarResult {
  events: CollectionCalendarEvent[];
  summaryBySource: Record<CollectionCalendarEventSource, CollectionCalendarSourceSummary>;
}

const DAY_MS = 86_400_000;

export const COLLECTION_CALENDAR_SOURCE_LABELS: Record<CollectionCalendarEventSource, string> = {
  BANK_MATCHED: 'Banco cruzado',
  BANK_FEDERAL: 'Ingreso Federal',
  BANK_UNMATCHED: 'Banco sin factura',
  JDE_PAID_UNMATCHED: 'Ingreso',
  JDE_OPEN_PROJECTED: 'Factura JDE por cobrar',
  ROL_PROJECTED: 'Viaje ROL por facturar',
};

const SOURCE_ORDER: CollectionCalendarEventSource[] = [
  'BANK_MATCHED',
  'BANK_FEDERAL',
  'BANK_UNMATCHED',
  'JDE_PAID_UNMATCHED',
  'JDE_OPEN_PROJECTED',
  'ROL_PROJECTED',
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
      return event.source === 'BANK_MATCHED' || event.source === 'BANK_FEDERAL';
    case 'bank_unmatched':
      return event.source === 'BANK_UNMATCHED';
    case 'jde':
      return event.source === 'JDE_PAID_UNMATCHED';
    case 'cxc':
      return event.source === 'JDE_OPEN_PROJECTED';
    case 'projected':
      return event.source === 'ROL_PROJECTED';
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

  const clientMatchByFactura = new Map<string, CollectionCalendarClientMatch | null>();
  for (const record of cobranzaRecords) {
    clientMatchByFactura.set(facturaKey(record.cia, record.noFactura), findClientForCobranza(record, clientLookup));
  }

  const consumedByBank = new Set<string>();
  for (const abono of reconciliation.abonoEnrichments) {
    events.push(eventFromAbono(abono, cobranzaByFactura, clientMatchByFactura, assumptions));
    for (const factura of abono.facturas ?? []) {
      consumedByBank.add(facturaKey(factura.cia, factura.noFactura));
    }
  }

  for (const record of cobranzaRecords) {
    // Movimientos internos (factura de una empresa propia del grupo a otra)
    // NO son cobranza real: no se proyectan ni bloquean el ciclo del cliente.
    if (isInternalCounterparty(record.rfc, record.nombreCliente)) continue;

    const key = facturaKey(record.cia, record.noFactura);
    const clientMatch = clientMatchByFactura.get(key) ?? null;

    if (consumedByBank.has(key)) continue;

    const match = matchByFactura.get(key);
    if (match?.status === 'cobrada-banco') continue;

    if (record.importePendientePesos <= 0 && record.fechaCobro) {
      events.push(eventFromJdePaid(record, clientMatch, assumptions));
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

  // ROL CITI: viajes EJECUTADOS aún sin factura — monto real del servicio
  // entregado, fechado por la regla del cliente (días crédito + día de pago
  // + frecuencia). Es la ÚNICA capa de proyección sin factura: el calendario
  // proyecta solo sobre viajes realmente ejecutados, nunca sobre el estimado
  // genérico del catálogo de clientes.
  for (const inflow of input.rolProjection?.inflows ?? []) {
    const client = clientLookup.byId.get(inflow.clientId);
    if (client && isInternalCounterparty(client.rfc, client.name)) continue;
    events.push({
      id: `rol:${inflow.cia}:${inflow.clientId}:${inflow.date}`,
      source: 'ROL_PROJECTED',
      date: inflow.date,
      amount: inflow.grossAmount,
      cia: inflow.cia || undefined,
      clientId: inflow.clientId,
      clientName: inflow.clientName,
      statusLabel: `Viaje ejecutado por facturar (${inflow.tripCount} viaje${inflow.tripCount === 1 ? '' : 's'})`,
      dateReason: `ROL CITI · ${inflow.ruleReason}`,
      ruleApplied: client ? clientRuleLabel(client) : 'Regla de cliente',
      confidence: 0.7,
      facturas: [],
    });
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
  clientMatchByFactura: Map<string, CollectionCalendarClientMatch | null>,
  assumptions: CashFlowAssumptions,
): CollectionCalendarEvent {
  // ABONO en cuenta `unidadNegocio=FEDERAL` del catálogo de bancos: venta
  // directa a banco (TPV/taquillas/OXXO/…), nunca tiene factura JDE detrás.
  // Es ingreso REAL del día — fuente propia para que la UI lo sume aparte.
  const source: CollectionCalendarEventSource = abono.status === 'federal'
    ? 'BANK_FEDERAL'
    : abono.status === 'factura-cobrada'
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
  let expectedPayDate: string | undefined;
  let paymentLagDays: number | undefined;
  if (source === 'BANK_MATCHED' && firstFactura) {
    const record = cobranzaByFactura.get(facturaKey(firstFactura.cia, firstFactura.noFactura));
    const clientMatch = record ? clientMatchByFactura.get(facturaKey(record.cia, record.noFactura)) : null;
    if (record && clientMatch) {
      expectedPayDate = resolveCobranzaRuleDate(record, clientMatch.client, assumptions).calendarDate;
      paymentLagDays = isoDaysBetween(expectedPayDate, abono.fechaOperacion);
    }
  }
  return {
    id: `bank:${abono.movementKey}`,
    source,
    date: abono.fechaOperacion,
    amount: abono.importe,
    cia: abono.cia,
    clientName: firstFactura?.nombreCliente
      ?? (source === 'BANK_FEDERAL' ? 'Venta Federal' : 'Abono bancario sin factura'),
    noCliente: firstFactura?.noCliente,
    noFactura: firstFactura?.noFactura,
    statusLabel: source === 'BANK_MATCHED'
      ? 'Real banco cruzado'
      : source === 'BANK_FEDERAL'
        ? 'Venta Federal directa a banco'
        : 'Real banco sin factura',
    dateReason: 'Fecha del movimiento bancario.',
    ruleApplied: source === 'BANK_MATCHED'
      ? `Cruce ${abono.matchTier ?? 'exact'}`
      : source === 'BANK_FEDERAL'
        ? 'Cuenta Federal del catálogo de bancos'
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
    expectedPayDate,
    paymentLagDays,
  };
}

function eventFromJdePaid(
  record: CobranzaRecord,
  clientMatch: CollectionCalendarClientMatch | null,
  assumptions: CashFlowAssumptions,
): CollectionCalendarEvent {
  let expectedPayDate: string | undefined;
  let paymentLagDays: number | undefined;
  if (clientMatch) {
    expectedPayDate = resolveCobranzaRuleDate(record, clientMatch.client, assumptions).calendarDate;
    paymentLagDays = isoDaysBetween(expectedPayDate, record.fechaCobro);
  }
  return {
    id: `jde:${record.cia}:${record.noFactura}`,
    source: 'JDE_PAID_UNMATCHED',
    date: record.fechaCobro,
    amount: record.importeBrutoPesos,
    cia: record.cia,
    clientId: clientMatch?.client.id,
    clientName: record.nombreCliente || 'Cliente sin nombre',
    noCliente: record.noCliente,
    noFactura: record.noFactura,
    statusLabel: 'Cobrado en JDE sin banco cruzado',
    dateReason: 'Fecha_Pago del API de cobranza.',
    ruleApplied: 'Fecha confirmada por JDE',
    facturas: [facturaFromRecord(record)],
    expectedPayDate,
    paymentLagDays,
  };
}

function eventFromJdeOpenProjected(
  record: CobranzaRecord,
  clientMatch: CollectionCalendarClientMatch | null,
  assumptions: CashFlowAssumptions,
): CollectionCalendarEvent {
  const resolved = clientMatch
    ? resolveCobranzaRuleDate(record, clientMatch.client, assumptions)
    : resolveCobranzaApiPaymentDate(record);
  const fallbackDate = record.fechaVence || record.fechaFactura || todayISO();
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
    fechaPromesaPago: record.fechaPromesaPago,
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
    const idDigits = onlyDigits(client.id);
    if (idDigits) addClientLookup(byDigits, idDigits, client);
    // Index también por noCliente JDE de cada cuenta enlazada. Cliente catálogo
    // usa id-slug (`catalog-0-foo`), pero ROL/Cobranza vienen por noCliente
    // numérico — sin este indexado, claveJDE/noCliente no matcheaba ningún
    // cliente, dejando ROL sin proyección.
    for (const acc of client.jdeAccounts ?? []) {
      const accDigits = onlyDigits(acc?.noCliente ?? '');
      if (accDigits) addClientLookup(byDigits, accDigits, client);
    }
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

export function significantTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .filter(token => token.length >= 3 && !GENERIC_CLIENT_TOKENS.has(token));
}

/**
 * Nombre del día de pago tal como lo expone el API de cobranza/ROL para
 * ESTA factura (`Nombre_Dia_Pago_CC13`). Es la autoridad por-factura — gana
 * sobre cualquier regla del catálogo. Solo el nombre; la clave numérica
 * (`Clave_Dia_Pago_CC13` p.ej. "027") no es un día parseable.
 */
function apiPaymentDayName(record: CobranzaRecord): string {
  return (record.diaPagoNombre || record.nombreDiaPagoCc13 || '').trim();
}

export function resolveCobranzaRuleDate(
  record: CobranzaRecord,
  client: Client,
  assumptions: CashFlowAssumptions,
): { calendarDate: string; invoiceDate: string; theoreticalDate: string; reason: string } {
  const invoiceDate = record.fechaFactura || record.fechaVence || todayISO();
  const invoice = parseIsoDate(invoiceDate);

  // Días de crédito: `Dias_Credito` del API (por factura) es autoridad sobre
  // el catálogo. Solo si el API no lo trae caemos al catálogo del cliente.
  const creditDays = record.diasCredito && record.diasCredito > 0
    ? record.diasCredito
    : client.creditDays;

  const theoretical = record.fechaFactura
    ? addDays(invoice, creditDays)
    : parseIsoDate(record.fechaVence || invoiceDate);

  let real: Date;
  let reason: string;
  if (client.factoraje) {
    real = addDays(invoice, assumptions.factorajeDays);
    while (isNonOperatingDay(real)) real = addDays(real, 1);
    reason = `Factoraje: factura + ${assumptions.factorajeDays} dias.`;
  } else {
    // Regla de día de pago en orden de autoridad:
    //   1. `Nombre_Dia_Pago_CC13` de ESTA factura (API/ROL).
    //   2. `paymentDayName` del catálogo (sincronizado del API).
    //   3. `paymentDay` estructurado histórico del catálogo.
    const apiName = apiPaymentDayName(record);
    const apiPattern = parseCc13PaymentDay(apiName);
    const catalogPattern = parseCc13PaymentDay(client.paymentDayName);
    const pattern = apiPattern ?? catalogPattern ?? client.paymentDay;
    real = resolveRealPaymentDate(theoretical, pattern, client.frequency);
    const ruleSrc = apiPattern
      ? `dia pago API ${apiName}`
      : catalogPattern
        ? `dia pago API ${client.paymentDayName}`
        : (client.paymentDayRaw || client.paymentDay.kind);
    reason = `Regla cliente: ${creditDays} dias credito + ${ruleSrc}.`;
  }
  return {
    calendarDate: toISODate(real),
    invoiceDate: toISODate(invoice),
    theoreticalDate: toISODate(theoretical),
    reason,
  };
}

export function resolveCobranzaApiPaymentDate(
  record: CobranzaRecord,
): { calendarDate: string; invoiceDate: string; theoreticalDate: string; reason: string } | null {
  const apiName = apiPaymentDayName(record);
  const paymentDay = parseCc13PaymentDay(apiName);
  if (!paymentDay) return null;

  const invoiceDate = record.fechaFactura || record.fechaVence || todayISO();
  const invoice = parseIsoDate(invoiceDate);
  const creditDays = record.diasCredito && record.diasCredito > 0
    ? record.diasCredito
    : Number.parseInt(record.condPago, 10) || 0;
  const theoretical = record.fechaVence
    ? parseIsoDate(record.fechaVence)
    : addDays(invoice, creditDays);
  const real = resolveRealPaymentDate(theoretical, paymentDay, 'Semanal');
  return {
    calendarDate: toISODate(real),
    invoiceDate: toISODate(invoice),
    theoreticalDate: toISODate(theoretical),
    reason: `Regla CC13 /cobranza: ${apiName || 'dia de pago'}.`,
  };
}

/**
 * Fecha de cobro esperada para un cliente a partir de una fecha base
 * arbitraria (p.ej. la fecha del viaje ejecutado en ROL), aplicando SOLO la
 * regla del catálogo: `creditDays` + día de pago + frecuencia + factoraje.
 *
 * Es el núcleo de regla compartido con `resolveCobranzaRuleDate` (que además
 * antepone autoridad por-factura del API). El catálogo del cliente ya viene
 * sincronizado del API /cobranza (`recomputeClientCreditDaysFromCobranza`),
 * así que para ROL —donde no hay factura ni override por-factura— esta regla
 * es la autoridad correcta. No double source: la lógica vive una sola vez.
 */
export function resolveClientCalendarDate(
  client: Client,
  baseDateISO: string,
  assumptions: CashFlowAssumptions,
): { calendarDate: string; theoreticalDate: string; reason: string } {
  const invoice = parseIsoDate(baseDateISO);
  const creditDays = client.creditDays;
  const theoretical = addDays(invoice, creditDays);

  let real: Date;
  let reason: string;
  if (client.factoraje) {
    real = addDays(invoice, assumptions.factorajeDays);
    while (isNonOperatingDay(real)) real = addDays(real, 1);
    reason = `Factoraje: base + ${assumptions.factorajeDays} dias.`;
  } else {
    const catalogPattern = parseCc13PaymentDay(client.paymentDayName);
    const pattern = catalogPattern ?? client.paymentDay;
    real = resolveRealPaymentDate(theoretical, pattern, client.frequency);
    const ruleSrc = catalogPattern
      ? `dia pago API ${client.paymentDayName}`
      : (client.paymentDayRaw || client.paymentDay.kind);
    reason = `Regla cliente: ${creditDays} dias credito + ${ruleSrc}.`;
  }
  return {
    calendarDate: toISODate(real),
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

function isoDaysBetween(fromIso: string, toIso: string): number {
  const a = parseIsoDate(fromIso);
  const b = parseIsoDate(toIso);
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/**
 * Sincroniza Client desde cobranza. Para cada cliente del catálogo:
 *
 *   1. `creditDays` ← `Dias_Credito` del API si viene poblado (autoridad JDE),
 *      en cuyo caso `creditDaysFromApi=true`. Fallback: promedio de lag real
 *      observado (`Fecha_Cobro - Fecha_Factura`) con piso 1 día.
 *   2. `commercialGroupName/Id` ← `Nombre_Cliente_Padre`/`No_Cliente_Padre` del
 *      API (autoridad JDE; lock UI). Excepto cuando el padre es el bucket
 *      genérico "Resto Clientes" (49080179) — ese se ignora.
 *   3. `paymentDayName` ← `Nombre_Dia_Pago_CC13` del API ("Viernes", etc.).
 *   4. `frequency` ← `Nombre_Frecuencia_Facturacion_CC17` del API
 *      ("MENSUAL"/"SEMANAL"/"QUINCENAL") si es clasificable; marca
 *      `frequencyFromApi=true`. Si el API manda algo no reconocible, se
 *      conserva la frecuencia del catálogo (no se pisa con un default).
 *
 * Match cliente↔cobranza pasa por `findClientForCobranza` (dig + tokens) que
 * funciona aunque el cliente no tenga jdeAccounts explícitos. Devuelve la
 * misma referencia cuando no hay cambios.
 *
 * `49080179` "Resto Clientes" — bucket JDE para huérfanos sin padre real
 * asignado. NO debe colapsar todos esos clientes en un grupo único.
 */
const RESTO_CLIENTES_PADRE_ID = '49080179';

export function recomputeClientCreditDaysFromCobranza(
  clients: Client[],
  cobranzaRecords: CobranzaRecord[],
): Client[] {
  if (cobranzaRecords.length === 0 || clients.length === 0) return clients;
  const lookup = buildClientLookup(clients);

  interface PerClientApiInfo {
    diasCreditoApi?: number;
    noClientePadre?: string;
    nombreClientePadre?: string;
    diaPagoNombre?: string;
    frecuenciaApi?: Frequency;
    lagSum: number;
    lagCount: number;
  }
  const apiByClient = new Map<string, PerClientApiInfo>();

  for (const record of cobranzaRecords) {
    const match = findClientForCobranza(record, lookup);
    if (!match) continue;
    let info = apiByClient.get(match.client.id);
    if (!info) {
      info = { lagSum: 0, lagCount: 0 };
      apiByClient.set(match.client.id, info);
    }
    // Capturar campos del API (primer registro poblado gana).
    if (record.diasCredito && !info.diasCreditoApi) info.diasCreditoApi = record.diasCredito;
    if (record.noClientePadre && !info.noClientePadre && record.noClientePadre !== RESTO_CLIENTES_PADRE_ID) {
      info.noClientePadre = record.noClientePadre;
    }
    if (record.nombreClientePadre && !info.nombreClientePadre && record.noClientePadre !== RESTO_CLIENTES_PADRE_ID) {
      info.nombreClientePadre = record.nombreClientePadre;
    }
    if (record.diaPagoNombre && !info.diaPagoNombre) info.diaPagoNombre = record.diaPagoNombre;
    if (record.frecuenciaFacturacionNombre && !info.frecuenciaApi) {
      const f = parseFrequencyStrict(record.frecuenciaFacturacionNombre);
      if (f) info.frecuenciaApi = f;
    }
    // Sample de lag real (fallback cuando no hay diasCredito API).
    if (record.fechaCobro && record.fechaFactura && record.importePendientePesos === 0) {
      const lag = isoDaysBetween(record.fechaFactura, record.fechaCobro);
      if (Number.isFinite(lag) && lag >= 0 && lag <= 365) {
        info.lagSum += lag;
        info.lagCount += 1;
      }
    }
  }

  if (apiByClient.size === 0) return clients;
  let mutated = false;
  const next = clients.map(client => {
    const info = apiByClient.get(client.id);
    if (!info) return client;

    const patch: Partial<Client> = {};
    let dirty = false;

    // 1. Días de crédito — API gana sobre cálculo de lag.
    if (info.diasCreditoApi != null) {
      if (client.creditDays !== info.diasCreditoApi) {
        patch.creditDays = info.diasCreditoApi;
        dirty = true;
      }
      if (client.creditDaysFromApi !== true) {
        patch.creditDaysFromApi = true;
        dirty = true;
      }
    } else if (info.lagCount > 0) {
      const observed = Math.max(1, Math.round(info.lagSum / info.lagCount));
      if (observed !== client.creditDays) {
        patch.creditDays = observed;
        dirty = true;
      }
      // No API: limpia flag si estaba activo.
      if (client.creditDaysFromApi === true) {
        patch.creditDaysFromApi = false;
        dirty = true;
      }
    }

    // 2. Grupo padre — autoridad JDE.
    if (info.noClientePadre && info.nombreClientePadre) {
      const padreId = `client-padre-${info.noClientePadre}`;
      const padreName = info.nombreClientePadre.trim();
      if (client.commercialGroupId !== padreId) {
        patch.commercialGroupId = padreId;
        dirty = true;
      }
      if (client.commercialGroupName !== padreName) {
        patch.commercialGroupName = padreName;
        dirty = true;
      }
      if (client.manualGroupOverride === true) {
        patch.manualGroupOverride = false;
        dirty = true;
      }
    }

    // 3. Día de pago preferido.
    if (info.diaPagoNombre && client.paymentDayName !== info.diaPagoNombre) {
      patch.paymentDayName = info.diaPagoNombre;
      dirty = true;
    }

    // 4. Frecuencia de facturación — autoridad JDE cuando es clasificable.
    if (info.frecuenciaApi != null) {
      if (client.frequency !== info.frecuenciaApi) {
        patch.frequency = info.frecuenciaApi;
        dirty = true;
      }
      if (client.frequencyFromApi !== true) {
        patch.frequencyFromApi = true;
        dirty = true;
      }
    }

    if (!dirty) return client;
    mutated = true;
    return { ...client, ...patch };
  });
  return mutated ? next : clients;
}
