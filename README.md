# Midas

> This artifact lets a treasury analyst evaluate consolidated cash flow to prioritize collections and payments before committing liquidity.

## Overview

Midas is an Atlas-ready treasury workbench for consolidated cash-flow review, scenario planning, collections, accounts payable, bank movements, KPIs, and forecasts. It is used by treasury and finance users who need to compare expected receipts, scheduled payments, current bank position, and scenario impact before making liquidity decisions. Live data is read from JDE and Cognos-facing service layers, with deterministic mock fallbacks for local development and staging.

## Architecture

```text
JDE F0911 / Cognos Reports
        ↓
src/services/*.service.ts  (API layer)
        ↓
src/config/api.config.ts   (env var config)
        ↓
React Components           (UI layer)
        ↓
Atlas (hosting)
```

## Tech Stack

- React 18.3.1 + Vite 5 + TypeScript 5.5
- Tailwind CSS 3.4 + custom Senda Design System tokens
- Recharts 2.12 for charts
- lucide-react 0.383 for icons
- Vitest + Testing Library + jsdom

## Project Structure

```text
src/
├── App.tsx                          # Top-level shell, routing, store wiring
├── index.css                        # Senda DS tokens and global styles
├── theme.ts, formatters.ts, types.ts
├── config/
│   └── api.config.ts                # Runtime API configuration from env vars
├── services/
│   ├── catalog.service.ts           # Cognos client/provider catalog
│   ├── jde.ts                       # JDE companies, CXP, cobranza, bank statements
│   ├── jdeClient.ts                 # Fetch client for JDE endpoints
│   └── jdeTypes.ts                  # JDE request/response types
├── domain/                          # Treasury / cash-flow engines
│   ├── persistence.ts               # midas-v8 store + migrations + normalizers
│   ├── netCashFlowEngine.ts
│   ├── collectionEngine.ts
│   ├── reconciliationEngine.ts      # Projected events vs bank ABONOs
│   ├── realReconciliationEngine.ts  # Real cobranza vs bank (4-layer match)
│   ├── operatingProjectionModule.ts # + scenarios + taxes + manual events
│   └── ...                          # forecast, budget, calendar, providers
├── modules/
│   ├── financial-planning/          # Scenarios + propuestas + spreadsheet
│   ├── financial-projection/        # KPIs + alerts + forward projection
│   ├── shared-finance/              # Shared types, audit, calc engine
│   └── taxes/                       # Tax dashboard
├── components/                      # Treasury UI
│   ├── Dashboard.tsx, CXP.tsx, Bancos.tsx, Clients.tsx, Providers.tsx
│   ├── CommandPalette.tsx, KeyboardShortcuts.tsx
│   └── ...
└── workers/                         # Web workers for heavy compute
```

## Environment Variables

All sensitive configuration is injected via environment variables. See `.env.example` for the complete list.

| VARIABLE | REQUIRED | DESCRIPTION | WHERE TO GET |
|----------|----------|-------------|--------------|
| `VITE_ATLAS_ARTIFACT_ID` | Yes | Atlas artifact identifier | Atlas admin |
| `VITE_JDE_BASE_URL` | Yes | JDE Orchestrator server URL or Atlas proxy path | JDE / Atlas admin |
| `VITE_JDE_TOKEN` | Yes | JDE bearer credential | JDE admin |
| `VITE_JDE_ENVIRONMENT` | Yes | JDE environment code, for example `PD920` | JDE admin |
| `VITE_COGNOS_BASE_URL` | Yes for live data | Cognos Analytics REST base URL | Cognos admin |
| `VITE_COGNOS_TOKEN` | Yes for live data | Cognos REST credential | Cognos admin |
| `VITE_COGNOS_NAMESPACE` | Yes for live data | Cognos auth namespace | Cognos admin |
| `VITE_JDE_UPSTREAM` | Local dev only | Vite proxy upstream host | SWAT engineer |

## Local Development Setup

1. Clone the repository.
2. Copy environment file: `cp .env.example .env.local`.
3. Fill in `.env.local` with development JDE and Cognos credentials.
4. Install dependencies: `npm install`.
5. Start the dev server: `npm run dev`.

If env vars are not set, Cognos-backed services return mock data automatically. This allows UI development without live JDE/Cognos access.

## Atlas Deployment

To activate live data connections in Atlas:

1. Go to Atlas -> Midas -> Environment Variables
2. Configure the following variables:

| VARIABLE | VALUE | WHERE TO GET IT |
|----------|-------|-----------------|
| `VITE_ATLAS_ARTIFACT_ID` | `midas` | Atlas admin |
| `VITE_JDE_BASE_URL` | Production JDE Orchestrator URL or Atlas proxy path | JDE / Atlas admin |
| `VITE_JDE_TOKEN` | Bearer credential | JDE admin |
| `VITE_JDE_ENVIRONMENT` | `PD920` for production | JDE admin |
| `VITE_COGNOS_BASE_URL` | Cognos Analytics REST base URL | Cognos admin |
| `VITE_COGNOS_TOKEN` | Cognos REST credential | Cognos admin |
| `VITE_COGNOS_NAMESPACE` | Cognos namespace, default `CognosEx` | Cognos admin |
| `VITE_JDE_UPSTREAM` | Dev proxy upstream only | SWAT engineer |

3. Redeploy the artifact after setting variables.

## Business Rules

- The **Base Scenario** (`id === 'base'`) is always present, locked, non-deletable, and represents the original forecast. No propuestas, no overrides, no manual edits. It is the comparison anchor for every other scenario.
- Scenario / propuesta state lives in `src/modules/financial-planning/`, not in the top-level `MidasStore`. The store carries shared treasury data only (catalogs, CXP, cobranza, bank, assumptions).
- Forecast composition order on a non-base scenario: **base values → active propuestas (FinancialAdjustments) → manual cell overrides → recompute KPIs**.
- Manual forecast overrides are scenario-specific and only editable in monthly view.
- Collections move to the next occurrence in the client's own payment cycle, not to the next business day.
- Factoring collections use the factoring term from invoice date and ignore the normal payment-day pattern.
- Internal bank transfers are excluded from net cash flow but remain visible in bank reconciliation views.
- Provider payments are enriched with flexibility and DTI criticality when catalog data is available.

UI ↔ code naming is intentionally inverted in financial-planning (Simulación / Escenario / Propuesta in UI vs. parent / `FinancialScenario` / `FinancialAdjustment` in code). See `CLAUDE.md` for the full table before renaming anything in that layer.

Full detail is documented in `RULES.md`.

## Known Limitations / TODOs

- `src/domain/collectionEngine.ts:75`: invoice dates are currently assumed as the first day of the month; per-event invoice dates are a documented follow-up.
- Cognos report paths must be confirmed by Atlas/Cognos admins:
  - `/reports/midas/cash-flow-plan`
  - `/reports/midas/clientes`
  - `/reports/midas/proveedores`
- The production bundle still exceeds Vite's 500 kB chunk warning threshold.
- `src/services/jde.ts` is imported both statically and dynamically, so Vite cannot split it into a separate chunk.

## Scripts

```bash
npm run dev
npm test
npm run build
npm run preview
```
