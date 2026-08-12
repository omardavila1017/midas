import { describe, expect, it } from 'vitest';
import type { FinancialMovement } from '../../shared-finance/types';
import {
  aggregateRowValueForBucket,
  buildPlanningRows,
  conceptKeyForMovement,
} from './planningRowTaxonomy';

describe('planning row taxonomy', () => {
  it('keeps one row per supplier and buckets it by the raw JDE pay classification pair', () => {
    const movements: FinancialMovement[] = [
      movement({
        id: 'm1',
        subcategory: 'REFACCIONARIO',
        providerCategory: 'REFACCIONES',
        payClass: 'Servicios',
        payClassFinanciera: '010 - Refacciones y Llantas',
        counterpartyName: 'Proveedor A',
        projectedAmount: 100,
      }),
      movement({
        id: 'm2',
        subcategory: 'REFACCIONARIO',
        payClass: 'Servicios',
        payClassFinanciera: '010 - Refacciones y Llantas',
        counterpartyName: 'Proveedor B',
        projectedAmount: 250,
      }),
      movement({
        id: 'm3',
        subcategory: 'TECNOLOGIA Y SOPORTE',
        payClass: 'Servicios',
        payClassFinanciera: '180 - Proveedores TI',
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
    // El bucket es el par CRUDO —con su prefijo numérico— no el generalizado
    // ("Flota"), que es justo lo que este cambio reemplaza.
    expect(rows.find((row) => row.label === 'Proveedor A')?.bucketLabel)
      .toBe('Servicios · 010 - Refacciones y Llantas');
    expect(rows.find((row) => row.label === 'Proveedor B')?.bucketLabel)
      .toBe('Servicios · 010 - Refacciones y Llantas');
    // Misma clasificación general, financiera distinta → grupo distinto.
    expect(rows.find((row) => row.label === 'Proveedor TI')?.bucketLabel)
      .toBe('Servicios · 180 - Proveedores TI');
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
      payClass: 'Directos',
      payClassFinanciera: '040 - Combustibles',
      concept: 'Pago recurrente Proveedor Diesel',
      projectedAmount: 50_000,
    });

    const rows = buildPlanningRows({ movements: [recurring], customRows: [], overrides: [] });
    const row = rows.find((item) => item.label === 'Proveedor Diesel');

    expect(row?.category).toBe('AP_PAYMENT');
    expect(row?.providerCategoryLabel).toBe('COMBUSTIBLE');
    // Un genérico (`Directos`) ya NO pierde la carrera: el par se muestra
    // completo, tal cual lo manda JDE.
    expect(row?.bucketLabel).toBe('Directos · 040 - Combustibles');
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

  it('muestra los centinelas de JDE como su propio grupo, no en un cajón de sastre', () => {
    // Los tres valores medidos en `jde.Pago_Proveedor` 2026 que
    // `usableJdeProviderCategory` descarta a propósito para poder bucketizar.
    // Aquí tienen que sobrevivir TAL CUAL: son el punto del cambio — Finanzas
    // necesita ver cuánto dinero cuelga de cada uno para mandarlo a corregir.
    const rows = buildPlanningRows({
      movements: [
        movement({
          id: 'sentinel-quotes',
          counterpartyName: 'Proveedor Comillas',
          payClass: '" "',
          projectedAmount: 62_960_000,
        }),
        movement({
          id: 'sentinel-dash',
          counterpartyName: 'Proveedor Guion',
          payClassFinanciera: '-                              .',
          projectedAmount: 900,
        }),
        movement({
          id: 'sentinel-por-clasificar',
          counterpartyName: 'Proveedor Por Clasificar',
          payClass: 'Servicios',
          payClassFinanciera: '220 - Por Clasificar',
          projectedAmount: 431_440_000,
        }),
      ],
      customRows: [],
      overrides: [],
    });

    expect(rows.find((row) => row.label === 'Proveedor Comillas')?.bucketLabel).toBe('" "');
    // El whitespace se colapsa (si no, `-   .` y `-      .` serían grupos
    // distintos e idénticos a la vista), pero nada más se toca.
    expect(rows.find((row) => row.label === 'Proveedor Guion')?.bucketLabel).toBe('- .');
    expect(rows.find((row) => row.label === 'Proveedor Por Clasificar')?.bucketLabel)
      .toBe('Servicios · 220 - Por Clasificar');
    expect(rows.map((row) => row.bucketLabel)).not.toContain('Proveedores sin categoría');
  });

  it('usa un solo lado del par cuando el otro viene vacío, y no repite el valor', () => {
    const rows = buildPlanningRows({
      movements: [
        // CXP abierto: `/antiguedadsaldos` no manda la financiera y el proveedor
        // nunca se ha pagado, así que el overlay no la puede prestar.
        movement({
          id: 'cxp:solo-general',
          counterpartyName: 'Proveedor Solo General',
          payClass: 'Servicios',
          projectedAmount: 700,
        }),
        // Las dos fuentes coinciden → una sola etiqueta, no `Servicios · Servicios`.
        movement({
          id: 'cxp:duplicado',
          counterpartyName: 'Proveedor Duplicado',
          payClass: 'Bancario',
          payClassFinanciera: 'Bancario',
          projectedAmount: 500,
        }),
      ],
      customRows: [],
      overrides: [],
    });

    expect(rows.find((row) => row.label === 'Proveedor Solo General')?.bucketLabel).toBe('Servicios');
    expect(rows.find((row) => row.label === 'Proveedor Duplicado')?.bucketLabel).toBe('Bancario');
  });

  it('separates suppliers without any pay class from unidentified bank outflows', () => {
    const rows = buildPlanningRows({
      movements: [
        // Proveedor con categoría generalizable pero SIN clasificación de pago:
        // ya no se rescata a un bucket deducido — se confiesa como sin clasificar.
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
        // Persona física pagada por cuentas por pagar (finiquito/honorario): la
        // heurística de nombre que la rescataba a "Personal y nómina" era
        // justamente deducción, no dato de JDE — ya no aplica al agrupar.
        movement({
          id: 'bank:person',
          sourceSystem: 'BANK',
          counterpartyName: 'Juan Pérez López',
          projectedAmount: 1_000,
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

    expect(rows.find((row) => row.label === 'Comercializadora del Norte')?.bucketLabel).toBe('Sin clasificación de pago');
    expect(rows.find((row) => row.label === 'Distribuidora Sin Catalogo')?.bucketLabel).toBe('Sin clasificación de pago');
    expect(rows.find((row) => row.label === 'Juan Pérez López')?.bucketLabel).toBe('Sin clasificación de pago');
    expect(rows.find((row) => row.label === 'Sin identificar · BANCO 123')?.bucketLabel).toBe('Egresos bancarios sin identificar');
    expect(rows.filter((row) => row.type === 'OUTFLOW').map((row) => row.bucketLabel)).not.toContain('Otros');
    expect(rows.filter((row) => row.type === 'OUTFLOW').map((row) => row.bucketLabel)).not.toContain('Otros egresos');
  });

  it('la identidad de fila NO depende del grupo — los CellOverride no se huerfanan', () => {
    // `conceptKey` es lo que amarra un `CellOverride` / custom row del usuario a
    // su fila. Si el bucket entrara en la llave, cambiar el agrupamiento habría
    // desprendido TODO lo capturado a mano (la clase de defecto de 2026-08-10).
    // Este pin hace que un cambio así truene aquí en vez de en producción.
    const sinClase = movement({
      id: 'm1',
      counterpartyName: 'Proveedor A',
      providerCategory: 'REFACCIONES',
      projectedAmount: 100,
    });
    const conClase = movement({
      ...sinClase,
      payClass: 'Servicios',
      payClassFinanciera: '010 - Refacciones y Llantas',
    });

    expect(conceptKeyForMovement(sinClase)).toBe('OUTFLOW:AP_PAYMENT:proveedor-a');
    expect(conceptKeyForMovement(conClase)).toBe(conceptKeyForMovement(sinClase));
    // …aunque el bucket sí cambie.
    const [rowSin] = buildPlanningRows({ movements: [sinClase], customRows: [], overrides: [] });
    const [rowCon] = buildPlanningRows({ movements: [conClase], customRows: [], overrides: [] });
    expect(rowSin.bucketLabel).not.toBe(rowCon.bucketLabel);
    expect(rowSin.conceptKey).toBe(rowCon.conceptKey);
  });

  it('agrupa los egresos que no son pago a proveedor por su categoría en español', () => {
    const rows = buildPlanningRows({
      movements: [
        movement({ id: 'payroll', category: 'PAYROLL', counterpartyName: 'Nómina semanal', projectedAmount: 10 }),
        movement({ id: 'tax', category: 'TAX', counterpartyName: 'IVA', projectedAmount: 20 }),
        movement({ id: 'debt', category: 'DEBT', counterpartyName: 'Convenio', projectedAmount: 30 }),
        movement({ id: 'opex', category: 'OPEX', counterpartyName: 'Arrendamiento', projectedAmount: 40 }),
        movement({ id: 'capex', category: 'CAPEX', counterpartyName: 'Equipo', projectedAmount: 50 }),
      ],
      customRows: [],
      overrides: [],
    });

    expect(rows.map((row) => row.bucketLabel).sort()).toEqual([
      'CAPEX', 'Deuda', 'Impuestos', 'Nómina', 'OPEX',
    ]);
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
    payClass: patch.payClass,
    payClassFinanciera: patch.payClassFinanciera,
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
