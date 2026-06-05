# Midas

> This artifact lets a treasury analyst evaluate consolidated cash flow to prioritize collections and payments before committing liquidity.

## Overview

Midas is a treasury workbench for consolidated cash-flow review, scenario planning, collections, accounts payable, bank movements, KPIs, and forecasts. It is used by treasury and finance users who need to compare expected receipts, scheduled payments, current bank position, and scenario impact before making liquidity decisions. Live data is read from JDE (companies, CXP, cobranza, compras, pagos, bank statements), TRESS (nómina) and CITI (ROL / viajes) via same-origin `/api/*` proxies; client/provider catalogs are bundled JSON, so the UI runs locally without live access.

## Architecture

```text
JDE / TRESS / CITI (REST)   +   bundled JSON catalogs
        ↓
api/[jde|tress|citi|openai|auth]/*   (serverless proxies — inject bearer server-side)
        ↓
src/services/* (jde.ts, jdeClient.ts, tress*, catalog.service.ts)   (API layer)
        ↓
src/domain/* + src/modules/*/calculation-engine   (treasury / cash-flow engines)
        ↓
React components + module dashboards   (UI layer)
        ↓
localStorage (midas-v12) + IndexedDB (heavy store, daily cache, projection cache)
```

Hosting is platform-agnostic: a static SPA build (`dist/`) plus the `api/*` serverless functions. See `CLAUDE.md` for the full code map and `ARCHITECTURE.md` for the layered view.

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
│   ├── catalog.service.ts           # Bundled client/provider catalog (local JSON, no remote fetch)
│   ├── jde.ts                       # JDE companies, CXP, cobranza, bank statements
│   ├── jdeClient.ts                 # Fetch client for JDE endpoints
│   └── jdeTypes.ts                  # JDE request/response types
├── domain/                          # Treasury / cash-flow engines
│   ├── persistence.ts               # midas-v12 store + migrations + normalizers
│   ├── storageRegistry.ts           # Central inventory of all localStorage + IDB keys
│   ├── netCashFlowEngine.ts         # Internal-transfer detection + bank-only cash flow
│   ├── collectionEngine.ts          # Collection projection rules
│   ├── auxiliarReconciliationEngine.ts # GL (AuxiliarContable) × bank reconciliation (current)
│   ├── reconciliationEngine.ts      # Projected events vs bank ABONOs (forecast)
│   ├── realReconciliationEngine.ts  # Legacy cobranza vs bank match (display tabs only)
│   └── ...                          # ivaLedger, predictive (Holt-Winters), budget, calendar, providers
├── modules/
│   ├── financial-planning/          # Scenarios + propuestas + spreadsheet (Planeación)
│   ├── financial-projection/        # KPIs + alerts + forward projection (Proyección, daily landing)
│   ├── shared-finance/              # Shared types + calculation-engine (canonicalProjection, 2 engines)
│   ├── taxes/                       # Tax dashboard (IVA real from GL + reserves/payments)
│   ├── concurso-mercantil/          # Convenio concursal (locked DEBT egresos)
│   ├── fideicomiso/                 # Fideicomiso DINA (Bajío re-injection in non-base)
│   ├── payroll/                     # TRESS nómina loader + analytics
│   ├── kpis-objectives/             # Auto + custom KPIs and objectives
│   ├── users/                       # User admin (RBAC, admin + mesa_ayuda only)
│   └── midas-ai/                    # MidasBubble proposal suggestion bot
├── components/                      # Treasury UI: CXP, Bancos, Clients, Providers, Compras, Pagos,
│   │                                #   CollectionProjection, CommandPalette, KeyboardShortcuts, …
│   └── ...                          # (Dashboard.tsx was removed 2026-05-18, merged into Proyección)
└── workers/                         # Web workers (scenario run, auxiliar reconciliation)
```

## Environment Variables

**`.env.example` is the authoritative, fully-commented template** — copy it to `.env.local` and fill local-only values. The table below is a summary. All production secrets are injected server-side by the backend/proxy; never commit real tokens or passwords, and never give a secret a `VITE_` prefix (those are baked into the public bundle).

The browser only ever talks to same-origin proxy paths under `/api/*` (`api/[jde|tress|citi|cognos|openai|auth]/*`); the proxy injects the bearer credential server-side so it never reaches the client.

| VARIABLE | REQUIRED | DESCRIPTION | WHERE TO GET |
|----------|----------|-------------|--------------|
| `VITE_JDE_BASE_URL` | Yes | Browser path, default `/api/jde` | DevOps / infra |
| `VITE_JDE_ENVIRONMENT` | Yes | JDE environment code (`PD920` prod, `PY920` test, `DV920` dev) | JDE admin |
| `VITE_TRESS_BASE_URL` | Yes (nómina) | Browser path, default `/api/tress` (shares the JDE token) | DevOps / infra |
| `VITE_CITI_BASE_URL` | Yes (ROL) | Browser path, default `/api/citi` (CITI roldiario) | DevOps / infra |
| `VITE_OPENAI_BASE_URL` | Yes (MIDAS AI) | Browser path, default `/api/openai` | DevOps / infra |
| `VITE_AUTH_BASE_URL` | Yes (auth) | Auth backend base, default `/api/auth` | Auth / SSO admin |
| `VITE_USER_ROLES` / `VITE_DEFAULT_ROLE` | Yes (RBAC UI) | CSV `email:rol` + fallback role for UI gating (not a security boundary) | Deploying team |
| `JDE_TOKEN` / `CITI_TOKEN` / `OPENAI_API_KEY` | Server-side only | Bearer credentials injected by the proxy | Respective admin |
| `JDE_UPSTREAM` / `TRESS_UPSTREAM` / `CITI_UPSTREAM` / `OPENAI_UPSTREAM` | Server-side only | Upstream API base URLs | SWAT engineer |

> **Cognos is legacy/optional.** The `/api/cognos` proxy and `*COGNOS*` vars still exist, but the current frontend no longer calls Cognos — client/provider catalogs are bundled JSON (`catalog.service.ts`). You can leave Cognos unset. See `AUDITORIA-INTEGRACION-MODULOS.md`.
>
> **Local auth mode (dev/internal).** When `src/config/authLocalUsers.json` has `"enabled": true`, logins validate against that JSON (passwords as SHA-256 hashes, never plaintext) instead of `VITE_AUTH_BASE_URL`. This is **not** a security boundary — see `AUTH.md`.

## Local Development Setup

1. Clone the repository.
2. Copy environment file: `cp .env.example .env.local`.
3. Fill in `.env.local` with local-only development credentials. Prefer non-`VITE_` token names so the Vite proxy injects headers instead of the browser.
4. Install dependencies: `npm install`.
5. Start the dev server: `npm run dev`.

If env vars are not set, the bundled JSON catalogs still load and live JDE/TRESS/CITI calls fail gracefully (empty results), so the UI runs against an empty/cached store. This allows UI development without live backend access.

## Deployment

The app deploys as a static SPA build (`dist/`) plus the serverless functions in `api/*` (Vercel-style `[...path].ts` handlers that proxy to the upstreams and inject bearer tokens server-side). To activate live data:

1. Configure the following environment variables in your hosting / serverless platform.
2. Provide the server-side secrets and upstreams (never as `VITE_*`).

| VARIABLE | VALUE | WHERE TO GET IT |
|----------|-------|-----------------|
| `VITE_JDE_BASE_URL` | `/api/jde` | DevOps / infra |
| `VITE_JDE_ENVIRONMENT` | `PD920` for production | JDE admin |
| `VITE_TRESS_BASE_URL` | `/api/tress` | DevOps / infra |
| `VITE_CITI_BASE_URL` | `/api/citi` | DevOps / infra |
| `VITE_OPENAI_BASE_URL` | `/api/openai` | DevOps / infra |
| `VITE_AUTH_BASE_URL` | `/api/auth` (or SSO/auth host) | Auth / SSO admin |
| `VITE_USER_ROLES` / `VITE_DEFAULT_ROLE` | `email:rol` CSV / `none` | Deploying team |
| `JDE_TOKEN` | Server-side JDE bearer credential (also used by TRESS) | JDE admin |
| `CITI_TOKEN` | Server-side CITI bearer credential | CITI admin |
| `OPENAI_API_KEY` | Server-side OpenAI credential | OpenAI admin |
| `JDE_UPSTREAM` / `TRESS_UPSTREAM` / `CITI_UPSTREAM` / `OPENAI_UPSTREAM` | Upstream API base URLs | SWAT engineer |

> Cognos (`VITE_COGNOS_BASE_URL` / `COGNOS_TOKEN` / `COGNOS_UPSTREAM`) is optional/legacy — the current frontend does not call it. Leave unset unless a future Cognos integration is reintroduced.

3. Redeploy the artifact after setting variables. `VITE_*` values are baked at build time — a redeploy is required for them to take effect.

Production builds must not set token/password/API-key values with `VITE_` prefixes. Run `npm run security:secrets` before pushing; teams with `gitleaks` installed can also run `npm run security:gitleaks` or wire that command into a local pre-commit hook.

## Gestión de accesos y contraseñas — procedimiento QA

La autenticación real vive en `/api/auth/*`: el backend emite una cookie de sesión `HttpOnly`, valida credenciales, cambia contraseñas y genera ligas de restablecimiento de un solo uso. Midas no guarda tokens ni contraseñas en el navegador y no usa contraseñas `VITE_*`.

El mapeo **correo → rol** visible en el frontend sigue siendo configuración `VITE_USER_ROLES` para RBAC de interfaz y vista de Usuarios. La autorización vinculante la hace el backend/proxy antes de exponer datos.

**Dónde vive en QA:** el `.env` del despliegue de QA se mantiene en el repo `midas` (rama `qa`), no en `flujo-senda` (aquí `.env*` está gitignored, solo sube `.env.example`). El workflow `.github/workflows/sync.yml` sincroniza código a `midas:qa` con `rsync` **sin `--delete`**, así que ese `.env` persiste entre syncs.

**Para cambiar roles visibles en QA:**

1. Edita el `.env` en `midas` rama `qa` (o el panel de variables de entorno del hosting que use el deploy):

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

These are documented follow-ups, not blockers for delivery. See `CLAUDE.md` ("Delivery / handoff state") and `AUDITORIA-INTEGRACION-MODULOS.md` for the full risk map.

- **ROL (CITI) not yet projected into cash.** Executed trips are fetched and cross-matched against cobranza in the Cobranza tab, but they do not feed the projection — blocked on a reliable client column from `/citi/roldiario`. *Viajes Especiales* (which do carry the client) already project.
- **`App.tsx`/`AppCore.tsx` hold all-company raw records in memory.** This is the renderer's heap floor; loading them on-demand per tab is the durable fix (deferred). A runtime guardian (`runtimeGuardian.ts`) defends against OOM in the meantime.
- **Legacy reconciliation engines** (`realReconciliationEngine.ts`, `paymentReconciliationEngine.ts`) still back a few display tabs (Pagos/CXP/Bancos/Cobranza badges); the projection/Conciliación already moved to `auxiliarReconciliationEngine.ts`.
- **Temporary debug panel** `InternalTransfersDebugPanel.tsx` ships (collapsed) in Proyección; remove once internal-transfer recon is signed off.
- **Bundle size:** the main `AppCoreWithProviders` chunk is ~845 kB (>500 kB Vite warning). Vendor and per-tab chunks are already split; the app chunk is the remaining floor.

## Documentation

`DOCS.md` is the index of every document in this repo (what is current vs. an archived historical snapshot). The load-bearing docs:

| Doc | For | Audience |
|-----|-----|----------|
| `CLAUDE.md` | Code layout, data flow, engines, invariants, "rules that bite" — **the source of truth** | Devs / agents |
| `README.md` (this file) | Deploy, env, tech stack, business surface | Devs / DevOps |
| `MANUAL.md` | How to use the tool (Spanish, non-technical) | End users (treasury) |
| `RULES.md` | Business rules behind the numbers | Users / audit |
| `AUTH.md` + `SECURITY-AUDIT.md` | Auth model and security posture / pre-deploy gate | Security / DevOps |
| `EXCLUSION_RULES.md` | Company exclusion filter (currently empty) | Devs |
| `AUDITORIA-INTEGRACION-MODULOS.md` | Module/API integration map and risks | Devs / architects |
| `AGENTS.md` | Pointer to `CLAUDE.md` (single source of truth) | Agents |

Historical snapshots (SendaStack pipeline reports, prior handoffs, superseded plans) live under `docs/archive/` — keep them for provenance, do not treat them as current.

## Scripts

```bash
npm install        # required first — the repo ships no node_modules
npm run dev        # vite dev server
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run build      # tsc && vite build
npm run preview    # serve the production build
npm run security:secrets   # scan for committed secrets (run before pushing)
```
