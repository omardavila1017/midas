import { describe, expect, it } from 'vitest';
import type { CellOverride, PlanningCustomRow } from '../../shared-finance/types';
import {
  describeAddRow,
  describeClearCell,
  describeCreateDraft,
  describeDuplicateDraft,
  describeEditCell,
  describeMergeToApproved,
  describeOverridePayload,
  describeRemoveRow,
  describeRenameRow,
  newChangeLogEntry,
} from './changeLogTemplates';

describe('newChangeLogEntry', () => {
  it('defaults the payload and the author when they are omitted', () => {
    const entry = newChangeLogEntry({
      scenarioId: 'draft-1',
      kind: 'EDIT_CELL',
      autoDescription: 'Cambio',
    });

    expect(entry).toMatchObject({
      scenarioId: 'draft-1',
      kind: 'EDIT_CELL',
      autoDescription: 'Cambio',
      payload: {},
      createdBy: 'tesoreria@senda.local',
    });
    expect(entry.userNote).toBeUndefined();
    expect(entry.id.startsWith('cl-')).toBe(true);
    expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps an explicit payload, note and author', () => {
    const entry = newChangeLogEntry({
      scenarioId: 'draft-1',
      kind: 'MERGE_TO_APPROVED',
      autoDescription: 'Aplicada',
      payload: { cellCount: 3 },
      userNote: 'Revisado con tesorería',
      createdBy: 'tester@senda.local',
    });

    expect(entry.payload).toEqual({ cellCount: 3 });
    expect(entry.userNote).toBe('Revisado con tesorería');
    expect(entry.createdBy).toBe('tester@senda.local');
  });
});

describe('describeMergeToApproved', () => {
  it('uses singular wording for a single change and a single custom row', () => {
    expect(describeMergeToApproved({ cellCount: 1, rowCount: 1, date: '2026-05-20' }))
      .toBe('Aplicada al Aprobado el 2026-05-20. 1 cambio, 1 fila personalizada.');
  });

  it('uses plural wording otherwise, including zero', () => {
    expect(describeMergeToApproved({ cellCount: 0, rowCount: 0, date: '2026-05-20' }))
      .toBe('Aplicada al Aprobado el 2026-05-20. 0 cambios, 0 filas personalizadas.');
    expect(describeMergeToApproved({ cellCount: 4, rowCount: 2, date: '2026-05-20' }))
      .toBe('Aplicada al Aprobado el 2026-05-20. 4 cambios, 2 filas personalizadas.');
  });

  it('mixes singular and plural independently per counter', () => {
    expect(describeMergeToApproved({ cellCount: 1, rowCount: 3, date: '2026-05-20' }))
      .toBe('Aplicada al Aprobado el 2026-05-20. 1 cambio, 3 filas personalizadas.');
    expect(describeMergeToApproved({ cellCount: 5, rowCount: 1, date: '2026-05-20' }))
      .toBe('Aplicada al Aprobado el 2026-05-20. 5 cambios, 1 fila personalizada.');
  });
});

describe('row and cell descriptions', () => {
  it('labels inflow and outflow rows in Spanish', () => {
    expect(describeAddRow(customRow('INFLOW'))).toBe('Agregaste fila "Fila nueva" en Ingresos.');
    expect(describeAddRow(customRow('OUTFLOW'))).toBe('Agregaste fila "Fila nueva" en Egresos.');
  });

  it('describes removals, renames and cell edits', () => {
    expect(describeRemoveRow({ label: 'Fila vieja', type: 'OUTFLOW' })).toBe('Eliminaste fila "Fila vieja".');
    expect(describeRenameRow('Antes', 'Después')).toBe('Renombraste "Antes" → "Después".');
    expect(describeEditCell({ rowLabel: 'Proveedor A', bucketLabel: 'Mayo', oldValue: 100, newValue: 200 }))
      .toContain('Cambiaste Proveedor A Mayo:');
    expect(describeClearCell({ rowLabel: 'Proveedor A', bucketLabel: 'Mayo', baseValue: 100 }))
      .toContain('Limpiaste override de Proveedor A Mayo');
  });

  it('describes draft creation and duplication', () => {
    expect(describeCreateDraft()).toBe('Propuesta creada desde Aprobado.');
    expect(describeDuplicateDraft('Escenario base')).toBe('Duplicada desde "Escenario base".');
  });

  it('serializes an override payload with every audited field', () => {
    const override: CellOverride = {
      id: 'co-1',
      scenarioId: 'draft-1',
      conceptKey: 'INFLOW:AR_COLLECTION:test',
      granularity: 'weekly',
      bucketKey: '2026-05-04',
      type: 'INFLOW',
      mode: 'REPLACE',
      value: 500,
      previousAggregatedValue: 400,
      createdBy: 'tester',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };

    expect(describeOverridePayload(override)).toEqual({
      conceptKey: 'INFLOW:AR_COLLECTION:test',
      bucketKey: '2026-05-04',
      granularity: 'weekly',
      type: 'INFLOW',
      value: 500,
      previousAggregatedValue: 400,
    });
  });
});

function customRow(type: PlanningCustomRow['type']): PlanningCustomRow {
  return {
    id: 'row-1',
    scenarioId: 'draft-1',
    conceptKey: `custom:${type}:row-1`,
    label: 'Fila nueva',
    type,
    category: 'MANUAL',
    createdBy: 'tester',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}
