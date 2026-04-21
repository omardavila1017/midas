# Design Context — SendaStack Artifacts

This file is read by every Impeccable skill (`/impeccable`, `/typeset`, `/arrange`,
`/polish`, `/distill`, etc.) before it does any design work. It locks the Senda Design
System as the only valid direction and explicitly overrides the Impeccable defaults
wherever they conflict with Senda's brand.

**Upstream source of truth:** `CLAUDE.md` §3 (Senda Design System). If anything in this
file contradicts `CLAUDE.md`, `CLAUDE.md` wins.

---

## Users

The artifacts processed by SendaStack are **internal dashboards and work tools** used by
Senda employees — operations, finance, HR, fleet management, logistics, treasury — and
by stakeholders of the three brand variants (Grupo Senda / Federal / Corporativo and
Senda Citi). These are **NOT** landing pages, marketing sites, product pages, or any
kind of public-facing acquisition surface.

Typical users are:

- Financial analysts reading JDE (F0911 General Ledger) transactions and Cognos reports.
- Operations supervisors monitoring fleet, routes, and KPIs throughout a shift.
- HR staff managing payroll records (F07001) and employee movements.
- Asset managers tracking fixed assets and depreciation (F1201).
- Treasury and controllership running reconciliations and closing the month.
- PMs and leadership consuming executive dashboards for decision support.

They use these tools **repeatedly throughout the workday**, often for hours at a time,
on desktop monitors inside corporate offices and warehouses, occasionally on tablets on
the operations floor. They care about data density, legibility, keyboard efficiency,
and not having their eyes fatigued by noise.

## Use Cases

- Read dense data tables with filters, sorts, pagination, and exports.
- Scan KPI dashboards to spot anomalies at a glance.
- Navigate forms with many fields (financial entries, asset records, HR movements).
- Compare periods, segments, cost centers, subsidiaries.
- Drill down from summary KPIs into detail records.
- Trigger workflows (approvals, closures, exports, imports).

**Explicit non-goals** of every SendaStack artifact:

- No hero sections, no marketing copy, no "above-the-fold" layout logic.
- No public call-to-action ("Sign up", "Get started", "Learn more"). The user is
  already authenticated and inside the tool.
- No landing page conventions — no 3-column feature grids, no testimonials, no
  pricing tables, no screenshots of itself.
- No storytelling animations, parallax, scroll-driven reveals, hero videos.
- No moodboards, no brand showcases, no visual flexing. The tool exists to help
  someone finish a job, not to impress.

## Brand Personality

Three words for every SendaStack artifact:

1. **Calm** — the interface does not compete for attention with the data inside it.
2. **Utilitarian** — every pixel earns its place by making a job easier.
3. **Trustworthy** — this tool handles money, payroll, assets, and operations; it
   must feel correct, stable, and institutional at first glance.

Emotional targets: **confidence**, **focus**, **unobtrusive competence**.
Emotions to avoid: excitement, playfulness, surprise, wow, delight, nostalgia, irony.

## Aesthetic Direction

**Visual tone:** refined institutional / industrial-utilitarian. Think:

- An enterprise banking back-office console, not a fintech landing page.
- A Bloomberg Terminal minus the density extremes, plus Senda's warmth.
- An airline operations control screen, not a consumer travel booking flow.
- A hospital admin back-end, not a patient-facing app.
- Stripe Dashboard's restraint, but with Senda's corporate identity.

**Theme:** light mode only. Always. No dark mode, no system preference, no toggle.
This is a hard override of the Impeccable `theme_selection` heuristic — the viewing
context (corporate office, fluorescent lighting, 9 hours a day, paper documents on the
desk) demands light mode, and the brand manual mandates it.

**Anti-references** (the interface must NOT look like any of these):

- Vercel / Next.js landing pages (purple gradients, glassmorphism, neon).
- Stripe marketing pages (gradient mesh, hero animations).
- Linear marketing pages (dark mode glow, animated hero).
- Any "AI product" launch page (Syne font, gradient text, auto-type writer).
- Crypto / DeFi dashboards (neon on black, gradient buttons).
- Generic SaaS admin templates (Material Design, Bootstrap defaults, Ant Design).
- shadcn defaults unchanged (`zinc` neutrals, `slate` blues, pure black cards).

## Design Principles

1. **Data is the protagonist.** Every design decision asks: does this help the user
   read the data faster? If no, cut it. Decorative elements steal attention from
   the numbers, labels, and statuses the user is actually there to read.

2. **Calm beats bold.** When in doubt, choose the quieter option. Senda artifacts
   are used 8 hours a day — intensity fatigues. Use weight, size, and whitespace
   for hierarchy before reaching for color or motion.

3. **Brand color is the canvas, accents are sparse.** Senda uses the **immersive
   model with white cards**: the page background is the saturated brand color of
   the artifact's skin (`federal` burgundy `#961939`, `citi` red `#EC0928`,
   `del-norte` blue `#0072CE`, `corporativo` navy `#1e293b`), and all data lives
   inside white cards floating on top. The accent (`var(--accent)`) appears only
   on active states, primary CTAs, and data highlights inside cards. Never as a
   gradient, never as a text fill, never as a decorative background stripe.
   **Exception:** the `citi` skin inverts the model because its brandbook is
   literally "white with red" — there the canvas is white and the brand red
   shows up only in sidebar/header, primary buttons, focus rings and accents.

4. **Consistency over cleverness.** Every table in every artifact should feel like
   the same table. Every form, the same form. Every modal, the same modal. The
   user is navigating a system, not discovering novelty. Reuse shadcn + Senda
   tokens aggressively; invent new patterns only when nothing else fits.

5. **Keyboard and density first.** The primary input device is the keyboard. Tab
   order, focus rings, shortcuts, and form-field density matter more than hover
   polish. Touch targets apply only on tablet-grade artifacts, not desktop tools.

---

## Senda DS Overrides of Impeccable Defaults

These are explicit, non-negotiable overrides of what the `/impeccable` skill would
otherwise recommend. When any Impeccable skill is invoked inside a SendaStack artifact,
these rules win every conflict.

| Impeccable default                                    | Senda override                                     | Reason                                                   |
| ----------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Reject Roboto / Inter / system fonts                  | **Roboto is the only font, cross-skin.** No display pairings. | `UI.md` §4. Non-negotiable.                    |
| Pair a distinctive display font with a refined body   | **Single family, Roboto, weights 400/500/700.**    | `UI.md` §4.                                              |
| Use OKLCH for colors                                  | **Use the CSS variable tokens from `UI.md` §3.**   | Each skin declares its own tokens; Tailwind reads them.  |
| Tint neutrals toward brand hue                        | **Neutrals inside cards are identical in all 4 skins** (`UI.md` §3.1). | Cards are always white; neutrals inside are shared.     |
| Derive theme from viewing context                     | **Single theme per skin. No dark mode runtime.**   | `UI.md` §7 replaces the old "light-only" rule with "one skin per artifact, one theme per skin". |
| Single brand color per product                        | **Four skins** (`federal`, `citi`, `del-norte`, `corporativo`). **Each artifact declares one** on `<html data-skin="...">`. | `UI.md` §1.1. |
| Commit to a BOLD aesthetic direction                  | **Commit to a CALM, utilitarian direction.**       | Dashboards, not landing pages.                           |
| Asymmetric layouts, break the grid for emphasis       | **Align to a strict 4-pt grid. Symmetry wins.**    | Data density and scannability.                           |
| Use modals "only when necessary" (they are lazy)      | **Modals are acceptable for destructive actions.** | Confirming deletions, approvals, exports is correct UX. |
| Use `clamp()` fluid type on headings                  | **Fixed rem scale on app UI.**                     | Dashboards; matches `UI.md` §4.                          |
| Vary font weights aggressively                        | **400 / 500 / 700 only. No 100, 300, 800, 900.**   | Roboto hinting and `UI.md` §4.                           |
| Add moments of joy, unexpected touches, personality   | **Suppress delight. Interface should disappear.**  | Work tools. See principle 2.                             |
| Maximalism is a valid direction                       | **Maximalism is forbidden.**                       | Work tools. See principle 2.                             |
| Rounded avatar / chip radius is fine above 12px       | **shadcn `--radius: 0.625rem` scale only.**        | `UI.md` §3.1.                                            |
| Glassmorphism discouraged but allowed purposefully    | **Glassmorphism forbidden entirely.**              | `UI.md` §7: cards are always white solid.                |
| Side-stripe borders forbidden (Impeccable BAN 1)      | **Same ban. Reinforced.**                          | Aligns with Senda's "no decorative accents" rule.        |
| Gradient text forbidden (Impeccable BAN 2)            | **Same ban. Reinforced. Plus all CSS gradients.**  | `UI.md` §7 forbids all gradients, not just text.         |
| Use Lucide OR Heroicons OR Phosphor OR any well-picked lib | **Lucide only, `strokeWidth={1.5}` always.**  | `UI.md` §5.                                              |
| Motion: exponential easing, one high-impact moment    | **Motion follows `emil-design-eng` skill.**        | Senda's motion authority is Emil Kowalski, not Impeccable. |

---

## Skill Application Policy for Dashboards and Work Tools

Not every Impeccable skill is equally useful for a dashboard. The `ui-agent` decides
which skills to invoke based on this policy:

### Core skills — apply thoroughly on every artifact

- `/impeccable` (as context anchor; this file satisfies its context gathering)
- `/shape` (for any new feature — plan UX before code)
- `/arrange` (layout, spacing, visual rhythm — dashboards need this badly)
- `/typeset` (typography hierarchy within Roboto's 3 weights)
- `/distill` (remove clutter — dashboards accumulate junk)
- `/quieter` (when anything feels too loud for an 8-hour tool)
- `/clarify` (UX copy, labels, errors — critical for JDE/Cognos data)
- `/normalize` (enforce consistency across components)
- `/harden` (edge cases, empty states, i18n, text overflow — production-grade)
- `/adapt` (responsive for desktop + tablet; no phone landing behavior)
- `/optimize` (performance, especially for large tables and charts)
- `/audit` (technical quality pass before QA gate)
- `/critique` (UX review before QA gate)
- `/polish` (final pass before closing the `ui.done` gate)
- `/extract` (consolidate repeated patterns into shadcn primitives)

### Situational skills — apply only when the artifact genuinely needs it

- `/onboard` — only for artifacts with meaningful empty states, first-run flows,
  or "no data yet" dashboard states. Never for marketing-style onboarding tours.
- `/animate` — **defer to the `emil-design-eng` skill**. Do not run `/animate`
  directly; its aesthetic goals conflict with Senda's calm-tool direction. Use
  `emil-design-eng` for any motion decision.

### Forbidden skills — do not invoke on SendaStack artifacts

- `/bolder` — dashboards must not be bold. If the artifact feels "too safe," that
  is correct. If the artifact feels genuinely broken or unreadable, use `/arrange`
  and `/typeset` to fix hierarchy, not `/bolder` to add noise.
- `/delight` — work tools must not delight. Delight means personality, surprise,
  moments of joy — every one of those is the opposite of "the interface disappears."
- `/overdrive` — shaders, spring physics, scroll reveals, 60fps show-off animations.
  None of this belongs in a JDE-backed back-office tool. Forbidden without
  exception.
- `/colorize` — dashboards use the brand primary sparingly and never decoratively.
  Adding color to "make it more engaging" is exactly what breaks a calm tool.
  The only valid way to add color is through functional data encoding (status
  badges, chart series from the DS palette), which is handled inside `/arrange`
  and `/typeset` reviews, not `/colorize`.

---

## Skin Selection (4 official skins)

Every SendaStack artifact declares exactly one skin on `<html data-skin="...">`. The
`ui-agent` determines which by reading `PURPOSE.md` (see `UI.md §1.1`), and the brand
color, logo file, and alt text follow from that selection:

| Skin          | Use case                                        | Brand color | Background model               | Logo file                  | Alt text             |
| ------------- | ----------------------------------------------- | ----------- | ------------------------------ | -------------------------- | -------------------- |
| `federal`     | Grupo Senda matriz                              | `#961939`   | Immersive (brand canvas)       | `senda-corporativo.svg`    | `Senda`              |
| `citi`        | Senda Citi (card, loyalty, Citi programs)       | `#EC0928`   | White canvas + red accents     | `senda-citi.svg`           | `Senda Citi`         |
| `del-norte`   | Del Norte subsidiary                            | `#0072CE`   | Immersive (brand canvas)       | `senda-del-norte.svg` *    | `Senda Del Norte`    |
| `corporativo` | Cross-company, consolidated, neutral            | `#1e293b`   | Immersive (brand canvas)       | `senda-corporativo.svg`    | `Senda`              |

*`senda-del-norte.svg` is pending delivery from the brand team. While pending, the
`ui-agent` uses `senda-corporativo.svg` as a placeholder and records a blocker in the
artifact's `UI.md` without blocking `ui.done`.

All other tokens — neutrals inside cards, spacing scale, radius, typography,
destructive colors — are **identical across all four skins**. Cards are always white
(`--card: #ffffff`) regardless of skin. The only shape-level difference between skins
is:
- The color of the page background (brand color for `federal`/`del-norte`/`corporativo`,
  white for `citi`).
- The 5 chart colors (`--chart-1` through `--chart-5`).
- The shadow intensity on cards (strong for the immersive skins, subtle for `citi`).

---

## How Skills Should Read This File

Every Impeccable skill begins with a Context Gathering Protocol that looks for existing
design context. When a skill is invoked inside a SendaStack artifact:

1. This file (`.impeccable.md` at the project root) **is** the Design Context. Skills
   must read it and proceed immediately — do not run `/impeccable teach`.
2. `UI.md` at the root of the SendaStack repo is the **canonical DS spec** (v2, 4
   skins, tokens, immersive model). Skills should consult it for exact token values,
   per-skin CSS, spacing scale, component rules, and logo usage. If anything in this
   `.impeccable.md` contradicts `UI.md`, **`UI.md` wins**.
3. `CLAUDE.md` §3 is the **operational summary** of the DS for agents that do not
   want to load `UI.md` in full; it points back to `UI.md` for anything detailed.
4. The `ui-agent` command (`.claude/commands/ui-agent.md`) orchestrates the order in
   which skills are applied and enforces the Senda-specific transformations that
   precede and follow the Impeccable pass.

If a skill's recommendations conflict with this file or with `CLAUDE.md`, the Senda
documents win. Skills operate as refinement layers on top of the brand system; they
never override it.
