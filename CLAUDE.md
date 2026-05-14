# CLAUDE.md

## Purpose

Operational context for any agent or new dev touching `midas` (formerly `flowsense`). The repo is the source of truth — this file is a map, not a spec. Read the actual files before changing them.

`README.md` covers the deploy / env / business surface. This file covers the code layout, the data flow, and the rules that bite if you ignore them.

## Stack

- React 18 + Vite 5 + TypeScript 5.5 + Tailwind 3.4 (with `darkMode: 'class'`)
- Charts: Recharts 2.12
- Icons: `lucide-react`
- Excel I/O: previously `exceljs`; package is currently in `dependencies` but **not imported anywhere** (verified 2026-05-14). Safe to remove with `npm uninstall exceljs`.
- Tests: Vitest + Testing Library + jsdom; Playwright available for e2e
- IndexedDB cache for daily JDE responses (`src/services/dailyApiCache.ts`); falls back to memory-only after 5s open timeout if locked by another tab.

Commands:

```bash
npm run dev        # vite dev server
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # tsc && vite build
```

Always run `npm test` and `npm run build` before declaring a change done. Note: as of 2026-05-14 main has ~12 pre-existing `TS6133` (unused locals) errors in `src/components/CashFlowDetail.tsx` and `src/modules/financial-planning/components/CashTrajectoryChart.tsx` that block `npm run build`. Do not introduce new ones; cleanup of the dead refactor leftovers is tracked separately.

## Where things live now

```text
src/
├── App.tsx                      # Top-level shell, routing, store load/save, boot orchestrator
├── main.tsx                     # Entry
├── index.css                    # Senda DS tokens (OKLCH light + dark), keyframes, a11y, Tailwind dark-mode overrides
├── theme.ts                     # Token + motion config
├── formatters.ts                # MXN / es-MX number + date formatters
├── types.ts                     # Cross-cutting types (CashFlowOverrides, etc.)
├── config/
│   └── api.config.ts            # Env-var driven API config (JDE, Cognos, TRESS)
├── services/
│   ├── jdeClient.ts             # Fetch client for JDE Orchestrator (120s timeout, 2 retries, 4s backoff cap)
│   ├── jde.ts                   # JDE companies, CXP, bank statements, cobranza
│   ├── jdeTypes.ts              # JDE request/response types
│   ├── catalog.service.ts       # Cognos client/provider catalog
│   ├── dailyApiCache.ts         # IndexedDB cache w/ 5s open-timeout safety
│   └── tress*.ts                # TRESS nómina client
├── domain/                      # Treasury / cash-flow engines (NOT scenarios)
│   ├── persistence.ts           # midas-v11 store, normalizers, migrations
│   ├── netCashFlowEngine.ts     # Internal transfer detection — misnamed; only filters, doesn't compute net
│   ├── collectionEngine.ts      # Collection projection rules (used by canonical + planning)
│   ├── reconciliationEngine.ts  # Projected events vs bank ABONOs (forecast cruce)
│   ├── realReconciliationEngine.ts  # Real cobranza vs bank movements, 4-layer match (realized cruce)
│   ├── operatingProjection*.ts  # Operating projection module + scenarios + taxes
│   ├── projectionEngine.ts      # Active monthly projection — canonical for Dashboard
│   ├── cashFlowEngine.ts        # Legacy historical baseline (used by Dashboard.tsx)
│   ├── dashboardEngine.ts       # computeBaseCashFlow + bank starting balance
│   ├── budget*.ts, calendar.ts, bankHolidays*.ts, bankStatements*.ts
│   ├── santanderCsv.ts, providerCatalog.ts, expensePerProvider.ts
│   └── ... (see folder)
├── modules/
│   ├── financial-planning/      # Scenarios + propuestas + spreadsheet UI
│   │   ├── components/          # SpreadsheetGrid, ProposalWizard, ScenarioTabs, etc.
│   │   ├── pages/               # FinancialPlanningDashboard.tsx (top-level)
│   │   └── services/            # scenarioBootstrap, financialPlanningService, cellOverridesStorage, scenarioMerge…
│   ├── financial-projection/    # KPIs, alerts, forward projection (canonical source for Planning)
│   │   ├── components/, pages/, services/
│   ├── shared-finance/          # Shared types, audit log, calc engine, permissions
│   │   ├── audit/               # createAuditEvent + storage (minimal — no query/reporting yet)
│   │   ├── calculation-engine/  # canonicalProjection.ts + financialProjectionEngine.ts (apply Δ + overrides)
│   │   ├── components/, permissions/, types/
│   ├── taxes/                   # Tax dashboard + service (tax movements wired into planning since 2026-05)
│   │   ├── pages/, services/
│   ├── payroll/                 # TRESS nómina loader; expansion to movements happens INSIDE canonicalProjection
│   └── midas-ai/                # MidasBubble proposal suggestion bot
├── components/                  # Treasury UI: Dashboard, CXP, Bancos, Clients, Providers, etc.
├── workers/                     # Web workers (reconciliation)
├── data/                        # Static data (logos, etc.)
└── assets/
```

Old files referenced by prior versions of this doc — `scenarioEngine.ts`, `simulationCompiler.ts`, `ProposalCreator.tsx`, `Forecast.tsx`, `Simulator.tsx`, **`forecastEngine.ts`** (deleted 2026-05-14, was only referenced by its own test) — no longer exist. Their responsibilities live in `src/modules/financial-planning/` and `src/modules/financial-projection/`.

## Module integration map (data flow)

```
JDE (REST)                          TRESS                LocalStorage / IDB
  │ companies, CXP, cobranza,         │ payrollCosts        │ catalogs, overrides
  │ compras, pagoProveedor,           │                     │ scenarios, propuestas
  │ bank statements                   │                     │
  ▼                                   ▼                     ▼
App.tsx (boot orchestrator)
  ├─ parallel fetches after companies (CXP, cobranza, compras, pagoProveedor, banks, nomina)
  └─ hydrates MidasStore + bank caches via scheduleIdleTask (debounce 2.5s, no main-thread JSON.stringify on hot path)
  │
  ▼
buildFinancialProjectionSourceData()  ← src/modules/financial-projection/services/financialProjectionService.ts
  │ Wraps buildCanonicalProjection() which expands:
  │   • CXC (cobranza + projections)
  │   • CXP (CXPRecord + recurring providers)
  │   • Payroll (TRESS, projected forward)
  │   • Purchase receipts (compras)
  │ Returns { movements, scenarios (Base+Approved shells), customers, suppliers, canonical }
  │ LRU-cached by content fingerprint.
  ▼
FinancialPlanningDashboard.tsx
  ├─ ensureCoreScenarios() — bootstraps Base + Approved (Base copies sourceBaseScenario shell, NO scenario.movements field; movements flow through source.movements directly)
  ├─ buildScenarioRun() per scenario:
  │     base movements
  │   + manual entries (expandManualPlanningEntriesToMovements)
  │   + adjustments (applyAdjustmentsToMovements)  ← computed ONCE per run; was duplicated before 2026-05-14
  │   + tax movements (buildAutomaticTaxReserveMovements + buildApprovedTaxPaymentMovements, from buildTaxDashboardView)
  │   + supplier payment schedule (scheduleSupplierPaymentsByScore)
  │ → calculateBaseProjection() → KPIs, trajectory
  └─ cellOverrides applied per cell at render (applyCellOverridesToBuckets)
```

Open integration questions / known gaps:
- `cashFlowEngine.ts` (legacy MA6 baseline) is still used by `Dashboard.tsx` + `MonthDrilldown.tsx`. The canonical path is `projectionEngine.ts`. Consider consolidating.
- `netCashFlowEngine.ts` only exports internal-transfer helpers despite its name. Rename to `internalTransferFilter.ts` or extend to actually compute net.
- Audit module (`shared-finance/audit/`) is write-only (`createAuditEvent`, `appendAuditEvent`); no query/timeline yet.
- `CellOverride` (per-cell) vs `FinancialAdjustment` (scenario-wide propuesta) have overlapping semantics — both can mutate the same bucket. Cell override wins at render. Document or unify before changing precedence.

## Critical UI ↔ code terminology inversion

The financial-planning module ships with this asymmetry between user language and code:

| User sees (Spanish UI) | Code (English)                 |
|------------------------|--------------------------------|
| Simulación             | parent of `FinancialScenario`s |
| Escenario              | `FinancialScenario`            |
| Propuesta              | `FinancialAdjustment`          |
| Escenario Base         | scenario where `id === 'base'` |

Concrete code names today (in `src/modules/shared-finance/types/` and `src/modules/financial-planning/services/scenarioBootstrap.ts`):

- `FinancialScenario` is what the UI calls **Escenario**.
- `FinancialAdjustment` is what the UI calls **Propuesta** (a reusable financial change applied to one or more scenarios).
- `ManualPlanningEntry` is a hand-typed line in the spreadsheet.
- `CellOverride` is a per-cell manual edit on a scenario.
- `BASE_SCENARIO_ID = 'base'` (scenarioBootstrap.ts:13)
- `APPROVED_SCENARIO_ID = 'approved'`

Before renaming or restructuring this layer, walk through both vocabularies and check what users see in the UI vs. what the type system calls it. The error of inverting these terms has happened before.

## Persistence (current shape)

`src/domain/persistence.ts` owns the `midas-v11` store (bumped from v8 → v11 as Compras + PagoProveedor + jdeAccounts landed). The interface lives at `persistence.ts:93` (`MidasStore`):

```ts
MidasStore {
  providers, clients,
  assumptions,
  confirmedPayments,
  cxpRecords, cxpLoadedCias,
  cobranzaRecords, cobranzaLoadedCias,
  cobranzaPayments, cobranzaPaymentsLoadedCias,
  comprasRecords, comprasLoadedCias,                   // v10
  pagoProveedorRecords, pagoProveedorLoadedCias,       // v11
  payrollCosts,                                        // TRESS
  cashFlowOverrides,
  lastSaved
}
```

Notes:

- Scenarios / propuestas / cell overrides do **not** live in `MidasStore`. They live inside `src/modules/financial-planning/` storage helpers (separate localStorage keys per concept).
- `App.tsx` writes a handful of `localStorage` keys directly outside the main store: `midas.selectedCia`, `midas.bankStatements.v2`, `midas.bankSupplementalStatements.v1`, `midas.bankLastQuery.v2`. These are intentional — bank-statement caches can be multi-MB and use a **debounced idle-task save strategy** (`scheduleIdleTask`, ~2.5s delay) so we never block the main thread on a hot keystroke. Pulling them into `MidasStore` (which `JSON.stringify`s the whole object on every save) would regress UX. If you ever consolidate, build an async-aware sub-store; do not flatten naively.
- `loadStore()` migrates `midas-v7..v10`, `midas-v6`, `midas-v5`, `flowsense-v5` (same shape, dropping any legacy proposal/scenario fields) and `flowsense-v1..v4` (incompatible legacy shapes; preserves clients/providers/cxp/assumptions only).
- `normalizeStore()` is the defensive landing zone — assume any persisted payload may be partial or wrong-shaped; the normalizer enforces the schema.
- `dailyApiCache.ts` uses IndexedDB with a **5s open timeout**. If another tab holds the DB locked, we fall back to memory-only writes so the session keeps working (logged once via `idbWarned`).

## API client tuning

`src/services/jdeClient.ts` (post 2026-05-14 retune):
- Timeout per request: **120s** (was 180s — too generous; locked workers for 2 extra minutes on hangs).
- Retries: **2** (3 total attempts), backoff exponential w/ full jitter, **cap 4s** (was 8s). Total worst case ~12s of backoff instead of 24s.
- Retried statuses: 408, 502, 503, 504. 4xx is not retried.

JDE typical response: ~60s. If you see persistent timeouts, check upstream — don't push timeout back up.

## Engines

Treasury / cash-flow logic lives in `src/domain/`. Two reconciliation engines exist by design:

- `reconciliationEngine.ts` — matches projected collection events against bank ABONOs (heuristic, ±5% tolerance).
- `realReconciliationEngine.ts` — matches real cobranza invoices (JDE `/JDEdwards/cobranza`) against actual bank movements. 4-layer matching: exact → tolerance → subset-sum → unmatched.

These are not duplicates — they answer different questions (forecast vs. realized).

The forecast / scenario evaluation pipeline lives across `src/modules/financial-planning/services/` and `src/modules/shared-finance/calculation-engine/`. Order of computation for a non-base scenario is:

1. Base movements from `source.movements` (real CXP + cobranza + payroll + compras + recurring providers + manual entries)
2. Active propuestas (`FinancialAdjustments`) applied via `applyAdjustmentsToMovements()` — **single call per run**; the previous double-call was deleted 2026-05-14
3. Tax movements seeded from the post-adjustment view (`buildTaxDashboardView` → `buildApprovedTaxPaymentMovements` + `buildAutomaticTaxReserveMovements`)
4. Supplier payment schedule (`scheduleSupplierPaymentsByScore`) rewires CXP timing under the cash floor
5. Manual cell overrides (`applyCellOverridesToBuckets`) at render
6. Recompute KPIs and projections via `calculateBaseProjection`

## Base scenario invariant

The Base scenario (`id === 'base'`) is special and non-negotiable:

- Always present (bootstrap in `scenarioBootstrap.ts` ensures it).
- Not deletable.
- No propuestas attached.
- No manual cell overrides.
- No manual entries spliced in (`includeManualEntries === false` for Base in `buildScenarioRun`).
- No tax movement injection (Base reads the raw canonical projection only).
- Read-only in the UI (forecast popover shows lock icon).

If you touch scenario selection, persistence, or the spreadsheet editor, validate this invariant explicitly.

## Forecast / spreadsheet

Lives in `src/modules/financial-planning/components/`:

- `FinancialPlanningDashboard.tsx` — top-level page, owns scenario selection.
- `SpreadsheetGrid.tsx` (+ `spreadsheet/` subfolder) — the editable forecast grid.
- `ScenarioTabs.tsx`, `ProposalWizard.tsx` (4-step guided creation, replaces the older flat `AddRowPopover`).
- `CellDetailPopover.tsx` — on cell click, shows base / Δ propuestas / Δ manual / total / diff vs Base / comments. Read-only on Base.

The forecast must always tolerate partial / legacy data. Defensive rendering + the persistence normalizer are the two lines of defense.

## Dark mode

Dark mode is a class strategy (`html.dark`) wired via `src/index.css`. As of 2026-05-14:

- `tailwind.config.js` has `darkMode: 'class'` and CSS variables mapped under `theme.extend.colors` so `bg-card`, `border-border`, `text-foreground` resolve to tokens.
- `:root` defines the OKLCH light palette; `html.dark` overrides every token with a slate-blue dark canvas (hue 248 across all neutrals so the dark UI looks carved from one slab).
- Tailwind utilities with hardcoded literal colors (`bg-white`, `text-gray-900`, `border-gray-200`, etc.) seeded across ~40 components are intercepted by global `html.dark .bg-white { background: var(--card) }` rules in `index.css`. This lets us avoid rewriting every component with `dark:` variants. To escape this override in a specific spot (rare — e.g. branding over a photo), inline `style={{ background: '#fff' }}`.
- Recharts: avoid inline `stroke="#hex"` on `CartesianGrid`. Use `className="recharts-cartesian-grid"` so the CSS rule in `index.css` (`.recharts-cartesian-grid-{horizontal,vertical} line`) governs both modes.
- Native form controls (`input`, `select`, `textarea`) get dark-mode background / color / border from `index.css` directly. Autofill is overridden via `-webkit-box-shadow: inset` trick.
- `color-scheme: dark` on `html.dark` tells the UA to draw native scrollbars + select popups in dark.
- Focus visible ring uses `var(--accent-blue)`; in dark, it gains a 4px blue glow for keyboard discoverability.

## Risks that bite

1. **Inverting the terminology again.** Simulación / Escenario / Propuesta in UI vs. proposal/scenario/adjustment in code. Check both before renaming.
2. **Breaking the Base scenario.** Any active-scenario change can accidentally allow editing or attach a propuesta to base. Validate.
3. **Assuming new persisted shape.** `localStorage` can hold partial / legacy payloads. Use the normalizer; never read raw fields blindly.
4. **Doc drift.** This file is reality at the time of writing. If you change architecture, update this file in the same PR.
5. **Heavy compute on the main thread.** Forecast and reconciliation are non-trivial. Move new heavy compute into `src/workers/` instead of growing `useEffect` recompute loops.
6. **Duplicate adjustment calls.** `applyAdjustmentsToMovements` is deterministic; calling it twice on the same input is wasted CPU per scenario eval. The fix landed 2026-05-14 — don't reintroduce.
7. **JDE timeout creep.** 120s is the current ceiling. If you raise it, document why; longer hangs make the boot orchestrator feel broken.
8. **Removing the global dark-mode CSS overrides.** ~40 components rely on the `html.dark .bg-white` family of rules in `index.css`. Removing them without migrating each callsite to `bg-card` / token variables will visibly break dark mode.

## Spanish vs English

User-facing copy is Spanish (es-MX). Internal identifiers, code, comments, and commit messages are English. Do not translate type names. Do translate UI strings.

Locale and currency are hardcoded `es-MX` / `MXN` in `formatters.ts`. If you ever need to internationalize, that file is the single chokepoint to refactor.

## Before you ship

- `npm test` (15 pre-existing failures on main as of 2026-05-14 — verify count didn't grow)
- `npm run typecheck` (12 pre-existing `TS6133` failures — verify count didn't grow)
- `npm run build`
- Smoke `npm run dev` against real JDE data (or empty store) for the path you touched.
- For visual changes, toggle dark mode (add `dark` class to `<html>` via DevTools) and verify your component reads correctly. The splash, dashboard, planning grid, charts, CommandPalette (⌘K), modals, and form inputs should all be coherent.
- Update this file if you changed the architecture.
