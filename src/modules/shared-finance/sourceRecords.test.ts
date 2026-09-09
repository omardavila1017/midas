import { describe, expect, it } from 'vitest';
import {
  buildPurchaseReceiptMovements,
  estimatedPurchaseDueDate,
  normalizeCancelledAt,
  parsePurchaseTaxRate,
  purchaseTaxMeta,
} from './sourceRecords';
import { comprasToPurchaseReceipts } from '../../domain/comprasToPurchaseReceipts';
import type { ComprasRecord } from '../../services/jdeTypes';
import type { Provider } from '../../domain/types';
import {
  generalizeCategoria,
  UNCATEGORIZED_PROVIDER_BUCKET,
} from '../financial-planning/services/providerCategoryGeneralization';

function comprasRecord(overrides: Partial<ComprasRecord> = {}): ComprasRecord {
  return {
    cia: '00001',
    noProveedor: '71601541',
    nombreProveedor: 'Test Supplier',
    noOrden: '18889',
    tipoOrden: 'OS',
    descTipoOrden: 'Catalogadas almacén',
    lineaOrden: 4,
    noProducto: '500102003103',
    descProducto: 'Producto test',
    concepto: 'Concepto test',
    cantidad: 100,
    precioUnitario: 16.85,
    importeTotal: 1685,
    moneda: 'MXP',
    tipoCambio: 1,
    fechaPedido: '2026-04-01',
    fechaRecepcion: '2026-04-10',
    diasCredito: 30,
    fechaPagoProyectada: '2026-05-10',
    noFactura: '675996',
    centroCostos: '101',
    categoria: 'IND',
    descCategoria: 'Indirectos',
    familia: 'PLI',
    descFamilia: 'PRODUCTOS DE LIMPIEZA',
    subFamilia: 'QDA',
    descSubFamilia: 'QUÍMICOS DE LIMPIEZA',
    estadoSiguiente: '380',
    tasaFiscal: 'IVA16',
    cancelada: false,
    facturada: true,
    ...overrides,
  };
}

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'p1',
    name: 'Test Supplier',
    type: 'Combustibles',
    risk: 'Medio',
    paymentPeriod: '30 días',
    numProveedorJDE: '71601541',
    ...overrides,
  };
}

function buildMovements(providers?: Provider[]) {
  const receipts = comprasToPurchaseReceipts([comprasRecord()], { asOfDate: '2026-04-15' });
  return buildPurchaseReceiptMovements({
    purchaseReceipts: receipts,
    cxpRecords: [],
    companyCode: 'all',
    asOfDate: '2026-04-15',
    providers,
  });
}

describe('buildPurchaseReceiptMovements — clasificación de pago heredada', () => {
  /**
   * `/compras` NO manda clasificación de proveedor (sólo el árbol de producto),
   * así que una OC nunca podría agruparse por clasificación de pago con lo que
   * trae su propio API. El overlay le presta el par del último pago cruzado de
   * ese proveedor; sin overlay se queda sin par y se confiesa como tal.
   */
  const receipts = () => comprasToPurchaseReceipts([comprasRecord()], { asOfDate: '2026-04-15' });

  it('hereda el par del proveedor cuando el overlay lo tiene', () => {
    const [movement] = buildPurchaseReceiptMovements({
      purchaseReceipts: receipts(),
      cxpRecords: [],
      companyCode: 'all',
      asOfDate: '2026-04-15',
      // `normalizeJde('71601541')` = '71601541' (ya sin ceros a la izquierda).
      payClassByProvider: new Map([['71601541', {
        payClass: 'Servicios',
        payClassFinanciera: '010 - Refacciones y Llantas',
      }]]),
    });

    expect(movement.payClass).toBe('Servicios');
    expect(movement.payClassFinanciera).toBe('010 - Refacciones y Llantas');
  });

  it('se queda sin par cuando el proveedor nunca se ha pagado — no inventa', () => {
    const [sinOverlay] = buildPurchaseReceiptMovements({
      purchaseReceipts: receipts(),
      cxpRecords: [],
      companyCode: 'all',
      asOfDate: '2026-04-15',
    });
    const [otroProveedor] = buildPurchaseReceiptMovements({
      purchaseReceipts: receipts(),
      cxpRecords: [],
      companyCode: 'all',
      asOfDate: '2026-04-15',
      payClassByProvider: new Map([['99999', { payClass: 'Servicios' }]]),
    });

    expect(sinOverlay.payClass).toBeUndefined();
    expect(sinOverlay.payClassFinanciera).toBeUndefined();
    expect(otroProveedor.payClass).toBeUndefined();
  });
});

describe('sourceRecords', () => {
  it('treats blank, zero and time-only cancellation values as active', () => {
    expect(normalizeCancelledAt('')).toBeUndefined();
    expect(normalizeCancelledAt('0')).toBeUndefined();
    expect(normalizeCancelledAt('00:00:00')).toBeUndefined();
  });

  it('recognizes real cancellation dates', () => {
    expect(normalizeCancelledAt('2026-04-13 00:00:00')).toBe('2026-04-13');
  });

  it('parses fiscal tax rates from purchase report labels', () => {
    expect(parsePurchaseTaxRate('IVA16')).toBe(16);
    expect(parsePurchaseTaxRate('IVA8')).toBe(8);
    expect(parsePurchaseTaxRate('')).toBeUndefined();
  });

  it('calculates creditable IVA from gross purchase amount', () => {
    const meta = purchaseTaxMeta(1160, 16);
    expect(meta.taxTreatment).toBe('IVA_CREDITABLE');
    expect(meta.taxBaseAmount).toBeCloseTo(1000);
    expect(meta.taxAmount).toBeCloseTo(160);
    expect(purchaseTaxMeta(500, undefined)).toEqual({ taxTreatment: 'UNCLASSIFIED' });
  });

  it('estimates purchase due date from receipt date plus credit days', () => {
    expect(estimatedPurchaseDueDate({
      receiptDate: '2026-04-15',
      orderDate: '2026-04-01',
      creditDays: 15,
    })).toBe('2026-04-30');
  });
});

describe('buildPurchaseReceiptMovements — provider catalog rules', () => {
  it('locks the OC egreso when the provider is inamovible (igual que CXP)', () => {
    const [m] = buildMovements([provider({ flexibility: 'inamovible' })]);
    expect(m.lockState).toBe('LOCKED');
    expect(m.ruleApplied).toContain('inamovible');
    expect(m.comments?.some((c) => c.includes('inamovible'))).toBe(true);
  });

  it('keeps confidence-based lock for a flexible provider', () => {
    const [m] = buildMovements([provider({ flexibility: 'flexible' })]);
    // CONFIRMED (OC recibida) → RESTRICTED, no LOCKED.
    expect(m.lockState).toBe('RESTRICTED');
  });

  it('falls back to confidence lock and family category without a catalog', () => {
    const [m] = buildMovements();
    expect(m.lockState).toBe('RESTRICTED');
    // La FAMILIA ("PRODUCTOS DE LIMPIEZA"), no la categoría padre
    // ("Indirectos"), que es el nivel de arriba del árbol de compras y no
    // describe el gasto — tomarla tapaba ~$120M de Flota (ver CLAUDE.md,
    // corrida 2026-08-05b). El nombre de este test siempre dijo "family".
    expect(m.providerCategory).toBe('PRODUCTOS DE LIMPIEZA');
  });

  it('uses the provider type as providerCategory when resolved', () => {
    const [m] = buildMovements([provider({ type: 'Combustibles', flexibility: 'flexible' })]);
    expect(m.providerCategory).toBe('Combustibles');
  });

  it('skips OCs already cleared via AuxiliarContable (paidPurchaseOrderKeys)', () => {
    const receipts = comprasToPurchaseReceipts([comprasRecord()], { asOfDate: '2026-04-15' });
    const paid = new Set(['00001::18889']);
    const movements = buildPurchaseReceiptMovements({
      purchaseReceipts: receipts,
      cxpRecords: [],
      companyCode: 'all',
      asOfDate: '2026-04-15',
      paidPurchaseOrderKeys: paid,
    });
    expect(movements).toHaveLength(0);
  });

  it('keeps OCs whose noOrden is NOT in paidPurchaseOrderKeys', () => {
    const receipts = comprasToPurchaseReceipts([comprasRecord()], { asOfDate: '2026-04-15' });
    const paid = new Set(['00001::99999']);
    const movements = buildPurchaseReceiptMovements({
      purchaseReceipts: receipts,
      cxpRecords: [],
      companyCode: 'all',
      asOfDate: '2026-04-15',
      paidPurchaseOrderKeys: paid,
    });
    expect(movements).toHaveLength(1);
  });
});

describe('buildPurchaseReceiptMovements — árbol de clasificación de compras (medido en BD)', () => {
  /**
   * `jde.Compras` clasifica en dos niveles: `Desc_Categoria` es el PADRE y
   * `Desc_Familia` el HIJO. Cifras de las OCs 2026 medidas por MCP midas-db.
   */
  const pick = (descCategoria: string, descFamilia: string) => {
    const receipts = comprasToPurchaseReceipts(
      [{ ...comprasRecord(), descCategoria, descFamilia, descSubFamilia: '' }],
      { asOfDate: '2026-04-15' },
    );
    return buildPurchaseReceiptMovements({
      purchaseReceipts: receipts,
      cxpRecords: [],
      companyCode: 'all',
      asOfDate: '2026-04-15',
    })[0]?.providerCategory;
  };

  it('la familia le gana al padre genérico "Directos" (~$120M de Flota que se perdían)', () => {
    expect(pick('Directos', 'MOTOR')).toBe('MOTOR');                       // $22.56M
    expect(pick('Directos', 'CARROCERÍA')).toBe('CARROCERÍA');             // $20.36M
    expect(pick('Directos', 'LLANTAS')).toBe('LLANTAS');                   // $10.94M
    expect(pick('Indirectos', 'UNIFORMES')).toBe('UNIFORMES');             // $6.03M
    // "Servicios" tapaba el arrendamiento inmobiliario ($59.22M) y TI ($22.56M)
    expect(pick('Servicios', 'ARRENDAMIENTO INMOBILIARIO')).toBe('ARRENDAMIENTO INMOBILIARIO');
    expect(pick('Servicios', 'TI PROYECTOS')).toBe('TI PROYECTOS');
  });

  it('descarta los centinelas del propio API y cae al padre', () => {
    // "Seleccionar Familia" es el placeholder del capturista (1,050 líneas /
    // $4.28M en 2026): no es clasificación usable, así que cede al padre — que
    // como último recurso se conserva, pero no generaliza a ningún bucket.
    // Queda en "Proveedores sin categoría" a propósito: la OC de verdad no
    // está clasificada en JDE (defecto de captura, no de Midas).
    expect(pick('Directos', 'Seleccionar Familia')).toBe('Directos');
    expect(generalizeCategoria('Directos')).toBe(UNCATEGORIZED_PROVIDER_BUCKET);
    // `.` como categoría (sentinel de JDE) no debe tapar a la familia.
    expect(pick('.', 'CONSULTORÍA')).toBe('CONSULTORÍA');
  });
});

describe('subcategory de la OC — los centinelas de JDE no se pintan como categoría', () => {
  // `subcategory` es la etiqueta que el usuario LEE en el grid. Sin el gate,
  // los placeholders del capturista (`.` como Desc_Categoria, `Seleccionar
  // Familia` como Desc_Familia — 1,050 líneas / $4.28M medidas en OCs 2026) se
  // mostraban como si fueran una categoría de gasto real.
  const subcategoryFor = (patch: Partial<ComprasRecord>) => {
    const receipts = comprasToPurchaseReceipts([comprasRecord(patch)], { asOfDate: '2026-04-15' });
    const [movement] = buildPurchaseReceiptMovements({
      purchaseReceipts: receipts,
      cxpRecords: [],
      companyCode: 'all',
      asOfDate: '2026-04-15',
    });
    return movement.subcategory;
  };

  it('descarta `Seleccionar Familia` y cae al siguiente nivel usable', () => {
    expect(subcategoryFor({ descFamilia: 'Seleccionar Familia', descSubFamilia: '', descCategoria: 'MOTOR' }))
      .toBe('MOTOR');
  });

  it('descarta `.` y no lo pinta como categoría', () => {
    expect(subcategoryFor({ descFamilia: '', descSubFamilia: '', descCategoria: '.' })).not.toBe('.');
  });

  it('familia (hijo) le gana al padre genérico', () => {
    expect(subcategoryFor({ descFamilia: 'LLANTAS', descCategoria: 'Directos' })).toBe('LLANTAS');
  });

  it('una familia real sigue saliendo tal cual', () => {
    expect(subcategoryFor({})).toBe('PRODUCTOS DE LIMPIEZA');
  });
});
