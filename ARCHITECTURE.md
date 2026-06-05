# Midas — Architecture

> High-level layered view of the codebase. For the dense operational map (every
> file, every engine, the rules that bite), read **`CLAUDE.md`** — it is the
> source of truth. This file is the orientation that `src/domain/types.ts`
> points to under "architecture layers".

Midas is a React + Vite + TypeScript single-page app for treasury cash-flow
review, short-term projection, reconciliation, and scenario planning. It has no
business backend of its own: it reads JDE / TRESS / CITI over same-origin
`/api/*` proxies, enriches with bundled catalogs, computes everything in the
browser (with web workers for the heavy paths), and persists to `localStorage`
+ IndexedDB.

## Layers (top to bottom)

```text
1. External systems        JDE (REST), TRESS (nómina), CITI (ROL / viajes)
        │                  + bundled JSON catalogs (clients / providers)
        ▼
2. Proxy layer             api/[jde|tress|citi|openai|auth]/*  (serverless
        │                  functions; inject the bearer token server-side via
        │                  the shared api/_lib/apiProxy.ts)
        ▼
3. Service layer           src/services/  (jde.ts, jdeClient.ts, tress*.ts,
        │                  catalog.service.ts, dailyApiCache.ts, heavyStoreIDB.ts)
        │                  — fetch, normalize, cache, per-cia global exclusion hook
        ▼
4. Domain engines          src/domain/  (cash-flow, reconciliation, collection,
        │                  IVA ledger, predictive/Holt-Winters, persistence,
        │                  storageRegistry, netCashFlow, …) — pure-ish TS, testable
        ▼
5. Calculation engine      src/modules/shared-finance/calculation-engine/
        │                  canonicalProjection.ts (public entry) composes the two
        │                  named engines and the scenario pipeline
        ▼
6. Module dashboards       src/modules/  (financial-projection, financial-planning,
        │                  taxes, payroll, concurso-mercantil, fideicomiso,
        │                  kpis-objectives, users, midas-ai)
        ▼
7. App shell + UI          App.tsx (boot + providers) → AppCore.tsx (nav, role
        │                  gating, per-dataset boot effects) → components/
        ▼
8. Persistence             localStorage (midas-v12 store) + IndexedDB
                           (heavy store, daily API cache, projection cache)
```

Workers (`src/workers/`) sit beside layers 4–5: the scenario run and the
AuxiliarContable reconciliation run off the main thread.

## Data flow

```text
App.tsx (boot orchestrator)
  ├─ gate splash on catalog + companies (fast, local)
  ├─ after companies: parallel JDE/TRESS/CITI fetches (CXP, cobranza, compras,
  │  pagoProveedor, banks, nómina, ROL, viajes especiales, auxiliar, IVA ledger)
  └─ hydrate MidasStore + heavy IDB caches (debounced idle-task saves)
        ▼
buildFinancialProjectionSourceData()  (financial-projection/services)
  └─ wraps buildCanonicalProjection() → expands CXC, CXP, payroll, purchase
     receipts, internal-transfer plug → { movements, scenarios, customers,
     suppliers, canonical }  (LRU-cached by content fingerprint)
        ▼
Proyección (daily landing) and Planeación (scenarios) render off the same source
```

## The two engines

`canonicalProjection.ts` is the single public entry point. It orchestrates:

- **MOTOR 1 — `historicalReconciledEngine.ts`** (≤ today): the cash truth from
  bank statements, the internal-transfer reconciliation plug (`INTERNAL_RECON`,
  anchors cash to the real bank balance), and no-bank fills.
- **MOTOR 2 — `shortTermProjectionEngine.ts`** (> today): real short-term data
  dated by its own rule — open cobranza/CXC, ROL, viajes especiales (income);
  CXP, purchase orders, TRESS payroll (expense). No balancing to synthetic
  totals; long-term projection was removed.

## Scenario evaluation pipeline (non-base)

`base movements → propuestas (applyAdjustmentsToMovements) → tax movements →
convenio concursal → supplier payment schedule → optional trend top-off →
cell overrides at render → KPIs`. The **Base scenario** skips all of that and is
filtered to real short-term API data only — see the Base scenario invariant in
`CLAUDE.md` (non-negotiable).

## Persistence

- `localStorage` `midas-v12` — light store (catalogs, assumptions, loaded keys),
  owned by `src/domain/persistence.ts` with migrations + a defensive normalizer.
- IndexedDB — heavy records (JDE/TRESS/CITI/bank), per-day API cache, and the
  projection source/run cache.
- Financial-planning state (scenarios, propuestas, manual entries, cell
  overrides) and taxes live in their own module storage helpers, not in
  `MidasStore`.
- Every storage key is inventoried in `src/domain/storageRegistry.ts`
  (`clearAllMidasStorage()` for logout/reset). Register new keys there.

## Conventions

- **UI ↔ code terminology is intentionally inverted** in financial-planning:
  UI *Simulación / Escenario / Propuesta* = code *parent / `FinancialScenario` /
  `FinancialAdjustment`*. Verify both vocabularies before renaming.
- **Spanish UI, English code.** es-MX / MXN are hardcoded in `formatters.ts`.
- **Heavy compute belongs in `src/workers/`**, not in `useEffect` loops. The
  performance hardening (grid virtualization, scenario worker, bounded
  granularity windows, cache-first boot, runtime guardian) is load-bearing.

## See also

`CLAUDE.md` (operational map), `DOCS.md` (doc index), `README.md` (deploy/env),
`RULES.md` (business rules), `AUDITORIA-INTEGRACION-MODULOS.md` (module/API map).
