import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManualPlanningEntry } from '../../shared-finance/types';
import {
  countManualEntryOccurrences,
  createManualPlanningEntry,
  expandManualPlanningEntriesToMovements,
  loadManualPlanningEntries,
  saveManualPlanningEntries,
} from './manualPlanningEntries';
import { PLANNING_MANUAL_ENTRIES_KEY } from './planningStorageKeys';

// Unreachable branch left uncovered on purpose: the `return addDays(date, 9999)` default of
// `nextOccurrence` (manualPlanningEntries.ts:215) is only reachable for ONE_TIME, and
// `enumerateDates` breaks out of the loop on ONE_TIME before ever calling it.

const WINDOW = {
  scenarioId: 'scenario-a',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  asOfDate: '2026-01-01',
};

function entry(patch: Partial<ManualPlanningEntry> = {}): ManualPlanningEntry {
  return {
    id: patch.id ?? 'manual-1',
    scenarioIds: patch.scenarioIds ?? ['scenario-a'],
    type: patch.type ?? 'OUTFLOW',
    category: patch.category ?? 'OTHER',
    name: patch.name ?? 'Movimiento manual',
    amount: patch.amount ?? 1000,
    startDate: patch.startDate ?? '2026-03-10',
    endDate: patch.endDate,
    recurrence: patch.recurrence ?? 'ONE_TIME',
    companyId: patch.companyId,
    businessUnitId: patch.businessUnitId,
    counterpartyName: patch.counterpartyName,
    description: patch.description,
    taxTreatment: patch.taxTreatment ?? 'UNCLASSIFIED',
    taxRate: patch.taxRate,
    taxBaseAmount: patch.taxBaseAmount,
    taxAmount: patch.taxAmount,
    status: patch.status ?? 'DRAFT',
    replacedAt: patch.replacedAt,
    createdBy: patch.createdBy ?? 'tester@senda.local',
    createdAt: patch.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: patch.updatedAt ?? '2026-01-01T00:00:00.000Z',
  };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('createManualPlanningEntry — validation branches', () => {
  const base = {
    scenarioIds: ['scenario-a'],
    type: 'OUTFLOW' as const,
    category: 'OTHER' as const,
    name: 'Pago',
    amount: 100,
    startDate: '2026-03-10',
    recurrence: 'ONE_TIME' as const,
  };

  it('rejects a blank name', () => {
    expect(() => createManualPlanningEntry({ ...base, name: '   ' })).toThrow('El nombre es obligatorio.');
  });

  it('rejects a non-positive or non-finite amount', () => {
    expect(() => createManualPlanningEntry({ ...base, amount: 0 })).toThrow('El monto debe ser mayor a cero.');
    expect(() => createManualPlanningEntry({ ...base, amount: Number.NaN })).toThrow('El monto debe ser mayor a cero.');
    expect(() => createManualPlanningEntry({ ...base, amount: -50 })).toThrow('El monto debe ser mayor a cero.');
  });

  it('rejects a malformed start date', () => {
    expect(() => createManualPlanningEntry({ ...base, startDate: '10/03/2026' })).toThrow('La fecha inicial no es válida.');
  });

  it('rejects an end date that is malformed or earlier than the start date', () => {
    expect(() => createManualPlanningEntry({ ...base, endDate: 'ayer' }))
      .toThrow('La fecha final debe ser igual o posterior a la inicial.');
    expect(() => createManualPlanningEntry({ ...base, endDate: '2026-03-01' }))
      .toThrow('La fecha final debe ser igual o posterior a la inicial.');
  });

  it('falls back to the custom scenario and drops whitespace-only optional fields', () => {
    const created = createManualPlanningEntry({
      ...base,
      scenarioIds: [],
      companyId: '   ',
      businessUnitId: '   ',
      counterpartyName: '   ',
      description: '   ',
    } as never);
    expect(created.scenarioIds).toEqual(['custom']);
    expect(created.companyId).toBeUndefined();
    expect(created.businessUnitId).toBeUndefined();
    expect(created.counterpartyName).toBeUndefined();
    expect(created.description).toBeUndefined();
  });

  it('keeps trimmed optional fields and honours explicit status/createdBy', () => {
    const created = createManualPlanningEntry({
      ...base,
      companyId: ' 00001 ',
      businessUnitId: ' BU ',
      counterpartyName: ' Proveedor ',
      description: ' Nota ',
      status: 'APPROVED',
      createdBy: 'alguien@senda.local',
      taxRate: 16,
      taxBaseAmount: 100,
      taxAmount: 16,
    });
    expect(created).toMatchObject({
      companyId: '00001',
      businessUnitId: 'BU',
      counterpartyName: 'Proveedor',
      description: 'Nota',
      status: 'APPROVED',
      createdBy: 'alguien@senda.local',
    });
  });

  it('derives the default tax treatment per category and type', () => {
    const taxPayment = createManualPlanningEntry({ ...base, category: 'TAX_PAYMENT' });
    const payroll = createManualPlanningEntry({ ...base, category: 'PAYROLL' });
    const supplier = createManualPlanningEntry({ ...base, category: 'SUPPLIER_PAYMENT' });
    const capex = createManualPlanningEntry({ ...base, category: 'CAPEX' });
    const opex = createManualPlanningEntry({ ...base, category: 'OPEX' });
    const inflow = createManualPlanningEntry({ ...base, type: 'INFLOW', category: 'MANUAL_INFLOW' });
    const other = createManualPlanningEntry({ ...base, category: 'MANUAL_OUTFLOW' });

    expect(taxPayment.taxTreatment).toBe('IVA_EXEMPT');
    expect(payroll.taxTreatment).toBe('IVA_EXEMPT');
    expect(supplier.taxTreatment).toBe('IVA_CREDITABLE');
    expect(capex.taxTreatment).toBe('IVA_CREDITABLE');
    expect(opex.taxTreatment).toBe('IVA_CREDITABLE');
    expect(inflow.taxTreatment).toBe('IVA_CAUSED');
    expect(other.taxTreatment).toBe('UNCLASSIFIED');
  });
});

describe('expandManualPlanningEntriesToMovements — category / recurrence branches', () => {
  it('maps every manual category to its movement category and counterparty type', () => {
    const cases: Array<[ManualPlanningEntry['category'], ManualPlanningEntry['type'], string, string]> = [
      ['SUPPLIER_PAYMENT', 'OUTFLOW', 'AP_PAYMENT', 'SUPPLIER'],
      ['TAX_PAYMENT', 'OUTFLOW', 'TAX', 'TAX_AUTHORITY'],
      ['PAYROLL', 'OUTFLOW', 'PAYROLL', 'EMPLOYEE'],
      ['CAPEX', 'OUTFLOW', 'CAPEX', 'SUPPLIER'],
      ['OPEX', 'OUTFLOW', 'OPEX', 'SUPPLIER'],
      ['MANUAL_INFLOW', 'INFLOW', 'MANUAL', 'CUSTOMER'],
      ['MANUAL_OUTFLOW', 'OUTFLOW', 'MANUAL', 'INTERNAL'],
      ['OTHER', 'OUTFLOW', 'MANUAL', 'INTERNAL'],
    ];

    for (const [category, type, expectedCategory, expectedCounterparty] of cases) {
      const [movement] = expandManualPlanningEntriesToMovements([entry({ category, type })], WINDOW);
      expect(movement.category, category).toBe(expectedCategory);
      expect(movement.counterpartyType, category).toBe(expectedCounterparty);
      expect(movement.lockState, category).toBe(category === 'TAX_PAYMENT' ? 'RESTRICTED' : 'UNLOCKED');
      // A single occurrence keeps the plain name (no `(1/N)` suffix).
      expect(movement.concept).toBe('Movimiento manual');
    }
  });

  it('expands weekly, biweekly and quarterly recurrences', () => {
    const weekly = expandManualPlanningEntriesToMovements(
      [entry({ recurrence: 'WEEKLY', startDate: '2026-03-02', endDate: '2026-03-23' })],
      WINDOW,
    );
    const biweekly = expandManualPlanningEntriesToMovements(
      [entry({ recurrence: 'BIWEEKLY', startDate: '2026-03-02', endDate: '2026-04-13' })],
      WINDOW,
    );
    const quarterly = expandManualPlanningEntriesToMovements(
      [entry({ recurrence: 'QUARTERLY', startDate: '2026-01-31', endDate: '2026-10-31' })],
      WINDOW,
    );

    expect(weekly.map((m) => m.projectedDate)).toEqual(['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23']);
    expect(biweekly.map((m) => m.projectedDate)).toEqual(['2026-03-02', '2026-03-16', '2026-03-30', '2026-04-13']);
    // Este test pineaba el defecto: cada paso avanzaba desde la ocurrencia
    // ANTERIOR, así que un día truncado por un mes corto (31 → 30-abr) se
    // quedaba truncado para siempre (31-ene · 30-abr · 30-jul · 30-oct). Ahora
    // cada ocurrencia se cuenta desde la fecha de INICIO, así que el día vuelve
    // en los meses que sí lo tienen.
    expect(quarterly.map((m) => m.projectedDate)).toEqual(['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31']);
    expect(weekly[0].concept).toBe('Movimiento manual (1/4)');
  });

  it('clips occurrences that fall outside the requested window', () => {
    const movements = expandManualPlanningEntriesToMovements(
      [entry({ recurrence: 'MONTHLY', startDate: '2026-01-15', endDate: '2026-12-15' })],
      { ...WINDOW, startDate: '2026-06-01', endDate: '2026-08-31' },
    );
    expect(movements.map((m) => m.projectedDate)).toEqual(['2026-06-15', '2026-07-15', '2026-08-15']);
  });

  it('tolerates zeroed month/day segments in an ISO-shaped start date', () => {
    const movements = expandManualPlanningEntriesToMovements(
      [entry({ startDate: '2026-00-00' })],
      WINDOW,
    );
    expect(movements.map((m) => m.projectedDate)).toEqual(['2026-01-01']);
  });

  it('marks approved entries with the approved status and higher confidence', () => {
    const [approved] = expandManualPlanningEntriesToMovements([entry({ status: 'APPROVED' })], WINDOW);
    const [draft] = expandManualPlanningEntriesToMovements([entry({ status: 'DRAFT' })], WINDOW);
    expect(approved.status).toBe('APPROVED');
    expect(approved.confidenceScore).toBe(78);
    expect(approved.comments).toContain('Escenario manual: aprobado');
    expect(draft.status).toBe('ADJUSTED');
    expect(draft.confidenceScore).toBe(58);
    expect(draft.comments).toContain('Escenario manual: propuesta');
  });

  it('keeps the description as the leading comment when present', () => {
    const [movement] = expandManualPlanningEntriesToMovements([entry({ description: 'Nota de tesorería' })], WINDOW);
    expect(movement.comments?.[0]).toBe('Nota de tesorería');
  });
});

describe('countManualEntryOccurrences', () => {
  it('counts recurring occurrences bounded by the range end', () => {
    expect(countManualEntryOccurrences(
      { startDate: '2026-01-15', endDate: undefined, recurrence: 'MONTHLY' },
      '2026-04-30',
    )).toBe(4);
  });

  it('returns zero when either boundary is not an ISO date', () => {
    expect(countManualEntryOccurrences(
      { startDate: 'no-es-fecha', endDate: undefined, recurrence: 'MONTHLY' },
      '2026-04-30',
    )).toBe(0);
    expect(countManualEntryOccurrences(
      { startDate: '2026-01-15', endDate: 'tampoco', recurrence: 'MONTHLY' },
      '2026-04-30',
    )).toBe(0);
  });
});

describe('loadManualPlanningEntries — persistence normalizer branches', () => {
  it('returns the fallback when nothing is stored', () => {
    const fallback = [entry({ id: 'fallback' })];
    expect(loadManualPlanningEntries(fallback)).toBe(fallback);
    expect(loadManualPlanningEntries()).toEqual([]);
  });

  it('returns the fallback when the payload is not an array', () => {
    localStorage.setItem(PLANNING_MANUAL_ENTRIES_KEY, JSON.stringify({ nope: true }));
    const fallback = [entry({ id: 'fallback' })];
    expect(loadManualPlanningEntries(fallback)).toBe(fallback);
  });

  it('returns the fallback when the payload is not valid JSON', () => {
    localStorage.setItem(PLANNING_MANUAL_ENTRIES_KEY, '{{{');
    const fallback = [entry({ id: 'fallback' })];
    expect(loadManualPlanningEntries(fallback)).toBe(fallback);
  });

  it('returns the fallback when every stored row is unusable', () => {
    localStorage.setItem(PLANNING_MANUAL_ENTRIES_KEY, JSON.stringify([
      null,
      'texto',
      42,
      { type: 'SIDEWAYS', category: 'OTHER', recurrence: 'ONE_TIME', name: 'x', amount: 1, startDate: '2026-01-01' },
      { type: 'OUTFLOW', category: 'NO_EXISTE', recurrence: 'ONE_TIME', name: 'x', amount: 1, startDate: '2026-01-01' },
      { type: 'OUTFLOW', category: 'OTHER', recurrence: 'ANUAL', name: 'x', amount: 1, startDate: '2026-01-01' },
      { type: 'OUTFLOW', category: 'OTHER', recurrence: 'ONE_TIME', name: '   ', amount: 1, startDate: '2026-01-01' },
      { type: 'OUTFLOW', category: 'OTHER', recurrence: 'ONE_TIME', name: 5, amount: 1, startDate: '2026-01-01' },
      { type: 'OUTFLOW', category: 'OTHER', recurrence: 'ONE_TIME', name: 'x', amount: 1, startDate: '01-01-2026' },
      { type: 'OUTFLOW', category: 'OTHER', recurrence: 'ONE_TIME', name: 'x', amount: 1, startDate: 20260101 },
      { type: 'OUTFLOW', category: 'OTHER', recurrence: 'ONE_TIME', name: 'x', amount: {}, startDate: '2026-01-01' },
      { type: 'OUTFLOW', category: 'OTHER', recurrence: 'ONE_TIME', name: 'x', amount: 0, startDate: '2026-01-01' },
    ]));
    const fallback = [entry({ id: 'fallback' })];
    expect(loadManualPlanningEntries(fallback)).toBe(fallback);
  });

  it('normalizes populated rows and whitespace-only optional fields alike', () => {
    localStorage.setItem(PLANNING_MANUAL_ENTRIES_KEY, JSON.stringify([
      {
        id: ' full ',
        scenarioIds: ['approved', '   ', 7],
        type: 'INFLOW',
        category: 'MANUAL_INFLOW',
        recurrence: 'MONTHLY',
        name: ' Ingreso ',
        amount: 1500,
        startDate: '2026-02-10',
        endDate: '2026-05-10',
        companyId: ' 00001 ',
        businessUnitId: ' BU ',
        counterpartyName: ' Cliente ',
        description: ' Nota ',
        taxTreatment: 'IVA_CREDITABLE',
        taxRate: 16,
        taxBaseAmount: 100,
        taxAmount: 16,
        status: 'APPROVED',
        replacedBySourceSystem: 'JDE',
        replacedBySourceObjectId: ' obj-1 ',
        replacedAt: ' 2026-03-01T00:00:00.000Z ',
        replacementNote: ' Sustituida ',
        createdBy: ' alguien@senda.local ',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: '   ',
        scenarioIds: 'no-es-arreglo',
        type: 'OUTFLOW',
        category: 'OTHER',
        recurrence: 'QUARTERLY',
        name: ' Egreso ',
        amount: '2500',
        startDate: '2026-05-10',
        endDate: '2026-05-01',
        companyId: '   ',
        businessUnitId: '   ',
        counterpartyName: '   ',
        description: '   ',
        taxTreatment: 'TAXABLE_IVA',
        taxRate: '8',
        taxBaseAmount: '100',
        taxAmount: -5,
        replacedBySourceSystem: 'NO_EXISTE',
        replacedBySourceObjectId: '   ',
        replacedAt: '   ',
        replacementNote: '   ',
        createdBy: '   ',
        createdAt: 12345,
        updatedAt: 12345,
      },
      {
        type: 'OUTFLOW',
        category: 'OPEX',
        recurrence: 'BIWEEKLY',
        name: 'Mínimo',
        amount: 10,
        startDate: '2026-06-01',
        endDate: 'no-es-fecha',
        taxTreatment: 'NO_EXISTE',
        taxRate: 99,
      },
    ]));

    const [full, blank, minimal] = loadManualPlanningEntries();

    expect(full).toMatchObject({
      id: 'full',
      scenarioIds: ['approved'],
      name: 'Ingreso',
      endDate: '2026-05-10',
      companyId: '00001',
      businessUnitId: 'BU',
      counterpartyName: 'Cliente',
      description: 'Nota',
      taxTreatment: 'IVA_CREDITABLE',
      taxRate: 16,
      taxBaseAmount: 100,
      taxAmount: 16,
      status: 'APPROVED',
      replacedBySourceSystem: 'JDE',
      replacedBySourceObjectId: 'obj-1',
      replacedAt: '2026-03-01T00:00:00.000Z',
      replacementNote: 'Sustituida',
      createdBy: 'alguien@senda.local',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(blank).toMatchObject({
      id: 'manual-entry-1',
      scenarioIds: ['custom'],
      amount: 2500,
      // endDate earlier than startDate is dropped.
      taxTreatment: 'IVA_CAUSED',
      taxRate: 8,
      taxBaseAmount: 100,
      status: 'DRAFT',
      createdBy: 'tesoreria@senda.local',
    });
    expect(blank.endDate).toBeUndefined();
    expect(blank.companyId).toBeUndefined();
    expect(blank.businessUnitId).toBeUndefined();
    expect(blank.counterpartyName).toBeUndefined();
    expect(blank.description).toBeUndefined();
    expect(blank.taxAmount).toBeUndefined();
    expect(blank.replacedBySourceSystem).toBeUndefined();
    expect(blank.replacedBySourceObjectId).toBeUndefined();
    expect(blank.replacedAt).toBeUndefined();
    expect(blank.replacementNote).toBeUndefined();
    expect(typeof blank.createdAt).toBe('string');
    expect(typeof blank.updatedAt).toBe('string');

    expect(minimal).toMatchObject({ id: 'manual-entry-2', category: 'OPEX' });
    // Unknown tax treatment falls back to the category default; unknown rate is dropped.
    expect(minimal.taxTreatment).toBe('IVA_CREDITABLE');
    expect(minimal.taxRate).toBeUndefined();
    expect(minimal.endDate).toBeUndefined();
    expect(minimal.taxBaseAmount).toBeUndefined();
    expect(minimal.taxAmount).toBeUndefined();
  });
});

describe('saveManualPlanningEntries', () => {
  it('removes the key when the list is empty and writes it otherwise', () => {
    saveManualPlanningEntries([entry()]);
    expect(localStorage.getItem(PLANNING_MANUAL_ENTRIES_KEY)).toContain('manual-1');
    saveManualPlanningEntries([]);
    expect(localStorage.getItem(PLANNING_MANUAL_ENTRIES_KEY)).toBeNull();
  });

  it('swallows storage write failures', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => saveManualPlanningEntries([entry()])).not.toThrow();
  });
});
