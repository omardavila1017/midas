# API MIGRATION REPORT
Generated: 2026-04-21T03:52:02Z
Artifact: flujo-senda

## Summary
- Excel sources eliminated: 4
- Service files created: 3
- Env vars required: 8
- Sources pending Atlas admin input: 3

## Migration Map

| EXCEL SOURCE | JDE/COGNOS TARGET | SERVICE FILE | ENV VARS | STATUS |
|-------------|-------------------|--------------|----------|--------|
| Cash-flow plan upload | Cognos cash-flow planning report | `src/services/cashFlow.service.ts` | `VITE_COGNOS_BASE_URL`, `VITE_COGNOS_TOKEN`, `VITE_COGNOS_NAMESPACE` | Migrated — service fallback active |
| Provider workbook import | Cognos supplier catalog / JDE supplier master enrichment | `src/services/catalog.service.ts` | `VITE_COGNOS_BASE_URL`, `VITE_COGNOS_TOKEN`, `VITE_COGNOS_NAMESPACE` | Migrated — service fallback active |
| Client workbook parser | Cognos client billing and payment-terms report | `src/services/catalog.service.ts` | `VITE_COGNOS_BASE_URL`, `VITE_COGNOS_TOKEN`, `VITE_COGNOS_NAMESPACE` | Migrated — service fallback active |
| `xlsx` runtime package | Not needed after service migration | N/A | N/A | Removed from `package.json` and lockfile |
| CXP aging data | JDE `/antiguedadsaldos` | `src/services/jde.ts` | `VITE_JDE_BASE_URL`, `VITE_JDE_TOKEN`, `VITE_JDE_ENVIRONMENT` | Already service-backed |
| Bank statements | JDE `/bancos` | `src/services/jde.ts` | `VITE_JDE_BASE_URL`, `VITE_JDE_TOKEN`, `VITE_JDE_ENVIRONMENT` | Already service-backed |
| Company catalog | JDE `/empresas` | `src/services/jde.ts` | `VITE_JDE_BASE_URL`, `VITE_JDE_TOKEN`, `VITE_JDE_ENVIRONMENT` | Already service-backed |

## Service Files Created

### `src/config/api.config.ts`
Centralizes Atlas runtime configuration for JDE, Cognos, and artifact metadata. All sensitive values are read from Vite environment variables, and `validateApiConfig()` reports missing Atlas settings.

### `src/services/cashFlow.service.ts`
Fetches the consolidated cash-flow plan from a Cognos report endpoint. When Cognos is not configured, it returns a deterministic mock plan so the UI remains usable in development and Atlas staging.

### `src/services/catalog.service.ts`
Fetches client and provider catalogs from Cognos report endpoints. When Cognos is not configured, it uses bundled mock catalog snapshots as a safe fallback.

### Existing JDE services
`src/services/jde.ts`, `src/services/jdeClient.ts`, and `src/services/jdeTypes.ts` remain the service layer for companies, CXP aging, and bank statements. `jdeClient` now reads credentials through `api.config.ts`.

## Atlas Setup Instructions

To activate live data connections in Atlas:

1. Go to Atlas → FlowSense → Environment Variables
2. Configure the following variables:

| VARIABLE | VALUE | WHERE TO GET IT |
|----------|-------|-----------------|
| `VITE_ATLAS_ARTIFACT_ID` | `flowsense` | Atlas admin |
| `VITE_JDE_BASE_URL` | Production JDE Orchestrator URL or Atlas proxy path | JDE / Atlas admin |
| `VITE_JDE_TOKEN` | Bearer credential | JDE admin |
| `VITE_JDE_ENVIRONMENT` | `PD920` for production | JDE admin |
| `VITE_COGNOS_BASE_URL` | Cognos Analytics REST base URL | Cognos admin |
| `VITE_COGNOS_TOKEN` | Cognos REST credential | Cognos admin |
| `VITE_COGNOS_NAMESPACE` | Cognos namespace, default `CognosEx` | Cognos admin |
| `VITE_JDE_UPSTREAM` | Dev proxy upstream only | SWAT engineer |

3. Redeploy the artifact after setting variables.

## Pending Items (require Atlas admin)
- Confirm the Cognos report path for the consolidated cash-flow plan: `/reports/flowsense/cash-flow-plan`.
- Confirm the Cognos report path for the client catalog: `/reports/flowsense/clientes`.
- Confirm the Cognos report path for the provider catalog: `/reports/flowsense/proveedores`.
- Confirm whether local catalog snapshots should remain as staging fallback or move to an Atlas-managed mock endpoint.

## Security Notes
- No credentials are committed to source code.
- All credentials are read from environment variables at runtime.
- `.env.example` contains empty credential slots only.
- Mock data is used automatically when Cognos variables are not set.

## Verification
- No `xlsx`, `XLSX`, spreadsheet parser package, or workbook parser references remain in `src`, `package.json`, `package-lock.json`, or `.env.example`.
- `src/config/api.config.ts` exists.
- `src/services/` contains five TypeScript service/configuration files.
- `.env.example` documents eight `VITE_` variables.
- `npm run build` passes after migration.
