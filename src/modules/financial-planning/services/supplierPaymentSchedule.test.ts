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
    expect(lowDecision).toMatchObject({ status: 'PENDING', paidAmount: 0, pendingAmount: 500, score: 10 });
    expect(dailyRow?.clientNamesExpected).toContain('Cliente · CXC-i-1');
    expect(dailyRow?.supplierNamesScheduled).toEqual(['Proveedor Alto', 'Proveedor Bajo']);
    expect(dailyRow?.outflowConcepts).toContain('Proveedor Alto · Factura m-high · F-m-high');
    expect(dailyRow?.supplierNamesPaid).toEqual(['Proveedor Alto']);
    expect(dailyRow?.supplierNamesPending).toEqual(['Proveedor Bajo']);
  });

  it('moves a supplier to a future date when later inflow makes the payment feasible', () => {
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
    const scheduled = result.movements.find((item) => item.id === 'm-high');

    expect(decision).toMatchObject({ status: 'DEFERRED', originalDate: '2026-05-02', estimatedDate: '2026-05-04' });
    expect(scheduled?.adjustedDate).toBe('2026-05-04');
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
});

function provider(id: string, name: string, score: number): Provider {
  return {
    id,
    name,
    type: 'Operativo',
    risk: 'Alto',
    paymentPeriod: '30 días',
    score,
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
