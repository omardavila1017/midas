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
    expect(rows.find((row) => row.label === 'Proveedor A')?.bucketLabel).toBe('Flota');
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
    expect(row?.bucketLabel).toBe('Flota');
    expect(aggregateRowValueForBucket({
      conceptKey: conceptKeyForMovement(recurring),
      movementsInBucket: [recurring],
    })).toBe(50_000);
  });

  it('groups bank inflows by business unit and keeps crossed client as row detail', () => {
    const inflow = movement({
      id: 'bank:multicarga',
      sourceSystem: 'BANK',
      type: 'INFLOW',
      category: 'AR_COLLECTION',
      businessUnitId: 'MULTICARGA',
      subcategory: 'Multicarga',
      counterpartyName: 'Cliente Multicarga',
      counterpartyType: 'CUSTOMER',
      concept: 'Cobro factura F-100',
      projectedAmount: 25_000,
    });

    const rows = buildPlanningRows({ movements: [inflow], customRows: [], overrides: [] });

    expect(rows[0]?.group).toBe('Ingresos · Multicarga');
    expect(rows[0]?.bucketLabel).toBe('Multicarga');
    expect(rows[0]?.label).toBe('Cliente Multicarga');
    expect(conceptKeyForMovement(inflow)).toBe('INFLOW:AR_COLLECTION:cliente-multicarga');
  });

  it('uses providerCategory as bucket source when the catalog lookup cannot resolve the supplier', () => {
    const rows = buildPlanningRows({
      movements: [
        movement({
          id: 'bank-unmatched-provider',
          sourceSystem: 'BANK',
          counterpartyId: undefined,
          counterpartyName: 'AIRE HIDRAULICOS Y NEU',
          providerCategory: 'MANTENIMIENTO INDUSTRIAL',
          subcategory: 'MANTENIMIENTO INDUSTRIAL',
          projectedAmount: 1200,
        }),
      ],
      customRows: [],
      overrides: [],
    });

    expect(rows[0]?.providerCategoryLabel).toBe('MANTENIMIENTO INDUSTRIAL');
    expect(rows[0]?.bucketLabel).toBe('Flota');
  });

  it('treats CHASIS as a classified fleet supplier category', () => {
    const rows = buildPlanningRows({
      movements: [
        movement({
          id: 'supplier-chasis',
          counterpartyName: 'Proveedor Chasis',
          providerCategory: 'CHASIS',
          subcategory: 'CHASIS',
          projectedAmount: 1800,
        }),
      ],
      customRows: [],
      overrides: [],
    });

    expect(rows[0]?.providerCategoryLabel).toBe('CHASIS');
    expect(rows[0]?.bucketLabel).toBe('Flota');
  });

  it('separates uncategorized suppliers from unidentified bank outflows', () => {
    const rows = buildPlanningRows({
      movements: [
        movement({
          id: 'supplier-unknown-category',
          counterpartyName: 'Proveedor conocido',
          providerCategory: 'GIRO NO MAPEADO',
          subcategory: 'GIRO NO MAPEADO',
          projectedAmount: 900,
        }),
        movement({
          id: 'supplier-without-category',
          counterpartyName: 'Proveedor sin catalogo',
          subcategory: undefined,
          projectedAmount: 700,
        }),
        movement({
          id: 'bank-unidentified',
          sourceSystem: 'BANK',
          category: 'TRANSFER',
          counterpartyName: 'Sin identificar · BANCO 123',
          counterpartyType: 'BANK',
          concept: 'Cargo folio 123',
          projectedAmount: 500,
        }),
      ],
      customRows: [],
      overrides: [],
    });

    expect(rows.find((row) => row.label === 'Proveedor conocido')?.bucketLabel).toBe('Proveedores sin categoría');
    expect(rows.find((row) => row.label === 'Proveedor sin catalogo')?.bucketLabel).toBe('Proveedores sin categoría');
    expect(rows.find((row) => row.label === 'Sin identificar · BANCO 123')?.bucketLabel).toBe('Egresos bancarios sin identificar');
    expect(rows.filter((row) => row.type === 'OUTFLOW').map((row) => row.bucketLabel)).not.toContain('Otros');
    expect(rows.filter((row) => row.type === 'OUTFLOW').map((row) => row.bucketLabel)).not.toContain('Otros egresos');
  });
});

function movement(patch: Partial<FinancialMovement>): FinancialMovement {
  const now = '2026-05-01T00:00:00.000Z';
  return {
    id: patch.id ?? 'm',
    sourceSystem: patch.sourceSystem ?? 'JDE',
    type: patch.type ?? 'OUTFLOW',
    category: patch.category ?? 'AP_PAYMENT',
    subcategory: patch.subcategory,
    businessUnitId: patch.businessUnitId,
    providerCategory: patch.providerCategory,
    counterpartyName: patch.counterpartyName,
    counterpartyType: patch.counterpartyType ?? 'SUPPLIER',
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
