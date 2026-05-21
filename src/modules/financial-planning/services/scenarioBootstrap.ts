import type {
  CellOverride,
  FinancialAdjustment,
  FinancialScenario,
  ManualPlanningEntry,
  PlanningCustomRow,
  ScenarioChangeLogEntry,
} from '../../shared-finance/types';
import { LEGACY_SCENARIO_KINDS } from '../../shared-finance/types';

export const BASE_SCENARIO_ID = 'base';
export const APPROVED_SCENARIO_ID = 'approved';

export interface BootstrapInput {
  storedScenarios: FinancialScenario[];
  storedAdjustments: FinancialAdjustment[];
  manualEntries: ManualPlanningEntry[];
  customRows: PlanningCustomRow[];
  cellOverrides: CellOverride[];
  changeLog: ScenarioChangeLogEntry[];
  sourceBaseScenario: FinancialScenario;
  user?: string;
}

export interface BootstrapResult {
  scenarios: FinancialScenario[];
  adjustments: FinancialAdjustment[];
  manualEntries: ManualPlanningEntry[];
  customRows: PlanningCustomRow[];
  cellOverrides: CellOverride[];
  changeLog: ScenarioChangeLogEntry[];
  changed: boolean;
}

export function ensureCoreScenarios(input: BootstrapInput): BootstrapResult {
  const now = new Date().toISOString();
  let changed = false;

  const legacyKindSet = new Set<string>(LEGACY_SCENARIO_KINDS);
  const legacyScenarios = input.storedScenarios.filter((scenario) => legacyKindSet.has(scenario.kind as string));
  const legacyIds = new Set(legacyScenarios.map((scenario) => scenario.id));

  if (legacyScenarios.length > 0) changed = true;

  let survivingScenarios = input.storedScenarios.filter((scenario) => !legacyIds.has(scenario.id));

  // Cleanup dependent records.
  let adjustments = input.storedAdjustments.filter((adjustment) => !adjustment.scenarioIds.some((id) => legacyIds.has(id)));
  let manualEntries = input.manualEntries.filter((entry) => !entry.scenarioIds.some((id) => legacyIds.has(id)));
  let customRows = input.customRows.filter((row) => !legacyIds.has(row.scenarioId));
  let cellOverrides = input.cellOverrides.filter((override) => !legacyIds.has(override.scenarioId));
  let changeLog = input.changeLog.filter((entry) => !legacyIds.has(entry.scenarioId));

  if (
    adjustments.length !== input.storedAdjustments.length
    || manualEntries.length !== input.manualEntries.length
    || customRows.length !== input.customRows.length
    || cellOverrides.length !== input.cellOverrides.length
    || changeLog.length !== input.changeLog.length
  ) {
    changed = true;
  }

  // Ensure Base.
  const existingBase = survivingScenarios.find((scenario) => scenario.kind === 'BASE' && !scenario.archivedAt);
  let baseScenario: FinancialScenario;
  if (existingBase) {
    baseScenario = existingBase;
  } else {
    baseScenario = {
      ...input.sourceBaseScenario,
      id: BASE_SCENARIO_ID,
      kind: 'BASE',
      isBase: true,
      status: 'APPROVED',
      adjustmentIds: [],
      name: 'Escenario Base',
      description: 'Proyección original. No editable.',
      createdAt: input.sourceBaseScenario.createdAt ?? now,
      updatedAt: now,
    };
    survivingScenarios = [baseScenario, ...survivingScenarios];
    changed = true;
  }

  // Ensure Approved.
  const approvedCandidates = survivingScenarios.filter(
    (scenario) => scenario.kind === 'APPROVED' && !scenario.archivedAt,
  );

  let approvedScenario: FinancialScenario;
  if (approvedCandidates.length === 0) {
    approvedScenario = {
      ...baseScenario,
      id: APPROVED_SCENARIO_ID,
      kind: 'APPROVED',
      isBase: false,
      status: 'APPROVED',
      name: 'Escenario Aprobado',
      description: 'Plan vivo de operación. Cambia al aplicar propuestas.',
      adjustmentIds: [],
      parentScenarioId: undefined,
      promotedFromScenarioId: undefined,
      promotedAt: undefined,
      archivedAt: undefined,
      createdAt: now,
      updatedAt: now,
    };
    survivingScenarios = [...survivingScenarios, approvedScenario];
    changed = true;
  } else if (approvedCandidates.length === 1) {
    approvedScenario = approvedCandidates[0];
  } else {
    // Defensive: `isScenario` only checks `id`, so a malformed persisted
    // scenario can land here without `updatedAt`. localeCompare on undefined
    // throws; coalesce to '' so corrupted records sort to the bottom instead
    // of breaking the bootstrap.
    const sorted = [...approvedCandidates].sort(
      (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    );
    approvedScenario = sorted[0];
    const archivedAt = now;
    survivingScenarios = survivingScenarios.map((scenario) => {
      if (scenario.kind !== 'APPROVED' || scenario.id === approvedScenario.id) return scenario;
      return { ...scenario, archivedAt };
    });
    changed = true;
  }

  // Normalize remaining scenarios as DRAFT pointing at Approved.
  const finalScenarios = survivingScenarios.map((scenario) => {
    if (scenario.id === baseScenario.id) return scenario;
    if (scenario.id === approvedScenario.id) return scenario;
    if (scenario.archivedAt) return scenario;
    if (scenario.kind === 'DRAFT' && scenario.parentScenarioId === approvedScenario.id) return scenario;
    return {
      ...scenario,
      kind: 'DRAFT' as const,
      parentScenarioId: approvedScenario.id,
      updatedAt: now,
    };
  });

  if (finalScenarios.some((scenario, index) => scenario !== survivingScenarios[index])) {
    changed = true;
  }

  return {
    scenarios: finalScenarios,
    adjustments,
    manualEntries,
    customRows,
    cellOverrides,
    changeLog,
    changed,
  };
}
