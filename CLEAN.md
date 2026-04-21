# CLEAN REPORT
Generated: 2026-04-21T03:52:02Z
Artifact: flujo-senda

## Summary
- Files modified: 5
- Files deleted: 3
- Total lines removed: 762
- Total reduction: 2.76% of audited `src` lines
- Items by category:
  - Dead code: 2 items
  - Out of purpose: 2 items
  - Non-Lucide icon libs: 0 items
  - Duplicate code: 0 items
  - Prohibited DS patterns: 1 item
  - Production diagnostic residue: 5 items

## Removals Log

### Dead code

| FILE | LINES BEFORE | LINES AFTER | REDUCTION | ITEM REMOVED | REASON |
|------|-------------|-------------|-----------|--------------|--------|
| `src/App.tsx` | 1363 | 1337 | -26 (-1.9%) | Disabled `NetCashFlowDashboard` commented import | Commented-out module wiring was not active and added confusion. |
| `src/components/NetCashFlowDashboard.tsx` | 578 | 0 | -578 (-100%) | `NetCashFlowDashboard` component | Verified no active imports; component was disabled and unused. |

### Out of purpose

| FILE | LINES BEFORE | LINES AFTER | REDUCTION | ITEM REMOVED | REASON |
|------|-------------|-------------|-----------|--------------|--------|
| `src/App.tsx` | 1363 | 1337 | included above | Dark-mode button, state, and imports | Runtime theme switching does not support the cash-flow evaluation purpose and conflicts with Atlas/Senda DS direction. |
| `src/hooks/useDarkMode.ts` | 45 | 0 | -45 (-100%) | Dark-mode hook | SendaStack uses one skin per artifact, not runtime dark mode. |

### Prohibited DS patterns

| FILE | LINES BEFORE | LINES AFTER | REDUCTION | ITEM REMOVED | REASON |
|------|-------------|-------------|-----------|--------------|--------|
| `src/styles/dark.css` | 68 | 0 | -68 (-100%) | `.dark` theme variables and dark glass styling | Runtime dark mode and glassmorphism are prohibited by the Senda Design System. |

### Production diagnostic residue

| FILE | LINES BEFORE | LINES AFTER | REDUCTION | ITEM REMOVED | REASON |
|------|-------------|-------------|-----------|--------------|--------|
| `src/App.tsx` | 1363 | 1337 | included above | Bank refresh console diagnostics | Background data refresh should fail gracefully without production console noise. |
| `src/services/jde.ts` | 590 | 552 | -38 (-6.4%) | JDE range diagnostic console output | Diagnostic logging was development-only residue; API failures are handled via empty day results and caller states. |
| `src/components/ErrorBoundary.tsx` | 42 | 38 | -4 (-9.5%) | Error boundary console logging | User-visible fallback remains; production console output removed. |
| `src/components/ActivityFeed.tsx` | 524 | 524 | 0 (comment replacement) | Activity-feed storage console logging | Activity history is non-critical; storage quota failures are silently ignored. |
| `src/domain/persistence.ts` | 705 | 702 | -3 (-0.4%) | Persistence validation console warnings/errors | Recovery paths still return safe defaults or throw user-facing errors without console output. |

## Files Not Modified
- `src/utils/calculations.ts` — examined but not removed. It is marked deprecated, but it is still imported by active forecast and simulator screens.
- `src/domain/importClients.ts` — Excel parser remains for `api-agent`; removing it here would be a data migration, not cleanup.
- `src/domain/importProviders.ts` — Excel parser remains for `api-agent`; removing it here would be a data migration, not cleanup.
- `src/utils/excelParser.ts` — active upload parser remains for `api-agent`.
- `src/components/Providers.tsx` — active provider import flow remains for `api-agent`.
- `src/components/Upload.tsx` — active plan import flow remains for `api-agent`.

## Found but Not Removed
| FILE | ITEM | WHY KEPT |
|------|------|----------|
| `src/utils/calculations.ts` | Deprecated formatter re-export | Still used by `Forecast` and `Simulator`; deleting it would break active screens. |
| Multiple chart components | `any` types in Recharts callbacks | Typing them safely requires component-level chart work; left for subsequent quality/UI passes. |
| Gradient classes and inline gradients | Visual DS violations | Left for `ui-agent`, which replaces visual styling with Senda tokens rather than simply removing backgrounds. |

## Verification
- Production console scan: no `console.log`, `console.warn`, `console.error`, or `console.info` remains in `src`.
- Dark-mode scan: no `darkMode`, `useDarkMode`, `prefers-color-scheme`, `dark:`, or `.dark` stylesheet remains.
- Build: `npm run build` passed after cleanup.

## Notes for Downstream Agents
### → api-agent
Active Excel and CSV import paths remain and must be replaced with service-backed flows or safe Atlas-compatible stubs.

### → ui-agent
Dark mode is removed. Gradients, Roboto, Senda skin, official logo, token cleanup, and icon stroke normalization remain for the UI pass.
