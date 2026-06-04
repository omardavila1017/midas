# Global exclusion rules

The single source of truth is
[`src/domain/companyExclusion.ts`](src/domain/companyExclusion.ts) — do not
re-implement this filter anywhere else, and do **not** apply it inside
`canonicalProjection.ts` (double-filtering UI + engine is a bug).

## Current state (2026-06-04): nothing is excluded

By business decision, **`EXCLUSION_RULES` is empty** — Multicarga / empresa 33
and BanBajío now count everywhere (bancos, gastos, proyección, KPIs, histórico).

```ts
export const EXCLUSION_RULES: ExclusionRules = {
  ciaNumbers: [],
  namePatterns: [],
  unidadesNegocio: [],
};
```

The matching mechanism is preserved (see below) so exclusions can be
re-enabled at any time by adding values to the arrays.

> **BanBajío** was a *separate* switch from this catalog: it lived in
> `excludeBajio` / `isBajioStatement` (`src/domain/bankStatements.ts`) and was
> applied in `AppCore.tsx` (`accountableBankStatements`). As of 2026-06-04 the
> accountable bank set **includes** Bajío too; `isBajioStatement` is kept only
> to feed the Fideicomiso DINA module (which still re-injects CORNING + DINA
> into non-base scenarios). See CLAUDE.md.

## Matching mechanism (for when exclusions are re-enabled)

An entity is excluded if **any** of three independent modes matches:

| Match mode | Field | Example value |
|---|---|---|
| `cia` number (padding-agnostic: `33`, `"33"`, `"00033"`) | company cia | `33` |
| company `nombre` substring (accent/case-insensitive) | company name | `"multicarga"` |
| bank-account `unidadNegocio` | bank account | `"MULTICARGA"` |

The single predicate is `matchesExclusionIdentity` (identity only, no date).
The exclusion is a **blanket delete** — no effective date, historical records
are dropped too.

## Where it is applied

- **Company selector + fetch gating** — `filterActiveCompanies(companies)`
  replaces every `companies.filter(c => c.activa !== false)` site in
  `src/App.tsx`.
- **JDE normalize layer** — every base fetch in `src/services/jde.ts` drops
  excluded rows before returning (via the local `dropExcludedByCia` helper, or
  inline for bank lines which also match on `unidadNegocio`). Covered:
  `fetchAgedBalances` (CXP), `fetchCobranza`, `normalizeCobranzaPayments`
  (`fetchIndicadoresCobranza`), `fetchCompras`, `fetchPagoProveedor`,
  `fetchNomina`, `fetchBankStatements`, `fetchRol`. The `*Range` variants
  delegate to these base fetches.
- **Bank-statement display chokepoint** — the `bankStatements` memo in
  `src/AppCore.tsx` filters excluded accounts (by `cia`) right where
  `excludeBajio` ran. With empty rules this is a no-op, but it stays so a
  re-enabled rule covers persisted IDB/localStorage caches and manual uploads
  that bypass `fetchBankStatements`.

## How to re-enable an exclusion

Edit the `EXCLUSION_RULES` constant in `src/domain/companyExclusion.ts` and add
a cia number, a name substring, or a unidadNegocio to the relevant array. There
is no date boundary — the match is blanket.
