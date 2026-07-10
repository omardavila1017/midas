# AGENTS.md

**`CLAUDE.md` is the single source of truth for this repo.** Read it before changing anything — it has the full code map, data flow, engine descriptions, invariants, and the "rules that bite." This file used to be a second copy of that content; it is now a pointer so the two never drift apart (doc drift is a real, recurring problem here).

> Agents and new devs: start with `CLAUDE.md`. Then `DOCS.md` (index of every doc), then `README.md` (deploy/env). End users read `MANUAL.md`.

## The non-negotiables (full detail in `CLAUDE.md`)

- **Base scenario invariant.** The `id === 'base'` scenario has no propuestas, no manual entries, no cell overrides, no tax injection, **no future** (drops movements after today), and shows **real short-term API data only** (`isRealShortTermApiMovement`). Don't move that filter into `canonicalProjection.ts`. Validate this whenever you touch scenario selection, persistence, or the spreadsheet.
- **Two engines.** MOTOR 1 (`historicalReconciledEngine.ts`, ≤ today) + MOTOR 2 (`shortTermProjectionEngine.ts`, > today), orchestrated by `buildMovements` in `canonicalProjection.ts` (the public entry point). Don't re-balance to synthetic totals; long-term projection was removed.
- **UI ↔ code terminology is inverted** in financial-planning: UI *Simulación / Escenario / Propuesta* = code *parent / `FinancialScenario` / `FinancialAdjustment`*. Check both vocabularies before renaming.
- **Persistence is defensive.** `localStorage` may hold partial/legacy payloads — always go through the normalizer (`persistence.ts`, store `midas-v12`). Register any new storage key in `storageRegistry.ts`.
- **Heavy compute goes in `src/workers/`.** Don't grow `useEffect` recompute loops. The perf hardening (grid virtualization, scenario worker, granularity-bounded windows, cache-first boot, runtime guardian) is load-bearing — re-read the Performance section before touching those files.
- **Company exclusion is empty** (nothing excluded; mechanism preserved). See `EXCLUSION_RULES.md`.
- **Frontend RBAC is UX only, not a security boundary.** See `AUTH.md`.
- **Deployment is platform-agnostic** (static SPA + `api/*` serverless functions). Don't bake a specific hosting platform into code or docs.
- **Spanish UI, English code.** User-facing copy es-MX; identifiers/comments/commits in English. Don't translate type names.
- **Eficiencia de tokens (hard rules).** Model routing (Sonnet default / Fable advisor-only / Haiku for mechanical), context isolation via read-only subagents, caveman response style, code minimalism (reuse before writing), and the "never cut for efficiency" safety carve-outs (money/auth/schema/API shapes). Full detail at the top of `CLAUDE.md` → "Eficiencia de tokens (hard rules)".

## Before you ship

`npm install` first (no `node_modules` is committed). Then `npm run typecheck` (clean), `npm test` (866 passed / 12 skipped baseline), `npm run build` (passes, with the expected ~845 kB main-chunk warning). Keep them green and update `CLAUDE.md` in the same PR if you change the architecture.
