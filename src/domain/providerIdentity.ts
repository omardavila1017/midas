/**
 * providerIdentity — central provider matching across data sources.
 *
 * Sources that reference proveedores by code:
 *   - Catálogo de Proveedores  → Provider.numProveedorJDE
 *   - Órdenes de Compras (OC)  → ComprasRecord.noProveedor
 *   - CXP (Antigüedad Saldos)  → CXPRecord.noProveedor
 *   - Pagos a Proveedores      → PagoProveedorRecord.claveProveedor
 *
 * The JDE numeric code is the canonical join key. This module normalizes
 * different shapes ("107671", "00107671", " 107671 ", etc.) into a stable
 * string so the rest of the app can ask "give me catalog metadata for this
 * provider" without re-implementing the normalizer.
 *
 * Fallback to name match (uppercase + diacritic strip) when no JDE code
 * exists on either side — useful for legacy bank statements.
 */

import { CLASIFICACION_LABELS, type Provider } from './types';

export type ProviderMatchKind = 'jde' | 'name' | 'none';

export interface ProviderMatch {
  provider: Provider | null;
  matchKind: ProviderMatchKind;
}

export type ProviderBusinessClassificationKey =
  | 'OPERACION'
  | 'PRIORITARIO'
  | 'NEGOCIABLE'
  | 'FLEXIBLE'
  | 'PAUSA'
  | 'SIN_CLASIFICAR';

export interface ProviderBusinessClassification {
  key: ProviderBusinessClassificationKey;
  label: string;
}

/** Normaliza un número de proveedor JDE a un string canónico. */
export function normalizeJdeKey(value: string | number | undefined | null): string {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  if (!text) return '';
  const digits = text.replace(/\D+/g, '');
  if (digits) return String(Number(digits));
  return text.toUpperCase();
}

// Memo cache: la función se llama por provider × varias rutas (catalog
// overlay, deriveProvidersFromJde, buildProviderIndex, reportUnmatched...)
// con los mismos strings repetidos miles de veces durante boot. Las regex
// (3 passes + normalize NFKD) son puras → cachear por input ahorra repeat
// work sin riesgo. Cap el cache a un tamaño razonable por si entra un
// torrente de nombres únicos (poco probable, pero seguro).
const PROVIDER_NAME_CACHE = new Map<string, string>();
const PROVIDER_NAME_CACHE_LIMIT = 20_000;

/** Normaliza un nombre para hacer match cuando no hay código JDE. */
export function normalizeProviderName(name: string | undefined | null): string {
  if (!name) return '';
  const hit = PROVIDER_NAME_CACHE.get(name);
  if (hit !== undefined) return hit;
  const normalized = name
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (PROVIDER_NAME_CACHE.size >= PROVIDER_NAME_CACHE_LIMIT) {
    // Cap defensivo: si el cache crece sin límite hay un input no esperado.
    // Tirar el cache entero es más simple que mantener LRU y suficiente
    // para el caso patológico (re-llenamos al siguiente paso del catálogo).
    PROVIDER_NAME_CACHE.clear();
  }
  PROVIDER_NAME_CACHE.set(name, normalized);
  return normalized;
}

/** Index a catalog list by JDE key and name for O(1) lookup. */
export interface ProviderIndex {
  byJde: Map<string, Provider>;
  byName: Map<string, Provider>;
  all: Provider[];
}

export function buildProviderIndex(providers: Provider[]): ProviderIndex {
  const byJde = new Map<string, Provider>();
  const byName = new Map<string, Provider>();
  for (const p of providers) {
    const jdeKey = normalizeJdeKey(p.numProveedorJDE);
    if (jdeKey) {
      const existing = byJde.get(jdeKey);
      if (!existing || providerHasMoreData(p, existing)) byJde.set(jdeKey, p);
    }
    const nameKey = normalizeProviderName(p.name);
    if (nameKey) {
      const existing = byName.get(nameKey);
      if (!existing || providerHasMoreData(p, existing)) byName.set(nameKey, p);
    }
  }
  return { byJde, byName, all: providers };
}

/**
 * Resuelve un proveedor desde una referencia transaccional. Prefiere match
 * por código JDE; si no hay, intenta nombre normalizado.
 */
export function findProviderByRef(
  index: ProviderIndex,
  ref: { jdeCode?: string | number | null; name?: string | null },
): ProviderMatch {
  const jdeKey = normalizeJdeKey(ref.jdeCode);
  if (jdeKey) {
    const hit = index.byJde.get(jdeKey);
    if (hit) return { provider: hit, matchKind: 'jde' };
  }
  const nameKey = normalizeProviderName(ref.name ?? null);
  if (nameKey) {
    const hit = index.byName.get(nameKey);
    if (hit) return { provider: hit, matchKind: 'name' };
  }
  return { provider: null, matchKind: 'none' };
}

/** Sólo el provider, o null. */
export function lookupProvider(
  index: ProviderIndex,
  ref: { jdeCode?: string | number | null; name?: string | null },
): Provider | null {
  return findProviderByRef(index, ref).provider;
}

export function providerBusinessClassification(
  provider: Provider | null | undefined,
): ProviderBusinessClassification {
  if (!provider) return { key: 'SIN_CLASIFICAR', label: CLASIFICACION_LABELS.SIN_CLASIFICAR };

  switch (provider.clasificacionAlberto) {
    case 'CRITICO':
      return { key: 'OPERACION', label: CLASIFICACION_LABELS.CRITICO };
    case 'FLEX_ALTO':
      return { key: 'PRIORITARIO', label: CLASIFICACION_LABELS.FLEX_ALTO };
    case 'FLEX_MEDIO':
      return { key: 'NEGOCIABLE', label: CLASIFICACION_LABELS.FLEX_MEDIO };
    case 'FLEX_BAJO':
      return { key: 'FLEXIBLE', label: CLASIFICACION_LABELS.FLEX_BAJO };
    case 'PAUSAR':
      return { key: 'PAUSA', label: CLASIFICACION_LABELS.PAUSAR };
    case 'SIN_CLASIFICAR':
    case undefined:
      break;
  }

  switch (provider.clasificacionAutomatica) {
    case 'CRITICO':
      return { key: 'OPERACION', label: CLASIFICACION_LABELS.CRITICO };
    case 'ALTO':
      return { key: 'PRIORITARIO', label: CLASIFICACION_LABELS.FLEX_ALTO };
    case 'MEDIO':
      return { key: 'NEGOCIABLE', label: CLASIFICACION_LABELS.FLEX_MEDIO };
    case 'BAJO':
      return { key: 'FLEXIBLE', label: CLASIFICACION_LABELS.FLEX_BAJO };
  }

  return { key: 'SIN_CLASIFICAR', label: CLASIFICACION_LABELS.SIN_CLASIFICAR };
}

/**
 * Etiqueta corta para badge en tablas. "CRITICO" / "FLEX. ALTO" / etc.
 * Devuelve null si no hay clasificación útil.
 */
export function provierClassificationLabel(provider: Provider | null | undefined): string | null {
  const classification = providerBusinessClassification(provider);
  return classification.key === 'SIN_CLASIFICAR' ? null : classification.label;
}

/** Tone para chips. Usa tokens DS. */
export function providerClassificationTone(provider: Provider | null | undefined): {
  bg: string;
  text: string;
  border: string;
} | null {
  if (!provider) return null;
  const alberto = provider.clasificacionAlberto && provider.clasificacionAlberto !== 'SIN_CLASIFICAR'
    ? provider.clasificacionAlberto
    : undefined;
  const cls = alberto || provider.clasificacionAutomatica;
  switch (cls) {
    case 'CRITICO':
      return { bg: 'var(--danger-muted)', text: 'var(--danger)', border: 'oklch(88% 0.08 25)' };
    case 'FLEX_ALTO':
    case 'ALTO':
      return { bg: 'var(--warning-muted)', text: 'var(--warning)', border: 'oklch(88% 0.08 80)' };
    case 'FLEX_MEDIO':
    case 'MEDIO':
      return { bg: 'var(--gray-100)', text: 'var(--gray-700)', border: 'var(--gray-200)' };
    case 'FLEX_BAJO':
    case 'BAJO':
      return { bg: 'var(--success-muted)', text: 'var(--success)', border: 'oklch(88% 0.08 145)' };
    case 'PAUSAR':
      return { bg: 'var(--gray-50)', text: 'var(--gray-500)', border: 'var(--gray-200)' };
    default:
      return null;
  }
}

/**
 * Reporta proveedores con movimientos transaccionales que NO están en el
 * catálogo — útil para detectar gaps de data quality.
 */
export interface UnmatchedReport {
  totalRefs: number;
  matched: number;
  unmatched: number;
  unmatchedSamples: Array<{ jdeCode: string; name: string; sourceCount: number }>;
}

export function reportUnmatchedProviders(
  index: ProviderIndex,
  refs: Array<{ jdeCode?: string | number | null; name?: string | null }>,
  sampleLimit = 20,
): UnmatchedReport {
  const seen = new Map<string, { jdeCode: string; name: string; sourceCount: number; matched: boolean }>();
  for (const ref of refs) {
    const jdeKey = normalizeJdeKey(ref.jdeCode);
    const nameKey = normalizeProviderName(ref.name ?? null);
    const key = jdeKey || nameKey;
    if (!key) continue;
    const existing = seen.get(key);
    if (existing) {
      existing.sourceCount += 1;
      continue;
    }
    const match = findProviderByRef(index, ref);
    seen.set(key, {
      jdeCode: jdeKey,
      name: (ref.name ?? '').toString().trim(),
      sourceCount: 1,
      matched: match.provider !== null,
    });
  }
  const matched = Array.from(seen.values()).filter((v) => v.matched).length;
  const unmatched = Array.from(seen.values()).filter((v) => !v.matched);
  const samples = unmatched
    .sort((a, b) => b.sourceCount - a.sourceCount)
    .slice(0, sampleLimit)
    .map((v) => ({ jdeCode: v.jdeCode, name: v.name, sourceCount: v.sourceCount }));
  return {
    totalRefs: seen.size,
    matched,
    unmatched: unmatched.length,
    unmatchedSamples: samples,
  };
}

function providerHasMoreData(a: Provider, b: Provider): boolean {
  const score = (p: Provider) =>
    (p.numProveedorJDE ? 4 : 0)
    + (p.clasificacionAlberto && p.clasificacionAlberto !== 'SIN_CLASIFICAR' ? 3 : 0)
    + (p.clasificacionAutomatica ? 2 : 0)
    + (p.score != null ? 1 : 0);
  return score(a) > score(b);
}
