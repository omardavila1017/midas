# Global exclusion rules

The single source of truth is
[`src/domain/companyExclusion.ts`](src/domain/companyExclusion.ts) — do not
re-implement this filter anywhere else, and do **not** apply it inside
`canonicalProjection.ts` (double-filtering UI + engine is a bug).

## Current state (2026-08-05): Multicarga / empresa 33 is excluded

By business decision (Santiago: "no los queremos ni jalar ni son relevantes en
nada de Midas"), **`EXCLUSION_RULES` excludes Multicarga / empresa 33 again**
— blanket, all three match modes, everywhere (bancos, gastos, proyección,
KPIs, histórico). This restores the original roadmap values that were emptied
on 2026-06-04.

```ts
export const EXCLUSION_RULES: ExclusionRules = {
  ciaNumbers: [33],
  namePatterns: ['multicarga'],
  unidadesNegocio: ['MULTICARGA'],
};
```

> **BanBajío is NOT re-excluded.** It was a *separate* switch from this
> catalog: it lived in `excludeBajio` / `isBajioStatement`
> (`src/domain/bankStatements.ts`) and was applied in `AppCore.tsx`
> (`accountableBankStatements`). Since 2026-06-04 the accountable bank set
> **includes** Bajío and that stays unchanged; `isBajioStatement` is kept only
> to feed the Fideicomiso DINA module (which still re-injects CORNING + DINA
> into non-base scenarios). See CLAUDE.md.

## Matching mechanism

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
  `excludeBajio` ran. This covers persisted IDB/localStorage caches and manual
  uploads that bypass `fetchBankStatements`, so stale Multicarga rows cached
  before re-enabling are also hidden.

## How to change an exclusion

Edit the `EXCLUSION_RULES` constant in `src/domain/companyExclusion.ts` and
add/remove a cia number, a name substring, or a unidadNegocio in the relevant
array. There is no date boundary — the match is blanket.
