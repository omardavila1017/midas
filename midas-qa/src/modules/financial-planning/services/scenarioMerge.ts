import type {
  AuditEvent,
  CellOverride,
  FinancialAdjustment,
  FinancialScenario,
  ManualPlanningEntry,
  PlanningCustomRow,
  ProjectionGranularity,
  ScenarioChangeLogEntry,
} from '../../shared-finance/types';
import { createAuditEvent } from '../../shared-finance/audit/audit';
import { describeMergeToApproved, newChangeLogEntry } from './changeLogTemplates';

export type MergeDiffKind = 'CELL_OVERRIDE' | 'CUSTOM_ROW' | 'MOVEMENT_ADJUSTMENT' | 'MANUAL_ENTRY';

export interface MergeDiffEntry {
  id: string;
  kind: MergeDiffKind;
  scenarioId: string;
  label: string;
  impactLabel: string;
  conflict: boolean;
  selectedByDefault: boolean;
  conceptKey?: string;
  bucketKey?: string;
  granularity?: ProjectionGranularity;
  rowLabel?: string;
  bucketLabel?: string;
  approvedValue?: number;
  draftValue?: number;
  delta?: number;
  approvedHasOverride?: boolean;
  draftHasOverride?: boolean;
  type?: CellOverride['type'];
}

export interface BuildMergeDiffArgs {
  approved: FinancialScenario;
  draft: FinancialScenario;
  approvedOverrides: CellOverride[];
  draftOverrides: CellOverride[];
  approvedCustomRows: PlanningCustomRow[];
  draftCustomRows: PlanningCustomRow[];
  approvedAdjustments?: FinancialAdjustment[];
  draftAdjustments?: FinancialAdjustment[];
  manualEntries?: ManualPlanningEntry[];
  rowLabelLookup: (conceptKey: string) => string;
  bucketLabelLookup: (bucketKey: string, granularity: ProjectionGranularity) => string;
  approvedAggregateLookup: (conceptKey: string, bucketKey: string, granularity: ProjectionGranularity) => number;
}

export function buildMergeDiff(args: BuildMergeDiffArgs): MergeDiffEntry[] {
  const draftKeys = args.draftOverrides.filter((override) => override.scenarioId === args.draft.id);
  const approvedByKey = new Map<string, CellOverride>();
  for (const override of args.approvedOverrides) {
    if (override.scenarioId !== args.approved.id) continue;
    approvedByKey.set(`${override.conceptKey}::${override.granularity}::${override.bucketKey}`, override);
  }

  const entries: MergeDiffEntry[] = [];
  for (const override of draftKeys) {
    const key = `${override.conceptKey}::${override.granularity}::${override.bucketKey}`;
    const approvedOverride = approvedByKey.get(key);
    const approvedAggregate = args.approvedAggregateLookup(override.conceptKey, override.bucketKey, override.granularity);
    const approvedValue = approvedOverride ? approvedOverride.value : approvedAggregate;
    if (approvedValue === override.value) continue;
    entries.push({
      id: cellChangeId(override.conceptKey, override.bucketKey, override.granularity),
      kind: 'CELL_OVERRIDE',
      scenarioId: args.draft.id,
      label: args.rowLabelLookup(override.conceptKey),
      impactLabel: `${args.bucketLabelLookup(override.bucketKey, override.granularity)} · ${formatAmount(approvedValue)} → ${formatAmount(override.value)}`,
      selectedByDefault: true,
      conceptKey: override.conceptKey,
      bucketKey: override.bucketKey,
      granularity: override.granularity,
      type: override.type,
      rowLabel: args.rowLabelLookup(override.conceptKey),
      bucketLabel: args.bucketLabelLookup(override.bucketKey, override.granularity),
      approvedValue,
      draftValue: override.value,
      delta: override.value - approvedValue,
      approvedHasOverride: Boolean(approvedOverride),
      draftHasOverride: true,
      conflict: Boolean(approvedOverride) && approvedOverride!.value !== override.value,
    });
  }

  const approvedCustomKeys = new Set(args.approvedCustomRows.map((row) => row.conceptKey));
  for (const row of args.draftCustomRows) {
    const alreadyExists = approvedCustomKeys.has(row.conceptKey);
    entries.push({
      id: customRowChangeId(row.id),
      kind: 'CUSTOM_ROW',
      scenarioId: args.draft.id,
      label: row.label,
      impactLabel: `${row.type === 'INFLOW' ? 'Ingreso' : 'Egreso'} · fila nueva`,
      conflict: alreadyExists,
      selectedByDefault: !alreadyExists,
      conceptKey: row.conceptKey,
      type: row.type,
    });
  }

  const approvedAdjustmentKeys = new Set(
    (args.approvedAdjustments ?? [])
      .filter((adjustment) => adjustment.scenarioIds.includes(args.approved.id) && adjustment.status !== 'REJECTED')
      .map(adjustmentKey),
  );
  for (const adjustment of args.draftAdjustments ?? []) {
    if (!adjustment.scenarioIds.includes(args.draft.id) || adjustment.status === 'REJECTED') continue;
    const conflict = approvedAdjustmentKeys.has(adjustmentKey(adjustment));
    entries.push({
      id: adjustmentChangeId(adjustment.id),
      kind: 'MOVEMENT_ADJUSTMENT',
      scenarioId: args.draft.id,
      label: adjustment.name,
      impactLabel: adjustmentImpactLabel(adjustment),
      conflict,
      selectedByDefault: true,
    });
  }

  const approvedManualKeys = new Set(
    (args.manualEntries ?? [])
      .filter((entry) => entry.scenarioIds.includes(args.approved.id) && !entry.replacedAt)
      .map(manualEntryKey),
  );
  for (const entry of args.manualEntries ?? []) {
    if (!entry.scenarioIds.includes(args.draft.id) || entry.scenarioIds.includes(args.approved.id) || entry.replacedAt) continue;
    const conflict = approvedManualKeys.has(manualEntryKey(entry));
    entries.push({
      id: manualEntryChangeId(entry.id),
      kind: 'MANUAL_ENTRY',
      scenarioId: args.draft.id,
      label: entry.name,
      impactLabel: `${entry.type === 'INFLOW' ? 'Ingreso' : 'Egreso'} manual · ${formatAmount(entry.amount)} · ${entry.startDate}`,
      conflict,
      selectedByDefault: true,
    });
  }

  return entries;
}

export interface SelectedMergeChange {
  kind: MergeDiffKind;
  id: string;
}

export interface ApplyMergeArgs {
  approved: FinancialScenario;
  draft: FinancialScenario;
  scenarios: FinancialScenario[];
  approvedOverrides: CellOverride[];
  draftOverrides: CellOverride[];
  allOverrides: CellOverride[];
  approvedAdjustments: FinancialAdjustment[];
  draftAdjustments: FinancialAdjustment[];
  allAdjustments: FinancialAdjustment[];
  approvedCustomRows: PlanningCustomRow[];
  draftCustomRows: PlanningCustomRow[];
  allCustomRows: PlanningCustomRow[];
  manualEntries: ManualPlanningEntry[];
  changeLog: ScenarioChangeLogEntry[];
  selectedChanges: SelectedMergeChange[];
  archiveDraft: boolean;
  user?: string;
}

export interface ApplyMergeResult {
  scenarios: FinancialScenario[];
  cellOverrides: CellOverride[];
  adjustments: FinancialAdjustment[];
  customRows: PlanningCustomRow[];
  manualEntries: ManualPlanningEntry[];
  changeLog: ScenarioChangeLogEntry[];
  auditEvents: AuditEvent[];
}

export function applyMerge(args: ApplyMergeArgs): ApplyMergeResult {
  const user = args.user ?? 'tesoreria@senda.local';
  const now = new Date().toISOString();
  const selectedSet = new Set(args.selectedChanges.map((change) => `${change.kind}:${change.id}`));
  const selectedCellSet = new Set(
    args.selectedChanges
      .filter((change) => change.kind === 'CELL_OVERRIDE')
      .map((change) => change.id),
  );

  // Index existing approved overrides by key for collision replacement.
  const approvedByKey = new Map<string, CellOverride>();
  for (const override of args.approvedOverrides) {
    approvedByKey.set(`${override.conceptKey}::${override.granularity}::${override.bucketKey}`, override);
  }

  // Promote selected draft overrides into approved.
  const draftIdsToRemove = new Set<string>();
  const promotedOverrides: CellOverride[] = [];
  for (const draftOverride of args.draftOverrides) {
    const key = cellChangeId(draftOverride.conceptKey, draftOverride.bucketKey, draftOverride.granularity);
    if (!selectedCellSet.has(key)) continue;
    const approvedKey = `${draftOverride.conceptKey}::${draftOverride.granularity}::${draftOverride.bucketKey}`;
    const existing = approvedByKey.get(approvedKey);
    promotedOverrides.push({
      ...draftOverride,
      id: existing?.id ?? `co-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      scenarioId: args.approved.id,
      previousAggregatedValue: draftOverride.previousAggregatedValue,
      updatedAt: now,
    });
    if (existing) approvedByKey.delete(key);
    draftIdsToRemove.add(draftOverride.id);
  }

  // Promote draft custom rows referenced by promoted concepts.
  const promotedConceptKeys = new Set(promotedOverrides.map((o) => o.conceptKey));
  const promotedCustomRows: PlanningCustomRow[] = [];
  const draftCustomIdsToRemove = new Set<string>();
  for (const row of args.draftCustomRows) {
    const selected = selectedSet.has(`CUSTOM_ROW:${customRowChangeId(row.id)}`) || promotedConceptKeys.has(row.conceptKey);
    if (!selected) continue;
    const alreadyExists = args.approvedCustomRows.some((r) => r.conceptKey === row.conceptKey);
    if (!alreadyExists) {
      promotedCustomRows.push({
        ...row,
        scenarioId: args.approved.id,
        id: `${row.id}:approved:${Date.now()}`,
        updatedAt: now,
      });
    }
    draftCustomIdsToRemove.add(row.id);
  }

  // Build new collections.
  const remainingApprovedOverrides = args.approvedOverrides.filter((override) => {
    const key = `${override.conceptKey}::${override.granularity}::${override.bucketKey}`;
    // Keep approved overrides that were NOT replaced by a promoted draft override.
    return !promotedOverrides.some((promoted) =>
      promoted.scenarioId === args.approved.id
      && `${promoted.conceptKey}::${promoted.granularity}::${promoted.bucketKey}` === key
      && promoted.id !== override.id,
    );
  });

  const otherOverrides = args.allOverrides.filter((override) =>
    override.scenarioId !== args.approved.id
    && override.scenarioId !== args.draft.id,
  );

  const remainingDraftOverrides = args.draftOverrides.filter((override) => !draftIdsToRemove.has(override.id));

  const cellOverrides = [
    ...otherOverrides,
    ...remainingApprovedOverrides,
    ...remainingDraftOverrides,
    ...promotedOverrides,
  ];

  const otherCustomRows = args.allCustomRows.filter((row) =>
    row.scenarioId !== args.approved.id && row.scenarioId !== args.draft.id,
  );
  const remainingApprovedCustomRows = args.approvedCustomRows;
  const remainingDraftCustomRows = args.draftCustomRows.filter((row) => !draftCustomIdsToRemove.has(row.id));

  const customRows = [
    ...otherCustomRows,
    ...remainingApprovedCustomRows,
    ...remainingDraftCustomRows,
    ...promotedCustomRows,
  ];

  const approvedAdjustmentByKey = new Map(args.approvedAdjustments.map((adjustment) => [adjustmentKey(adjustment), adjustment]));
  const promotedAdjustmentIds = new Set<string>();
  const replacedApprovedAdjustmentIds = new Set<string>();
  const promotedAdjustments: FinancialAdjustment[] = [];
  for (const adjustment of args.draftAdjustments) {
    if (!selectedSet.has(`MOVEMENT_ADJUSTMENT:${adjustmentChangeId(adjustment.id)}`)) continue;
    const existing = approvedAdjustmentByKey.get(adjustmentKey(adjustment));
    if (existing) replacedApprovedAdjustmentIds.add(existing.id);
    promotedAdjustmentIds.add(adjustment.id);
    promotedAdjustments.push({
      ...adjustment,
      id: existing?.id ?? `${adjustment.id}:approved:${Date.now()}`,
      scenarioIds: [args.approved.id],
      status: 'APPROVED',
      approvedBy: user,
      approvedAt: now,
    });
  }

  const adjustments = [
    ...args.allAdjustments.filter((adjustment) =>
      !replacedApprovedAdjustmentIds.has(adjustment.id) &&
      !promotedAdjustmentIds.has(adjustment.id)
    ),
    ...promotedAdjustments,
  ];

  const promotedManualEntryIds = new Set<string>();
  const manualEntries = args.manualEntries.map((entry) => {
    if (!selectedSet.has(`MANUAL_ENTRY:${manualEntryChangeId(entry.id)}`)) return entry;
    promotedManualEntryIds.add(entry.id);
    const scenarioIds = new Set(entry.scenarioIds);
    scenarioIds.add(args.approved.id);
    if (args.archiveDraft) scenarioIds.delete(args.draft.id);
    return {
      ...entry,
      scenarioIds: Array.from(scenarioIds),
      status: 'APPROVED' as const,
      updatedAt: now,
    };
  });

  // Update scenarios: bump approved updatedAt, archive draft if requested.
  const scenarios = args.scenarios.map((scenario) => {
    if (scenario.id === args.approved.id) {
      return { ...scenario, updatedAt: now };
    }
    if (scenario.id === args.draft.id && args.archiveDraft) {
      return { ...scenario, archivedAt: now, updatedAt: now };
    }
    return scenario;
  });

  // Append the apply-to-approved changelog entry on the proposal.
  const mergeEntry = newChangeLogEntry({
    scenarioId: args.draft.id,
    kind: 'MERGE_TO_APPROVED',
    autoDescription: describeMergeToApproved({
      cellCount: promotedOverrides.length + promotedAdjustments.length + promotedManualEntryIds.size,
      rowCount: promotedCustomRows.length,
      date: now.slice(0, 10),
    }),
    payload: {
      approvedScenarioId: args.approved.id,
      cellCount: promotedOverrides.length,
      rowCount: promotedCustomRows.length,
      adjustmentCount: promotedAdjustments.length,
      manualEntryCount: promotedManualEntryIds.size,
      archivedDraft: args.archiveDraft,
    },
    createdBy: user,
  });
  const changeLog = [mergeEntry, ...args.changeLog];

  const auditEvents: AuditEvent[] = [
    createAuditEvent({
      entityType: 'SCENARIO',
      entityId: args.approved.id,
      action: 'UPDATE',
      previousValue: { overrideCount: args.approvedOverrides.length },
      newValue: {
        overrideCount: remainingApprovedOverrides.length + promotedOverrides.length,
        promotedCells: promotedOverrides.length,
        promotedCustomRows: promotedCustomRows.length,
        promotedAdjustments: promotedAdjustments.length,
        promotedManualEntries: promotedManualEntryIds.size,
        sourceDraftId: args.draft.id,
      },
      comment: `Propuesta "${args.draft.name}" aplicada al Aprobado.`,
      userId: user,
    }),
  ];
  if (args.archiveDraft) {
    auditEvents.push(createAuditEvent({
      entityType: 'SCENARIO',
      entityId: args.draft.id,
      action: 'UPDATE',
      previousValue: { archived: false },
      newValue: { archived: true },
      comment: 'Propuesta archivada tras aplicar cambios al Aprobado.',
      userId: user,
    }));
  }

  return {
    scenarios,
    cellOverrides,
    adjustments,
    customRows,
    manualEntries,
    changeLog,
    auditEvents,
  };
}

function cellChangeId(conceptKey: string, bucketKey: string, granularity: ProjectionGranularity): string {
  return `${conceptKey}::${granularity}::${bucketKey}`;
}

function customRowChangeId(rowId: string): string {
  return rowId;
}

function adjustmentChangeId(adjustmentId: string): string {
  return adjustmentId;
}

function manualEntryChangeId(entryId: string): string {
  return entryId;
}

function adjustmentKey(adjustment: FinancialAdjustment): string {
  return `${adjustment.type}::${adjustment.targetType}::${adjustment.targetExpression}`;
}

function manualEntryKey(entry: ManualPlanningEntry): string {
  return `${entry.type}::${entry.category}::${entry.name.trim().toUpperCase()}::${entry.startDate}::${entry.amount}`;
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: 0,
  }).format(value);
}

function adjustmentImpactLabel(adjustment: FinancialAdjustment): string {
  if (adjustment.type === 'DATE_SHIFT') return `Mover fecha · ${String(adjustment.adjustedValue ?? adjustment.deltaDays ?? '')}`;
  if (adjustment.type === 'AMOUNT_OVERRIDE') return `Nuevo monto · ${formatAmount(Number(adjustment.adjustedValue ?? 0))}`;
  if (adjustment.type === 'AMOUNT_DELTA') return `Delta · ${formatAmount(adjustment.deltaAmount ?? 0)}`;
  if (adjustment.type === 'PERCENTAGE_CHANGE') return `Cambio porcentual · ${Math.round((adjustment.percentageChange ?? 0) * 100)}%`;
  if (adjustment.type === 'SPLIT_PAYMENT') return `Dividir pago · ${adjustment.splitConfig?.numberOfPayments ?? 0} pagos`;
  if (adjustment.type === 'CANCEL_MOVEMENT') return 'Cancelar movimiento';
  return adjustment.type;
}
