/**
 * Global company / unidad-negocio exclusion.
 *
 * Single source of truth for which entities are dropped from the whole system
 * (banks, gastos, proyección, KPIs). Three independent match modes — an entity
 * is excluded if ANY rule matches:
 *
 *   1. `cia` number      — e.g. "empresa 33" → cia "00033" / "33" / 33
 *   2. company `nombre`  — accent/case-insensitive substring (e.g. "multicarga")
 *   3. `unidadNegocio`   — bank-account business unit (e.g. "MULTICARGA")
 *
 * Blanket exclusion (no date boundary): a matching entity is dropped in ALL
 * dates, including historical records — multicarga must never appear anywhere.
 *
 * Applied at the JDE normalize layer of every fetch (CXP, cobranza, pagos de
 * cobranza, compras, pagoProveedor, nómina, bancos, Rol) and the
 * company-selector sites. Do NOT apply this inside canonicalProjection.ts —
 * the cut lives upstream of the record arrays; double-filtering (UI + engine)
 * is a bug.
 *
 * See EXCLUSION_RULES.md for the human-readable rule documentation.
 */

export interface ExclusionRules {
  /** JDE company numbers to exclude (compared numerically; padding-agnostic). */
  ciaNumbers: number[];
  /** Substrings matched against company name (accent/case-insensitive). */
  namePatterns: string[];
  /** Bank-account unidadNegocio values to exclude (case-insensitive). */
  unidadesNegocio: string[];
}

/**
 * Reglas de exclusión global. **Vacías por decisión de negocio (2026-06-04):
 * ya NO se excluye nada — Multicarga / empresa 33 y BanBajío vuelven a contar
 * en todo el sistema.** El mecanismo se conserva intacto (tres modos de match)
 * para poder reactivar exclusiones a futuro: basta agregar un número de cia,
 * un substring de nombre, o una unidadNegocio al arreglo correspondiente.
 */
export const EXCLUSION_RULES: ExclusionRules = {
  ciaNumbers: [],
  namePatterns: [],
  unidadesNegocio: [],
};

/**
 * Parse a cia value to its numeric form, padding-agnostic. "00033" → 33.
 *
 * NOT built on domain/cia.normalizeCia on purpose: this contract is
 * parseInt-based (leading digits only — "MX-33" → null), while the canonical
 * takes the FIRST digit run anywhere ("MX-33" → "00033" → 33). Rebasing it
 * would silently widen exclusion matching for alphanumeric cia strings.
 */
export function normalizeCiaNumber(cia: unknown): number | null {
  if (cia == null) return null;
  const n = typeof cia === 'number' ? cia : parseInt(String(cia).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .trim();
}

export interface ExclusionInput {
  cia?: string | number | null;
  nombre?: string | null;
  unidadNegocio?: string | null;
}

/**
 * Pure identity match across the three modes — no date involved. Use for
 * company-catalog / fetch gating (forward-looking).
 */
export function matchesExclusionIdentity(
  input: ExclusionInput,
  rules: ExclusionRules = EXCLUSION_RULES,
): boolean {
  const ciaNum = normalizeCiaNumber(input.cia);
  if (ciaNum != null && rules.ciaNumbers.includes(ciaNum)) return true;

  if (input.nombre) {
    const name = fold(input.nombre);
    if (rules.namePatterns.some(p => name.includes(fold(p)))) return true;
  }

  if (input.unidadNegocio) {
    const un = input.unidadNegocio.trim().toUpperCase();
    if (rules.unidadesNegocio.some(u => u.trim().toUpperCase() === un)) return true;
  }

  return false;
}

/**
 * Company-level exclusion (identity only). Use to gate fetching/aggregation
 * and the company selector.
 */
export function isExcludedCompany(
  company: { cia?: string | number | null; nombre?: string | null },
  rules: ExclusionRules = EXCLUSION_RULES,
): boolean {
  return matchesExclusionIdentity(
    { cia: company.cia, nombre: company.nombre },
    rules,
  );
}

/**
 * Centralizes the `activa !== false` + exclusion filter. Replaces every
 * scattered `companies.filter(c => c.activa !== false)` site so the rule can
 * never drift again.
 */
export function filterActiveCompanies<
  T extends { cia: string; nombre?: string | null; activa?: boolean },
>(companies: T[], rules: ExclusionRules = EXCLUSION_RULES): T[] {
  return companies.filter(
    c => c.activa !== false && !isExcludedCompany(c, rules),
  );
}
