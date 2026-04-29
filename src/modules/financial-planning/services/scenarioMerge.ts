import type {
  AuditEvent,
  CellOverride,
  FinancialScenario,
  ManualPlanningEntry,
  PlanningCustomRow,
  ProjectionGranularity,
  ScenarioChangeLogEntry,
} from '../../shared-finance/types';
import { createAuditEvent } from '../../shared-finance/audit/audit';
import { describeMergeToApproved, newChangeLogEntry } from './changeLogTemplates';

export interface MergeDiffEntry {
  conceptKey: string;
  bucketKey: string;
  granularity: ProjectionGranularity;
  rowLabel: string;
  bucketLabel: string;
  approvedValue: number;
  draftValue: number;
  delta: number;
  approvedHasOverride: boolean;
  draftHasOverride: boolean;
  conflict: boolean;
  type: CellOverride['type'];
}

export interface BuildMergeDiffArgs {
  approved: FinancialScenario;
  draft: FinancialScenario;
  approvedOverrides: CellOverride[];
  draftOverrides: CellOverride[];
  approvedCustomRows: PlanningCustomRow[];
  draftCustomRows: PlanningCustomRow[];
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
  return entries;
}

export interface ApplyMergeArgs {
  approved: FinancialScenario;
  draft: FinancialScenario;
  scenarios: FinancialScenario[];
  approvedOverrides: CellOverride[];
  draftOverrides: CellOverride[];
  allOverrides: CellOverride[];
  approvedCustomRows: PlanningCustomRow[];
  draftCustomRows: PlanningCustomRow[];
  allCustomRows: PlanningCustomRow[];
  manualEntries: ManualPlanningEntry[];
  changeLog: ScenarioChangeLogEntry[];
  selectedKeys: Array<{ conceptKey: string; bucketKey: string; granularity: ProjectionGranularity }>;
  archiveDraft: boolean;
  user?: string;
}

export interface ApplyMergeResult {
  scenarios: FinancialScenario[];
  cellOverrides: CellOverride[];
  customRows: PlanningCustomRow[];
  manualEntries: ManualPlanningEntry[];
  changeLog: ScenarioChangeLogEntry[];
  auditEvents: AuditEvent[];
}

export function applyMerge(args: ApplyMergeArgs): ApplyMergeResult {
  const user = args.user ?? 'tesoreria@senda.local';
  const now = new Date().toISOString();
  const selectedSet = new Set(
    args.selectedKeys.map((sel) => `${sel.conceptKey}::${sel.granularity}::${sel.bucketKey}`),
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
    const key = `${draftOverride.conceptKey}::${draftOverride.granularity}::${draftOverride.bucketKey}`;
    if (!selectedSet.has(key)) continue;
    const existing = approvedByKey.get(key);
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
    if (!promotedConceptKeys.has(row.conceptKey)) continue;
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

  // Manual entries: keep as-is for now (manual entries cross-scenarios via scenarioIds[]).
  const manualEntries = args.manualEntries;

  // Append MERGE_TO_APPROVED changelog entry on draft.
  const mergeEntry = newChangeLogEntry({
    scenarioId: args.draft.id,
    kind: 'MERGE_TO_APPROVED',
    autoDescription: describeMergeToApproved({
      cellCount: promotedOverrides.length,
      rowCount: promotedCustomRows.length,
      date: now.slice(0, 10),
    }),
    payload: {
      approvedScenarioId: args.approved.id,
      cellCount: promotedOverrides.length,
      rowCount: promotedCustomRows.length,
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
        sourceDraftId: args.draft.id,
      },
      comment: `Merge desde ${args.draft.name} a Aprobado.`,
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
      comment: 'Borrador archivado tras merge a Aprobado.',
      userId: user,
    }));
  }

  return {
    scenarios,
    cellOverrides,
    customRows,
    manualEntries,
    changeLog,
    auditEvents,
  };
}
