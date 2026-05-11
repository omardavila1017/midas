import { describe, expect, it } from 'vitest';
import type { FinancialMovement } from '../../shared-finance/types';
import {
  aggregateRowValueForBucket,
  buildPlanningRows,
  conceptKeyForMovement,
} from './planningRowTaxonomy';

describe('planning row taxonomy', () => {
  it('keeps supplier rows and tags them with provider type for category grouping', () => {
    const movements: FinancialMovement[] = [
      movement({
        id: 'm1',
        subcategory: 'REFACCIONARIO',
        providerCategory: 'REFACCIONES',
        counterpartyName: 'Proveedor A',
        projectedAmount: 100,
      }),
      movement({
        id: 'm2',
        subcategory: 'REFACCIONARIO',
        counterpartyName: 'Proveedor B',
        projectedAmount: 250,
      }),
      movement({
        id: 'm3',
        subcategory: 'TECNOLOGIA Y SOPORTE',
        counterpartyName: 'Proveedor TI',
        projectedAmount: 75,
      }),
    ];

    const rows = buildPlanningRows({ movements, customRows: [], overrides: [] });

    expect(rows.filter((row) => row.category === 'AP_PAYMENT').map((row) => row.label).sort()).toEqual([
      'Proveedor A',
      'Proveedor B',
      'Proveedor TI',
    ]);
    expect(rows.find((row) => row.label === 'Proveedor A')?.subgroupLabel).toBe('REFACCIONARIO');
    expect(rows.find((row) => row.label === 'Proveedor A')?.providerCategoryLabel).toBe('REFACCIONES');
    expect(aggregateRowValueForBucket({
      conceptKey: conceptKeyForMovement(movements[0]),
      movementsInBucket: movements,
    })).toBe(100);
  });

  it('uses movement concept as the row label for non-supplier outflows', () => {
    const payroll = movement({
      id: 'payroll',
      category: 'PAYROLL',
      subcategory: undefined,
      counterpartyName: undefined,
      concept: 'Nómina semanal',
      projectedAmount: 500,
    });

    const rows = buildPlanningRows({ movements: [payroll], customRows: [], overrides: [] });

    expect(rows[0]?.label).toBe('Nómina semanal');
    expect(conceptKeyForMovement(payroll)).toBe('OUTFLOW:PAYROLL:nomina-semanal');
  });

  it('shows recurrent provider movements as editable future expense rows', () => {
    const recurring = movement({
      id: 'recurring-provider:2026-06:provider-diesel',
      sourceSystem: 'FORECAST',
      forecastMethod: 'DRIVER',
      counterpartyName: 'Proveedor Diesel',
      providerCategory: 'COMBUSTIBLE',
      subcategory: 'COMBUSTIBLE',
      concept: 'Pago recurrente Proveedor Diesel',
      projectedAmount: 50_000,
    });

    const rows = buildPlanningRows({ movements: [recurring], customRows: [], overrides: [] });
    const row = rows.find((item) => item.label === 'Proveedor Diesel');

    expect(row?.category).toBe('AP_PAYMENT');
    expect(row?.providerCategoryLabel).toBe('COMBUSTIBLE');
    expect(aggregateRowValueForBucket({
      conceptKey: conceptKeyForMovement(recurring),
      movementsInBucket: [recurring],
    })).toBe(50_000);
  });
});

function movement(patch: Partial<FinancialMovement>): FinancialMovement {
  const now = '2026-05-01T00:00:00.000Z';
  return {
    id: patch.id ?? 'm',
    sourceSystem: patch.sourceSystem ?? 'JDE',
    type: 'OUTFLOW',
    category: patch.category ?? 'AP_PAYMENT',
    subcategory: patch.subcategory,
    providerCategory: patch.providerCategory,
    counterpartyName: patch.counterpartyName,
    counterpartyType: 'SUPPLIER',
    concept: patch.concept ?? 'Factura',
    currency: 'MXN',
    originalAmount: patch.projectedAmount ?? 0,
    baseAmount: patch.projectedAmount ?? 0,
    projectedAmount: patch.projectedAmount ?? 0,
    projectedDate: '2026-05-15',
    confidenceScore: 90,
    confidenceBand: 'HIGH',
    forecastMethod: patch.forecastMethod ?? 'RULE',
    status: 'PROJECTED_BASE',
    lockState: 'RESTRICTED',
    createdAt: now,
    updatedAt: now,
  };
}
