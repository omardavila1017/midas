# CLAUDE.md

## Purpose

Operational context for any agent or new dev touching `midas` (formerly `flowsense`). The repo is the source of truth — this file is a map, not a spec. Read the actual files before changing them.

`README.md` covers the deploy / env / business surface. This file covers the code layout, the data flow, and the rules that bite if you ignore them.

## Stack

- React 18 + Vite 5 + TypeScript 5.5 + Tailwind 3.4
- Charts: Recharts 2.12
- Icons: `lucide-react`
- Excel I/O: `exceljs`
- Tests: Vitest + Testing Library + jsdom; Playwright available for e2e

Commands:

```bash
npm run dev        # vite dev server
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # tsc && vite build
```

Always run `npm test` and `npm run build` before declaring a change done.

## Where things live now

```text
src/
├── App.tsx                      # Top-level shell, routing, store load/save
├── main.tsx                     # Entry
├── index.css                    # Senda DS tokens (OKLCH), keyframes, a11y
├── theme.ts                     # Token + motion config
├── formatters.ts                # MXN / es-MX number + date formatters
├── types.ts                     # Cross-cutting types (CashFlowOverrides, etc.)
├── config/
│   └── api.config.ts            # Env-var driven API config (JDE, Cognos)
├── services/
│   ├── jdeClient.ts             # Fetch client for JDE Orchestrator
│   ├── jde.ts                   # JDE companies, CXP, bank statements, cobranza
│   ├── jdeTypes.ts              # JDE request/response types
│   └── catalog.service.ts       # Cognos client/provider catalog
├── domain/                      # Treasury / cash-flow engines (NOT scenarios)
│   ├── persistence.ts           # midas-v8 store, normalizers, migrations
│   ├── netCashFlowEngine.ts     # Unified inflow/outflow cash view
│   ├── collectionEngine.ts      # Collection projection rules
│   ├── reconciliationEngine.ts  # Projected events vs bank ABONOs
│   ├── realReconciliationEngine.ts  # Real cobranza vs bank movements (4-layer match)
│   ├── operatingProjection*.ts  # Operating projection module + scenarios + taxes
│   ├── projectionEngine.ts
│   ├── forecastEngine.ts
│   ├── cashFlowEngine.ts
│   ├── budget*.ts, calendar.ts, bankHolidays*.ts, bankStatements*.ts
│   ├── santanderCsv.ts, providerCatalog.ts, expensePerProvider.ts
│   └── ... (see folder)
├── modules/
│   ├── financial-planning/      # Scenarios + propuestas + spreadsheet UI
│   │   ├── components/          # SpreadsheetGrid, ProposalWizard, etc.
│   │   ├── pages/
│   │   └── services/            # scenarioBootstrap.ts, evaluation, storage
│   ├── financial-projection/    # KPIs, alerts, forward projection
│   │   ├── components/, pages/, services/, mock-data/
│   ├── shared-finance/          # Shared types, audit log, calc engine, permissions
│   │   ├── audit/, calculation-engine/, components/, permissions/, types/
│   └── taxes/                   # Tax dashboard + service
│       ├── pages/, services/
├── components/                  # Treasury UI: Dashboard, CXP, Bancos, Clients, Providers, etc.
├── workers/                     # Web workers for heavy compute
├── data/                        # Static data (logos, etc.)
└── assets/
```

Old files referenced by prior versions of this doc — `scenarioEngine.ts`, `simulationCompiler.ts`, `ProposalCreator.tsx`, `Forecast.tsx`, `Simulator.tsx` — no longer exist. Their responsibilities moved into `src/modules/financial-planning/` and `src/modules/financial-projection/`.

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

`src/domain/persistence.ts` owns the `midas-v8` store. The interface lives at `persistence.ts:67` (`MidasStore`):

```ts
MidasStore {
  providers, clients,
  assumptions,
  confirmedPayments,
  cxpRecords, cxpLoadedCias,
  cobranzaRecords, cobranzaLoadedCias,
  cobranzaPayments, cobranzaPaymentsLoadedCias,
  cashFlowOverrides,
  lastSaved
}
```

Notes:

- Scenarios / propuestas / cell overrides do **not** live in `MidasStore`. They live inside `src/modules/financial-planning/` storage helpers.
- `App.tsx` writes a handful of `localStorage` keys directly outside the main store: `midas.selectedCia`, `midas.bankStatements.v2`, `midas.bankSupplementalStatements.v1`, `midas.bankLastQuery.v2`. These are intentional — bank-statement caches can be multi-MB and use a **debounced idle-task save strategy** (`scheduleIdleTask`, ~2.5s delay) so we never block the main thread on a hot keystroke. Pulling them into `MidasStore` (which `JSON.stringify`s the whole object on every save) would regress UX. If you ever consolidate, build an async-aware sub-store; do not flatten naively.
- `loadStore()` migrates `midas-v7`, `midas-v6`, `midas-v5`, `flowsense-v5` (same shape, dropping any legacy proposal/scenario fields) and `flowsense-v1..v4` (incompatible legacy shapes; preserves clients/providers/cxp/assumptions only).
- `normalizeStore()` is the defensive landing zone — assume any persisted payload may be partial or wrong-shaped; the normalizer enforces the schema.

## Engines

Treasury / cash-flow logic lives in `src/domain/`. Two reconciliation engines exist by design:

- `reconciliationEngine.ts` — matches projected collection events against bank ABONOs (heuristic, ±5% tolerance).
- `realReconciliationEngine.ts` — matches real cobranza invoices (JDE `/v1/erp/tesoreria/cobranza`) against actual bank movements. 4-layer matching: exact → tolerance → subset-sum → unmatched.

These are not duplicates — they answer different questions (forecast vs. realized).

The forecast / scenario evaluation pipeline lives across `src/modules/financial-planning/services/` and `src/modules/shared-finance/calculation-engine/`. Order of computation for a non-base scenario is:

1. Base values from the plan / real data
2. Active propuestas (FinancialAdjustments) applied
3. Manual cell overrides
4. Recompute KPIs and projections

## Base scenario invariant

The Base scenario (`id === 'base'`) is special and non-negotiable:

- Always present (bootstrap in `scenarioBootstrap.ts` ensures it).
- Not deletable.
- No propuestas attached.
- No manual cell overrides.
- Read-only in the UI (forecast popover shows lock icon).

If you touch scenario selection, persistence, or the spreadsheet editor, validate this invariant explicitly.

## Forecast / spreadsheet

Lives in `src/modules/financial-planning/components/`:

- `FinancialPlanningDashboard.tsx` — top-level page, owns scenario selection.
- `SpreadsheetGrid.tsx` (+ `spreadsheet/` subfolder) — the editable forecast grid.
- `ScenarioTabs.tsx`, `ProposalWizard.tsx` (4-step guided creation, replaces the older flat `AddRowPopover`).
- `CellDetailPopover.tsx` — on cell click, shows base / Δ propuestas / Δ manual / total / diff vs Base / comments. Read-only on Base.

The forecast must always tolerate partial / legacy data. Defensive rendering + the persistence normalizer are the two lines of defense.

## Risks that bite

1. **Inverting the terminology again.** Simulación / Escenario / Propuesta in UI vs. proposal/scenario/adjustment in code. Check both before renaming.
2. **Breaking the Base scenario.** Any active-scenario change can accidentally allow editing or attach a propuesta to base. Validate.
3. **Assuming new persisted shape.** `localStorage` can hold partial / legacy payloads. Use the normalizer; never read raw fields blindly.
4. **Doc drift.** This file is reality at the time of writing. If you change architecture, update this file in the same PR.
5. **Heavy compute on the main thread.** Forecast and reconciliation are non-trivial. Move new heavy compute into `src/workers/` instead of growing `useEffect` recompute loops.

## Spanish vs English

User-facing copy is Spanish (es-MX). Internal identifiers, code, comments, and commit messages are English. Do not translate type names. Do translate UI strings.

Locale and currency are hardcoded `es-MX` / `MXN` in `formatters.ts`. If you ever need to internationalize, that file is the single chokepoint to refactor.

## Before you ship

- `npm test`
- `npm run typecheck`
- `npm run build`
- Smoke `npm run dev` against real JDE data (or empty store) for the path you touched.
- Update this file if you changed the architecture.
