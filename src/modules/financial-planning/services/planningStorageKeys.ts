/**
 * Single source of truth for the financial-planning localStorage keys.
 *
 * Lives in its own leaf module (no imports) so both the per-concept storage
 * helpers (financialPlanningStorage / cellOverridesStorage / …) and the
 * server-sync layer (planningRemoteSync) can share the key↔docKey mapping
 * without an import cycle.
 */

export type PlanningDocKey =
  | 'scenarios'
  | 'adjustments'
  | 'manualEntries'
  | 'customRows'
  | 'cellOverrides'
  | 'changeLog';

export const PLANNING_SCENARIOS_KEY = 'midas.financialPlanning.scenarios.v1';
export const PLANNING_ADJUSTMENTS_KEY = 'midas.financialPlanning.adjustments.v1';
export const PLANNING_MANUAL_ENTRIES_KEY = 'midas.financialPlanning.manualEntries.v1';
export const PLANNING_CUSTOM_ROWS_KEY = 'midas.financialPlanning.customRows.v1';
export const PLANNING_CELL_OVERRIDES_KEY = 'midas.financialPlanning.cellOverrides.v1';
export const PLANNING_CHANGE_LOG_KEY = 'midas.financialPlanning.changeLog.v1';

/** docKey (the shared-store document name) → localStorage key (the local mirror). */
export const PLANNING_LOCAL_KEY: Record<PlanningDocKey, string> = {
  scenarios: PLANNING_SCENARIOS_KEY,
  adjustments: PLANNING_ADJUSTMENTS_KEY,
  manualEntries: PLANNING_MANUAL_ENTRIES_KEY,
  customRows: PLANNING_CUSTOM_ROWS_KEY,
  cellOverrides: PLANNING_CELL_OVERRIDES_KEY,
  changeLog: PLANNING_CHANGE_LOG_KEY,
};

export const PLANNING_DOC_KEYS = Object.keys(PLANNING_LOCAL_KEY) as PlanningDocKey[];
