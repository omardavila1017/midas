# AUDIT REPORT
Generated: 2026-04-21T03:52:02Z
Artifact: flujo-senda
Audited by: SendaStack audit-agent

## 1. Observable Purpose
FlowSense is a treasury and cash-flow workbench for transport companies. It lets users select companies or groups, load or derive clients/providers, review bank movements and accounts payable, project collections, manage simulations/scenarios/proposals, and inspect KPIs and forecasts for cash-flow decisions.

## 2. Users
| ROL | ÁREA | FRECUENCIA ESTIMADA |
|-----|------|---------------------|
| Treasury analyst | Tesorería / Finanzas | Daily during cash position review and payment planning |
| Finance manager | Dirección financiera / Contraloría | Weekly and during closing or liquidity reviews |
| Accounts payable analyst | Cuentas por pagar | Daily when reviewing CXP aging and supplier payment timing |
| Collections analyst | Cobranza | Weekly to monthly when reviewing expected receipts and client payment rules |

## 3. Excel / Static Data Inventory
| SOURCE | PURPOSE | FIELDS USED | CONSUMED IN | MIGRATION PRIORITY |
|--------|---------|-------------|-------------|-------------------|
| `xlsx` package dependency | Workbook parsing for legacy uploads | WorkBook, WorkSheet, sheet_to_json, read | `src/utils/excelParser.ts:1`, `src/domain/importClients.ts:16`, `src/domain/importProviders.ts:18`, `src/components/Providers.tsx:2` | HIGH |
| User-uploaded cash-flow workbook (`.xlsx/.xls`) | Load a `FlowPlan` from an Excel plan | plan name, concepts, months, weekly values, yearly amounts | `src/components/Upload.tsx:18`, `src/components/Upload.tsx:27`, `src/utils/excelParser.ts:276` | HIGH |
| User-uploaded provider workbook (`.xlsx/.xls`) | Import provider catalog manually | provider name, classification, frequency, amount fields | `src/components/Providers.tsx:133`, `src/domain/importProviders.ts:31` | HIGH |
| Client import workbook parser | Import clients from two workbook sheets | client name, pay day, cycle, sales, credit days, monthly billing | `src/domain/importClients.ts:56` | MED |
| `public/clientes-db.json` | Local client catalog derived from tabular business data | name, payDay, cycle, sales, creditDays, active | `src/domain/loadClientsCatalog.ts:63`, `src/App.tsx:230` | HIGH |
| `src/assets/providerCatalog.json` | Bundled provider flexibility and criticality catalog derived from Excel workbooks | flexibilityByName, flexibilityByClass, dtiCatalog, lastPayment | `src/domain/loadProvidersCatalog.ts:24`, `src/domain/providerCatalog.ts:18`, `src/App.tsx:239` | HIGH |
| CSV upload/export flows | Manual CXP import and several exports | CXP rows, bank statement exports, client/catalog exports | `src/components/CXP.tsx:227`, `src/components/CXP.tsx:1111`, `src/components/Bancos.tsx:281` | MED |

## 4. Dead Code
| FILE | LINE | TYPE | DESCRIPTION |
|------|------|------|-------------|
| `src/App.tsx` | 20 | Commented code | `NetCashFlowDashboard` import is disabled in a comment and should be removed or restored intentionally. |
| `src/components/NetCashFlowDashboard.tsx` | 63 | Unused component | Component exists but is not imported by the active app shell. |
| `src/hooks/useDarkMode.ts` | 13 | Out-of-scope feature | Dark-mode hook is active but SendaStack forbids runtime dark mode. |
| `src/styles/dark.css` | 1 | Out-of-scope feature | Dark-mode stylesheet remains in the bundle. |
| `src/utils/calculations.ts` | 2 | Deprecated wrapper | File is explicitly marked deprecated and only re-exports formatters. |
| `src/domain/collectionEngine.ts` | 75 | TODO comment | Invoice-date behavior is still documented as future work. |
| `src/App.tsx` | 43 | Weak typing | Section icon type uses `any`. |
| `src/App.tsx` | 49 | Weak typing | Sub-tab icon type uses `any`. |
| `src/components/CXP.tsx` | 375 | Weak typing | Recharts tooltip uses `any`. |
| `src/components/Dashboard.tsx` | 130 | Weak typing | Recharts tooltip uses `any`. |
| `src/components/KpiCenter.tsx` | 1896 | Weak typing | Chart dot renderer uses `any`. |

## 5. Missing UX
| PRIORITY | FEATURE | REASON |
|----------|---------|--------|
| HIGH | Replace spreadsheet uploads with official service-backed flows | Atlas delivery should not depend on users uploading Excel/CSV files to get current business data. |
| HIGH | Visible mock/stale-data warning | Some flows fall back to demo or cached data; the user needs an explicit warning when live company systems are not connected. |
| HIGH | Confirmation before destructive actions | Delete/reset actions exist for clients, providers, scenarios, simulations, CXP resets, and company groups without a consistent confirmation step. |
| MED | Standardized loading/error states per data module | Loading and error states exist, but they are not consistently shaped across all data views. |
| MED | Design-system aligned shell | The app does not declare a Senda skin, does not use Roboto, and still carries dark-mode and gradient patterns. |
| LOW | Performance optimization for the large bundle | Production build succeeds but the main bundle is 1,454.09 kB minified and 407.16 kB gzip, above the desired initial bundle target. |

## 6. External Dependencies
| PACKAGE | VERSION | STATUS |
|---------|---------|--------|
| `react` | `^18.3.1` | Keep |
| `react-dom` | `^18.3.1` | Keep |
| `recharts` | `^2.12.7` | Keep; SendaStack chart library |
| `lucide-react` | `^0.383.0` | Keep; required icon library, but stroke widths need normalization |
| `xlsx` | `^0.18.5` | Replace/remove after Excel upload paths are migrated to services |
| `@vitejs/plugin-react` | `^4.3.1` | Keep |
| `vite` | `^5.3.1` | Keep |
| `typescript` | `^5.5.2` | Keep |
| `tailwindcss` | `^3.4.4` | Keep; tokens need SendaStack alignment |
| `postcss` | `^8.4.38` | Keep |
| `autoprefixer` | `^10.4.19` | Keep |
| `vitest` | `^2.1.8` | Keep |
| `@testing-library/react` | `^16.3.0` | Keep |
| `@testing-library/user-event` | `^14.6.1` | Keep |
| `jsdom` | `^25.0.1` | Keep |
| `@types/react` | `^18.3.3` | Keep |
| `@types/react-dom` | `^18.3.0` | Keep |

## 7. Tech Stack
- Framework: React 18.3.1 with TypeScript
- Bundler: Vite 5
- UI Library: Tailwind CSS with custom component classes, Recharts, Lucide icons
- State: React local state and custom localStorage persistence
- Data fetching: Fetch-based JDE services; static JSON catalogs; active Excel/CSV upload parsing

## 8. Complexity Metrics
- Total lines: 27,616 across `src`
- React components: 28 `.tsx` files
- TypeScript files: 31 `.ts` files
- Service files: 3 files under `src/services`
- Utility files: 3 files under `src/utils`
- Notable large files: `src/App.tsx` 1,363 lines, `src/components/KpiCenter.tsx` over 1,900 lines, `src/components/CXP.tsx` over 1,200 lines

## 9. Current Data Architecture
- Data fetching method: mixed. JDE uses `fetch` through a service layer, but clients/providers/cash-flow plans still use static JSON or workbook uploads.
- Existing `src/services/`: yes — `jde.ts`, `jdeClient.ts`, `jdeTypes.ts`
- Existing `src/config/`: no — `src/config/api.config.ts` is missing
- Existing `.env` files: `.env.example`, `.env.local`
- Env vars currently read: `VITE_JDE_BASE_URL`, `VITE_JDE_TOKEN`
- Current JDE integration points: companies, accounts payable aging, bank account statements
- Current static sources: `public/clientes-db.json`, `src/assets/providerCatalog.json`, uploaded `.xlsx/.xls`, uploaded `.csv`

## 10. Baseline Quality Score (artifact AS-IS, before any changes)

> This score uses the exact same rubric as the qa-agent so that the ship-agent
> can compute before/after deltas at the end of the pipeline.

| AXIS | SCORE | MAX | JUSTIFICATION (why not higher / what would push it to 20) |
|------|-------|-----|-----------------------------------------------------------|
| 1. Code Quality | 14 | 20 | Build and tests pass (`npm run build`, `npm test`), but there are 12 console warnings/errors in production paths, 12 `any` usages, a deprecated wrapper, and a disabled dashboard component left in the codebase. Reaching 20 requires removing those leftovers or typing them intentionally. |
| 2. Design System | 8 | 20 | The app uses Inter instead of Roboto, has no Senda skin declared, no official Senda logo, runtime dark mode, gradients, hardcoded colors, and several icon strokes outside the required value. It uses Lucide and Recharts, which prevents a zero, but the Senda DS is not yet applied. |
| 3. Data Integrity | 8 | 20 | The project has real JDE services and `.env.example`, but no central `api.config.ts`, active `xlsx` parsing remains, static JSON catalogs are compiled from spreadsheets, and CSV/Excel import flows are still user-facing. Reaching 20 requires service-backed replacements and removal of active Excel dependencies. |
| 4. Documentation | 8 | 20 | `README.md` exists and explains the current app, but it is Spanish, lacks required SendaStack sections, and `MANUAL.md` plus `RULES.md` are missing. Reaching 20 requires the three audience-specific documents. |
| 5. User Experience | 16 | 20 | The main purpose is understandable and many loading/error states exist, but destructive actions are not consistently confirmed and mock/stale/live-data state is not always visible. Reaching 20 requires consistent confirmations and explicit data-source feedback. |
| **BASELINE TOTAL** | **54** | **100** | |

**Baseline verdict:** Below 90 threshold — pipeline has work to do in axes 2, 3, 4, and targeted cleanup in axes 1 and 5.

## 11. Atlas Deployment Notes
- Env vars required (detected so far): `VITE_JDE_BASE_URL`, `VITE_JDE_TOKEN`, `VITE_JDE_UPSTREAM`
- Integration points identified: JDE/Tesorería companies, accounts payable aging, bank statements; static client and provider catalogs should be moved behind Atlas-managed data services.
- Deployment blockers: Senda DS not applied, docs incomplete, active Excel dependency, missing central API config, and visible upload flows that bypass official systems.
- Build status: PASS with warnings about a large chunk and a dynamic import that cannot split `src/services/jde.ts`.
- Test status: PASS — 12 tests across 4 files.

## 12. Work Map for Downstream Agents
### → purpose-agent
The single core action is treasury cash-flow review and scenario planning for liquidity decisions.

### → clean-agent
Priority items to remove: dark-mode hook and stylesheet, disabled `NetCashFlowDashboard` comment/component if verified unused, deprecated `utils/calculations.ts` wrapper if no imports remain, obvious console logging in production paths, and DS-prohibited gradients/dark-mode remnants that do not require replacement.

### → api-agent
Excel/static migration targets: cash-flow workbook upload → Cognos/JDE planning report or Atlas-managed planning service; provider workbook and provider catalog JSON → JDE/Cognos supplier master/criticality report; client JSON → Cognos/JDE customer billing and terms report; CSV CXP import → JDE `/antiguedadsaldos`; bank exports remain downloads only and do not block data integrity.

### → ui-agent
Design gaps: choose `corporativo` skin unless PURPOSE narrows ownership; add Roboto; declare `data-skin`; apply Senda tokens; remove gradients and dark mode; normalize Lucide stroke widths; add official logo; replace hardcoded component colors with tokens; keep charts inside white cards and make non-time bar charts horizontal.

### → doc-agent
Documentation gaps: rewrite README in English for TI/SWAT, create Spanish user manual, and document business rules for payment flexibility, client payment-day parsing, scenario/base behavior, CXP aging buckets, and KPI thresholds.

### → qa-agent
Risk areas: Excel dependencies, Senda DS compliance, missing docs, unconfirmed destructive actions, and production console output are the most likely QA deductions.
