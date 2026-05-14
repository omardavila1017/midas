import { describe, it, expect } from 'vitest';
import { comprasToPurchaseReceipts } from './comprasToPurchaseReceipts';
import type { ComprasRecord } from '../services/jdeTypes';

function record(overrides: Partial<ComprasRecord>): ComprasRecord {
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
    fechaPedido: '2026-03-04',
    fechaRecepcion: '2026-03-14',
    diasCredito: 60,
    fechaPagoProyectada: '2026-05-13',
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

describe('comprasToPurchaseReceipts — CONFIRMED path', () => {
  it('emits CONFIRMED for OCs with fechaRecepcion and fechaPagoProyectada >= asOfDate', () => {
    const out = comprasToPurchaseReceipts([record({})], { asOfDate: '2026-05-13' });
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('CONFIRMED');
    expect(out[0].estimatedDueDate).toBe('2026-05-13');
    expect(out[0].projectedLeadTimeDays).toBeUndefined();
  });

  it('drops OCs whose fechaPagoProyectada is in the past', () => {
    const out = comprasToPurchaseReceipts(
      [record({ fechaPagoProyectada: '2026-01-01' })],
      { asOfDate: '2026-05-13' },
    );
    expect(out).toHaveLength(0);
  });

  it('drops cancelled OCs', () => {
    const out = comprasToPurchaseReceipts(
      [record({ cancelada: true })],
      { asOfDate: '2026-05-13' },
    );
    expect(out).toHaveLength(0);
  });

  it('drops OCs with closed workflow state (999)', () => {
    const out = comprasToPurchaseReceipts(
      [record({ estadoSiguiente: '999' })],
      { asOfDate: '2026-05-13' },
    );
    expect(out).toHaveLength(0);
  });

  it('drops OCs with zero or negative importe', () => {
    const out = comprasToPurchaseReceipts(
      [record({ importeTotal: 0 }), record({ importeTotal: -100 })],
      { asOfDate: '2026-05-13' },
    );
    expect(out).toHaveLength(0);
  });
});

describe('comprasToPurchaseReceipts — PROJECTED path', () => {
  // Build enough history for lead time stats (3 samples)
  const history = [
    record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-11', familia: 'PLI', subFamilia: 'QDA' }),
    record({ fechaPedido: '2026-01-05', fechaRecepcion: '2026-01-15', familia: 'PLI', subFamilia: 'QDA' }),
    record({ fechaPedido: '2026-01-10', fechaRecepcion: '2026-01-20', familia: 'PLI', subFamilia: 'QDA' }),
  ];

  it('emits PROJECTED for OCs without recepción when includeProjected=true', () => {
    const unreceived = record({
      noOrden: '99999',
      fechaPedido: '2026-04-01',
      fechaRecepcion: '',
      fechaPagoProyectada: '',
      diasCredito: 60,
      familia: 'PLI',
      subFamilia: 'QDA',
    });
    const out = comprasToPurchaseReceipts([...history, unreceived], { asOfDate: '2026-04-15' });
    const projected = out.find((r) => r.purchaseOrderNo === '99999');
    expect(projected).toBeDefined();
    expect(projected?.confidence).toBe('PROJECTED');
    expect(projected?.projectedLeadTimeDays).toBe(10);
    expect(projected?.projectedLeadTimeSource).toBeDefined();
    // Pedido 2026-04-01 + 10d lead + 60d crédito = 2026-06-10
    expect(projected?.estimatedDueDate).toBe('2026-06-10');
  });

  it('does NOT emit PROJECTED when includeProjected=false', () => {
    const unreceived = record({
      fechaRecepcion: '',
      fechaPagoProyectada: '',
    });
    const out = comprasToPurchaseReceipts(
      [...history, unreceived],
      { asOfDate: '2026-04-15', includeProjected: false },
    );
    expect(out.find((r) => r.confidence === 'PROJECTED')).toBeUndefined();
  });

  it('uses default lead time when no historical stats available', () => {
    const unreceived = record({
      fechaPedido: '2026-04-01',
      fechaRecepcion: '',
      fechaPagoProyectada: '',
      diasCredito: 30,
    });
    const out = comprasToPurchaseReceipts([unreceived], { asOfDate: '2026-04-15' });
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('PROJECTED');
    expect(out[0].projectedLeadTimeSource).toBe('default');
    // 2026-04-01 + 21d default + 30d crédito = 2026-05-22
    expect(out[0].estimatedDueDate).toBe('2026-05-22');
  });

  it('drops PROJECTED whose projected due date already passed', () => {
    const unreceived = record({
      fechaPedido: '2025-01-01',
      fechaRecepcion: '',
      fechaPagoProyectada: '',
      diasCredito: 30,
    });
    const out = comprasToPurchaseReceipts([unreceived], { asOfDate: '2026-04-15' });
    expect(out).toHaveLength(0);
  });
});

describe('comprasToPurchaseReceipts — backward compat', () => {
  it('accepts string as second arg (legacy asOfDate)', () => {
    const out = comprasToPurchaseReceipts([record({})], '2026-05-13');
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('CONFIRMED');
  });

  it('accepts no second arg', () => {
    // Use a future date so it doesn't get filtered as past
    const out = comprasToPurchaseReceipts([
      record({ fechaPagoProyectada: '2099-12-31' }),
    ]);
    expect(out).toHaveLength(1);
  });
});
