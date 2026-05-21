# Global exclusion rules

Some entities must never appear in system-wide aggregates (bancos, gastos,
proyección, KPIs). The single source of truth is
[`src/domain/companyExclusion.ts`](src/domain/companyExclusion.ts) — do not
re-implement this filter anywhere else, and do **not** apply it inside
`canonicalProjection.ts` (double-filtering UI + engine is a bug).

## What is excluded

| Target | Match mode | Configured value |
|---|---|---|
| Empresa 33 | `cia` number (padding-agnostic: `33`, `"33"`, `"00033"`) | `33` |
| Multicarga | company `nombre` substring (accent/case-insensitive) | `"multicarga"` |
| Multicarga | bank-account `unidadNegocio` | `"MULTICARGA"` |

An entity is excluded if **any** of the three modes matches. Empresa 33 was
confirmed by the user to be all three forms (a cia number, a name, and a
unidad de negocio) — hence the three independent modes in one predicate.

## No date boundary — blanket exclusion

The exclusion is a **blanket delete**, not effective-dated:

- A matching entity is dropped in **all dates, including historical records**.
- Multicarga must never appear anywhere — there is no cutoff to configure.

The single predicate is `matchesExclusionIdentity` (identity only, no date).

## Where it is applied

- **Company selector + fetch gating** — `filterActiveCompanies(companies)`
  replaces every `companies.filter(c => c.activa !== false)` site in
  `src/App.tsx` (6 sites).
- **JDE normalize layer** — every base fetch in `src/services/jde.ts` drops
  excluded rows before returning (via the local `dropExcludedByCia` helper,
  or inline for bank lines which also match on `unidadNegocio`). Covered:
  `fetchAgedBalances` (CXP), `fetchCobranza`, `normalizeCobranzaPayments`
  (`fetchIndicadoresCobranza`), `fetchCompras`, `fetchPagoProveedor`,
  `fetchNomina`, `fetchBankStatements`, `fetchRol`. The `*Range` variants
  delegate to these base fetches, so they are covered too. The cut lives
  upstream of the record arrays — downstream (canonical, Dashboard,
  Planeación, Proyección, taxes) inherits it for free.
- **Bank-statement display chokepoint** — the `bankStatements` memo in
  `src/App.tsx` filters excluded accounts (by `cia`) right where
  `excludeBajio` runs. Required because persisted IDB/localStorage bank
  caches (`loadBankCaches`), the daily-cache path and manual uploads feed
  the UI without passing through `fetchBankStatements`; the fetch-layer cut
  alone leaves stale multicarga accounts visible until a refetch.

## How to change the rules

Edit the `EXCLUSION_RULES` constant in `src/domain/companyExclusion.ts`:

```ts
export const EXCLUSION_RULES: ExclusionRules = {
  ciaNumbers: [33],
  namePatterns: ['multicarga'],
  unidadesNegocio: ['MULTICARGA'],
};
```

Add a cia number, a name substring, or a unidadNegocio to the relevant array.
There is no date boundary — the match is blanket.
