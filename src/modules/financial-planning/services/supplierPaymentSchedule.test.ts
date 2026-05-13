import { describe, expect, it } from 'vitest';
import type { Provider } from '../../../domain/types';
import type { FinancialMovement } from '../../shared-finance/types';
import { scheduleSupplierPaymentsByScore } from './supplierPaymentSchedule';

describe('supplierPaymentSchedule', () => {
  it('pays suppliers by descending score and defers lower priority when cash is short', () => {
    const high = movement('m-high', 'Proveedor Alto', 'p-high', 100, 700, '2026-05-02');
    const low = movement('m-low', 'Proveedor Bajo', 'p-low', 10, 500, '2026-05-02');

    const result = scheduleSupplierPaymentsByScore({
      movements: [inflow('i-1', 1000, '2026-05-02'), high, low],
      providers: [
        provider('p-high', 'Proveedor Alto', 100),
        provider('p-low', 'Proveedor Bajo', 10),
      ],
      startDate: '2026-05-01',
      endDate: '2026-05-05',
      initialCash: 0,
      minimumCash: 100,
      scenarioId: 'base',
    });

    const highDecision = result.plan.decisions.find((decision) => decision.movementId === 'm-high');
    const lowDecision = result.plan.decisions.find((decision) => decision.movementId === 'm-low');
    const dailyRow = result.plan.dailyRows.find((row) => row.date === '2026-05-02');

    expect(highDecision).toMatchObject({ status: 'PAID', estimatedDate: '2026-05-02', paidAmount: 700, score: 100 });
    expect(lowDecision).toMatchObject({ status: 'PARTIAL', paidAmount: 200, pendingAmount: 300, score: 10 });
    expect(dailyRow?.clientNamesExpected).toContain('Cliente · CXC-i-1');
    expect(dailyRow?.supplierNamesScheduled).toEqual(['Proveedor Alto', 'Proveedor Bajo']);
    expect(dailyRow?.outflowConcepts).toContain('Proveedor Alto · Factura m-high · F-m-high');
    expect(dailyRow?.supplierNamesPaid).toEqual(['Proveedor Alto', 'Proveedor Bajo']);
    expect(dailyRow?.supplierNamesPending).toEqual(['Proveedor Bajo']);
  });

  it('splits a supplier across dates when later inflow completes the payment', () => {
    const payment = movement('m-high', 'Proveedor Alto', 'p-high', 100, 700, '2026-05-02');

    const result = scheduleSupplierPaymentsByScore({
      movements: [inflow('i-1', 400, '2026-05-02'), inflow('i-2', 500, '2026-05-04'), payment],
      providers: [provider('p-high', 'Proveedor Alto', 100)],
      startDate: '2026-05-01',
      endDate: '2026-05-05',
      initialCash: 0,
      minimumCash: 100,
      scenarioId: 'base',
    });

    const decision = result.plan.decisions.find((item) => item.movementId === 'm-high');
    const scheduled = result.movements.filter((item) => item.id.startsWith('m-high:partial:'));

    expect(decision).toMatchObject({
      status: 'PARTIAL',
      originalDate: '2026-05-02',
      estimatedDate: '2026-05-04',
      paidAmount: 700,
      pendingAmount: 0,
    });
    expect(decision?.installments).toEqual([
      { date: '2026-05-02', amount: 300 },
      { date: '2026-05-04', amount: 400 },
    ]);
    expect(scheduled.map((item) => item.adjustedDate)).toEqual(['2026-05-02', '2026-05-04']);
  });

  it('manages non-JDE supplier AP payments and keeps the original due date', () => {
    const payment = movement('m-manual', 'Proveedor Manual', 'p-manual', 99, 300, '2026-05-06');
    payment.sourceSystem = 'MANUAL';
    payment.dueDate = '2026-05-01';

    const result = scheduleSupplierPaymentsByScore({
      movements: [payment],
      providers: [provider('p-manual', 'Proveedor Manual', 99)],
      startDate: '2026-05-06',
      endDate: '2026-05-07',
      initialCash: 1_000,
      minimumCash: 100,
      scenarioId: 'base',
    });

    expect(result.plan.decisions[0]).toMatchObject({
      status: 'DEFERRED',
      originalDate: '2026-05-01',
      estimatedDate: '2026-05-06',
      score: 99,
    });
  });

  it('does not pay suppliers before due date and then applies score order', () => {
    const high = movement('m-high', 'Proveedor Alto', 'p-high', 100, 700, '2026-05-02');
    high.dueDate = '2026-05-04';
    const low = movement('m-low', 'Proveedor Bajo', 'p-low', 10, 500, '2026-05-02');
    low.dueDate = '2026-05-04';

    const result = scheduleSupplierPaymentsByScore({
      movements: [inflow('i-1', 1000, '2026-05-02'), high, low],
      providers: [
        provider('p-high', 'Proveedor Alto', 100),
        provider('p-low', 'Proveedor Bajo', 10),
      ],
      startDate: '2026-05-01',
      endDate: '2026-05-05',
      initialCash: 0,
      minimumCash: 100,
      scenarioId: 'base',
    });

    const highDecision = result.plan.decisions.find((decision) => decision.movementId === 'm-high');
    const lowDecision = result.plan.decisions.find((decision) => decision.movementId === 'm-low');
    const earlyRow = result.plan.dailyRows.find((row) => row.date === '2026-05-02');

    expect(earlyRow?.suppliersPaid).toBe(0);
    expect(highDecision).toMatchObject({ status: 'PAID', estimatedDate: '2026-05-04', score: 100 });
    expect(lowDecision).toMatchObject({ status: 'PARTIAL', paidAmount: 200, pendingAmount: 300, score: 10 });
  });

  it('keeps critical suppliers untouched even when liquidity is short', () => {
    const critical = movement('m-critical', 'Proveedor Critico', 'p-critical', 100, 900, '2026-05-02');
    const result = scheduleSupplierPaymentsByScore({
      movements: [inflow('i-1', 500, '2026-05-02'), critical],
      providers: [provider('p-critical', 'Proveedor Critico', 100, { clasificacionAlberto: 'CRITICO' })],
      startDate: '2026-05-01',
      endDate: '2026-05-03',
      initialCash: 0,
      minimumCash: 100,
      scenarioId: 'base',
    });

    expect(result.plan.decisions).toHaveLength(0);
    expect(result.movements.find((item) => item.id === 'm-critical')).toBeTruthy();
    expect(result.plan.dailyRows.find((row) => row.date === '2026-05-02')?.closingCash).toBe(0);
  });

  it('partially schedules unlocked tax outflows while locked taxes remain fixed', () => {
    const movableTax = taxMovement('tax-iva', 700, '2026-05-02', 'RESTRICTED');
    const lockedTax = taxMovement('tax-imss', 300, '2026-05-02', 'LOCKED');
    const result = scheduleSupplierPaymentsByScore({
      movements: [inflow('i-1', 1_000, '2026-05-02'), movableTax, lockedTax],
      providers: [],
      startDate: '2026-05-01',
      endDate: '2026-05-03',
      initialCash: 0,
      minimumCash: 100,
      scenarioId: 'base',
    });

    expect(result.plan.decisions[0]).toMatchObject({
      movementId: 'tax-iva',
      status: 'PARTIAL',
      paidAmount: 600,
      pendingAmount: 100,
    });
    expect(result.movements.some((item) => item.id === 'tax-imss')).toBe(true);
  });
});

function provider(id: string, name: string, score: number, patch: Partial<Provider> = {}): Provider {
  return {
    id,
    name,
    type: 'Operativo',
    risk: 'Alto',
    paymentPeriod: '30 días',
    score,
    ...patch,
  };
}

function taxMovement(
  id: string,
  amount: number,
  date: string,
  lockState: FinancialMovement['lockState'],
): FinancialMovement {
  return {
    id,
    sourceSystem: 'TAX',
    sourceObjectId: id,
    type: 'OUTFLOW',
    category: 'TAX',
    counterpartyName: 'SAT',
    counterpartyType: 'TAX_AUTHORITY',
    concept: id,
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate: date,
    dueDate: date,
    confidenceScore: 80,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

function movement(
  id: string,
  providerName: string,
  providerId: string,
  score: number,
  amount: number,
  date: string,
): FinancialMovement {
  return {
    id,
    sourceSystem: 'JDE',
    sourceObjectId: `F-${id}`,
    type: 'OUTFLOW',
    category: 'AP_PAYMENT',
    counterpartyId: providerId,
    counterpartyName: providerName,
    counterpartyType: 'SUPPLIER',
    concept: `Factura ${id}`,
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate: date,
    dueDate: date,
    confidenceScore: score,
    confidenceBand: 'CONFIRMED',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'RESTRICTED',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

function inflow(id: string, amount: number, date: string): FinancialMovement {
  return {
    id,
    sourceSystem: 'JDE',
    sourceObjectId: `CXC-${id}`,
    type: 'INFLOW',
    category: 'AR_COLLECTION',
    counterpartyName: 'Cliente',
    counterpartyType: 'CUSTOMER',
    concept: `Cobranza ${id}`,
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate: date,
    confidenceScore: 80,
    confidenceBand: 'HIGH',
    forecastMethod: 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'UNLOCKED',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}
