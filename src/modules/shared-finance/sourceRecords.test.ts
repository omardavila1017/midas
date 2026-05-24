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
    expect(m.providerCategory).toBe('Indirectos');
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
