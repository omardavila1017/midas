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
        // Razón social (marcador COMERCIALIZADORA) sin categoría mapeada: se
        // queda en "Proveedores sin categoría", no se rescata como persona.
        movement({
          id: 'supplier-unknown-category',
          counterpartyName: 'Comercializadora del Norte',
          providerCategory: 'GIRO NO MAPEADO',
          subcategory: 'GIRO NO MAPEADO',
          projectedAmount: 900,
        }),
        movement({
          id: 'supplier-without-category',
          counterpartyName: 'Distribuidora Sin Catalogo',
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

    expect(rows.find((row) => row.label === 'Comercializadora del Norte')?.bucketLabel).toBe('Proveedores sin categoría');
    expect(rows.find((row) => row.label === 'Distribuidora Sin Catalogo')?.bucketLabel).toBe('Proveedores sin categoría');
    expect(rows.find((row) => row.label === 'Sin identificar · BANCO 123')?.bucketLabel).toBe('Egresos bancarios sin identificar');
    expect(rows.filter((row) => row.type === 'OUTFLOW').map((row) => row.bucketLabel)).not.toContain('Otros');
    expect(rows.filter((row) => row.type === 'OUTFLOW').map((row) => row.bucketLabel)).not.toContain('Otros egresos');
  });

  it('rescues person-name and payroll-account AP payments into Personal y nómina', () => {
    const rows = buildPlanningRows({
      movements: [
        // Persona física pagada por cuentas por pagar (finiquito/honorario/
        // reembolso) sin categoría de proveedor → rescatada por la heurística
        // de nombre de persona, en vez de quedar como "sin categoría".
        movement({
          id: 'bank:person',
          sourceSystem: 'BANK',
          counterpartyName: 'Juan Pérez López',
          providerCategory: undefined,
          subcategory: undefined,
          projectedAmount: 1_000,
        }),
        // Pago desde cuenta pagadora de nómina (subRole proveedores_nomina) sin
        // categoría y SIN nombre de persona → rescatado por la señal exacta de
        // la cuenta de banco, no por la heurística.
        movement({
          id: 'bank:nomina-account',
          sourceSystem: 'BANK',
          counterpartyName: 'Pago folio 8842',
          providerCategory: undefined,
          subcategory: 'proveedores_nomina',
          projectedAmount: 2_000,
        }),
      ],
      customRows: [],
      overrides: [],
    });

    expect(rows.find((row) => row.label === 'Juan Pérez López')?.bucketLabel).toBe('Personal y nómina');
    expect(rows.find((row) => row.label === 'Pago folio 8842')?.bucketLabel).toBe('Personal y nómina');
  });

  it('routes GL-derived categories/subcategories to the correct row buckets', () => {
    // Egreso re-categorizado a TAX por su cuenta contable → fila "Impuestos".
    const glTax = movement({
      id: 'bank:gl-tax',
      sourceSystem: 'BANK',
      type: 'OUTFLOW',
      category: 'TAX',
      counterpartyName: 'Sin identificar · BANAMEX CTA-1',
      counterpartyType: 'TAX_AUTHORITY',
      projectedAmount: 9_000,
    });
    // Egreso re-categorizado a OPEX → fila OPEX (no "sin identificar").
    const glOpex = movement({
      id: 'bank:gl-opex',
      sourceSystem: 'BANK',
      type: 'OUTFLOW',
      category: 'OPEX',
      counterpartyName: 'Sin identificar · BANAMEX CTA-1',
      projectedAmount: 3_000,
    });
    // Ingreso con subcategoría GL dentro de INCOME_BUCKETS → su fila de ingreso.
    const glInflow = movement({
      id: 'bank:gl-inflow',
      sourceSystem: 'BANK',
      type: 'INFLOW',
      category: 'AR_COLLECTION',
      subcategory: 'Federal',
      counterpartyName: 'Concentradora Federal',
      counterpartyType: 'CUSTOMER',
      projectedAmount: 12_000,
    });

    const rows = buildPlanningRows({ movements: [glTax, glOpex, glInflow], customRows: [], overrides: [] });

    expect(rows.find((r) => r.category === 'TAX')?.bucketLabel).toBe('Impuestos');
    expect(rows.find((r) => r.category === 'OPEX')?.bucketLabel).toBe('OPEX');
    const inflowRow = rows.find((r) => r.type === 'INFLOW');
    expect(inflowRow?.group).toBe('Ingresos · Federal');
    expect(inflowRow?.bucketLabel).toBe('Federal');
  });

  it('separa cuentas/empresas internas de "Proveedores sin categoría"', () => {
    const rows = buildPlanningRows({
      movements: [
        // CARGO de una pagadora propia promovido a AP por el rol de la cuenta,
        // sin proveedor cruzado (counterpartyType BANK) → traspaso interno.
        movement({
          id: 'bank:pagadora-unidentified',
          sourceSystem: 'BANK',
          counterpartyName: 'Sin identificar · BANAMEX 70141027881',
          counterpartyType: 'BANK',
          subcategory: 'proveedores',
          projectedAmount: 35_300_000,
        }),
        // Pago cruzado a una empresa interna (MULTICARGA, clasificación Filiales).
        movement({
          id: 'bank:multicarga',
          sourceSystem: 'BANK',
          counterpartyName: 'MULTICARGA SA DE CV',
          counterpartyType: 'SUPPLIER',
          providerCategory: 'Filiales',
          subcategory: 'Filiales',
          projectedAmount: 158_300,
        }),
      ],
      customRows: [],
      overrides: [],
    });

    expect(rows.find((r) => r.label === 'Sin identificar · BANAMEX 70141027881')?.bucketLabel)
      .toBe('Traspasos internos (cuentas pagadoras)');
    expect(rows.find((r) => r.label === 'MULTICARGA SA DE CV')?.bucketLabel)
      .toBe('Empresas del grupo');
    // Ninguno cae en "Proveedores sin categoría".
    expect(rows.map((r) => r.bucketLabel)).not.toContain('Proveedores sin categoría');
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
