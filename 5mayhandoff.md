# Midas — 5 May Handoff

End-of-day testing pass, 5 May 2026. Findings are organized by module group (Catálogos, Operación, Proyección) and ranked by severity.

## Methodology

Two passes were run:

1. **Static-dist pass (sandboxed Playwright, headless Chromium)** — three parallel agents (Catálogos / Operación / Proyección) ran Playwright via `playwright-core` against the prebuilt `dist/` served on `python3 -m http.server`. This pass exercised structural behavior (DOM, navigation, login, empty-state rendering) but cannot exercise live data, since no API backend is wired up against a static build. Agents wrote intermediate findings into `outputs/{catalogos,operacion,proyeccion}-findings.md` and `outputs/screenshots/`.
2. **Live pass (Chrome MCP against `http://localhost:5173/`)** — drove the dev server running on the host machine via the Claude-in-Chrome extension. This pass exercised real data and is where the substantive findings below come from.

**Login:** `admin` / `ARomo1$` (from `.env`, baked into both dist build and dev runtime).

**Sandbox notes for the next agent:**

- Vite dev server cannot start inside the local sandbox — `node_modules/.vite` cache is owned by macOS and read-only from Linux. Run dev on the host.
- Background processes do not survive across `bash` calls in the sandbox. Spawn the http server inside each Playwright run.
- The `playwright test` CLI hangs in this sandbox for unknown reasons; `playwright-core` driven directly from a node script works (`/tmp/seed.js` was the seed).
- Screenshots from `mcp__claude-in-chrome` `save_to_disk: true` go to the user's Downloads, not the sandbox mount, so this doc references them by ID/description rather than path.

**Coverage matrix:**

| Module | Static-dist sweep | Live sweep | Result |
| --- | --- | --- | --- |
| Catálogos / Clientes | Yes | Yes | Tested |
| Catálogos / Proveedores | Yes | Yes | Tested |
| Operación / Flujo Neto | Yes | Yes (Diario, Semanal, Mensual) | Tested |
| Operación / CXP | Yes | Yes (chart + Top 10 + filters) | Tested |
| Operación / Cobranza | Yes | Yes (Real JDE + Proyectada toggle) | Tested |
| Operación / Bancos | Yes | Yes | Tested |
| Proyección / Dashboard | Static-only | Yes (chart + cards) | Tested |
| Proyección / Operativa | Static-only | Yes | Tested |
| Proyección / Proyección Financiera | Static-only | **Failed** — Chrome MCP timed out repeatedly | Not exercised live; static review only |
| Proyección / Planeación Financiera | Static-only | **Failed** — same | Not exercised live; static review only |
| Proyección / Impuestos | Static-only | **Failed** — same | Not exercised live; static review only |

The three Proyección pages that did not load through the extension are the heaviest in the bundle (lazy chunks with Recharts + canonical engine). The repeated extension stall suggests they're either spending several seconds to mount or hitting a render error during their first load. Worth investigating regardless of whether it's a bug or just slow first paint.

---

## Catálogos

### Clientes

#### C-1 — Currency formatting missing on summary cards and table  *(minor)*

- **Repro:** Catálogos → Clientes.
- **Observed:** The summary cards "VENTAS ANUALES" (`2,539,453,730`), "POR COBRAR PROYECTADO" (`1,649,511,874`), and the table columns `VENTAS` and `POR COBRAR` show raw numbers with no `$` prefix.
- **Expected:** Other modules (Cobranza, Bancos, CXP, Dashboard) render the same kinds of monetary values with a `$` prefix or `M$` suffix. Catálogos / Clientes is the outlier.
- **Suggested fix:** Apply the existing `currency` formatter from `src/formatters.ts` to `ventasAnuales`, `porCobrar`, and the equivalent table columns in `Clients.tsx`.

#### C-2 — Summary cards do not update when the search filter is applied  *(minor)*

- **Repro:** Search "corning" in the search input. Table filters down to one row. Summary cards remain at `115 grupos comerciales`, `$2.5B ventas anuales`, etc.
- **Observed:** Summary cards reflect the full catalog, not the filtered set.
- **Expected (or a UX call):** Either the cards should reflect the filtered view, or there should be a small "filtered view" indicator — currently it reads as inconsistent.
- **Suggested fix:** Either (a) compute card aggregates from `filteredClients` instead of `allClients`, or (b) leave the totals but add a small subtitle "Sobre catálogo completo" so the user knows the cards are global.

### Proveedores

No issues found in the live pass. 478 proveedores load, score chips (Operativo / Prioritario / Negociable / Flexible) match the top "OPERATIVOS (SCORE ≥ 80) 66" card, search/category/frequency filters all wire up, ProviderDetailModal opens on row click. Donut chart "Por tipo de proveedor" renders correctly with category percentages.

---

## Operación

### Flujo Neto

#### O-FN-1 — "2 días con actividad" label conflicts with rollup showing only 1 day  *(major)*

- **Repro:** Operación → Flujo Neto. Note the "Saldo real bancos" header reads `34 cuentas · 2 días con actividad · Al 30-abr`. Switch the table grouping to **Diario**.
- **Observed:** Only one row appears: `30-abr · Jue · 468 movimientos`. Switch to **Semanal** → only `Semana 17 · Desde 27-abr` appears. Switch to **Mensual** → only `Abril` appears.
- **Expected:** If the bank-statement coverage is genuinely "2 días con actividad", the Diario rollup should show two rows, not one. Either the label is overstating coverage, or the Diario rollup is dropping a day.
- **Suggested fix:** Audit `domain/bankStatements.ts` (the `bankActiveDays` calculation feeding the badge) against the data feeding `CashFlowTable.tsx` for grouping=Diario. The two are computed from the same dataset and should not disagree.

#### O-FN-2 — Company-chip filter row overflows horizontally with no scroll affordance  *(minor)*

- **Repro:** Look at the row of company chips under "Saldo real bancos" (`ACTIVAS · 00038 - SERVICIOS T DE N · 00001 - TRANSPORTES TAMAULIPAS · ...`).
- **Observed:** The last chip "00011 - Servicio Industrial Regio…" is visually clipped at the right edge of the panel and scroll is mouse-wheel only — no chevron, no fade, no count badge indicating there are more chips.
- **Expected:** A horizontal scroll affordance (chevron button, gradient fade, "+N more" badge) so the user knows there are additional companies hidden.
- **Suggested fix:** Add right-edge gradient mask + chevron buttons in the chip-row container in `App.tsx` (or wherever `companyChips` row is rendered).

### CXP

No defects in the page itself — `74.6 M$ saldo total CXP`, `2,361 facturas`, `301 proveedores` all render, the `Distribución por Antigüedad` horizontal-bar chart and the "Por tipo de proveedor" donut both populate, and Top 10 Proveedores list renders correctly with bars. Search input and category/frequency filters present and responsive.

#### O-CXP-1 — Donut chart "Por tipo de proveedor" renders ~1s after the bar chart  *(minor)*

- **Repro:** Click on CXP tab and immediately scroll down. The horizontal bar chart "Distribución por Antigüedad" renders quickly; the donut chart appears noticeably later.
- **Observed:** First screenshot shows category labels (REFACCIONARIO, TECNOLOGIA Y SOPORTE, RENTAS...) without the donut visual — only on a second render does the donut appear.
- **Expected:** Both charts should render together, or the donut should show a skeleton/loader.
- **Suggested fix:** Either preload the donut data alongside the bar (likely both come from the same aggregation but the donut is gated on a separate `useMemo`), or render a `<Sparkline>` skeleton placeholder while the donut data computes.

### Cobranza

#### O-COB-1 — `SALDO CXC PENDIENTE` shows `$0.00` while the panel below reports `$194,454,164.89` total CXC  *(critical)*

- **Repro:** Operación → Cobranza, default view `Real (JDE)`.
- **Observed:** The top summary card row reads:
  - `SALDO CXC PENDIENTE: $0.00`
  - `IMPORTE BRUTO FACTURADO: $106,959,170.70`
  - `VENCIDO (% DEL SALDO): 0.0% / $0.00`
  - `COBRANZA CRUZADA CON BANCO: 0.0% (0/147 abonos)` — with a "3 por revisar" note linking to candidates listed below
  - `FACTURAS: 3,093`
  - But the section further down says: `TOTAL CXC: $194,454,164.89 · 343 eventos · 124 clientes`, `REAL BANCO: $0.00 cruzado con banco`, `JDE + CXC PENDIENTE: $0.00`.
- **Expected:** `SALDO CXC PENDIENTE` and `TOTAL CXC` should agree (or be clearly labeled as different aggregations of the same set of receivables).
- **Suggested fix:** In `CollectionProjection.tsx`, audit how `saldoCXCPendiente` is computed at the top of the page vs `totalCXC` at the bottom. They likely use different filters (e.g. one applies cross-with-bank and one doesn't) but if so, that needs to be visible in the labels.

#### O-COB-2 — `Cobrado (Real)` and `Real banco cruzado` are both `$0.00` despite having 3 high-confidence candidate matches (74%, 86%, 86%)  *(major)*

- **Repro:** In the same Cobranza page, "Cruces por revisar" shows three candidates with high match confidence:
  - `2026-04-30 · $10,771.37 → GRUPO CONEKTAME · Fact. RI-91361 · 74%`
  - `2026-04-30 · $1,606.16 → JAIME MARTINEZ RESENDEZ · Fact. RI-91210 · 86%`
  - `2026-04-30 · $769.52 → EDGAM LOGISTICA · Fact. RI-91212 · 86%`
- **Observed:** The Reconciliación Bancaria panel says `CRUZADOS $0.00 (0 pagos confirmados en banco)` and `PROBABLES $19,102,337.93 (38 pagos con match parcial)`.
- **Expected (or call):** Either auto-confirm matches above some threshold (say 80%) or surface the three candidates in a much more action-prominent banner. Right now the banner's "$13,147.05" badge is the only signal that the user has work to do, and the overall percent-cruzado stays 0%.
- **Suggested fix:** Add a one-click "Confirmar cruces ≥ 85%" button at the top of the "Cruces por revisar" banner. Alternatively, change `CRUZADOS` to count `confirmados + auto-applicable` so the user sees forward motion.

#### O-COB-3 — Inconsistent `clientes` count in the Proyectada view: header says `128`, panel below says `126`  *(minor)*

- **Repro:** Operación → Cobranza → toggle to **Proyectada**.
- **Observed:** The top summary reads `CLIENTES: 128`. The "Cobranza Total" panel further down reads `350 pagos · 126 clientes`.
- **Expected:** Consistent count, or different labels making the difference explicit (e.g., "clientes con proyección" vs "clientes con pagos pendientes").
- **Suggested fix:** Confirm whether the difference is the two clientes with no pending pagos and re-label one of them.

#### O-COB-4 — Reconciliación Bancaria `SIN CRUZAR $175,039,380.85` (312 pagos) suggests the matcher is not running, not just that no matches were found  *(major)*

- **Repro:** Cobranza → Proyectada → Reconciliación Bancaria panel.
- **Observed:** `CRUZADOS $0.00 / 0`, `PROBABLES $19.1M / 38`, `SIN CRUZAR $175.0M / 312`, `ABONOS NO ASIGNADOS $55.3M / 114`. With $175M in pagos sin cruzar against $55.3M in unassigned abonos, the matcher is finding 38 probables out of 350 — call it ~11%.
- **Expected:** Match rate should be much higher given the candidates we saw are at 74-86% confidence. Either the threshold for "PROBABLE" is too tight, or the matcher silently bails out for most rows.
- **Suggested fix:** Inspect `domain/realReconciliationEngine.ts` — confirm the matcher is iterating all 350 pagos, and that the "PROBABLE" threshold isn't set so high it excludes obvious matches.

### Bancos

No defects found. `34 cuentas · $54.3M saldo total · 470 movimientos · Estado al 2026-05-05 · Formato SWIFT`. Bank tree expands cleanly (BANAMEX Concentradora 24 cuentas $52.6M), individual account rows render with company name + saldo final + count of movimientos. Filter chips (Todos los bancos, Todas las monedas, Cargos y abonos) are present.

---

## Proyección

### Dashboard

#### P-DSH-1 — `GASTO MÍN. OPERATIVO $111.8 M$ / mes` is implausibly high — likely a unit bug in Nómina + finiquitos  *(critical)*

- **Repro:** Proyección → Dashboard. Look at the right-most card.
- **Observed:**
  - `GASTO MÍN. OPERATIVO $111,802,686.20 / mes`
  - Subtitle: `1341.6 M$ anualizado` (which is just `12 × 111.8M`)
  - Breakdown:
    - `Proveedores Operación 66 — 19.7 M$`
    - `Nómina + finiquitos — 92.1 M$`
- **Expected:** `19.7M + 92.1M = 111.8M` matches the headline, so the math is consistent _internally_. But $92.1M/month in nómina + finiquitos for a company that does $55M/month in ingresos is not internally consistent with the rest of the dashboard. The most likely explanation is that the source figure is annual (not monthly) and is being labeled as `/ mes`.
- **Compare against:** `INGRESOS YTD 2026: $55.4M · 55.4 M$ / mes promedio` — i.e., monthly ingresos are roughly equal to what the card claims is the monthly _minimum_ payroll. Either revenue is half of payroll (in which case the company is a bonfire, which contradicts the rest of the data), or the unit is wrong.
- **Suggested fix:** Trace `gastoMinOperativo.nominaFiniquitos` in the Dashboard data path. If the source is JDE annual, divide by 12 before displaying as `/ mes`. The Proveedores Operación piece (`19.7M`) is plausible as monthly so the inconsistency is almost certainly on the nómina side.

#### P-DSH-2 — `COBRANZA CRUZADA CON BANCO 0.0%` repeated as a critical-styled red banner  *(major — duplicate of O-COB-1)*

- The same `0.0% (0 de 147 abonos · 147 sin factura)` message that appears on the Cobranza tab also dominates the Dashboard with a red border and "Diagnosticar bajo cruce" link. It is correctly diagnostic — but if O-COB-1/O-COB-2 above are fixed (i.e. the matcher actually populates), this banner should drop too.

#### P-DSH-3 — `Flujo mensual` chart skips months Ene 26 / Feb 26 / Mar 26 / May 26  *(major)*

- **Repro:** Proyección → Dashboard → scroll to "Flujo mensual" chart.
- **Observed:** X-axis goes `Abr 26 → Jun 26 → Jul 26 → Ago 26 → Sep 26 → Oct 26 → Nov 26 → Dic 26`. May 26 is **missing entirely** from the axis. Jan/Feb/Mar 26 are missing too.
- **Expected:** A YTD dashboard for 2026 should show all months from Jan to Dec — Jan-Mar with empty/zero bars if there's no data, May with its current partial data. Today is May 5, so May should at minimum exist as a partial bar.
- **Suggested fix:** In `Dashboard.tsx` `monthlyFlow` aggregation, ensure the month domain spans the full fiscal year (or at minimum from `min(firstActivity, Jan)` to `Dec`). Inserting a zero-padding step before passing to the Recharts `XAxis` should fix it.

### Operativa

#### P-OP-1 — `PAGOS CRÍTICOS $20.0` value with `$5,492,066.96` subtitle is a unit/format mismatch  *(critical)*

- **Repro:** Proyección → Operativa. Look at the seventh card from the left.
- **Observed:** Card big value reads `$20.0`. Card subtitle reads `$5,492,066.96`. Top-right header pill reads `PAGOS CRÍTICOS 20`.
- **Expected:** Other cards on the same row use the convention "abbreviated big number + exact amount in subtitle":
  - `INGRESOS PROYECTADOS · 1649.5 M$ · $1,649,511,873.81`
  - `EGRESOS PROYECTADOS · 1665.2 M$ · $1,665,161,002.95`
- **Diagnosis:** The big number is the **count** (`20`) but is being rendered with the currency formatter, producing `$20.0`. The subtitle is then the actual amount (`$5,492,066.96`). So the user sees `$20.0` and reads "twenty dollars".
- **Suggested fix:** Either show the count separately (`20 pagos` + `$5.5 M$ total`), or follow the rest-of-row convention: big = `5.5 M$`, subtitle = `$5,492,066.96`, with a small badge showing count. Don't apply the currency formatter to the count.

#### P-OP-2 — Page title "Proyección operativa" and helper text appear ghosted/disabled-looking  *(minor)*

- **Repro:** Proyección → Operativa.
- **Observed:** Header text "Proyección operativa" and "Muestra de dónde entra el efectivo, en qué se usa y cuánto queda apartado para pagos obligatorios." both render at very low opacity / pale gray, almost looking disabled. Compare against e.g. Dashboard headers which are bold full-contrast.
- **Expected:** Page heading should be at full text contrast, matching the rest of the design system.
- **Suggested fix:** Check `OperatingProjection.tsx` for an opacity/disabled class being applied during loading and not removed. Could be a state variable that flipped wrong.

#### P-OP-3 — `CONFIANZA Baja (45% · 241 días)` — confidence card uses red text when "Baja", but red also signals errors elsewhere  *(minor)*

- **Repro:** Proyección → Operativa.
- **Observed:** The "CONFIANZA" card displays "Baja" in red. The "Déficit / Excedente" card next to it also displays a negative value in red. Two adjacent red signals that mean different things (data quality vs. a money number being negative).
- **Expected:** Use a different color for confidence (e.g., amber for low confidence) to distinguish from money-negative red.

### Proyección Financiera, Planeación Financiera, Impuestos

These three tabs did **not** complete loading through the live test pass — every attempt to click into them caused the Chrome extension session to time out. Could be:

- A genuine first-mount perf bug (these are the heaviest chunks, with `Recharts` + canonical engine + the planning grid). Worth opening DevTools Performance and checking if the first render exceeds ~5s.
- An unhandled state during mount. Check the browser console at the moment of click — if there's a thrown exception during `FinancialProjectionDashboard`, `FinancialPlanningDashboard`, or `TaxDashboard` mount, it would explain the symptom.

For now, the only signal we have on these is from the static-dist agent's source-code review of all three files (`5,888 lines combined`), which found no obvious defects. **This is unverified at runtime against live data and should be treated as an open testing gap.**

---

## Cross-cutting

#### X-1 — Heavy bundle: `Operativa` and `Proyección Financiera` cause perceptible jank when first navigating  *(minor → major if perf regresses)*

The lazy-loaded Proyección sub-pages (Dashboard, Operativa, Proyección Financiera, Planeación Financiera, Impuestos) all wait several seconds before the first paint. The `App.tsx` already sets up `Suspense` and lazy chunks, so this is a chunk-size problem more than a code-splitting one. Recharts + canonical engine + planning grid are likely the bulk.

**Suggested fix:** Check `dist/assets/` chunk sizes. If `vendor-charts-*.js` is dominating, consider routing to a charting library that supports tree-shakeable imports (or pre-rendering specific chart components at build time).

#### X-2 — `0 de 147 abonos · 147 sin factura` repeats in three places  *(consistency)*

The same red `0.0% / 0 de 147 abonos / 147 sin factura` block appears on the Dashboard, Cobranza Real (JDE), and Cobranza Proyectada views. Once O-COB-1/2 are addressed the message should change in all three. Make sure the source of truth is one selector (e.g. `useReconciliationStatus`) so all three update together.

---

## Suggested fix order

Ranked by user impact / blast radius:

1. **P-OP-1** (Pagos críticos `$20.0` / subtitle mismatch) — visible, embarrassing, looks like the app is showing $20 in critical payments.
2. **P-DSH-1** (Gasto mín. operativo unit bug) — the highest-trust card on the dashboard is showing a number that doesn't reconcile against revenue.
3. **O-COB-1 + O-COB-2** (CXC `$0.00` vs `$194M`, matcher under-running) — affects the entire Cobranza module, the trust signal for treasury.
4. **P-DSH-3** (Flujo mensual chart missing months) — visible, missing data signal.
5. **O-FN-1** (`2 días con actividad` vs `1 day in rollup`) — one-line label mismatch but affects daily user trust.
6. **C-1** (currency formatter on Clientes) — easy win, polish.
7. **O-COB-3** (`128 vs 126` clientes) — easy win, polish.
8. **O-FN-2** (chip overflow), **P-OP-2** (ghosted title), **P-OP-3** (red-on-red), **C-2** (filter card update), **O-CXP-1** (donut delay) — all UX polish.
9. **Proyección Financiera / Planeación / Impuestos load failure** — open testing gap, please re-run a focused pass against these three tabs once dev is feeling fresh.

## Files referenced

- `src/App.tsx` — top-level navigation, tab routing
- `src/components/Clients.tsx` — Catálogos / Clientes
- `src/components/Providers.tsx`, `src/components/ProviderDetailModal.tsx` — Catálogos / Proveedores
- `src/components/CashFlowDetail.tsx`, `src/components/CashFlowTable.tsx` — Operación / Flujo Neto
- `src/components/CXP.tsx` — Operación / CXP
- `src/components/CollectionProjection.tsx` — Operación / Cobranza
- `src/components/Bancos.tsx` — Operación / Bancos
- `src/components/Dashboard.tsx` — Proyección / Dashboard
- `src/components/OperatingProjection.tsx` — Proyección / Operativa
- `src/modules/financial-projection/pages/FinancialProjectionDashboard.tsx` — Proyección / Proyección Financiera
- `src/modules/financial-planning/pages/FinancialPlanningDashboard.tsx` — Proyección / Planeación Financiera
- `src/modules/taxes/pages/TaxDashboard.tsx` — Proyección / Impuestos
- `src/domain/bankStatements.ts` — bank-coverage label
- `src/domain/realReconciliationEngine.ts` — Cobranza matcher
- `src/formatters.ts` — currency / percentage formatters

## Test artifacts

- Static-dist agent reports: `outputs/catalogos-findings.md`, `outputs/operacion-findings.md`, `outputs/proyeccion-findings.md`
- Static-dist agent JSONs: `outputs/{catalogos,operacion}-findings.json`, `outputs/operacion-{run-1, run-2-3, comprehensive, deep-test, results}.json`
- Static-dist screenshots: `outputs/screenshots/operacion-*.png`, `outputs/screenshots/catalogos-*.png`
- Live pass: screenshot IDs captured during the Chrome MCP run (`ss_4717r7f2o`, `ss_17922cyre`, `ss_4148s5nns`, `ss_2193gas2g`, `ss_41254gvub`, `ss_4698ar8e1`, `ss_31051uh2u`, `ss_5187v3ylc`, `ss_5547grs12`, `ss_14064ufl3`, `ss_80161noh7`, `ss_1069mtcra`, `ss_3308z2chx`, `ss_6791ldppu`, `ss_4812c118s`, `ss_8870iiy9s`, `ss_7714z520t`); these were saved from the user's browser session.
