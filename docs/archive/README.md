# docs/archive — historical snapshots

These files are **frozen historical artifacts**, kept for provenance only. They do **not** describe the current state of Midas. For the current state read, at the repo root:

- `CLAUDE.md` — code map, data flow, engines, invariants (source of truth)
- `README.md` — deploy / env / business surface
- `DOCS.md` — index of every doc in the repo

## What's here

| File | Date | What it was | Why archived |
|------|------|-------------|--------------|
| `COBRANZA-HANDOFF.md` | 2026-05-03 | Handoff for the JDE cobranza + bank-cross integration | The P0/P1 bugs it lists (crashes, 0% cross) were resolved (workers, IndexedDB, perf hardening, AuxiliarContable reconciliation). |
| `2026-05-05-impeccable-handoff.md` | 2026-05-05 | Visual/DS audit + Codex execution plan (Impeccable tooling) | Point-in-time plan; several findings no longer apply (e.g. dark mode was reintroduced). Was previously at the repo root under a broken filename (`"  .md"`). |
| `2026-05-11-audit.md` | 2026-05-11 | Read-only multi-lens audit | Predates later work (e.g. `exceljs` removed). |
| `UI-PROPOSALS.md` | 2026-04-20 | UI improvement proposals | Most proposals are now implemented (Command Palette, Toasts, Keyboard shortcuts, Activity feed, Dark mode, …). |

## What was deleted (not archived)

The auto-generated SendaStack pipeline reports (`API.md`, `AUDIT.md`, `CLEAN.md`, `CONVERT.md`, `UI.md`, `QA.md`, all stamped `Generated: 2026-04-21`) were **removed** rather than archived: they are reproducible machine output and contained assumptions that contradict the current codebase (a defunct deployment target, a Cognos migration that never shipped to the frontend, dark mode "removed" when it is supported, Excel parsing "present" when it was removed). They remain in git history if ever needed.
