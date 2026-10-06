import { describe, expect, it } from 'vitest';
import type {
  CellOverride,
  FinancialAdjustment,
  FinancialScenario,
  ManualPlanningEntry,
  PlanningCustomRow,
  ScenarioChangeLogEntry,
} from '../../shared-finance/types';
import { createNewDraft, duplicateDraft, type DuplicateDraftArgs } from './scenarioDuplicate';

const APPROVED_ID = 'approved';

function scenario(patch: Partial<FinancialScenario> = {}): FinancialScenario {
  return {
    id: 'draft-src',
    name: 'Propuesta original',
    kind: 'DRAFT',
    adjustmentIds: ['adj-1', 'adj-2'],
    status: 'APPROVED',
    parentScenarioId: APPROVED_ID,
    createdBy: 'blanca@senda.local',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    archivedAt: '2026-02-01T00:00:00.000Z',
    promotedFromScenarioId: 'draft-old',
    promotedAt: '2026-02-01T00:00:00.000Z',
    ...patch,
  };
}

function override(patch: Partial<CellOverride> = {}): CellOverride {
  return {
    id: 'ov-1',
    scenarioId: 'draft-src',
    conceptKey: 'OUTFLOW:AP_PAYMENT:pemex',
    granularity: 'monthly',
    bucketKey: '2026-03-01',
    type: 'OUTFLOW',
    mode: 'REPLACE',
    value: 1000,
    createdBy: 'blanca@senda.local',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function customRow(patch: Partial<PlanningCustomRow> = {}): PlanningCustomRow {
  return {
    id: 'row-1',
    scenarioId: 'draft-src',
    conceptKey: 'INFLOW:AR_COLLECTION:extra',
    label: 'Ingreso extra',
    type: 'INFLOW',
    category: 'AR_COLLECTION',
    createdBy: 'blanca@senda.local',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function adjustmentFor(patch: Partial<FinancialAdjustment> = {}): FinancialAdjustment {
  return {
    id: 'adj-1',
    name: 'Diferir Pemex',
    scenarioIds: ['draft-src'],
    type: 'DATE_SHIFT',
    targetType: 'COUNTERPARTY',
    targetExpression: 'PEMEX',
    deltaDays: 15,
    reasonCode: 'LIQUIDITY',
    justification: 'test',
    status: 'DRAFT',
    createdBy: 'blanca@senda.local',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function manualEntryFor(patch: Partial<ManualPlanningEntry> = {}): ManualPlanningEntry {
  return {
    id: 'me-1',
    scenarioIds: ['draft-src'],
    type: 'OUTFLOW',
    category: 'OPEX',
    name: 'Renta',
    amount: 1000,
    startDate: '2026-03-15',
    recurrence: 'MONTHLY',
    taxTreatment: 'IVA_CREDITABLE',
    status: 'DRAFT',
    createdBy: 'blanca@senda.local',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function existingLogEntry(): ScenarioChangeLogEntry {
  return {
    id: 'cl-old',
    scenarioId: 'draft-src',
    kind: 'EDIT_CELL',
    payload: {},
    autoDescription: 'Cambio previo',
    createdBy: 'blanca@senda.local',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function args(patch: Partial<DuplicateDraftArgs> = {}): DuplicateDraftArgs {
  return {
    source: scenario(),
    approvedScenarioId: APPROVED_ID,
    allOverrides: [override(), override({ id: 'ov-other', scenarioId: 'otro-escenario' })],
    allCustomRows: [customRow(), customRow({ id: 'row-other', scenarioId: 'otro-escenario' })],
    allAdjustments: [adjustmentFor(), adjustmentFor({ id: 'adj-other', scenarioIds: ['otro-escenario'] })],
    allManualEntries: [manualEntryFor(), manualEntryFor({ id: 'me-other', scenarioIds: ['otro-escenario'] })],
    changeLog: [existingLogEntry()],
    ...patch,
  };
}

describe('duplicateDraft', () => {
  it('crea un DRAFT nuevo colgado del Aprobado, limpiando estado heredado', () => {
    const { newScenario } = duplicateDraft(args());
    expect(newScenario.id).not.toBe('draft-src');
    expect(newScenario.id).toMatch(/^draft-/);
    expect(newScenario.kind).toBe('DRAFT');
    expect(newScenario.status).toBe('DRAFT');
    expect(newScenario.isBase).toBe(false);
    expect(newScenario.parentScenarioId).toBe(APPROVED_ID);
    // Estado heredado del origen que NO debe viajar a la copia:
    expect(newScenario.adjustmentIds).toEqual([]);
    expect(newScenario.archivedAt).toBeUndefined();
    expect(newScenario.promotedFromScenarioId).toBeUndefined();
    expect(newScenario.promotedAt).toBeUndefined();
    // Metadatos nuevos:
    expect(newScenario.createdBy).toBe('tesoreria@senda.local');
    expect(newScenario.createdAt).toBe(newScenario.updatedAt);
  });

  it('nombra la copia "<origen> (copia)" por default y respeta newName trimmeado', () => {
    expect(duplicateDraft(args()).newScenario.name).toBe('Propuesta original (copia)');
    expect(duplicateDraft(args({ newName: '  Escenario B  ' })).newScenario.name).toBe('Escenario B');
    // newName whitespace-only cae al default:
    expect(duplicateDraft(args({ newName: '   ' })).newScenario.name).toBe('Propuesta original (copia)');
  });

  it('clona SOLO los overrides del escenario origen, re-apuntados al id nuevo', () => {
    const result = duplicateDraft(args());
    const newId = result.newScenario.id;
    const clones = result.cellOverrides.filter((o) => o.scenarioId === newId);
    expect(clones).toHaveLength(1);
    expect(clones[0].id).not.toBe('ov-1');
    expect(clones[0].conceptKey).toBe('OUTFLOW:AP_PAYMENT:pemex');
    expect(clones[0].value).toBe(1000);
    // Los overrides originales (del origen y de otros escenarios) se preservan:
    expect(result.cellOverrides).toHaveLength(3);
    expect(result.cellOverrides.some((o) => o.id === 'ov-1' && o.scenarioId === 'draft-src')).toBe(true);
    expect(result.cellOverrides.some((o) => o.id === 'ov-other' && o.scenarioId === 'otro-escenario')).toBe(true);
  });

  it('clona SOLO las custom rows del origen, re-apuntadas al id nuevo', () => {
    const result = duplicateDraft(args());
    const newId = result.newScenario.id;
    const clones = result.customRows.filter((r) => r.scenarioId === newId);
    expect(clones).toHaveLength(1);
    expect(clones[0].label).toBe('Ingreso extra');
    expect(clones[0].id).not.toBe('row-1');
    expect(result.customRows).toHaveLength(3);
  });

  it('clona las propuestas y entradas manuales del origen: la copia calcula igual', () => {
    const result = duplicateDraft(args());
    const newId = result.newScenario.id;
    const adjClones = result.adjustments.filter((a) => a.scenarioIds.includes(newId));
    const entryClones = result.manualEntries.filter((e) => e.scenarioIds.includes(newId));
    expect(adjClones).toHaveLength(1);
    expect(adjClones[0]).toMatchObject({ type: 'DATE_SHIFT', targetExpression: 'PEMEX', deltaDays: 15, scenarioIds: [newId] });
    expect(adjClones[0].id).not.toBe('adj-1');
    expect(entryClones).toHaveLength(1);
    expect(entryClones[0]).toMatchObject({ name: 'Renta', amount: 1000, scenarioIds: [newId] });
    expect(entryClones[0].id).not.toBe('me-1');
    // Copias independientes: el origen y los de otros escenarios no se tocan.
    expect(result.adjustments).toHaveLength(3);
    expect(result.adjustments.find((a) => a.id === 'adj-1')?.scenarioIds).toEqual(['draft-src']);
    expect(result.manualEntries).toHaveLength(3);
    expect(result.manualEntries.find((e) => e.id === 'me-1')?.scenarioIds).toEqual(['draft-src']);
  });

  it('re-apunta la propuesta dirigida a una ocurrencia manual al id clonado', () => {
    const result = duplicateDraft(args({
      allAdjustments: [adjustmentFor({
        id: 'adj-mov',
        type: 'AMOUNT_OVERRIDE',
        targetType: 'MOVEMENT',
        targetExpression: 'manual-entry:me-1:2026-03-15',
        adjustedValue: 2000,
      })],
    }));
    const newId = result.newScenario.id;
    const clonedEntry = result.manualEntries.find((e) => e.scenarioIds.includes(newId))!;
    const clonedAdj = result.adjustments.find((a) => a.scenarioIds.includes(newId))!;
    expect(clonedAdj.targetExpression).toBe(`manual-entry:${clonedEntry.id}:2026-03-15`);
    // El original no se toca.
    expect(result.adjustments.find((a) => a.id === 'adj-mov')!.targetExpression)
      .toBe('manual-entry:me-1:2026-03-15');
  });

  it('re-apunta también cuando la propuesta apunta al id pelado de la entrada', () => {
    const result = duplicateDraft(args({
      allAdjustments: [adjustmentFor({ id: 'adj-src', targetType: 'MOVEMENT', targetExpression: 'me-1' })],
    }));
    const newId = result.newScenario.id;
    const clonedEntry = result.manualEntries.find((e) => e.scenarioIds.includes(newId))!;
    expect(result.adjustments.find((a) => a.scenarioIds.includes(newId))!.targetExpression).toBe(clonedEntry.id);
  });

  it('no toca el target de una propuesta ajena a las entradas manuales', () => {
    const result = duplicateDraft(args({
      allAdjustments: [
        adjustmentFor({ id: 'adj-cat', targetType: 'CATEGORY', targetExpression: 'AP_PAYMENT' }),
        adjustmentFor({ id: 'adj-api', targetType: 'MOVEMENT', targetExpression: 'cxc:00011:RI-123' }),
      ],
    }));
    const newId = result.newScenario.id;
    const targets = result.adjustments.filter((a) => a.scenarioIds.includes(newId)).map((a) => a.targetExpression).sort();
    expect(targets).toEqual(['AP_PAYMENT', 'cxc:00011:RI-123']);
  });

  it('antepone una entrada DUPLICATE_DRAFT al changelog con los conteos clonados', () => {
    const result = duplicateDraft(args());
    expect(result.changeLog).toHaveLength(2);
    const seed = result.changeLog[0];
    expect(seed.kind).toBe('DUPLICATE_DRAFT');
    expect(seed.scenarioId).toBe(result.newScenario.id);
    expect(seed.autoDescription).toContain('Propuesta original');
    expect(seed.payload).toMatchObject({
      sourceScenarioId: 'draft-src',
      sourceName: 'Propuesta original',
      cellCount: 1,
      customRowCount: 1,
      adjustmentCount: 1,
      manualEntryCount: 1,
    });
    // El log previo se conserva DESPUÉS del seed:
    expect(result.changeLog[1].id).toBe('cl-old');
  });

  it('propaga el usuario dado al escenario y al seed del changelog', () => {
    const result = duplicateDraft(args({ user: 'romo@senda.local' }));
    expect(result.newScenario.createdBy).toBe('romo@senda.local');
    expect(result.changeLog[0].createdBy).toBe('romo@senda.local');
  });

  it('origen sin overrides ni rows produce copia limpia con conteos en 0', () => {
    const result = duplicateDraft(args({
      allOverrides: [], allCustomRows: [], allAdjustments: [], allManualEntries: [], changeLog: [],
    }));
    expect(result.cellOverrides).toEqual([]);
    expect(result.customRows).toEqual([]);
    expect(result.adjustments).toEqual([]);
    expect(result.manualEntries).toEqual([]);
    expect(result.changeLog).toHaveLength(1);
    expect(result.changeLog[0].payload).toMatchObject({
      cellCount: 0, customRowCount: 0, adjustmentCount: 0, manualEntryCount: 0,
    });
  });
});

describe('createNewDraft', () => {
  const approved = scenario({ id: APPROVED_ID, name: 'Aprobado', kind: 'APPROVED' });

  it('crea un DRAFT vacío colgado del Aprobado con seed CREATE_DRAFT', () => {
    const { newScenario, seedEntry } = createNewDraft({ approved });
    expect(newScenario.id).toMatch(/^draft-/);
    expect(newScenario.kind).toBe('DRAFT');
    expect(newScenario.status).toBe('DRAFT');
    expect(newScenario.parentScenarioId).toBe(APPROVED_ID);
    expect(newScenario.adjustmentIds).toEqual([]);
    expect(newScenario.createdBy).toBe('tesoreria@senda.local');
    expect(seedEntry.kind).toBe('CREATE_DRAFT');
    expect(seedEntry.scenarioId).toBe(newScenario.id);
    expect(seedEntry.payload).toEqual({ approvedScenarioId: APPROVED_ID });
  });

  it('usa el nombre dado (trim) o cae al default "Propuesta <fecha es-MX>"', () => {
    expect(createNewDraft({ approved, name: '  Plan agresivo  ' }).newScenario.name).toBe('Plan agresivo');
    const fallback = createNewDraft({ approved, name: '   ' }).newScenario.name;
    expect(fallback).toBe(`Propuesta ${new Date().toLocaleDateString('es-MX')}`);
  });

  it('propaga el usuario dado', () => {
    const { newScenario, seedEntry } = createNewDraft({ approved, user: 'vero@senda.local' });
    expect(newScenario.createdBy).toBe('vero@senda.local');
    expect(seedEntry.createdBy).toBe('vero@senda.local');
  });
});
