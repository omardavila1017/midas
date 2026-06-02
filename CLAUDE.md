# CLAUDE.md

## Purpose

Operational context for any agent or new dev touching `midas` (formerly `flowsense`). The repo is the source of truth — this file is a map, not a spec. Read the actual files before changing them.

`README.md` covers the deploy / env / business surface. This file covers the code layout, the data flow, and the rules that bite if you ignore them.

## Branch: `no-long-term-projection` (2026-05-20)

This branch removes long-term cash-flow projection. **Planeación Financiera y Proyección Financiera ahora muestran solo:**

1. **Histórico real** — bank statements + cobranza histórica JDE + payroll TRESS real + CXP real.
2. **Corto plazo real (ingresos)**: ROL CITI (viajes ejecutados, fecha de cobro por regla de catálogo del cliente) + CXC abierto (facturas JDE pendientes de cobro). Cobranza valida el cobro al cruzar contra ABONOs bancarios.
3. **Corto plazo real (egresos)**: OC compras (`F_Recepcion + D_Credito`) + CXP abierto. Pago se valida vía `pagoProveedor` y el cargo bancario.
4. **Obligaciones contractuales conocidas (mantienen)**: convenio concursal (deuda firmada, locked DEBT) + impuestos (reservas semanales de IVA + pagos aprobados).

**Eliminado del motor canónico** (`src/modules/shared-finance/calculation-engine/canonicalProjection.ts`):
- `client:` — proyección genérica de cobranza por regla de catálogo (sin ROL detrás)
- `recurring-provider:` / `recurring-operating:` — patrones recurrentes bancarios
- `budget-opex-gap:` — reserva presupuestal de opex
- `federal-forecast:` — modelo estacional de ingreso Federal
- `canonical-outflow:` / `canonical-inflow:` — balancer sintético que escalaba líneas al total mensual del Dashboard
- `payroll:forecast:` — replicación del último mes TRESS hacia adelante (`buildPayrollCostMovements` ya no proyecta; ignora `projectThroughYearMonth`)

Los tests obsoletos en `canonicalProjection.test.ts` están marcados `it.skip` con la razón. UI de Escenarios/Propuestas/Adjustments se mantiene intacta — solo cambia la fuente de movimientos.

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

Always run `npm test` and `npm run build` before declaring a change done. As of 2026-05-15 `npm run typecheck` and `npm run build` are clean (the prior ~12 `TS6133` leftovers in `CashFlowDetail.tsx` / `CashTrajectoryChart.tsx` are gone). Keep them clean — do not introduce new unused-locals errors.

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
│   └── api.config.ts            # Env-var driven API config (JDE, TRESS, CITI, OpenAI)
├── services/
│   ├── jdeClient.ts             # Fetch client for JDE Orchestrator (120s timeout, 2 retries, 4s backoff cap)
│   ├── jde.ts                   # JDE companies, CXP, bank statements, cobranza
│   ├── jdeTypes.ts              # JDE request/response types
│   ├── catalog.service.ts       # Client/provider catalog — bundled static JSON (no remote fetch)
│   ├── dailyApiCache.ts         # IndexedDB cache w/ 5s open-timeout safety
│   └── tress*.ts                # TRESS nómina client
├── domain/                      # Treasury / cash-flow engines (NOT scenarios)
│   ├── persistence.ts           # midas-v12 store, normalizers, migrations
│   ├── storageRegistry.ts       # Inventario central de TODA la persistencia (localStorage + IDB) + clearAllMidasStorage()
│   ├── netCashFlowEngine.ts     # Internal-transfer detection + bank-only cash-flow compute (computeBankOnlyCashFlow, computeDailyFlow, aggregateWeekly/Monthly, computeSummary)
│   ├── collectionEngine.ts      # Collection projection rules (used by canonical + planning)
│   ├── reconciliationEngine.ts  # Projected events vs bank ABONOs (forecast cruce)
│   ├── realReconciliationEngine.ts  # Real cobranza vs bank movements, 4-layer match (realized cruce)
│   ├── operatingProjection*.ts  # Operating projection module + scenarios + taxes
│   ├── projectionEngine.ts      # Legacy monthly projection (now only its types/helpers are referenced)
│   ├── cashFlowEngine.ts        # toYearMonth/compareYearMonth/buildHistoricalMonths — used by the engines below
│   ├── dashboardEngine.ts       # computeBaseCashFlow + bank starting balance (consumed by canonicalProjection.ts)
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
│   ├── shared-finance/          # Shared types, calc engine, permissions
│   │   ├── calculation-engine/  # canonicalProjection.ts + financialProjectionEngine.ts (apply Δ + overrides)
│   │   ├── components/, permissions/, types/
│   ├── taxes/                   # Tax dashboard + service (tax movements wired into planning since 2026-05)
│   │   ├── pages/, services/
│   ├── concurso-mercantil/      # Convenio concursal: data/ (Excel→code, 29 trimestres + 80 acreedores, en miles) + pages/ (dashboard: calendario + cruce banco + futuro) + services/ (convenioMovements → DEBT egresos a Aprobado)
│   │   ├── data/, pages/, services/
│   ├── payroll/                 # TRESS nómina loader + dashboard analítico (sub-tabs: Resumen/Comparativo/Conceptos/Tendencia/Predictivo/Alertas/Detalle, services/payrollAnalyticsService + payrollForecastAdapter + payrollAnomalyService; ver README.md). API agregado (empresa×concepto×periodo×mes) — SIN empleado/puesto/CC → análisis por empleado/CC bloqueado, ver "API gaps" en README. Expansion to movements happens INSIDE canonicalProjection
│   ├── kpis-objectives/         # KPIs autocalculados (bancos + cobranza + CXP) + KPIs custom + objetivos con seguimiento (sección "Objetivos")
│   └── midas-ai/                # MidasBubble proposal suggestion bot
├── components/                  # Treasury UI: CXP, Bancos, Clients, Providers, etc. (Dashboard.tsx removed — merged into Proyección 2026-05-18)
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
  │   • Purchase receipts (compras) — OC egreso fechado en pago proyectado
  │     (recepción/pedido + crédito). `comprasToPurchaseReceipts` deriva un
  │     overlay de días-crédito por proveedor desde las propias OCs
  │     (`buildComprasCreditOverlay`, "el API actualiza el catálogo") para
  │     rellenar D_Credito=0. `buildPurchaseReceiptMovements` recibe
  │     `providers?` y enriquece cada egreso con reglas del catálogo igual que
  │     CXP (flexibilidad → `inamovible` LOCKED, criticidad, providerType).
  │     Pasar `providers` aquí afecta Planeación/Proyección/Dashboard/Base;
  │     el acumulador de IVA (taxes) lo omite a propósito (lockState irrelevante).
  │ Returns { movements, scenarios (Base+Approved shells), customers, suppliers, canonical }
  │ LRU-cached by content fingerprint.
  ▼
FinancialPlanningDashboard.tsx
  ├─ ensureCoreScenarios() — bootstraps Base + Approved (Base copies sourceBaseScenario shell, NO scenario.movements field; movements flow through source.movements directly — but Base filters them to real short-term API only via isRealShortTermApiMovement, see Base scenario invariant)
  ├─ buildScenarioRun() per scenario:
  │     base movements
  │   + manual entries (expandManualPlanningEntriesToMovements)
  │   + adjustments (applyAdjustmentsToMovements)  ← computed ONCE per run; was duplicated before 2026-05-14
  │   + tax movements (buildAutomaticTaxReserveMovements + buildApprovedTaxPaymentMovements, from buildTaxDashboardView)
  │   + supplier payment schedule (scheduleSupplierPaymentsByScore)
  │ → calculateBaseProjection() → KPIs, trajectory
  └─ cellOverrides applied per cell at render (applyCellOverridesToBuckets)
```

Dashboard → Proyección merge (2026-05-18): the standalone **Dashboard** tab was removed and folded into **Proyección Financiera**, which is now the daily landing surface (`DEFAULT_TAB.proyeccion = 'financialProjection'`). `Dashboard.tsx`, `MonthDrilldown.tsx`, `DashboardMonthlyChart.tsx`, `CashFlowTable.tsx` were deleted. Rescued pieces live in `src/modules/financial-projection/components/MergedDashboardKpis.tsx` (`CobranzaKpiCard`, `MinimumExpenseKpi`, `computeRunYtd`). Proyección's forecast window now starts `${year}-01-01` (was `today`) so it shows historical months like the old Dashboard, keeping the `today+364` forward horizon — change applied in BOTH `ProjectionDashboardInner` and `preloadProjectionScenarioRuns` (must stay in sync for cache-key parity). `CashFlowChart` gained an `operatingFloor` line, rendered only at monthly granularity. Note: `deficitDays`/risk KPIs now include historical buckets (accepted tradeoff).

Open integration questions / known gaps:
- `cashFlowEngine.ts` exports `toYearMonth`/`compareYearMonth`/`buildHistoricalMonths`, consumed by `dashboardEngine.ts`, `projectionEngine.ts`, `canonicalProjection.ts`, `expensePerProvider.ts` and the predictive engine. Not dead — don't delete with the old Dashboard.
- `netCashFlowEngine.ts` does internal-transfer detection AND bank-only cash-flow computation (`computeBankOnlyCashFlow`, `computeDailyFlow`, `aggregateWeekly/Monthly`, `computeSummary`, `extractPaymentEvents`). The name is reasonable; do not rename.
- **ROL (CITI) — integración parcial.** `fetchRolRange` trae los viajes ejecutados y se cachean en IDB (`rolRecords`). El cruce `buildRolCobranzaCross` (`src/domain/rolCobranzaMatch.ts`) los empata contra cobranza por `factura`/`uuidFiscal` y alimenta `RolCobranzaPanel` dentro de la pestaña Cobranza (facturado / predicho / huérfano). **Pendiente / BLOQUEADO:** proyectar el ingreso de un viaje *predicho* (ROL → `canonicalProjection`) requiere que el API `/citi/roldiario` exponga de forma fiable la columna de cliente — sin ella no se puede saber quién paga ni con qué reglas de pago. Cuando llegue, el punto de entrada esperado es un campo `rolRecords` en `CanonicalProjectionInputs`. No proyectar ROL como ingreso hasta entonces.
- **Viajes Especiales (2026-05-26).** API dev `http://srv-desarrollo:95/ViajesEspeciales/Servicios` (proxy `/api/viajes-especiales`). A diferencia de ROL, el row trae `K_Cliente` + `D_Cliente` + `Clave_JDE` + `K_Empresa` + `Factura_JDE` + `UUID` + `Fecha_Factura` + `Dias_Credito` por viaje, así que sí se proyecta como ingreso a corto plazo. Pipeline:
  1. `fetchViajesEspecialesRange` (`src/services/jde.ts`) trocea por mes, dedup por `K_Renta`. IDB heavy-store key `viajesEspecialesRecords`. Auto-fetch año en curso en paralelo con ROL — comparte el dataset slot `'rol'` para no agregar boot status nuevo. Falla silenciosa (no bloquea boot).
  2. Cruce factura/UUID vs cobranza JDE: `buildViajesEspecialesCobranzaCross` (`src/domain/viajesEspecialesCobranzaMatch.ts`).
  3. En `canonicalProjection.ts`: las facturas cruzadas re-etiquetan el `cxc:` existente con `subcategory='Viajes Especiales'` (el `id` pasa a `cxc:especial:`). Las NO cruzadas emiten un movimiento sintético `cxc:especial:viaje:` con `date = Fecha_Factura + Dias_Credito` del API (no del catálogo). Como `cxc:especial:` empieza con `cxc:`, pasa el filtro `isRealShortTermApiMovement` de Base sin tocarlo.
  4. Auto-poblado del catálogo: `applyViajesEspecialesGroup` (`src/domain/viajesEspecialesCatalog.ts`) promueve clientes con cuenta JDE coincidente al grupo `group-viajes-especiales`. Respeta `manualGroupOverride=true`. Corre en effect de AppCore cuando cambian `(clients, viajesEspecialesRecords)`.
  - URL prod pendiente: el default `/api/viajes-especiales` apunta a `srv-desarrollo:95` vía proxy de Vite. Ajustar `VITE_VIAJES_ESPECIALES_UPSTREAM` cuando se publique productivo.

`CellOverride` vs `FinancialAdjustment` precedence (decided — no longer ambiguous): `applyAdjustmentsToMovements` mutates at the **movement** level first; `applyCellOverridesToBuckets` mutates at the **bucket** level afterward, at render. If both touch the same concept/bucket, **the `CellOverride` wins** (REPLACE replaces, DELTA adds on top). Historical buckets (before `asOfDate`) are not overridden.

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

`src/domain/persistence.ts` owns the `midas-v12` store. The interface lives at `persistence.ts` (`MidasStore`):

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

- **Inventario completo de persistencia: `src/domain/storageRegistry.ts`.** Enumera TODA key de localStorage (~30) y las 4 bases IndexedDB, con dueño y descripción. Cuando agregues una key nueva, regístrala ahí en el mismo PR. `clearAllMidasStorage()` hace un borrado total coordinado (logout / reset). Los helpers de cada módulo (`loadTaxStore`, `loadChangeLog`, `loadStore`, …) siguen siendo la vía de lectura/escritura — el registro es el mapa, no el cajero.
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

### JDE contract change 2026-05-19 (dev — prod pending)

- **`/compras` now requires `cia` in the body** (one company per request, like `/antiguedadsaldos` + `/cobranza`). It is no longer a global endpoint. `ComprasRequest` carries `cia`; `fetchComprasRange(cia, from, to, …)` signature gained a leading `cia`; the daily cache key is now per-cia (`compras.{cia}.{day}` — was `compras.__all__.{day}`). The compras boot effect in `App.tsx` loops `filterActiveCompanies` in a bounded pool (mirrors the cobranza loader): per-cia delta-sync + per-cia `comprasLoadedCias[cia]` timestamps, plus an aggregate `comprasLoadedCias.__all__` kept only so the Compras tab's "última carga" display (`Compras.tsx`) keeps working untouched. Merge stays upsert (delta only pulls new days; never replace — would drop hydrated history). `pagoproveedor` was NOT changed and is still global (`__all__`).
- **`/compras` renamed the order date** `F_Pedido` → `F_Orden` in the new payload (not announced as a change — caught by field-level diff). `mapCompras` accepts both aliases so it survives dev→prod transition; cash projection was unaffected (uses `F_Recepcion` + `D_Credito`).
- **`/cobranza` added `Clave_/Nombre_Frecuencia_Facturacion_CC17`** (billing cadence: MENSUAL/SEMANAL/QUINCENAL). Mapped to `CobranzaRecord.frecuenciaFacturacion{Clave,Nombre}`. `recomputeClientCreditDaysFromCobranza` now patches `Client.frequency` from it (authority over the static catalog, sets `frequencyFromApi`) — same runtime-overlay path as `creditDays`/`paymentDayName`. Unrecognized frequency strings do NOT override (guarded by `parseFrequencyStrict`, which returns `null` instead of defaulting to Mensual). This closes the "collection rules only from static catalog" gap for cadence.

## Engines

Treasury / cash-flow logic lives in `src/domain/`. Reconciliation engines:

- `auxiliarReconciliationEngine.ts` — **historical bank reconciliation (current)**. Crosses the JDE general ledger (`/JDEdwards/AuxiliarContable`, accounting object 1010-1020 = Caja + Bancos) against real bank statement lines. Both sides are accounting records, so matching by (bank account, date, amount) is near-deterministic — match tiers: `jde-reconciled` (JDE's own `Estatus_conciliado='R'`) → `exact` → `tolerance` → `gl-orphan`; object-1010 caja lines and internal transfers bucket separately. Powers the **Conciliación** dashboard and, via `auxiliarProjectionAdapter.ts`, feeds the projection's "what was confirmed in bank" signal (`cobradaBancoKeys`, `paidCxpKeys`, bank-movement enrichments). Runs in `src/workers/auxiliarReconciliation.worker.ts`.
- `reconciliationEngine.ts` — matches projected collection events against bank ABONOs (heuristic, ±5% tolerance). Forecast-side, not historical.
- `realReconciliationEngine.ts` / `paymentReconciliationEngine.ts` — **legacy** heuristic engines (cobranza↔ABONO 4-layer; pagoProveedor↔CARGO). As of the AuxiliarContable migration these NO LONGER feed Conciliación or the projection — they remain ONLY because the **Pagos**, **CXP**, **Bancos** and **Cobranza** (`CollectionProjection`) display tabs still consume their match types for badges/drilldowns. Pending follow-up: rewrite those tabs onto `auxiliarReconciliationEngine` and delete both legacy engines.

`reconciliationEngine.ts` (forecast) and the legacy engines are not duplicates — they answer different questions (forecast vs. realized).

The forecast / scenario evaluation pipeline lives across `src/modules/financial-planning/services/` and `src/modules/shared-finance/calculation-engine/`. Order of computation for a non-base scenario is:

1. Base movements from `source.movements` (real CXP + cobranza + payroll + compras + recurring providers + manual entries)
2. Active propuestas (`FinancialAdjustments`) applied via `applyAdjustmentsToMovements()` — **single call per run**; the previous double-call was deleted 2026-05-14
3. Tax movements seeded from the post-adjustment view (`buildTaxDashboardView` → `buildApprovedTaxPaymentMovements` + `buildAutomaticTaxReserveMovements`)
4. Convenio concursal: future quarterly payments injected as locked `DEBT` egresos (`buildConvenioPaymentMovements`, mirrors the tax pattern) — non-base only, clipped to the projection window. Calendar/data: `src/domain/convenioConcursal.ts` + `src/modules/concurso-mercantil/data/convenioSchedule.ts` (Excel baked to code, values in miles ×1000)
5. Supplier payment schedule (`scheduleSupplierPaymentsByScore`) rewires CXP timing under the cash floor
6. **Trend top-off (opt-in, non-base)**: `buildTrendTopOffMovements` (`src/domain/predictive/trendTopOff.ts`) injects synthetic `forecast:trend:` movements that lift each future month to the Holt-Winters trend without double-counting. Gap per month = `max(0, predicted − alreadyCommitted)`, so real/known flow is never reduced ("top-off"); the current partial month works because the predictive `expected` already encodes real-to-date + remainder (`isPartial`). Computed AFTER the supplier schedule (its movements are the "committed" baseline) and only when the **Tendencia** toggle in Proyección is on. Series come from `canonical.predictive.{income,expense}.monthly` (Holt-Winters, see `src/domain/predictive/`), threaded as a light per-run arg (`includeTrendTopOff` + `trendForecast`). The flag is part of `cacheKey` AND `pipelineKey` (worker caches the pipeline) — keep both in sync. NOT in Base: `forecast:trend:` fails `isRealShortTermApiMovement`, so the Base filter drops it automatically.
7. Manual cell overrides (`applyCellOverridesToBuckets`) at render
8. Recompute KPIs and projections via `calculateBaseProjection`

## Base scenario invariant

The Base scenario (`id === 'base'`) is special and non-negotiable:

- Always present (bootstrap in `scenarioBootstrap.ts` ensures it).
- Not deletable.
- No propuestas attached.
- No manual cell overrides.
- No manual entries spliced in (`includeManualEntries === false` for Base in `buildScenarioRun`).
- No tax movement injection.
- **No future.** The Base run additionally drops any movement whose `effectiveMovementDate` is `> today` (cut in `buildScenarioForecastRun`, scenarioForecastRun.ts). Base shows past/today only; future dates appear ONLY in Approved/proposal scenarios. `cxc:`/`purchase:`/`payroll:` records pass the API filter but their projected collection/payment date can land in the future — this date cut removes those from Base.
- **Real short-term API data only.** Base does NOT read the full canonical projection. `buildScenarioRun` filters `source.movements` through `isRealShortTermApiMovement` (FinancialPlanningDashboard.tsx) so Base keeps only: real JDE cobranza (`cxc:` — invoices for executed trips, the business calls this *rol*), JDE purchase orders/receipts (`purchase:` / `po:` — *órdenes de compra*) and real TRESS payroll (`payroll:` without `:forecast:` — *nómina*). It drops rule-projected collections (`client:`), CXP (`cxp:`), recurring providers (`recurring-*`), budget reserve (`budget-opex-gap:`), the synthetic canonical balancer (`canonical-*`), synthetic payroll fill and the opt-in trend top-off (`forecast:trend:`). The shared canonical engine is NOT modified — the cut lives only in the Base run, so Dashboard/Proyección still get the full projection. Don't move this filter into `canonicalProjection.ts`.
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

## Performance architecture (2026-05-19 hardening — do not regress)

Crash/perf pass landed 2026-05-19. These are load-bearing; re-check before touching the cited files.

- **Grid virtualization.** `components/spreadsheet/SpreadsheetGrid.tsx` windows rows AND columns (uniform sizes → exact arithmetic; `measured` fallback renders all in jsdom/first paint). Daily zoom × many movements used to OOM ("Aw Snap code 5"); the window keeps the DOM ≈ visibleRows×visibleCols. Don't un-virtualize; keep the `offset !== top` guard in `VirtualRowList` and the equality short-circuit in `handleScroll` (without them it re-renders + forces reflow every scroll frame).
- **Scenario pipeline off the main thread.** `buildScenarioForecastRun` runs in `src/workers/scenarioForecastRun.worker.ts` via `src/modules/shared-finance/hooks/useScenarioRunWorker.ts`. Contract: cache hit = sync (unchanged); miss = post + return the scenario's previous run (stale-while-recompute, never freezes); no `Worker` (jsdom) = sync fallback; `runVersion` bump re-reads the cache. Heavy invariant inputs (`sourceMovements` ~100k + catalogs) are sent ONCE per version and cached in the worker — per-run posts ship only light deltas, so no main-thread structured-clone per edit/flip. `needsHeavy` response = worker lacks the bundle → hook forces a resend. Don't reintroduce posting full args every call. Mirrors the `useFinancialProjectionSource` pattern.
- **Granularity-bounded window.** BOTH `FinancialPlanningDashboard` and `FinancialProjectionDashboard` bound weekly/daily to a near window (monthly = natural year). Proyección originally lacked this → the month→week→day flip blew up to ~365-730 buckets × scenarios and OOM'd ("error 5"). Keep the `deferredGranularity`-keyed window; never widen daily back to the full year.
- **Cache-first instant boot.** The splash (`bootTasks` in `App.tsx`) gates ONLY on `catalog` + `companies` (local/cached, fast). Banks are cache-first (open instantly with hydrated statements) + background revalidate — NOT a splash gate. Boot hard-timeout is **8s** (was 240s). Do NOT re-add `banks` to `bootTasks` or restore the long timeout; that reintroduces the 100-240s splash hang.
- **dailyApiCache.** `ensureMemoryReady` loads via `getAll()` (one callback — the old `openCursor()` fired ~2163 main-thread callbacks/623ms at boot) + a background prune at `CACHE_RETENTION_DAYS` (800 ≈ 2.2yr, must stay ≥ the 2yr Holt-Winters window). Don't revert to the cursor or drop the prune (unbounded `memoryIndex` → GC thrash / OOM over weeks of use).
- **Memory-OOM defense (2026-06-01).** With ALL companies on a normal laptop, the renderer can OOM ("Aw Snap") when switching modules — raw records (compras ~334k, cobranza, nómina 24m, banks) + the ~227k canonical + worker copies + run cache exceed Chrome's per-tab heap ceiling. `src/services/runtimeGuardian.ts` defends in layers: (1) **adaptive heap sampling** — 15s at rest, **2.5s once heap ≥60%** (a fixed 15s interval missed the spike); (2) pressure handlers fire at **75%** (was 85% — too late) to free rebuildable caches, **emergency** at **90%** as a soft last resort; (3) a **persistent post-mortem trail** (`midas.runtime.lastTrail.v1`, registered in `storageRegistry.ts`) written on every sample/nav with a `cleanExit` flag — set false at boot, true on `pagehide`. An OOM-kill skips `pagehide`, so next boot logs "sesión anterior NO cerró limpio" + the active module + heap. Inspect with `window.__midas__.runtime.getLastTrail()`. The **app-level pressure/emergency handler lives in `AppCore.tsx`** (effect near the nav tracker, ~800), NOT only in the finance dashboards — those unmount with the 1-tab keep-alive cap, which previously left **Nómina with zero registered handlers** exactly when it OOM'd. It clears `clearProjectionRunCache` + `clearProjectionSourceCache` + `resetScenarioRunWorker` (terminates the scenario worker → drops its ~100k heavy bundle; lazy-recreated, jobs rejected are all `.catch`-handled); emergency also navigates heavy tabs → `bancos` with a toast. Do NOT move this back into the dashboards only. **Still-open follow-up:** the raw `comprasRecords`/`nominaRecords` arrays held in `AppCore` state for ALL companies are the base heap floor — loading them on-demand per tab (vs. always-in-state) is the durable fix, deferred.

## Risks that bite

1. **Inverting the terminology again.** Simulación / Escenario / Propuesta in UI vs. proposal/scenario/adjustment in code. Check both before renaming.
2. **Breaking the Base scenario.** Any active-scenario change can accidentally allow editing or attach a propuesta to base. Validate.
3. **Assuming new persisted shape.** `localStorage` can hold partial / legacy payloads. Use the normalizer; never read raw fields blindly.
4. **Doc drift.** This file is reality at the time of writing. If you change architecture, update this file in the same PR.
5. **Heavy compute on the main thread.** Forecast and reconciliation are non-trivial. Move new heavy compute into `src/workers/` instead of growing `useEffect` recompute loops.
6. **Duplicate adjustment calls.** `applyAdjustmentsToMovements` is deterministic; calling it twice on the same input is wasted CPU per scenario eval. The fix landed 2026-05-14 — don't reintroduce.
7. **JDE timeout creep.** 120s is the current ceiling. If you raise it, document why; longer hangs make the boot orchestrator feel broken.
8. **Removing the global dark-mode CSS overrides.** ~40 components rely on the `html.dark .bg-white` family of rules in `index.css`. Removing them without migrating each callsite to `bg-card` / token variables will visibly break dark mode.
9. **Re-implementing the global exclusion filter.** Empresa 33 / multicarga exclusion lives ONLY in `src/domain/companyExclusion.ts`, applied at the JDE normalize layer of **every** base fetch in `src/services/jde.ts` (`fetchAgedBalances`, `fetchCobranza`, `normalizeCobranzaPayments`, `fetchCompras`, `fetchPagoProveedor`, `fetchNomina`, `fetchBankStatements`, `fetchRol` — via `dropExcludedByCia`; `*Range` variants delegate to these) and the company-selector sites (`filterActiveCompanies` in `App.tsx`), plus the `bankStatements` display memo in `App.tsx` (filters excluded accounts next to `excludeBajio` — required because persisted IDB bank caches / daily-cache / manual uploads bypass `fetchBankStatements`). It is **blanket — no date boundary** (historical records dropped too; the predicate is `matchesExclusionIdentity`). Do NOT apply it inside `canonicalProjection.ts` (double-filter bug — the cut is upstream, downstream inherits it). See `EXCLUSION_RULES.md`.

## Spanish vs English

User-facing copy is Spanish (es-MX). Internal identifiers, code, comments, and commit messages are English. Do not translate type names. Do translate UI strings.

Locale and currency are hardcoded `es-MX` / `MXN` in `formatters.ts`. If you ever need to internationalize, that file is the single chokepoint to refactor.

## Before you ship

- `npm test` (13 pre-existing failures on main as of 2026-05-15, all in `CollectionProjection.test.tsx` + `MidasSplash.test.tsx` — verify count didn't grow)
- `npm run typecheck` (clean as of 2026-05-15 — any error is yours)
- `npm run build` (clean as of 2026-05-15)
- Smoke `npm run dev` against real JDE data (or empty store) for the path you touched.
- For visual changes, toggle dark mode (add `dark` class to `<html>` via DevTools) and verify your component reads correctly. The splash, dashboard, planning grid, charts, CommandPalette (⌘K), modals, and form inputs should all be coherent.
- Update this file if you changed the architecture.
