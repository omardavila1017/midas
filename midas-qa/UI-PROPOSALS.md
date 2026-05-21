# Midas — UI Improvement Proposals

**Date:** April 20, 2026  
**Scope:** Full-app sweep — navigation, data viz, workflows, interactions  
**Methodology:** Deep code review of every component, domain engine, theme, and CSS layer

---

## 1. Command Palette & Global Search

**Impact: Very High | Complexity: Medium**

Midas has 9 tabs across 3 sections, dozens of clients, providers, proposals, and KPIs — but no way to jump to anything instantly. A `Cmd+K` command palette would let power users (CFOs, treasury managers) navigate by intent rather than by clicking through tabs.

What it does: a floating modal triggered by keyboard shortcut that accepts freeform text. Type "Cementos" and it surfaces that client's row, their collection projection, and any scenario that mentions them. Type "CXP vencida" and it jumps to the aged payables dashboard filtered to overdue. Type "escenario optimista" and it opens that proposal's workbench.

This single feature touches navigation, search, and filtering simultaneously. It also solves the missing deep-linking problem — today there's no way to bookmark or share a specific view state.

**What to build:** a `CommandPalette.tsx` component using a fuzzy-match library (fuse.js), indexing tab names, client names, provider names, proposal/scenario names, KPI names, and recent actions. Wire it to `Cmd+K` globally.

---

## 2. Inline Sparklines in Data Tables

**Impact: High | Complexity: Low**

Every major table in Midas (Clients, Providers, CXP aging, Collections) shows static numbers. Adding a tiny 60×20px sparkline column next to key metrics would let users spot trends without drilling into charts.

For example, in the Clients table, a sparkline showing the 12-month seasonality pattern next to each client name instantly communicates who is seasonal vs. flat. In CXP, a sparkline of aging movement (is this provider getting more or less overdue?) replaces mental arithmetic.

Recharts is already installed. A `<Sparkline data={monthlyValues} />` wrapper component with a fixed width, no axes, and a single stroke line would be roughly 30 lines of code per use case.

**Where to apply:** Clients (seasonality), CollectionProjection (monthly trend per client), CXP (aging trend), KpiCenter (historical value), Dashboard (concept-level mini-trends in drill-down).

---

## 3. Scenario Diff View (Side-by-Side Comparison)

**Impact: High | Complexity: Medium**

The ScenarioWorkbench lets you create proposals with multiple scenarios, but comparing them requires mentally toggling between views. A dedicated diff mode showing two scenarios side-by-side — with cells color-coded by delta magnitude (green for improvement, red for deterioration) — would make the core planning workflow dramatically faster.

Today the Forecast component shows base/simulated/manual/diff layers, but always for one scenario at a time. A `ScenarioDiff.tsx` component would render two Forecast grids in parallel, synchronized by scroll position, with a delta column between them showing absolute and percentage differences.

**Bonus:** add a "Winner" row at the bottom that highlights which scenario is better per KPI (caja final, flujo neto, caja mínima), so the CFO gets a clear recommendation at a glance.

---

## 4. Toast Notification System

**Impact: High | Complexity: Low**

Midas currently has zero feedback for successful actions. You add a client — nothing. You import CXP — it says "Abriendo dashboard..." but doesn't transition. You delete a provider — the row just disappears. This violates a basic UX heuristic (visibility of system status).

A lightweight toast system (bottom-right, auto-dismiss after 4 seconds, with undo action for destructive operations) would cover every CRUD action across the app. The `index.css` already defines z-index 500 for toasts and has entrance animations (`slideUp`, `fadeIn`) ready to use.

**Implementation:** a `ToastProvider` context wrapping the app, with a `useToast()` hook. Every `setState` call that modifies data (add client, delete provider, import CXP, create proposal, apply simulation) gets a one-line `toast.success("Cliente agregado")` call. Destructive actions get `toast.warning("Proveedor eliminado", { undo: () => restoreProvider(id) })`.

---

## 5. Drag-and-Drop Simulation Builder

**Impact: High | Complexity: High**

The ScenarioWorkbench simulation form is functional but feels like filling out a tax return. Six simulation types, four categories, frequency selectors, date pickers, target concept dropdowns, custom allocation arrays (comma-separated strings!) — all crammed into a sequential form.

A visual builder where you drag simulation "blocks" onto a timeline would transform the experience. Each block represents a simulation type (cost reduction, revenue growth, deferral, etc.) with a colored card. You drag it onto a month-range track, resize it to set duration, and click to configure details. The timeline shows stacked blocks so you can see which simulations overlap.

This is the highest-complexity proposal but also the most transformative for the core use case. The comma-separated `customAllocation` field alone is a usability problem worth solving — replace it with a visual bar chart where you drag individual month values.

---

## 6. Cash Flow Waterfall Chart

**Impact: High | Complexity: Medium**

The Dashboard currently uses a ComposedChart with bars (Ingresos, Egresos) and a line (Caja Final). This is standard but doesn't communicate *how* you got from one month's balance to the next. A waterfall chart — where each bar segment shows the contribution of a specific concept (collections, payroll, taxes, loan payments) stacked as increases and decreases — tells a much richer story.

Recharts doesn't have a native waterfall, but it can be built with a stacked BarChart using invisible "connector" bars. D3 is already in the dependency tree for more complex cases.

**Where to use:** replace or complement the main Dashboard chart, and add it as a new view in Forecast (alongside P&L, Cashflow, Drivers — add "Waterfall" as a fourth tab).

---

## 7. Responsive Layout with Collapsible Sidebar

**Impact: Medium-High | Complexity: Medium**

Midas has zero responsive breakpoints. The CSS uses hardcoded `grid-cols-4` for KPI cards, fixed-width tables, and a `max-w-[1400px]` content container. On a laptop (1366px), content is cramped; on a tablet, it's broken.

The proposal: replace the top tab bar with a collapsible left sidebar. Sections (Catálogos, Operación, Planeación) become sidebar groups with icon-only collapsed state. The main content area gets the full viewport width. On screens below 1024px, the sidebar auto-collapses to icons; below 768px, it becomes a hamburger overlay.

This also creates space for a persistent "active proposal" indicator in the sidebar — today users can forget which proposal/scenario they're editing because the selector is buried inside the ScenarioWorkbench tab.

---

## 8. Keyboard Shortcuts & Accessibility Pass

**Impact: Medium-High | Complexity: Low-Medium**

The app has no `:focus-visible` styles defined, no `aria-expanded` on collapsible rows, no keyboard shortcut system, and no skip-navigation links. For a financial tool used 8 hours a day by power users, this is a significant gap.

**Phase 1 (low effort):** Add `:focus-visible` ring styles to all interactive elements in `index.css`. Add `aria-expanded`, `aria-label`, and `role` attributes to expandable table rows, dropdowns, and modals. Add a skip-to-content link.

**Phase 2 (medium effort):** Implement a shortcut layer: `1-9` to switch tabs, `N` to create new (client/provider/proposal depending on context), `E` to export, `/` to focus search, `Esc` to close any open panel. Show a `?` shortcut cheat sheet.

This directly improves accessibility compliance and power-user efficiency with minimal code changes.

---

## 9. Confirmed Payment Workflow with Batch Actions

**Impact: Medium | Complexity: Medium**

CollectionProjection supports marking individual payments as "confirmed" but has no batch operations. A finance team reconciling 200+ expected payments against bank deposits needs to select multiple rows, paste a bank reference, and confirm them in one action.

**Proposed flow:** add a checkbox column to the collections table. When one or more rows are checked, a floating action bar appears at the bottom ("3 selected — Confirm All | Export | Clear"). The "Confirm All" action opens a small modal to enter a bank reference and confirmation date. Confirmed rows get a green checkmark badge and are excluded from projection uncertainty calculations.

This also connects to the Bancos module — if bank statement data is loaded, the app could auto-suggest matches between expected collections and actual bank movements (fuzzy matching on amount ± 2% and date ± 3 days).

---

## 10. KPI Formula Builder with Autocomplete

**Impact: Medium | Complexity: Medium**

The KpiCenter's custom formula editor is a plain text input where users type variable names like `porcentaje_cobranza` from memory. There's a variable reference dropdown, but composing formulas for complex KPIs (e.g., `(collections_confirmed / collections_projected) * 100`) is error-prone.

Replace the bare input with a code-editor-style field that offers autocomplete as you type (triggered by typing a letter or `$`), syntax highlighting for operators and variables, inline validation (red underline for unknown variables), and a live preview showing the computed value for the selected month.

This could be built with a controlled `<textarea>` plus a floating suggestion list — no need for a full code editor library. The variable catalog already exists in `kpiCatalog.ts`.

---

## 11. Dark Mode

**Impact: Medium | Complexity: Medium**

The design system is already built on CSS variables (`--surface`, `--gray-*`, `--primary`), which means dark mode is architecturally ready — it's just a matter of defining an alternate set of values under `@media (prefers-color-scheme: dark)` or a `.dark` class toggle.

For a financial app used all day, dark mode isn't cosmetic — it reduces eye strain during late-night planning sessions and improves chart contrast on projector screens during board meetings.

**Implementation:** duplicate the `:root` variable block into a `.dark` selector, invert the gray ramp (950→50), adjust surface colors, slightly desaturate the primary/success/danger tokens, and add a toggle button in the header. The glassmorphism `.glass` class needs a darker backdrop with adjusted blur. Chart colors may need brightness bumps for readability on dark backgrounds.

---

## 12. Activity Feed & Change Log

**Impact: Medium-Low | Complexity: Medium**

Midas stores `editedAt` timestamps on scenario cell overrides but doesn't surface them anywhere. When multiple people touch a cash flow plan (or even one person revisiting after a week), there's no way to see what changed.

An activity feed panel — accessible from a bell icon in the header — would log every meaningful action: "Simulation 'Recorte Nómina -15%' added to Escenario Optimista", "Client 'Cementos del Norte' billing updated from $2.4M to $2.8M", "CXP data imported (347 records, $14.2M total)". Each entry links back to the relevant tab and record.

Since the app is localStorage-based, the feed would also be localStorage-backed — a simple array of `{ action, entity, detail, timestamp }` objects, capped at 500 entries. This is a stepping stone toward multi-user audit trails if Midas ever gets a backend.

---

## Priority Matrix

| # | Proposal | Impact | Complexity | Quick Win? |
|---|----------|--------|------------|------------|
| 1 | Command Palette | Very High | Medium | |
| 2 | Inline Sparklines | High | Low | Yes |
| 3 | Scenario Diff View | High | Medium | |
| 4 | Toast Notifications | High | Low | Yes |
| 5 | Drag-and-Drop Simulations | High | High | |
| 6 | Waterfall Chart | High | Medium | |
| 7 | Responsive Sidebar | Medium-High | Medium | |
| 8 | Keyboard Shortcuts & A11y | Medium-High | Low-Medium | Yes |
| 9 | Batch Payment Confirmation | Medium | Medium | |
| 10 | KPI Formula Autocomplete | Medium | Medium | |
| 11 | Dark Mode | Medium | Medium | |
| 12 | Activity Feed | Medium-Low | Medium | |

**Recommended build order:** Start with the three quick wins (4 → 2 → 8) to immediately improve daily usability. Then tackle the high-impact medium-complexity features (1 → 3 → 6) that differentiate Midas. Save the heavy lifts (5, 7) for a dedicated sprint.
