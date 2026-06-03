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

All sensitive configuration is injected server-side by Atlas/backend. See `.env.example` for placeholders only; never commit real tokens or passwords.

| VARIABLE | REQUIRED | DESCRIPTION | WHERE TO GET |
|----------|----------|-------------|--------------|
| `VITE_ATLAS_ARTIFACT_ID` | Yes | Atlas artifact identifier | Atlas admin |
| `VITE_JDE_BASE_URL` | Yes | Browser path, default `/api/jde` | Atlas admin |
| `VITE_TRESS_BASE_URL` | Yes | Browser path, default `/api/tress` | Atlas admin |
| `VITE_COGNOS_BASE_URL` | Yes for live data | Browser path, default `/api/cognos` | Atlas admin |
| `VITE_OPENAI_BASE_URL` | Yes for MIDAS AI | Browser path, default `/api/openai` | Atlas admin |
| `VITE_JDE_ENVIRONMENT` | Yes | JDE environment code, for example `PD920` | JDE admin |
| `JDE_TOKEN` | Server-side only | JDE/TRESS bearer credential injected by backend | JDE admin |
| `COGNOS_TOKEN` | Server-side only | Cognos bearer credential injected by backend | Cognos admin |
| `OPENAI_API_KEY` | Server-side only | OpenAI key injected by backend | OpenAI admin |
| `JDE_UPSTREAM` / `TRESS_UPSTREAM` / `COGNOS_UPSTREAM` | Server-side only | Upstream API base URLs | SWAT engineer |

## Local Development Setup

1. Clone the repository.
2. Copy environment file: `cp .env.example .env.local`.
3. Fill in `.env.local` with local-only development credentials. Prefer non-`VITE_` token names so the Vite proxy injects headers instead of the browser.
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
| `VITE_JDE_BASE_URL` | `/api/jde` | Atlas admin |
| `VITE_TRESS_BASE_URL` | `/api/tress` | Atlas admin |
| `VITE_COGNOS_BASE_URL` | `/api/cognos` | Atlas admin |
| `VITE_OPENAI_BASE_URL` | `/api/openai` | Atlas admin |
| `VITE_JDE_ENVIRONMENT` | `PD920` for production | JDE admin |
| `JDE_TOKEN` | Server-side JDE bearer credential | JDE admin |
| `COGNOS_TOKEN` | Server-side Cognos bearer credential | Cognos admin |
| `OPENAI_API_KEY` | Server-side OpenAI credential | OpenAI admin |
| `JDE_UPSTREAM` / `TRESS_UPSTREAM` / `COGNOS_UPSTREAM` | Upstream API base URLs | SWAT engineer |

3. Redeploy the artifact after setting variables.

Production builds must not set token/password/API-key values with `VITE_` prefixes. Run `npm run security:secrets` before pushing; teams with `gitleaks` installed can also run `npm run security:gitleaks` or wire that command into a local pre-commit hook.

## Gestión de accesos y contraseñas — procedimiento QA

La autenticación real vive en `/api/auth/*`: el backend emite una cookie de sesión `HttpOnly`, valida credenciales, cambia contraseñas y genera ligas de restablecimiento de un solo uso. Midas no guarda tokens ni contraseñas en el navegador y no usa contraseñas `VITE_*`.

El mapeo **correo → rol** visible en el frontend sigue siendo configuración `VITE_USER_ROLES` para RBAC de interfaz y vista de Usuarios. La autorización vinculante la hace el backend/proxy antes de exponer datos.

**Dónde vive en QA:** el `.env` del despliegue de QA se mantiene en el repo `midas` (rama `qa`), no en `flujo-senda` (aquí `.env*` está gitignored, solo sube `.env.example`). El workflow `.github/workflows/sync.yml` sincroniza código a `midas:qa` con `rsync` **sin `--delete`**, así que ese `.env` persiste entre syncs.

**Para cambiar roles visibles en QA:**

1. Edita el `.env` en `midas` rama `qa` (o el panel de Environment Variables de Atlas, lo que use el deploy):

   | VARIABLE | EJEMPLO | NOTA |
   |----------|---------|------|
   | `VITE_USER_ROLES` | `email:rol,email:rol,…` (CSV) | Roles válidos: `admin \| abastos \| contaduria \| fiscal \| cobranza \| mesa_ayuda`. `admin` = todo. |
   | `VITE_DEFAULT_ROLE` | `none` | Rol para correos NO listados. `none` = sin acceso. |

2. **Redeploy** del artefacto (las `VITE_*` se hornean en build — sin redeploy no aplican).
3. Quita `VITE_CURRENT_USER_EMAIL` del `.env` de QA: solo **pre-llena** el campo de correo, así que dejarla hace que a todos les aparezca el correo de esa persona.

**Para contraseñas:**

- El usuario puede cambiar su contraseña desde el header de Midas.
- El usuario puede pedir una liga desde "Olvidé mi contraseña".
- `admin` y `mesa_ayuda` pueden enviar una liga de reset desde el módulo Usuarios.
- El backend debe aplicar política mínima, hash seguro, bloqueo de reuso, expiración, rate limiting y envío de correo.

**Matriz rol → módulos** (catálogo declarativo, en código): ver `src/config/roles.ts`.

| Rol | Módulos visibles |
|-----|------------------|
| `admin` | Todos |
| `abastos` | Antigüedad de Saldo · Órdenes de Compras · Proveedores |
| `contaduria` | Cobranza · Pagos · Bancos |
| `cobranza` | Cobranza · Clientes · Bancos |
| `fiscal` | Impuestos |
| `mesa_ayuda` | Solo Usuarios |
| `none` | Ninguno |

> **RBAC frontend no es frontera de seguridad** (ver `AUTH.md`). Oculta módulos para UX; el backend/proxy `/api/*` debe autorizar cada solicitud. Las contraseñas y sesiones nunca deben exponerse como `VITE_*`.

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
