/**
 * comprasToPurchaseReceipts.branches.test.ts — cobertura de RAMAS del adapter
 * Compras → PurchaseReceipt. Hermano de `comprasToPurchaseReceipts.test.ts`
 * (que fija los caminos CONFIRMED / PROJECTED principales); aquí se ejercitan
 * las ramas de mapeo que quedaban muertas: tasa fiscal en todas sus formas,
 * divisa / tipo de cambio, campos de catálogo vacíos, fechas no-ISO y las
 * variantes de `excludePastUnexecuted` / `includePastConfirmed`.
 *
 * No toca código fuente. Las aserciones documentan el comportamiento REAL.
 */
import { describe, expect, it } from 'vitest';
import {
  comprasToPurchaseReceipts,
  buildComprasCreditOverlay,
  isComprasWorkflowClosed,
} from './comprasToPurchaseReceipts';
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

const ASOF = '2026-05-13';

function one(patch: Partial<ComprasRecord>, options?: Parameters<typeof comprasToPurchaseReceipts>[1]) {
  const out = comprasToPurchaseReceipts([record(patch)], options ?? { asOfDate: ASOF });
  return out[0];
}

describe('isComprasWorkflowClosed', () => {
  it('998 y 999 cierran; el resto y el vacío no', () => {
    expect(isComprasWorkflowClosed('999')).toBe(true);
    expect(isComprasWorkflowClosed(' 998 ')).toBe(true);
    expect(isComprasWorkflowClosed('380')).toBe(false);
    expect(isComprasWorkflowClosed('')).toBe(false);
    expect(isComprasWorkflowClosed(undefined)).toBe(false);
  });

  it('el adapter descarta también el estado 998', () => {
    const out = comprasToPurchaseReceipts([record({ estadoSiguiente: '998' })], { asOfDate: ASOF });
    expect(out).toHaveLength(0);
  });
});

describe('comprasToPurchaseReceipts — tasa fiscal (todas las formas)', () => {
  const cases: Array<[string, number | undefined, string]> = [
    ['IVA16', 16, 'IVA_CREDITABLE'],
    ['TASA 16', 16, 'IVA_CREDITABLE'],
    ['IVA8', 8, 'IVA_CREDITABLE'],
    ['tasa 8 frontera', 8, 'IVA_CREDITABLE'],
    ['IVA0', 0, 'IVA_EXEMPT'],
    ['EXTO', 0, 'IVA_EXEMPT'],
    ['EXENTO', 0, 'IVA_EXEMPT'],
  ];

  for (const [raw, rate, treatment] of cases) {
    it(`"${raw}" → tasa ${rate} / ${treatment}`, () => {
      const rec = one({ tasaFiscal: raw });
      expect(rec.taxRate).toBe(rate);
      expect(rec.taxTreatment).toBe(treatment);
      expect(rec.taxRateCode).toBe(raw.trim());
    });
  }

  it('tasa vacía → sin tasa, sin base ni IVA, taxRateCode undefined', () => {
    const rec = one({ tasaFiscal: '   ' });
    expect(rec.taxRate).toBeUndefined();
    expect(rec.taxTreatment).toBe('UNCLASSIFIED');
    expect(rec.taxBaseAmount).toBeUndefined();
    expect(rec.taxAmount).toBeUndefined();
    expect(rec.taxRateCode).toBeUndefined();
  });

  it('tasa desconocida (sin 16/8/0/exento) → UNCLASSIFIED pero conserva el código crudo', () => {
    const rec = one({ tasaFiscal: 'ZZZ' });
    expect(rec.taxRate).toBeUndefined();
    expect(rec.taxTreatment).toBe('UNCLASSIFIED');
    expect(rec.taxRateCode).toBe('ZZZ');
  });

  it('tasa 0 (exenta) NO desglosa base/IVA', () => {
    const rec = one({ tasaFiscal: 'IVA0' });
    expect(rec.taxBaseAmount).toBeUndefined();
    expect(rec.taxAmount).toBeUndefined();
  });

  it('tasa 16 desglosa base + IVA sobre el importe total', () => {
    const rec = one({ tasaFiscal: 'IVA16', importeTotal: 1160 });
    expect(rec.taxBaseAmount).toBeCloseTo(1000, 6);
    expect(rec.taxAmount).toBeCloseTo(160, 6);
  });
});

describe('comprasToPurchaseReceipts — divisa y tipo de cambio', () => {
  it('MXP se normaliza a MXN con tipo de cambio 1', () => {
    const rec = one({ moneda: 'MXP', tipoCambio: 17 });
    expect(rec.currency).toBe('MXN');
    expect(rec.exchangeRate).toBe(1);
    expect(rec.amountMxn).toBe(rec.totalAmount);
  });

  it('MXN explícito también se normaliza a MXN', () => {
    const rec = one({ moneda: 'MXN' });
    expect(rec.currency).toBe('MXN');
    expect(rec.exchangeRate).toBe(1);
  });

  it('moneda vacía cae a MXN', () => {
    const rec = one({ moneda: '' });
    expect(rec.currency).toBe('MXN');
    expect(rec.exchangeRate).toBe(1);
  });

  it('USD convierte el importe con el tipo de cambio del registro', () => {
    const rec = one({ moneda: 'USD', tipoCambio: 17, importeTotal: 100 });
    expect(rec.currency).toBe('USD');
    expect(rec.exchangeRate).toBe(17);
    expect(rec.amountMxn).toBe(1700);
  });

  it('divisa con tipo de cambio 0/ausente cae a 1 (no se pierde el importe)', () => {
    const rec = one({ moneda: 'USD', tipoCambio: 0, importeTotal: 100 });
    expect(rec.exchangeRate).toBe(1);
    expect(rec.amountMxn).toBe(100);
  });
});

describe('comprasToPurchaseReceipts — campos de catálogo vacíos', () => {
  it('todos los campos descriptivos vacíos salen undefined y el proveedor cae al placeholder', () => {
    const rec = one({
      nombreProveedor: '',
      lineaOrden: 0,
      centroCostos: '  ',
      noProducto: '  ',
      descProducto: '  ',
      categoria: '  ',
      descCategoria: '  ',
      familia: '  ',
      descFamilia: '  ',
      subFamilia: '  ',
      descSubFamilia: '  ',
      estadoSiguiente: '   ',
    });
    expect(rec.supplierName).toBe('Proveedor sin nombre');
    expect(rec.receiptNo).toBe('');
    expect(rec.costCenter).toBeUndefined();
    expect(rec.productCode).toBeUndefined();
    expect(rec.productDescription).toBeUndefined();
    expect(rec.categoryCode).toBeUndefined();
    expect(rec.categoryName).toBeUndefined();
    expect(rec.familyCode).toBeUndefined();
    expect(rec.familyName).toBeUndefined();
    expect(rec.subfamilyCode).toBeUndefined();
    expect(rec.subfamilyName).toBeUndefined();
    expect(rec.workflowState).toBeUndefined();
  });

  it('nombre de proveedor SÓLO-espacios NO cae al placeholder (no se trima, a diferencia del resto)', () => {
    // Comportamiento real observado: `supplierName` usa `r.nombreProveedor || …`
    // sin trim, mientras que los demás campos descriptivos sí trimean. Un
    // nombre en blanco del API se propaga tal cual.
    const rec = one({ nombreProveedor: '   ' });
    expect(rec.supplierName).toBe('   ');
  });

  it('estadoSiguiente ausente (undefined) no rompe el mapeo', () => {
    const rec = one({ estadoSiguiente: undefined as unknown as string });
    expect(rec.workflowState).toBeUndefined();
  });

  it('importeTotal ausente se trata como 0 y la OC se descarta', () => {
    const out = comprasToPurchaseReceipts(
      [record({ importeTotal: undefined as unknown as number })],
      { asOfDate: ASOF },
    );
    expect(out).toHaveLength(0);
  });
});

describe('comprasToPurchaseReceipts — fechas no-ISO / centinela', () => {
  it('fechaPedido no-ISO no dispara el corte de lookahead futuro', () => {
    const out = comprasToPurchaseReceipts(
      [record({ fechaPedido: 'N/D' })],
      { asOfDate: ASOF, futureOrderLookaheadMonths: 3 },
    );
    expect(out).toHaveLength(1);
  });

  it('fechaPedido ausente (undefined) tampoco rompe el corte de lookahead', () => {
    const out = comprasToPurchaseReceipts(
      [record({ fechaPedido: undefined as unknown as string })],
      { asOfDate: ASOF, futureOrderLookaheadMonths: 3 },
    );
    expect(out).toHaveLength(1);
  });

  it('fecha de pago no parseable NO se considera vencida (se conserva la OC)', () => {
    const out = comprasToPurchaseReceipts(
      [record({ fechaPagoProyectada: 'PENDIENTE' })],
      { asOfDate: ASOF, excludePastUnexecuted: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0].estimatedDueDate).toBe('PENDIENTE');
  });

  it('asOfDate no parseable deja el corte de lookahead sin desplazamiento (passthrough)', () => {
    // addMonths sobre una fecha inválida regresa la misma cadena.
    const out = comprasToPurchaseReceipts(
      [record({ fechaPedido: '2026-03-04', fechaPagoProyectada: '2026-05-13' })],
      { asOfDate: 'no-es-fecha', futureOrderLookaheadMonths: 3, includePastConfirmed: true },
    );
    expect(out).toHaveLength(1);
  });

  it('lookahead de 0 meses corta cualquier OC pedida después de hoy', () => {
    const out = comprasToPurchaseReceipts(
      [record({ fechaPedido: '2026-05-14' })],
      { asOfDate: ASOF, futureOrderLookaheadMonths: 0 },
    );
    expect(out).toHaveLength(0);
  });

  it('lookahead negativo se acota a 0 (no adelanta el corte al pasado)', () => {
    const out = comprasToPurchaseReceipts(
      [record({ fechaPedido: ASOF })],
      { asOfDate: ASOF, futureOrderLookaheadMonths: -6, includePastConfirmed: true },
    );
    expect(out).toHaveLength(1);
  });
});

describe('comprasToPurchaseReceipts — ventanas de pago pasado', () => {
  it('includePastConfirmed conserva una OC CONFIRMED con pago ya vencido', () => {
    const out = comprasToPurchaseReceipts(
      [record({ fechaRecepcion: '2025-01-01', fechaPagoProyectada: '2025-03-02' })],
      { asOfDate: ASOF, includePastConfirmed: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('CONFIRMED');
    expect(out[0].estimatedDueDate).toBe('2025-03-02');
  });

  it('sin includePastConfirmed la misma OC se descarta', () => {
    const out = comprasToPurchaseReceipts(
      [record({ fechaRecepcion: '2025-01-01', fechaPagoProyectada: '2025-03-02' })],
      { asOfDate: ASOF },
    );
    expect(out).toHaveLength(0);
  });

  it('excludePastUnexecuted descarta una PROJECTED vencida por más de un mes', () => {
    const out = comprasToPurchaseReceipts(
      [record({
        fechaPedido: '2024-01-01',
        fechaRecepcion: '',
        fechaPagoProyectada: '',
        diasCredito: 30,
      })],
      { asOfDate: ASOF, excludePastUnexecuted: true },
    );
    expect(out).toHaveLength(0);
  });

  it('excludePastUnexecuted conserva una PROJECTED dentro de la gracia de un mes', () => {
    // Pedido 2026-03-20 + 21d default + 30d crédito = 2026-05-10 (dentro de gracia).
    const out = comprasToPurchaseReceipts(
      [record({
        fechaPedido: '2026-03-20',
        fechaRecepcion: '',
        fechaPagoProyectada: '',
        diasCredito: 30,
      })],
      { asOfDate: ASOF, excludePastUnexecuted: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('PROJECTED');
  });

  it('OC sin recepción pero con includeProjected=false y sin stats no emite nada', () => {
    const out = comprasToPurchaseReceipts(
      [record({ fechaRecepcion: '', fechaPagoProyectada: '' })],
      { asOfDate: ASOF, includeProjected: false },
    );
    expect(out).toHaveLength(0);
  });

  it('OC sin recepción y sin fechaPedido no puede proyectarse', () => {
    const out = comprasToPurchaseReceipts(
      [record({ fechaRecepcion: '', fechaPagoProyectada: '', fechaPedido: '' })],
      { asOfDate: ASOF },
    );
    expect(out).toHaveLength(0);
  });

  it('OC con recepción pero SIN fechaPagoProyectada cae al camino PROJECTED', () => {
    const out = comprasToPurchaseReceipts(
      [record({
        fechaRecepcion: '2026-04-01',
        fechaPagoProyectada: '',
        fechaPedido: '2026-04-01',
        diasCredito: 30,
      })],
      { asOfDate: ASOF },
    );
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe('PROJECTED');
  });
});

describe('buildComprasCreditOverlay — ramas de llave y desempate', () => {
  it('sin número JDE usa el nombre normalizado como llave', () => {
    const overlay = buildComprasCreditOverlay([
      record({ noProveedor: '', nombreProveedor: 'Acme Refacciones', diasCredito: 45 }),
    ]);
    expect(overlay.get('ACME REFACCIONES')).toBe(45);
  });

  it('sin número JDE ni nombre la OC se descarta del overlay', () => {
    const overlay = buildComprasCreditOverlay([
      record({ noProveedor: '', nombreProveedor: '', diasCredito: 45 }),
    ]);
    expect(overlay.size).toBe(0);
  });

  it('diasCredito negativo o no numérico se ignora', () => {
    const overlay = buildComprasCreditOverlay([
      record({ noProveedor: '500', diasCredito: -30 }),
      record({ noProveedor: '501', diasCredito: Number.NaN }),
      record({ noProveedor: '502', diasCredito: undefined as unknown as number }),
    ]);
    expect(overlay.size).toBe(0);
  });

  it('trunca días fraccionarios al entero inferior', () => {
    const overlay = buildComprasCreditOverlay([
      record({ noProveedor: '600', diasCredito: 30.9 }),
    ]);
    expect(overlay.get('600')).toBe(30);
  });

  it('fechaPedido no-ISO se normaliza a cadena vacía y no rompe el desempate', () => {
    const overlay = buildComprasCreditOverlay([
      record({ noProveedor: '700', noOrden: 'A', diasCredito: 30, fechaPedido: 'N/D' }),
      record({ noProveedor: '700', noOrden: 'B', diasCredito: 60, fechaPedido: '2026-02-01' }),
    ]);
    // Empate 1-1 en frecuencia → gana la de pedido más reciente (la ISO).
    expect(overlay.get('700')).toBe(60);
  });

  it('varias OCs del mismo plazo acumulan y actualizan la fecha más reciente', () => {
    const overlay = buildComprasCreditOverlay([
      record({ noProveedor: '800', noOrden: 'A', diasCredito: 30, fechaPedido: '2026-01-01' }),
      record({ noProveedor: '800', noOrden: 'B', diasCredito: 30, fechaPedido: '2026-04-01' }),
      record({ noProveedor: '800', noOrden: 'C', diasCredito: 30, fechaPedido: '2026-02-01' }),
      record({ noProveedor: '800', noOrden: 'D', diasCredito: 90, fechaPedido: '2026-12-01' }),
    ]);
    expect(overlay.get('800')).toBe(30);
  });

  it('lista vacía → overlay vacío', () => {
    expect(buildComprasCreditOverlay([]).size).toBe(0);
  });
});

describe('comprasToPurchaseReceipts — leadTimeStats inyectados', () => {
  it('respeta los stats precomputados que le pasa el caller', () => {
    const out = comprasToPurchaseReceipts(
      [record({
        fechaPedido: '2026-05-01',
        fechaRecepcion: '',
        fechaPagoProyectada: '',
        diasCredito: 30,
      })],
      {
        asOfDate: ASOF,
        leadTimeStats: {
          byCiaSubfamilia: new Map(),
          byCiaFamilia: new Map(),
          bySubfamilia: new Map(),
          byFamilia: new Map(),
          byCategoria: new Map(),
          global: { avgDays: 5, medianDays: 5, sampleSize: 9 },
        },
      },
    );
    expect(out).toHaveLength(1);
    expect(out[0].projectedLeadTimeDays).toBe(5);
    expect(out[0].projectedLeadTimeSource).toBe('global');
    // 2026-05-01 + 5d + 30d = 2026-06-05
    expect(out[0].estimatedDueDate).toBe('2026-06-05');
  });
});
