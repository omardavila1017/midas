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

describe('scenarioMerge', () => {
  it('detects cells, custom rows, movement adjustments and manual entries as pending changes', () => {
    const diff = buildMergeDiff({
      approved,
      draft,
      approvedOverrides: [],
      draftOverrides: [cell('co-draft', draft.id, 100)],
      approvedCustomRows: [],
      draftCustomRows: [customRow('row-draft', draft.id)],
      approvedAdjustments: [],
      draftAdjustments: [adjustment('adj-draft', [draft.id])],
      manualEntries: [manualEntry('manual-draft', [draft.id])],
      rowLabelLookup: () => 'Proveedor A',
      bucketLabelLookup: () => 'Mayo',
      approvedAggregateLookup: () => 50,
    });

    expect(diff.map((entry) => entry.kind)).toEqual([
      'CELL_OVERRIDE',
      'CUSTOM_ROW',
      'MOVEMENT_ADJUSTMENT',
      'MANUAL_ENTRY',
    ]);
    expect(diff.every((entry) => entry.selectedByDefault)).toBe(true);
  });

  it('promotes selected movement adjustments and manual entries to approved', () => {
    const draftAdjustment = adjustment('adj-draft', [draft.id]);
    const draftManual = manualEntry('manual-draft', [draft.id]);
    const result = applyMerge({
      approved,
      draft,
      scenarios: [approved, draft],
      approvedOverrides: [],
      draftOverrides: [],
      allOverrides: [],
      approvedAdjustments: [],
      draftAdjustments: [draftAdjustment],
      allAdjustments: [draftAdjustment],
      approvedCustomRows: [],
      draftCustomRows: [],
      allCustomRows: [],
      manualEntries: [draftManual],
      changeLog: [],
      selectedChanges: [
        { kind: 'MOVEMENT_ADJUSTMENT', id: draftAdjustment.id },
        { kind: 'MANUAL_ENTRY', id: draftManual.id },
      ],
      archiveDraft: true,
      user: 'tester@senda.local',
    });

    expect(result.adjustments).toEqual([
      expect.objectContaining({
        scenarioIds: [approved.id],
        status: 'APPROVED',
        approvedBy: 'tester@senda.local',
      }),
    ]);
    expect(result.manualEntries[0]).toEqual(expect.objectContaining({
      scenarioIds: [approved.id],
      status: 'APPROVED',
    }));
    expect(result.scenarios.find((item) => item.id === draft.id)?.archivedAt).toBeTruthy();
  });

  it('applies only selected changes during a partial merge', () => {
    const draftCell = cell('co-draft', draft.id, 100);
    const draftAdjustment = adjustment('adj-draft', [draft.id]);
    const result = applyMerge({
      approved,
      draft,
      scenarios: [approved, draft],
      approvedOverrides: [],
      draftOverrides: [draftCell],
      allOverrides: [draftCell],
      approvedAdjustments: [],
      draftAdjustments: [draftAdjustment],
      allAdjustments: [draftAdjustment],
      approvedCustomRows: [],
      draftCustomRows: [],
      allCustomRows: [],
      manualEntries: [],
      changeLog: [],
      selectedChanges: [{ kind: 'CELL_OVERRIDE', id: 'INFLOW:AR_COLLECTION:test::monthly::2026-05-01' }],
      archiveDraft: false,
    });

    expect(result.cellOverrides).toContainEqual(expect.objectContaining({
      scenarioId: approved.id,
      conceptKey: draftCell.conceptKey,
    }));
    expect(result.adjustments).toEqual([draftAdjustment]);
    expect(result.scenarios.find((item) => item.id === draft.id)?.archivedAt).toBeUndefined();
  });

  it('marks conflicts when approved already changed the same cell or movement', () => {
    const approvedAdjustment = adjustment('adj-approved', [approved.id]);
    const diff = buildMergeDiff({
      approved,
      draft,
      approvedOverrides: [cell('co-approved', approved.id, 90)],
      draftOverrides: [cell('co-draft', draft.id, 100)],
      approvedCustomRows: [],
      draftCustomRows: [],
      approvedAdjustments: [approvedAdjustment],
      draftAdjustments: [adjustment('adj-draft', [draft.id])],
      manualEntries: [],
      rowLabelLookup: () => 'Proveedor A',
      bucketLabelLookup: () => 'Mayo',
      approvedAggregateLookup: () => 50,
    });

    expect(diff.find((entry) => entry.kind === 'CELL_OVERRIDE')?.conflict).toBe(true);
    expect(diff.find((entry) => entry.kind === 'MOVEMENT_ADJUSTMENT')?.conflict).toBe(true);
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

function cell(id: string, scenarioId: string, value: number): CellOverride {
  return {
    id,
    scenarioId,
    conceptKey: 'INFLOW:AR_COLLECTION:test',
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

function customRow(id: string, scenarioId: string): PlanningCustomRow {
  return {
    id,
    scenarioId,
    conceptKey: `custom:OUTFLOW:${id}`,
    label: 'Pago extraordinario',
    type: 'OUTFLOW',
    category: 'MANUAL',
    createdBy: 'tester',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

function adjustment(id: string, scenarioIds: string[]): FinancialAdjustment {
  return {
    id,
    name: 'Mover pago proveedor',
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
  };
}

function manualEntry(id: string, scenarioIds: string[]): ManualPlanningEntry {
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
  };
}
