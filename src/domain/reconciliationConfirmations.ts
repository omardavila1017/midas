import { useEffect, useState } from 'react';
import type {
  AbonoEnrichment,
  RealReconciliationMatch,
  RealReconciliationResult,
  ReconciliationCandidateFactura,
} from './realReconciliationEngine';

const STORAGE_KEY = 'midas/reconciliation-confirmations/v1';
const CHANGE_EVENT = 'midas:reconciliation-confirmations-changed';

function readStorage(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
}

function writeStorage(keys: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(keys)));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    /* swallow quota errors — confirmations are best-effort */
  }
}

export function loadConfirmedReviewKeys(): Set<string> {
  return readStorage();
}

export function confirmReviewKeys(keys: Iterable<string>): Set<string> {
  const next = readStorage();
  for (const key of keys) {
    if (key) next.add(key);
  }
  writeStorage(next);
  return next;
}

export function unconfirmReviewKey(key: string): Set<string> {
  const next = readStorage();
  next.delete(key);
  writeStorage(next);
  return next;
}

export function clearConfirmedReviewKeys(): Set<string> {
  writeStorage(new Set());
  return new Set();
}

export function useConfirmedReviewKeys(): Set<string> {
  const [keys, setKeys] = useState<Set<string>>(() => readStorage());
  useEffect(() => {
    const refresh = () => setKeys(readStorage());
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return keys;
}

function pickBestCandidate(
  candidates: ReconciliationCandidateFactura[] | undefined,
): ReconciliationCandidateFactura | null {
  if (!candidates || candidates.length === 0) return null;
  let best = candidates[0];
  for (const c of candidates) {
    if (c.confidence > best.confidence) best = c;
  }
  return best;
}

/**
 * Aplica una capa de confirmaciones manuales sobre el resultado del
 * matcher. No toca el motor — el motor sigue siendo determinista.
 *
 * Para cada `movementKey` confirmado:
 *  - Sube la mejor factura candidata a `status='cobrada-banco'`.
 *  - Mueve el ABONO a `status='factura-cobrada'`.
 *  - Lo saca de `reviewCandidates`.
 *  - Recalcula el summary.
 */
export function applyManualConfirmations(
  result: RealReconciliationResult,
  confirmedKeys: Set<string>,
): RealReconciliationResult {
  if (confirmedKeys.size === 0) return result;

  const matchByKey = new Map<string, RealReconciliationMatch>();
  const matches: RealReconciliationMatch[] = result.matches.map(m => {
    const clone = { ...m };
    matchByKey.set(`${clone.cia}::${clone.noFactura}`, clone);
    return clone;
  });

  const enrichments: AbonoEnrichment[] = result.abonoEnrichments.map(e => ({ ...e }));
  const consumedKeys = new Set<string>();

  for (const enrichment of enrichments) {
    if (!confirmedKeys.has(enrichment.movementKey)) continue;
    if (enrichment.status !== 'cobranza-sin-factura') continue;
    const best = pickBestCandidate(enrichment.candidateFacturas);
    if (!best) continue;

    const factKey = `${best.cia}::${best.noFactura}`;
    const match = matchByKey.get(factKey);
    if (!match || match.status === 'cobrada-banco') continue;

    match.status = 'cobrada-banco';
    match.matchTier = best.matchTier;
    match.confidence = best.confidence;
    match.reviewStatus = 'auto';
    match.matchReason = `Confirmado manual (${Math.round(best.confidence * 100)}%) — ${best.matchReason}`;
    match.bankRef = enrichment.referencia || enrichment.movementKey;
    match.bankAmount = enrichment.importe;
    match.bankDate = enrichment.fechaOperacion;
    match.bankConcept = enrichment.concepto;
    match.bankAccount = enrichment.cuenta;
    match.bankCia = enrichment.cia;
    match.bankMovements = [{
      movementKey: enrichment.movementKey,
      cia: enrichment.cia,
      cuenta: enrichment.cuenta,
      fechaOperacion: enrichment.fechaOperacion,
      importe: enrichment.importe,
      concepto: enrichment.concepto,
      referencia: enrichment.referencia,
    }];

    enrichment.status = 'factura-cobrada';
    enrichment.matchTier = best.matchTier;
    enrichment.confidence = best.confidence;
    enrichment.facturas = [{
      cia: best.cia,
      noFactura: best.noFactura,
      noCliente: best.noCliente,
      nombreCliente: best.nombreCliente,
      importeBruto: best.importeBruto,
    }];
    enrichment.candidateFacturas = undefined;
    enrichment.matchReason = `Confirmado manual (${Math.round(best.confidence * 100)}%)`;
    consumedKeys.add(enrichment.movementKey);
  }

  const reviewCandidates = result.reviewCandidates.filter(
    rc => !consumedKeys.has(rc.movement.movementKey),
  );

  const cobradas = matches.filter(m => m.status === 'cobrada-banco');
  const cobradasJde = matches.filter(m => m.status === 'cobrada-jde-sin-banco');
  const pendientes = matches.filter(m => m.status === 'pendiente');
  const totalCobradoBanco = cobradas.reduce((s, m) => s + (m.bankAmount ?? 0), 0);
  const totalSaldoPendiente = pendientes.reduce((s, m) => s + m.importePendiente, 0);
  const abonosFacturaCobrada = enrichments.filter(e => e.status === 'factura-cobrada').length;
  const abonosSinFactura = enrichments.filter(e => e.status === 'cobranza-sin-factura').length;
  const facturasConSaldo = matches.filter(
    m => m.importePendiente > 0 || m.status === 'cobrada-banco',
  );

  const summary = {
    ...result.summary,
    facturasCobradasBanco: cobradas.length,
    facturasCobradasJdeSinBanco: cobradasJde.length,
    facturasPendientes: pendientes.length,
    totalSaldoPendiente,
    totalCobradoBanco,
    abonosFacturaCobrada,
    abonosSinFactura,
    pctAbonosCruzados: result.summary.totalAbonos > 0
      ? abonosFacturaCobrada / result.summary.totalAbonos
      : 0,
    pctFacturasCruzadas: facturasConSaldo.length > 0
      ? cobradas.length / facturasConSaldo.length
      : 0,
  };

  return {
    ...result,
    matches,
    abonoEnrichments: enrichments,
    reviewCandidates,
    summary,
  };
}

export function reviewCandidateKeysAboveThreshold(
  result: RealReconciliationResult,
  minConfidence: number,
): string[] {
  const keys: string[] = [];
  for (const candidate of result.reviewCandidates) {
    const best = pickBestCandidate(candidate.candidateFacturas);
    if (best && best.confidence >= minConfidence) {
      keys.push(candidate.movement.movementKey);
    }
  }
  return keys;
}
