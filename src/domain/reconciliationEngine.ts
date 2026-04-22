/**
 * Bank Reconciliation Engine
 *
 * Cross-references projected collection events with actual bank movements
 * (ABONO type) to identify which expected payments have been received.
 *
 * Matching algorithm:
 *   1. Extract all ABONO movements from bank statements
 *   2. For each projected collection event, search for a matching bank movement:
 *      - Amount tolerance: ±5% (invoices may include/exclude IVA, rounding, partial payments)
 *      - Date tolerance: ±5 days (bank processing, weekends, holidays)
 *   3. Each bank movement can only match ONE collection event (1:1)
 *   4. Priority: exact amount match first, then closest date, then closest amount
 *
 * Output: ReconciliationResult[] with match status, confidence, and bank reference.
 */

import { CollectionEvent, Client, eventKey } from './types';
import type { BankAccountStatement, BankStatementLine } from '../services/jdeTypes';
import {
  isInternalTransfer,
  buildOwnAccountsIndex,
  buildOwnAccountDetector,
  buildInternalAccountsIndex,
} from './netCashFlowEngine';

// ── Configuration ──
const AMOUNT_TOLERANCE = 0.05;  // 5%
const DATE_TOLERANCE_DAYS = 5;
const DAY_MS = 86_400_000;

// ── Types ──

export type ReconciliationStatus =
  | 'matched'       // High-confidence match found
  | 'likely'        // Probable match (looser criteria)
  | 'unmatched'     // No matching bank movement found
  | 'overpaid';     // Bank movement exceeds projection

export interface ReconciliationMatch {
  /** The projected collection event key */
  eventKey: string;
  /** Client ID from the collection event */
  clientId: string;
  /** Projected real date (ISO) */
  projectedDate: string;
  /** Projected amount */
  projectedAmount: number;
  /** Reconciliation status */
  status: ReconciliationStatus;
  /** Confidence score 0–1 (1 = perfect match) */
  confidence: number;
  /** Matched bank movement, if any */
  bankMovement?: BankStatementLine;
  /** Actual amount received (from bank) */
  actualAmount?: number;
  /** Actual date received (from bank) */
  actualDate?: string;
  /** Bank reference */
  bankReference?: string;
  /** Delta between projected and actual amount */
  amountDelta?: number;
  /** Days between projected and actual date */
  dateDelta?: number;
}

export interface ReconciliationSummary {
  totalProjected: number;
  totalMatched: number;
  totalLikely: number;
  totalUnmatched: number;
  matchedCount: number;
  likelyCount: number;
  unmatchedCount: number;
  matchRate: number;          // 0–1
  unmatchedBankAbonos: BankStatementLine[];  // Bank deposits not matched to any projection
}

// ── Helpers ──

function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T12:00:00Z').getTime();
  const db = new Date(b + 'T12:00:00Z').getTime();
  return Math.round((db - da) / DAY_MS);
}

function amountSimilarity(projected: number, actual: number): number {
  if (projected === 0 && actual === 0) return 1;
  if (projected === 0 || actual === 0) return 0;
  const ratio = actual / projected;
  // Perfect match = 1, diverging = approaches 0
  return Math.max(0, 1 - Math.abs(1 - ratio) / AMOUNT_TOLERANCE);
}

function dateSimilarity(projectedDate: string, actualDate: string): number {
  const days = Math.abs(daysBetween(projectedDate, actualDate));
  if (days === 0) return 1;
  if (days > DATE_TOLERANCE_DAYS) return 0;
  return 1 - days / DATE_TOLERANCE_DAYS;
}

function computeConfidence(amountSim: number, dateSim: number): number {
  // Weighted: amount is more important than date
  return amountSim * 0.6 + dateSim * 0.4;
}

// ── Main Engine ──

/**
 * Extract all ABONO (credit/deposit) movements from bank statements
 * for a given month.
 */
function extractAbonos(
  bankStatements: BankAccountStatement[],
  year: number,
  month: number,
): BankStatementLine[] {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
  const abonos: BankStatementLine[] = [];

  // Los traspasos entre cuentas propias no son cobros de clientes — nunca
  // deben entrar al pool de abonos candidatos a cruzarse contra proyecciones
  // de cobranza.
  const detector = buildOwnAccountDetector(buildOwnAccountsIndex(bankStatements));
  const internalAccountKeys = buildInternalAccountsIndex(bankStatements);

  for (const account of bankStatements) {
    for (const mov of account.movimientos) {
      if (mov.tipoMovimiento !== 'ABONO') continue;
      if (!mov.fechaOperacion.startsWith(prefix)) continue;
      if (isInternalTransfer(mov, detector, internalAccountKeys)) continue;
      abonos.push(mov);
    }
  }

  // Also include movements from adjacent dates (±tolerance) that might match
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;
  const prevPrefix = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}`;
  const nextPrefix = `${nextYear}-${String(nextMonth + 1).padStart(2, '0')}`;

  // Get last few days of prev month and first few days of next month
  for (const account of bankStatements) {
    for (const mov of account.movimientos) {
      if (mov.tipoMovimiento !== 'ABONO') continue;
      if (isInternalTransfer(mov, detector, internalAccountKeys)) continue;
      const d = mov.fechaOperacion;
      if (d.startsWith(prevPrefix)) {
        const day = Number(d.slice(8, 10));
        if (day >= 25) abonos.push(mov); // last week of previous month
      } else if (d.startsWith(nextPrefix)) {
        const day = Number(d.slice(8, 10));
        if (day <= 7) abonos.push(mov);  // first week of next month
      }
    }
  }

  return abonos;
}

/**
 * Reconcile projected collection events against actual bank movements.
 *
 * @param events      Projected collection events for the period
 * @param clients     Client catalog (for IVA rates, names)
 * @param bankStatements  Bank account statements with movements
 * @param year        Year being reconciled
 * @param month       0-based month being reconciled
 */
export function reconcileCollections(
  events: CollectionEvent[],
  clients: Client[],
  bankStatements: BankAccountStatement[],
  year: number,
  month: number,
): { matches: ReconciliationMatch[]; summary: ReconciliationSummary } {
  const clientMap = new Map(clients.map(c => [c.id, c]));
  const abonos = extractAbonos(bankStatements, year, month);
  const usedAbonos = new Set<number>(); // indices of matched abonos
  const matches: ReconciliationMatch[] = [];

  // Filter events to the target month
  const monthEvents = events.filter(e => {
    const m = Number(e.realDate.slice(5, 7)) - 1;
    return m === month;
  });

  // Sort events by amount descending (match bigger amounts first for better accuracy)
  const sortedEvents = [...monthEvents].sort((a, b) => b.amount - a.amount);

  for (const event of sortedEvents) {
    const client = clientMap.get(event.clientId);
    const ivaRate = (client?.ivaRate ?? 16) / 100;
    const key = eventKey(event);

    // Compute amount variants to try matching:
    // 1. Base amount (as projected)
    // 2. Amount with IVA included (projection might be pre-IVA)
    // 3. Amount without IVA (bank might show net)
    const amountVariants = [
      event.amount,
      event.amount * (1 + ivaRate),     // with IVA
      event.amount / (1 + ivaRate),     // without IVA
    ];

    let bestMatch: {
      abonoIdx: number;
      confidence: number;
      abono: BankStatementLine;
      amountSim: number;
      dateSim: number;
    } | null = null;

    for (let i = 0; i < abonos.length; i++) {
      if (usedAbonos.has(i)) continue;
      const abono = abonos[i];

      // Try each amount variant
      for (const variant of amountVariants) {
        const amountRatio = variant > 0 ? abono.importe / variant : 0;
        if (amountRatio < (1 - AMOUNT_TOLERANCE) || amountRatio > (1 + AMOUNT_TOLERANCE)) continue;

        const amountSim = amountSimilarity(variant, abono.importe);
        const dateSim = dateSimilarity(event.realDate, abono.fechaOperacion);

        if (dateSim === 0) continue; // Outside date tolerance

        const confidence = computeConfidence(amountSim, dateSim);

        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = { abonoIdx: i, confidence, abono, amountSim, dateSim };
        }
      }
    }

    if (bestMatch && bestMatch.confidence >= 0.5) {
      usedAbonos.add(bestMatch.abonoIdx);
      const status: ReconciliationStatus = bestMatch.confidence >= 0.75 ? 'matched' : 'likely';
      matches.push({
        eventKey: key,
        clientId: event.clientId,
        projectedDate: event.realDate,
        projectedAmount: event.amount,
        status,
        confidence: bestMatch.confidence,
        bankMovement: bestMatch.abono,
        actualAmount: bestMatch.abono.importe,
        actualDate: bestMatch.abono.fechaOperacion,
        bankReference: bestMatch.abono.referencia,
        amountDelta: bestMatch.abono.importe - event.amount,
        dateDelta: daysBetween(event.realDate, bestMatch.abono.fechaOperacion),
      });
    } else {
      matches.push({
        eventKey: key,
        clientId: event.clientId,
        projectedDate: event.realDate,
        projectedAmount: event.amount,
        status: 'unmatched',
        confidence: 0,
      });
    }
  }

  // Find unmatched bank abonos (deposits with no corresponding projection)
  const unmatchedBankAbonos = abonos.filter((_, i) => !usedAbonos.has(i));

  // Compute summary
  const matchedEntries = matches.filter(m => m.status === 'matched');
  const likelyEntries = matches.filter(m => m.status === 'likely');
  const unmatchedEntries = matches.filter(m => m.status === 'unmatched');

  const summary: ReconciliationSummary = {
    totalProjected: monthEvents.reduce((s, e) => s + e.amount, 0),
    totalMatched: matchedEntries.reduce((s, m) => s + (m.actualAmount ?? 0), 0),
    totalLikely: likelyEntries.reduce((s, m) => s + (m.actualAmount ?? 0), 0),
    totalUnmatched: unmatchedEntries.reduce((s, m) => s + m.projectedAmount, 0),
    matchedCount: matchedEntries.length,
    likelyCount: likelyEntries.length,
    unmatchedCount: unmatchedEntries.length,
    matchRate: monthEvents.length > 0
      ? (matchedEntries.length + likelyEntries.length) / monthEvents.length
      : 0,
    unmatchedBankAbonos,
  };

  return { matches, summary };
}

/**
 * Build a lookup map: eventKey → ReconciliationMatch
 */
export function buildReconciliationMap(
  matches: ReconciliationMatch[],
): Map<string, ReconciliationMatch> {
  const map = new Map<string, ReconciliationMatch>();
  for (const m of matches) {
    map.set(m.eventKey, m);
  }
  return map;
}
