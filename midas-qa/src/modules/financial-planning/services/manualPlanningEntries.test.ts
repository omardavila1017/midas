import { describe, expect, it } from 'vitest';
import {
  createManualPlanningEntry,
  expandManualPlanningEntriesToMovements,
} from './manualPlanningEntries';

describe('manualPlanningEntries', () => {
  it('expands monthly manual entries into scenario movements', () => {
    const entry = createManualPlanningEntry({
      scenarioIds: ['scenario-a'],
      type: 'INFLOW',
      category: 'MANUAL_INFLOW',
      name: 'Viaje especial sin factura',
      amount: 1000,
      startDate: '2026-05-15',
      endDate: '2026-07-15',
      recurrence: 'MONTHLY',
      counterpartyName: 'Cliente especial',
      taxTreatment: 'IVA_CAUSED',
    });

    const movements = expandManualPlanningEntriesToMovements([entry], {
      scenarioId: 'scenario-a',
      startDate: '2026-05-01',
      endDate: '2026-12-31',
      asOfDate: '2026-05-01',
    });

    expect(movements).toHaveLength(3);
    expect(movements.map((movement) => movement.projectedDate)).toEqual([
      '2026-05-15',
      '2026-06-15',
      '2026-07-15',
    ]);
    expect(movements[0]).toMatchObject({
      sourceSystem: 'MANUAL',
      type: 'INFLOW',
      category: 'MANUAL',
      counterpartyName: 'Cliente especial',
      taxTreatment: 'IVA_CAUSED',
    });
  });

  it('does not emit movements for another scenario', () => {
    const entry = createManualPlanningEntry({
      scenarioIds: ['scenario-a'],
      type: 'OUTFLOW',
      category: 'SUPPLIER_PAYMENT',
      name: 'Pago proveedor confirmado',
      amount: 2500,
      startDate: '2026-05-20',
      recurrence: 'ONE_TIME',
    });

    const movements = expandManualPlanningEntriesToMovements([entry], {
      scenarioId: 'scenario-b',
      startDate: '2026-05-01',
      endDate: '2026-12-31',
      asOfDate: '2026-05-01',
    });

    expect(movements).toHaveLength(0);
  });

  it('expands expected commitments with company metadata and skips replaced placeholders', () => {
    const payroll = createManualPlanningEntry({
      scenarioIds: ['approved'],
      type: 'OUTFLOW',
      category: 'PAYROLL',
      name: 'Nómina semanal',
      amount: 5000,
      startDate: '2026-05-22',
      recurrence: 'ONE_TIME',
      companyId: '00001',
    });
    const replaced = {
      ...payroll,
      id: 'manual-entry-replaced',
      replacedAt: '2026-05-10T00:00:00.000Z',
      replacedBySourceSystem: 'PAYROLL' as const,
    };

    const movements = expandManualPlanningEntriesToMovements([payroll, replaced], {
      scenarioId: 'approved',
      startDate: '2026-05-01',
      endDate: '2026-12-31',
      asOfDate: '2026-05-01',
    });

    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      category: 'PAYROLL',
      companyId: '00001',
      counterpartyType: 'EMPLOYEE',
      taxTreatment: 'IVA_EXEMPT',
    });
  });
});
