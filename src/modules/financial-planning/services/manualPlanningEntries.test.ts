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

describe('recurrencia mensual anclada a la fecha de inicio', () => {
  // Encadenar cada ocurrencia desde la ANTERIOR pierde el día para siempre en
  // cuanto un mes corto lo trunca: una entrada del 31-ene daba 31-ene · 28-feb
  // · 28-mar · 28-abr… Anclando al inicio, el truncamiento es local al mes
  // corto y el día vuelve en los meses que lo tienen.
  const monthly = (startDate: string, endDate: string) => expandManualPlanningEntriesToMovements(
    [createManualPlanningEntry({
      scenarioIds: ['s'], type: 'OUTFLOW', category: 'OPEX', name: 'Renta',
      amount: 1000, startDate, endDate, recurrence: 'MONTHLY',
    })],
    { scenarioId: 's', startDate: '2026-01-01', endDate: '2026-12-31', asOfDate: '2026-01-01' },
  ).map((m) => m.projectedDate);

  it('el día 31 vuelve después de febrero', () => {
    expect(monthly('2026-01-31', '2026-05-31')).toEqual([
      '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31',
    ]);
  });

  it('el día 30 vuelve después de febrero', () => {
    expect(monthly('2026-01-30', '2026-04-30')).toEqual([
      '2026-01-30', '2026-02-28', '2026-03-30', '2026-04-30',
    ]);
  });

  it('trimestral ancla igual', () => {
    const quarterly = expandManualPlanningEntriesToMovements(
      [createManualPlanningEntry({
        scenarioIds: ['s'], type: 'OUTFLOW', category: 'OPEX', name: 'Predial',
        amount: 1000, startDate: '2026-05-31', endDate: '2027-02-28', recurrence: 'QUARTERLY',
      })],
      { scenarioId: 's', startDate: '2026-01-01', endDate: '2027-12-31', asOfDate: '2026-01-01' },
    ).map((m) => m.projectedDate);
    expect(quarterly).toEqual(['2026-05-31', '2026-08-31', '2026-11-30', '2027-02-28']);
  });

  it('un día que existe en todos los meses no cambia', () => {
    expect(monthly('2026-01-15', '2026-03-15')).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
  });
});
