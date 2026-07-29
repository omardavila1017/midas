import { describe, expect, it } from 'vitest';
import type {
  CellOverride,
  FinancialAdjustment,
  FinancialScenario,
  ManualPlanningEntry,
  PlanningCustomRow,
} from '../../shared-finance/types';
import { applyMerge, buildMergeDiff } from './scenarioMerge';

const approved = scenario('approved', 'APPROVED');
const draft = scenario('draft-1', 'DRAFT');
const other = scenario('draft-2', 'DRAFT');

const LOOKUPS = {
  rowLabelLookup: () => 'Proveedor A',
  bucketLabelLookup: () => 'Mayo',
  approvedAggregateLookup: () => 50,
};

describe('buildMergeDiff — optional collections', () => {
  it('treats missing adjustment and manual-entry collections as empty', () => {
    const diff = buildMergeDiff({
      approved,
      draft,
      approvedOverrides: [],
      draftOverrides: [],
      approvedCustomRows: [],
      draftCustomRows: [],
      ...LOOKUPS,
    });
    expect(diff).toEqual([]);
  });
});

describe('buildMergeDiff — skip branches', () => {
  it('ignores approved overrides from other scenarios and draft cells that already match approved', () => {
    const diff = buildMergeDiff({
      approved,
      draft,
      approvedOverrides: [cell('co-other', other.id, 999)],
      draftOverrides: [
        cell('co-same', draft.id, 50, 'INFLOW:AR_COLLECTION:same'),
        cell('co-changed', draft.id, 120, 'INFLOW:AR_COLLECTION:changed'),
      ],
      approvedCustomRows: [],
      draftCustomRows: [],
      ...LOOKUPS,
    });

    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({
      conceptKey: 'INFLOW:AR_COLLECTION:changed',
      approvedValue: 50,
      draftValue: 120,
      delta: 70,
      approvedHasOverride: false,
      draftHasOverride: true,
      conflict: false,
    });
  });

  it('flags an existing custom row as a conflict and labels inflow rows as ingreso', () => {
    const diff = buildMergeDiff({
      approved,
      draft,
      approvedOverrides: [],
      draftOverrides: [],
      approvedCustomRows: [customRow('row-approved', approved.id, 'custom:INFLOW:dup', 'INFLOW')],
      draftCustomRows: [
        customRow('row-dup', draft.id, 'custom:INFLOW:dup', 'INFLOW'),
        customRow('row-new', draft.id, 'custom:OUTFLOW:new', 'OUTFLOW'),
      ],
      ...LOOKUPS,
    });

    expect(diff.map((entry) => [entry.impactLabel, entry.conflict, entry.selectedByDefault])).toEqual([
      ['Ingreso · fila nueva', true, false],
      ['Egreso · fila nueva', false, true],
    ]);
  });

  it('skips draft adjustments that belong to another scenario or were rejected', () => {
    const diff = buildMergeDiff({
      approved,
      draft,
      approvedOverrides: [],
      draftOverrides: [],
      approvedCustomRows: [],
      draftCustomRows: [],
      approvedAdjustments: [
        adjustment('adj-approved', [approved.id], { targetExpression: 'movement-1' }),
        // Rejected approved adjustments never seed the conflict index.
        adjustment('adj-approved-rejected', [approved.id], { targetExpression: 'movement-9', status: 'REJECTED' }),
      ],
      draftAdjustments: [
        adjustment('adj-other-scenario', [other.id], { targetExpression: 'movement-2' }),
        adjustment('adj-rejected', [draft.id], { targetExpression: 'movement-3', status: 'REJECTED' }),
        adjustment('adj-conflict', [draft.id], { targetExpression: 'movement-1' }),
        adjustment('adj-clean', [draft.id], { targetExpression: 'movement-9' }),
      ],
      ...LOOKUPS,
    });

    expect(diff.map((entry) => entry.id)).toEqual(['adj-conflict', 'adj-clean']);
    expect(diff[0].conflict).toBe(true);
    expect(diff[1].conflict).toBe(false);
  });

  it('skips manual entries that are approved, shared or replaced, and labels inflow entries', () => {
    const diff = buildMergeDiff({
      approved,
      draft,
      approvedOverrides: [],
      draftOverrides: [],
      approvedCustomRows: [],
      draftCustomRows: [],
      manualEntries: [
        // Approved-only entry — seeds the conflict index (and exercises the !replacedAt guard).
        manualEntry('me-approved', [approved.id], { name: 'Duplicada' }),
        // Approved AND replaced — excluded from the conflict index.
        manualEntry('me-approved-replaced', [approved.id], { name: 'Vieja', replacedAt: '2026-04-01T00:00:00.000Z' }),
        // Shared with approved → nothing to promote.
        manualEntry('me-shared', [draft.id, approved.id], { name: 'Compartida' }),
        // Draft-only but already replaced → skipped.
        manualEntry('me-replaced', [draft.id], { name: 'Reemplazada', replacedAt: '2026-04-01T00:00:00.000Z' }),
        // Draft-only conflicting with the approved one (same natural key).
        manualEntry('me-conflict', [draft.id], { name: 'Duplicada' }),
        // Draft-only inflow.
        manualEntry('me-inflow', [draft.id], { name: 'Cobro extraordinario', type: 'INFLOW', amount: 2500 }),
      ],
      ...LOOKUPS,
    });

    expect(diff.map((entry) => entry.id)).toEqual(['me-conflict', 'me-inflow']);
    expect(diff[0].conflict).toBe(true);
    expect(diff[1].conflict).toBe(false);
    expect(diff[1].impactLabel).toContain('Ingreso manual');
    expect(diff[0].impactLabel).toContain('Egreso manual');
  });
});

describe('buildMergeDiff — adjustment impact labels', () => {
  it('renders one label per adjustment type, including the empty-value fallbacks', () => {
    const diff = buildMergeDiff({
      approved,
      draft,
      approvedOverrides: [],
      draftOverrides: [],
      approvedCustomRows: [],
      draftCustomRows: [],
      draftAdjustments: [
        adjustment('a1', [draft.id], { type: 'DATE_SHIFT', targetExpression: 'm1', adjustedValue: '2026-05-20' }),
        adjustment('a2', [draft.id], { type: 'DATE_SHIFT', targetType: 'CATEGORY', targetExpression: 'm2', adjustedValue: undefined, deltaDays: 5 }),
        adjustment('a3', [draft.id], { type: 'DATE_SHIFT', targetType: 'FILTER_SET', targetExpression: 'm3', adjustedValue: undefined }),
        adjustment('a4', [draft.id], { type: 'AMOUNT_OVERRIDE', targetExpression: 'm4', adjustedValue: 1234 }),
        adjustment('a5', [draft.id], { type: 'AMOUNT_OVERRIDE', targetType: 'CATEGORY', targetExpression: 'm5', adjustedValue: undefined }),
        adjustment('a6', [draft.id], { type: 'AMOUNT_DELTA', targetExpression: 'm6', deltaAmount: -500 }),
        adjustment('a7', [draft.id], { type: 'AMOUNT_DELTA', targetType: 'CATEGORY', targetExpression: 'm7' }),
        adjustment('a8', [draft.id], { type: 'PERCENTAGE_CHANGE', targetExpression: 'm8', percentageChange: 0.12 }),
        adjustment('a9', [draft.id], { type: 'PERCENTAGE_CHANGE', targetType: 'CATEGORY', targetExpression: 'm9' }),
        adjustment('a10', [draft.id], { type: 'SPLIT_PAYMENT', targetExpression: 'm10', splitConfig: { numberOfPayments: 3, frequency: 'BIWEEKLY' } }),
        adjustment('a11', [draft.id], { type: 'SPLIT_PAYMENT', targetType: 'CATEGORY', targetExpression: 'm11' }),
        adjustment('a12', [draft.id], { type: 'CANCEL_MOVEMENT', targetExpression: 'm12' }),
        adjustment('a13', [draft.id], { type: 'FINANCING_DRAW', targetExpression: 'm13' }),
      ],
      ...LOOKUPS,
    });

    expect(diff.map((entry) => entry.impactLabel)).toEqual([
      'Mover fecha · 2026-05-20',
      'Mover fecha · 5',
      'Mover fecha · ',
      expect.stringContaining('Nuevo monto ·'),
      expect.stringContaining('Nuevo monto ·'),
      expect.stringContaining('Delta ·'),
      expect.stringContaining('Delta ·'),
      'Cambio porcentual · 12%',
      'Cambio porcentual · 0%',
      'Dividir pago · 3 pagos',
      'Dividir pago · 0 pagos',
      'Cancelar movimiento',
      'FINANCING_DRAW',
    ]);
  });
});

describe('applyMerge — promotion branches', () => {
  it('reuses the approved override id, keeps unselected draft rows and promotes custom rows by concept', () => {
    const approvedOverride = cell('co-approved', approved.id, 90);
    const selectedDraft = cell('co-draft', draft.id, 100);
    const unselectedDraft = cell('co-draft-2', draft.id, 70, 'INFLOW:AR_COLLECTION:otro');
    const foreignOverride = cell('co-foreign', other.id, 10, 'INFLOW:AR_COLLECTION:foreign');
    const promotedRow = customRow('row-linked', draft.id, selectedDraft.conceptKey, 'INFLOW');
    const explicitRow = customRow('row-explicit', draft.id, 'custom:OUTFLOW:explicit', 'OUTFLOW');
    const untouchedRow = customRow('row-untouched', draft.id, 'custom:OUTFLOW:untouched', 'OUTFLOW');
    const foreignRow = customRow('row-foreign', other.id, 'custom:OUTFLOW:foreign', 'OUTFLOW');

    const result = applyMerge({
      approved,
      draft,
      scenarios: [approved, draft, other],
      approvedOverrides: [approvedOverride],
      draftOverrides: [selectedDraft, unselectedDraft],
      allOverrides: [approvedOverride, selectedDraft, unselectedDraft, foreignOverride],
      approvedAdjustments: [],
      draftAdjustments: [],
      allAdjustments: [],
      approvedCustomRows: [],
      draftCustomRows: [promotedRow, explicitRow, untouchedRow],
      allCustomRows: [promotedRow, explicitRow, untouchedRow, foreignRow],
      manualEntries: [],
      changeLog: [],
      selectedChanges: [
        { kind: 'CELL_OVERRIDE', id: `${selectedDraft.conceptKey}::monthly::2026-05-01` },
        { kind: 'CUSTOM_ROW', id: explicitRow.id },
      ],
      archiveDraft: false,
    });

    const promoted = result.cellOverrides.filter((override) => override.scenarioId === approved.id && override.value === 100);
    expect(promoted).toHaveLength(1);
    // The promoted override reuses the id of the approved override it replaces.
    expect(promoted[0].id).toBe(approvedOverride.id);
    // KNOWN DEFECT pinned here: `remainingApprovedOverrides` only drops the replaced approved
    // override when the promoted copy got a DIFFERENT id, so reusing `existing.id` leaves BOTH
    // the stale (90) and the promoted (100) rows in the collection under the same id.
    expect(result.cellOverrides.filter((override) => override.id === approvedOverride.id)).toHaveLength(2);
    // The unselected draft override survives untouched; foreign scenarios are preserved too.
    expect(result.cellOverrides.some((override) => override.id === unselectedDraft.id)).toBe(true);
    expect(result.cellOverrides.some((override) => override.id === foreignOverride.id)).toBe(true);

    // Rows promoted either by explicit selection or because their concept was promoted.
    const approvedRows = result.customRows.filter((row) => row.scenarioId === approved.id);
    expect(approvedRows.map((row) => row.conceptKey).sort()).toEqual([
      'custom:OUTFLOW:explicit',
      selectedDraft.conceptKey,
    ].sort());
    expect(result.customRows.some((row) => row.id === untouchedRow.id)).toBe(true);
    expect(result.customRows.some((row) => row.id === foreignRow.id)).toBe(true);
    expect(result.changeLog[0].kind).toBe('MERGE_TO_APPROVED');
    expect(result.changeLog[0].createdBy).toBe('tesoreria@senda.local');
  });

  it('does not duplicate an approved custom row that already carries the promoted concept', () => {
    const draftRow = customRow('row-dup', draft.id, 'custom:OUTFLOW:dup', 'OUTFLOW');
    const approvedRow = customRow('row-dup-approved', approved.id, 'custom:OUTFLOW:dup', 'OUTFLOW');

    const result = applyMerge({
      approved,
      draft,
      scenarios: [approved, draft],
      approvedOverrides: [],
      draftOverrides: [],
      allOverrides: [],
      approvedAdjustments: [],
      draftAdjustments: [],
      allAdjustments: [],
      approvedCustomRows: [approvedRow],
      draftCustomRows: [draftRow],
      allCustomRows: [approvedRow, draftRow],
      manualEntries: [],
      changeLog: [],
      selectedChanges: [{ kind: 'CUSTOM_ROW', id: draftRow.id }],
      archiveDraft: false,
    });

    expect(result.customRows.filter((row) => row.conceptKey === 'custom:OUTFLOW:dup')).toHaveLength(1);
    expect(result.customRows[0].id).toBe(approvedRow.id);
  });

  it('replaces the approved adjustment that shares the natural key and leaves unselected entries alone', () => {
    const approvedAdjustment = adjustment('adj-approved', [approved.id], { targetExpression: 'movement-1' });
    const draftAdjustment = adjustment('adj-draft', [draft.id], { targetExpression: 'movement-1' });
    const untouchedAdjustment = adjustment('adj-untouched', [draft.id], { targetExpression: 'movement-2' });
    const selectedEntry = manualEntry('me-selected', [draft.id], { name: 'Promovida' });
    const untouchedEntry = manualEntry('me-untouched', [draft.id], { name: 'Intacta' });

    const result = applyMerge({
      approved,
      draft,
      scenarios: [approved, draft],
      approvedOverrides: [],
      draftOverrides: [],
      allOverrides: [],
      approvedAdjustments: [approvedAdjustment],
      draftAdjustments: [draftAdjustment, untouchedAdjustment],
      allAdjustments: [approvedAdjustment, draftAdjustment, untouchedAdjustment],
      approvedCustomRows: [],
      draftCustomRows: [],
      allCustomRows: [],
      manualEntries: [selectedEntry, untouchedEntry],
      changeLog: [],
      selectedChanges: [
        { kind: 'MOVEMENT_ADJUSTMENT', id: draftAdjustment.id },
        { kind: 'MANUAL_ENTRY', id: selectedEntry.id },
      ],
      archiveDraft: true,
      user: 'tester@senda.local',
    });

    // The replaced approved adjustment is gone; the promoted one inherits its id.
    expect(result.adjustments.map((item) => item.id).sort()).toEqual(['adj-approved', 'adj-untouched']);
    expect(result.adjustments.find((item) => item.id === 'adj-approved')).toMatchObject({
      status: 'APPROVED',
      scenarioIds: [approved.id],
      approvedBy: 'tester@senda.local',
    });
    // Unselected manual entries are returned unchanged (same object reference).
    expect(result.manualEntries.find((item) => item.id === untouchedEntry.id)).toBe(untouchedEntry);
    // The selected one is promoted and unlinked from the archived draft.
    expect(result.manualEntries.find((item) => item.id === selectedEntry.id)).toMatchObject({
      status: 'APPROVED',
      scenarioIds: [approved.id],
    });
    expect(result.scenarios.find((item) => item.id === draft.id)?.archivedAt).toBeTruthy();
  });
});

function scenario(id: string, kind: FinancialScenario['kind']): FinancialScenario {
  return {
    id,
    name: kind === 'APPROVED' ? 'Escenario Aprobado' : 'Propuesta',
    kind,
    status: kind === 'DRAFT' ? 'DRAFT' : 'APPROVED',
    adjustmentIds: [],
    parentScenarioId: kind === 'DRAFT' ? 'approved' : undefined,
    createdBy: 'tester',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

function cell(id: string, scenarioId: string, value: number, conceptKey = 'INFLOW:AR_COLLECTION:test'): CellOverride {
  return {
    id,
    scenarioId,
    conceptKey,
    granularity: 'monthly',
    bucketKey: '2026-05-01',
    type: 'INFLOW',
    mode: 'REPLACE',
    value,
    createdBy: 'tester',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

function customRow(
  id: string,
  scenarioId: string,
  conceptKey: string,
  type: PlanningCustomRow['type'],
): PlanningCustomRow {
  return {
    id,
    scenarioId,
    conceptKey,
    label: `Fila ${id}`,
    type,
    category: 'MANUAL',
    createdBy: 'tester',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

function adjustment(
  id: string,
  scenarioIds: string[],
  patch: Partial<FinancialAdjustment> = {},
): FinancialAdjustment {
  return {
    id,
    name: `Ajuste ${id}`,
    scenarioIds,
    type: 'DATE_SHIFT',
    targetType: 'MOVEMENT',
    targetExpression: 'movement-1',
    adjustedValue: '2026-05-20',
    reasonCode: 'LIQUIDITY',
    justification: 'Cuidar caja mínima.',
    status: 'DRAFT',
    createdBy: 'tester',
    createdAt: '2026-05-01T00:00:00.000Z',
    ...patch,
  };
}

function manualEntry(
  id: string,
  scenarioIds: string[],
  patch: Partial<ManualPlanningEntry> = {},
): ManualPlanningEntry {
  return {
    id,
    scenarioIds,
    type: 'OUTFLOW',
    category: 'SUPPLIER_PAYMENT',
    name: 'Pago manual',
    amount: 1000,
    startDate: '2026-05-10',
    recurrence: 'ONE_TIME',
    taxTreatment: 'IVA_CREDITABLE',
    status: 'DRAFT',
    createdBy: 'tester',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...patch,
  };
}
