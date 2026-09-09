/**
 * Matcher cliente↔cobranza — espejo del patrón usado en
 * realReconciliationEngine.ts para banks↔cobranza.
 *
 * Produce sugerencias tier-by-tier sobre qué `(cia, noCliente)` JDE
 * corresponde a cada `Client` del catálogo. El consumidor decide qué hacer
 * con cada cubo:
 *   - autoAccepted   (≥ AUTO_ACCEPT_THRESHOLD) → persistir directo a Client.jdeAccounts
 *   - needsReview    (≥ REVIEW_THRESHOLD)       → mostrar en wizard
 *   - orphanNoClientes                          → cuentas JDE sin candidato decente
 *
 * Tiers (mismos pesos conceptuales que el patrón de banks):
 *   rfc-exact       1.00
 *   name-exact      0.98
 *   substring       0.90  (≥ 8 chars normalizados)
 *   token-overlap   0.62–0.85 (jaccard sobre tokens significativos)
 */

import type { Client, ClientCobranzaMatchTier, JdeAccountLink } from './types';
import type { CobranzaRecord } from '../services/jdeTypes';

export const AUTO_ACCEPT_THRESHOLD = 0.85;
export const REVIEW_THRESHOLD = 0.62;
const SUBSTRING_MIN_CHARS = 8;

export interface MatchSuggestion {
  clientId: string;
  cia: string;
  noCliente: string;
  nombreCliente: string;
  rfc?: string;
  tier: ClientCobranzaMatchTier;
  confidence: number;
  invoiceCount: number;
}

export interface OrphanNoCliente {
  cia: string;
  noCliente: string;
  nombreCliente: string;
  rfc?: string;
  invoiceCount: number;
  bestGuess?: MatchSuggestion;
}

export interface MatcherOutput {
  autoAccepted: MatchSuggestion[];
  needsReview: MatchSuggestion[];
  orphanNoClientes: OrphanNoCliente[];
}

// ── Normalización (réplica de realReconciliationEngine.ts:429) ─────────────
function normalizeName(s: string | undefined | null): string {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCompact(s: string | undefined | null): string {
  return normalizeName(s).replace(/ /g, '');
}

const STOPWORDS = new Set([
  'SA', 'CV', 'SAB', 'SAPI', 'SC', 'AC', 'RL', 'DE', 'EL', 'LA', 'LOS', 'LAS',
  'DEL', 'Y', 'E', 'O', 'SR', 'SRA', 'COMPANIA', 'COMPANIAS', 'GRUPO',
  'CLIENTE', 'CORPORATIVO', 'INTERNACIONAL', 'NACIONAL', 'SERVICIOS',
  'TRANSPORTES', 'MEXICO',
]);

function significantTokens(s: string | undefined | null): string[] {
  return normalizeName(s)
    .split(' ')
    .filter(t => t.length >= 4 && !STOPWORDS.has(t));
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const t of setA) if (setB.has(t)) intersect++;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersect / union;
}

// ── Index sobre cobranza ────────────────────────────────────────────────────

interface CobranzaAccountAggregate {
  cia: string;
  noCliente: string;
  nombreCliente: string;
  rfc?: string;
  invoiceCount: number;
}

/** Agrupa cobranza por (cia, noCliente) para tratarlo como una "cuenta JDE". */
function aggregateAccounts(records: CobranzaRecord[]): CobranzaAccountAggregate[] {
  const map = new Map<string, CobranzaAccountAggregate>();
  for (const r of records) {
    const key = `${r.cia}::${r.noCliente}`;
    const cur = map.get(key);
    if (cur) {
      cur.invoiceCount++;
      if (!cur.rfc && r.rfc) cur.rfc = r.rfc;
    } else {
      map.set(key, {
        cia: r.cia,
        noCliente: r.noCliente,
        nombreCliente: r.nombreCliente,
        rfc: r.rfc || undefined,
        invoiceCount: 1,
      });
    }
  }
  return Array.from(map.values());
}

// ── Scoring por cuenta vs cliente ──────────────────────────────────────────

interface ClientFingerprint {
  client: Client;
  rfc?: string;
  names: string[];          // normalizadas: name, legalName, commercialGroupName
  namesCompact: string[];
  tokens: string[];
}

function fingerprint(client: Client): ClientFingerprint {
  const raws = [client.name, client.legalName, client.commercialGroupName].filter(Boolean) as string[];
  const names = raws.map(normalizeName).filter(Boolean);
  const namesCompact = raws.map(normalizeCompact).filter(Boolean);
  const tokens = Array.from(new Set(raws.flatMap(significantTokens)));
  return {
    client,
    rfc: client.rfc?.toUpperCase().trim() || undefined,
    names,
    namesCompact,
    tokens,
  };
}

function scoreClientAccount(
  fp: ClientFingerprint,
  account: CobranzaAccountAggregate,
): { tier: ClientCobranzaMatchTier; confidence: number } | null {
  // 1. RFC-exact
  const accRfc = account.rfc?.toUpperCase().trim();
  if (fp.rfc && accRfc && fp.rfc === accRfc) {
    return { tier: 'rfc-exact', confidence: 1 };
  }

  const accName = normalizeName(account.nombreCliente);
  const accCompact = normalizeCompact(account.nombreCliente);
  if (!accName) return null;

  // 2. name-exact (normalizado)
  if (fp.names.some(n => n === accName) || fp.namesCompact.some(n => n === accCompact)) {
    return { tier: 'name-exact', confidence: 0.98 };
  }

  // 3. substring ≥ 8 chars
  if (accCompact.length >= SUBSTRING_MIN_CHARS) {
    const hit = fp.namesCompact.some(n =>
      n.length >= SUBSTRING_MIN_CHARS && (n.includes(accCompact) || accCompact.includes(n))
    );
    if (hit) return { tier: 'substring', confidence: 0.9 };
  }

  // 4. token-overlap (jaccard sobre tokens significativos)
  const accTokens = significantTokens(account.nombreCliente);
  if (fp.tokens.length >= 2 && accTokens.length >= 2) {
    const j = jaccard(fp.tokens, accTokens);
    if (j >= 0.5) {
      const confidence = 0.62 + (j - 0.5) * (0.85 - 0.62) / 0.5;
      return { tier: 'token-overlap', confidence: Math.min(0.85, confidence) };
    }
  }

  return null;
}

// ── API pública ────────────────────────────────────────────────────────────

/**
 * Calcula sugerencias de match entre el catálogo y los registros de cobranza.
 *
 * No persiste nada. El llamador decide cómo aplicar los buckets:
 *   - autoAccepted    → push a Client.jdeAccounts con matchedBy='auto'
 *   - needsReview     → mostrar en wizard
 *   - orphanNoClientes → mostrar en tab "Sin asignar"
 *
 * Tie-break por candidato múltiple: confidence DESC → presencia de RFC en
 * el cliente → tier rank → primer match estable.
 */
export function buildMatchSuggestions(
  clients: Client[],
  cobranzaRecords: CobranzaRecord[],
): MatcherOutput {
  if (clients.length === 0 || cobranzaRecords.length === 0) {
    return { autoAccepted: [], needsReview: [], orphanNoClientes: [] };
  }

  // Excluir cuentas JDE que ya están enlazadas (matchedBy='user' o 'auto').
  const linkedKeys = new Set<string>();
  for (const c of clients) {
    if (!c.jdeAccounts) continue;
    for (const link of c.jdeAccounts) {
      linkedKeys.add(`${link.cia}::${link.noCliente}`);
    }
  }

  const accounts = aggregateAccounts(cobranzaRecords).filter(
    a => !linkedKeys.has(`${a.cia}::${a.noCliente}`),
  );
  const fingerprints = clients.map(fingerprint);

  // Para cada cuenta JDE, encontrar al mejor cliente candidato.
  const autoAccepted: MatchSuggestion[] = [];
  const needsReview: MatchSuggestion[] = [];
  const orphanNoClientes: OrphanNoCliente[] = [];

  const tierRank: Record<ClientCobranzaMatchTier, number> = {
    'rfc-exact': 4,
    'name-exact': 3,
    'substring': 2,
    'token-overlap': 1,
  };

  for (const acc of accounts) {
    let best: { fp: ClientFingerprint; tier: ClientCobranzaMatchTier; confidence: number } | null = null;
    for (const fp of fingerprints) {
      const s = scoreClientAccount(fp, acc);
      if (!s) continue;
      if (!best) {
        best = { fp, ...s };
        continue;
      }
      if (s.confidence > best.confidence) best = { fp, ...s };
      else if (s.confidence === best.confidence) {
        const sRank = tierRank[s.tier];
        const bRank = tierRank[best.tier];
        if (sRank > bRank) best = { fp, ...s };
        else if (sRank === bRank && !best.fp.rfc && fp.rfc) best = { fp, ...s };
      }
    }

    if (!best) {
      orphanNoClientes.push({
        cia: acc.cia,
        noCliente: acc.noCliente,
        nombreCliente: acc.nombreCliente,
        rfc: acc.rfc,
        invoiceCount: acc.invoiceCount,
      });
      continue;
    }

    const suggestion: MatchSuggestion = {
      clientId: best.fp.client.id,
      cia: acc.cia,
      noCliente: acc.noCliente,
      nombreCliente: acc.nombreCliente,
      rfc: acc.rfc,
      tier: best.tier,
      confidence: best.confidence,
      invoiceCount: acc.invoiceCount,
    };

    // No hay tercera rama: `REVIEW_THRESHOLD` es el PISO del tier más bajo
    // (`token-overlap` con jaccard 0.5 devuelve exactamente 0.62), así que un
    // candidato que puntuó siempre alcanza review. La rama `else` que existía
    // aquí —empujar el orphan con `bestGuess`— era inalcanzable por
    // construcción, y hacía creer que un orphan podía traer conjetura desde el
    // matcher. La conjetura se la pone `AppCore` a los `needsReview` por debajo
    // de `AUTO_MERGE_THRESHOLD`; el bucket `orphanNoClientes` de aquí es sólo
    // "ningún candidato puntuó", y por eso va sin `bestGuess`.
    //
    // El piso está pineado por test: si alguien baja la confianza de un tier
    // por debajo de `REVIEW_THRESHOLD`, truena en vez de perder silenciosamente
    // ese candidato.
    if (best.confidence >= AUTO_ACCEPT_THRESHOLD) autoAccepted.push(suggestion);
    else needsReview.push(suggestion);
  }

  return { autoAccepted, needsReview, orphanNoClientes };
}

/**
 * Para un orphan, ranquea los top-N clientes del catálogo por similitud de
 * nombre/tokens/substring sin aplicar umbrales. Útil para sugerencias en UI
 * cuando el matcher principal no encontró candidato sobre REVIEW_THRESHOLD.
 *
 * Score combinado: jaccard de tokens (0..1) + bonus por substring largo.
 * Ignora RFC (esos ya los capturó el matcher principal).
 */
export function rankClientsForAccount(
  account: { cia: string; noCliente: string; nombreCliente: string; rfc?: string; invoiceCount?: number },
  clients: Client[],
  limit = 5,
): MatchSuggestion[] {
  const accName = normalizeName(account.nombreCliente);
  const accCompact = normalizeCompact(account.nombreCliente);
  const accTokens = significantTokens(account.nombreCliente);
  if (!accName) return [];

  const scored: Array<{ client: Client; score: number; tier: ClientCobranzaMatchTier }> = [];
  for (const c of clients) {
    const fp = fingerprint(c);
    let score = 0;
    let tier: ClientCobranzaMatchTier = 'token-overlap';

    if (fp.names.some(n => n === accName) || fp.namesCompact.some(n => n === accCompact)) {
      score = 1; tier = 'name-exact';
    } else if (
      accCompact.length >= SUBSTRING_MIN_CHARS &&
      fp.namesCompact.some(n => n.length >= SUBSTRING_MIN_CHARS && (n.includes(accCompact) || accCompact.includes(n)))
    ) {
      score = 0.9; tier = 'substring';
    } else if (fp.tokens.length > 0 && accTokens.length > 0) {
      const j = jaccard(fp.tokens, accTokens);
      // Bonus pequeño por substring parcial entre nombres compactos.
      let sub = 0;
      for (const n of fp.namesCompact) {
        if (n.length < 5) continue;
        const minLen = Math.min(n.length, accCompact.length, 5);
        for (let len = minLen; len <= Math.min(n.length, accCompact.length); len++) {
          if (accCompact.length >= len && n.includes(accCompact.slice(0, len))) sub = Math.max(sub, len / Math.max(n.length, accCompact.length));
        }
      }
      score = j * 0.85 + sub * 0.15;
      tier = 'token-overlap';
    }

    if (score > 0) scored.push({ client: c, score, tier });
  }

  scored.sort((a, b) => b.score - a.score || a.client.name.localeCompare(b.client.name));

  return scored.slice(0, limit).map(s => ({
    clientId: s.client.id,
    cia: account.cia,
    noCliente: account.noCliente,
    nombreCliente: account.nombreCliente,
    rfc: account.rfc,
    tier: s.tier,
    confidence: s.score,
    invoiceCount: account.invoiceCount ?? 0,
  }));
}

/** Conversión de una sugerencia aceptada a un JdeAccountLink persistible. */
export function suggestionToLink(s: MatchSuggestion, matchedBy: 'auto' | 'user'): JdeAccountLink {
  return {
    cia: s.cia,
    noCliente: s.noCliente,
    nombreCliente: s.nombreCliente,
    rfc: s.rfc,
    matchedAt: new Date().toISOString(),
    matchedBy,
    confidence: matchedBy === 'auto' ? s.confidence : undefined,
    tier: matchedBy === 'auto' ? s.tier : undefined,
  };
}
