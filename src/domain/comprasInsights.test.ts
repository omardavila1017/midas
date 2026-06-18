import { describe, expect, it } from 'vitest';
import type { ComprasRecord } from '../services/jdeTypes';
import {
  COMPRA_ESTADO_LABEL,
  STALE_OPEN_ORDER_DAYS,
  buildComprasByOrder,
  buildComprasDepuracionInsights,
  buildOpenSinEntradaByMonth,
  compraEstado,
  comprasImporteMxn,
  comprasOrdersToCsv,
  comprasRecordKey,
  comprasToCsv,
  daysSinceIso,
  isOpenSinEntrada,
  isStaleSinEntrada,
} from './comprasInsights';

const AS_OF = '2026-06-10';

function compra(overrides: Partial<ComprasRecord>): ComprasRecord {
  return {
    cia: '00001',
    noProveedor: '100',
    nombreProveedor: 'Proveedor Demo',
    noOrden: 'OC-1',
    tipoOrden: 'OS',
    descTipoOrden: 'Orden de servicio',
    lineaOrden: 1,
    noProducto: 'SKU',
    descProducto: 'Producto',
    concepto: 'Concepto',
    cantidad: 1,
    precioUnitario: 1000,
    importeTotal: 1000,
    moneda: 'MXP',
    tipoCambio: 1,
    fechaPedido: '2026-06-01',
    fechaRecepcion: '',
    diasCredito: 30,
    fechaPagoProyectada: '',
    noFactura: '',
    centroCostos: '101',
    categoria: 'CAT',
    descCategoria: 'Indirectos',
    familia: 'FAM',
    descFamilia: 'Servicios',
    subFamilia: 'SUB',
    descSubFamilia: 'Servicios',
    estadoSiguiente: '',
    tasaFiscal: 'IVA16',
    cancelada: false,
    facturada: false,
    ...overrides,
  };
}

describe('comprasImporteMxn', () => {
  it('passes MXP/MXN through and converts foreign currency by tipoCambio', () => {
    expect(comprasImporteMxn(compra({ importeTotal: 1500, moneda: 'MXP' }))).toBe(1500);
    expect(comprasImporteMxn(compra({ importeTotal: 1500, moneda: 'MXN' }))).toBe(1500);
    expect(comprasImporteMxn(compra({ importeTotal: 100, moneda: 'USD', tipoCambio: 17.5 }))).toBe(1750);
    // TC ausente → fallback 1 (mismo comportamiento que el motor)
    expect(comprasImporteMxn(compra({ importeTotal: 100, moneda: 'USD', tipoCambio: 0 }))).toBe(100);
  });
});

describe('isOpenSinEntrada / isStaleSinEntrada', () => {
  it('open = activa, sin factura, sin recepción, workflow vivo', () => {
    expect(isOpenSinEntrada(compra({}))).toBe(true);
    expect(isOpenSinEntrada(compra({ cancelada: true }))).toBe(false);
    expect(isOpenSinEntrada(compra({ facturada: true, noFactura: 'F-1' }))).toBe(false);
    expect(isOpenSinEntrada(compra({ fechaRecepcion: '2026-06-01' }))).toBe(false);
    expect(isOpenSinEntrada(compra({ estadoSiguiente: '998' }))).toBe(false);
    expect(isOpenSinEntrada(compra({ estadoSiguiente: '999' }))).toBe(false);
    expect(isOpenSinEntrada(compra({ estadoSiguiente: '380' }))).toBe(true);
  });

  it('stale exige superar la ventana de días desde el pedido', () => {
    expect(isStaleSinEntrada(compra({ fechaPedido: '2026-01-10' }), AS_OF)).toBe(true);
    expect(isStaleSinEntrada(compra({ fechaPedido: '2026-06-01' }), AS_OF)).toBe(false);
    expect(isStaleSinEntrada(compra({ fechaPedido: '' }), AS_OF)).toBe(false);
    // recibida → ya no es "sin entrada", aunque sea vieja
    expect(
      isStaleSinEntrada(compra({ fechaPedido: '2025-01-10', fechaRecepcion: '2025-02-01' }), AS_OF),
    ).toBe(false);
  });

  it('daysSinceIso computes elapsed days and rejects garbage', () => {
    expect(daysSinceIso('2026-06-01', AS_OF)).toBe(9);
    expect(daysSinceIso('2026-06-11', AS_OF)).toBe(-1);
    expect(daysSinceIso('', AS_OF)).toBeNull();
    expect(daysSinceIso('no-date', AS_OF)).toBeNull();
  });
});

describe('buildOpenSinEntradaByMonth', () => {
  it('groups open-without-receipt OCs by order month in MXN, sorted, with stale flag', () => {
    const records = [
      compra({ noOrden: 'A', fechaPedido: '2026-06-01', importeTotal: 3000 }),
      compra({ noOrden: 'B', fechaPedido: '2026-06-15', importeTotal: 2000 }),
      compra({ noOrden: 'C', fechaPedido: '2026-01-10', importeTotal: 100, moneda: 'USD', tipoCambio: 17 }),
      // excluidas del strip:
      compra({ noOrden: 'D', fechaPedido: '2026-06-01', fechaRecepcion: '2026-06-02' }),
      compra({ noOrden: 'E', fechaPedido: '2026-06-01', facturada: true, noFactura: 'F-1' }),
      compra({ noOrden: 'F', fechaPedido: '2026-06-01', cancelada: true }),
      compra({ noOrden: 'G', fechaPedido: '2026-06-01', estadoSiguiente: '999' }),
      compra({ noOrden: 'H', fechaPedido: '' }),
    ];
    const months = buildOpenSinEntradaByMonth(records, AS_OF);
    expect(months.map((m) => m.ym)).toEqual(['2026-01', '2026-06']);

    const enero = months[0];
    expect(enero.count).toBe(1);
    expect(enero.totalMxn).toBe(1700);
    expect(enero.stale).toBe(true); // todo enero quedó atrás del corte de 90 días
    expect(enero.keys).toEqual(['00001::C::1']);

    const junio = months[1];
    expect(junio.count).toBe(2);
    expect(junio.totalMxn).toBe(5000);
    expect(junio.stale).toBe(false);
    expect(junio.keys).toEqual(['00001::A::1', '00001::B::1']);
  });
});

describe('compraEstado', () => {
  it('derives the estado with the documented precedence', () => {
    expect(compraEstado(compra({ cancelada: true, facturada: true }))).toBe('cancelada');
    expect(compraEstado(compra({ facturada: true, noFactura: 'F' }))).toBe('facturada');
    expect(compraEstado(compra({ estadoSiguiente: '998' }))).toBe('cerradaWorkflow');
    expect(compraEstado(compra({ fechaRecepcion: '2026-06-01' }))).toBe('porPagar');
    expect(compraEstado(compra({}))).toBe('sinEntrada');
  });

  it('renombra "Por pagar" → "Pendiente factura" (es pasivo por distribuir, no CXP)', () => {
    expect(COMPRA_ESTADO_LABEL.porPagar).toBe('Pendiente factura');
  });
});

describe('buildComprasByOrder', () => {
  it('agrega líneas a una fila por OC con el split recibido/pendiente y rollup de estado', () => {
    const records: ComprasRecord[] = [
      // OC-MIX: una línea de cada tipo relevante.
      compra({ noOrden: 'OC-MIX', lineaOrden: 1, importeTotal: 1000 }), // sinEntrada
      compra({ noOrden: 'OC-MIX', lineaOrden: 2, importeTotal: 2000, fechaRecepcion: '2026-06-05' }), // porPagar
      compra({ noOrden: 'OC-MIX', lineaOrden: 3, importeTotal: 3000, fechaRecepcion: '2026-06-05', facturada: true, noFactura: 'F-1' }), // facturada
      compra({ noOrden: 'OC-MIX', lineaOrden: 4, importeTotal: 9999, cancelada: true }), // cancelada → excluida
      // OC-PASIVO: solo recibida sin factura.
      compra({ noOrden: 'OC-PASIVO', lineaOrden: 1, importeTotal: 500, fechaRecepcion: '2026-06-01' }),
      // OC-FACT: todo facturado.
      compra({ noOrden: 'OC-FACT', lineaOrden: 1, importeTotal: 800, fechaRecepcion: '2026-05-01', facturada: true, noFactura: 'F-2' }),
    ];
    const orders = buildComprasByOrder(records, AS_OF);

    const mix = orders.find((o) => o.noOrden === 'OC-MIX')!;
    expect(mix.lineCount).toBe(4);
    expect(mix.importeRecibidoMxn).toBe(5000); // 2000 + 3000
    expect(mix.importeFacturadoMxn).toBe(3000);
    expect(mix.importePendienteRecibirMxn).toBe(1000);
    expect(mix.importePendienteFacturaMxn).toBe(2000);
    expect(mix.importeTotalMxn).toBe(6000); // recibido + pendiente por recibir (sin cancelada)
    expect(mix.estado).toBe('pendienteRecibir'); // falta recibir algo → manda

    const pasivo = orders.find((o) => o.noOrden === 'OC-PASIVO')!;
    expect(pasivo.estado).toBe('pendienteFactura');
    expect(pasivo.importePendienteFacturaMxn).toBe(500);

    const fact = orders.find((o) => o.noOrden === 'OC-FACT')!;
    expect(fact.estado).toBe('facturada');
    expect(fact.importeFacturadoMxn).toBe(800);
    expect(fact.importePendienteRecibirMxn).toBe(0);

    // Orden: backlog (pendienteRecibir/Factura) antes que facturada.
    expect(orders.map((o) => o.noOrden)).toEqual(['OC-MIX', 'OC-PASIVO', 'OC-FACT']);
  });

  it('comprasOrdersToCsv emite encabezado y una fila por OC', () => {
    const orders = buildComprasByOrder(
      [compra({ noOrden: 'OC-CSV', importeTotal: 1234, fechaRecepcion: '2026-06-01' })],
      AS_OF,
    );
    const csv = comprasOrdersToCsv(orders);
    const [header, row] = csv.split('\n');
    expect(header).toContain('Pendiente por recibir MXN');
    expect(header).toContain('Pendiente factura MXN');
    expect(row).toContain('OC-CSV');
    expect(row).toContain('Pendiente factura'); // estado pendienteFactura
  });
});

describe('buildComprasDepuracionInsights', () => {
  it('detects each finding from API fields with logic', () => {
    const records = [
      // limpia: ninguna detección
      compra({ noOrden: 'OK', fechaPedido: '2026-06-01' }),
      // orden muerta: +90 días sin entrada
      compra({ noOrden: 'STALE', fechaPedido: '2026-01-10', importeTotal: 5000 }),
      // recibida sin factura con pago proyectado vencido +30 días
      compra({
        noOrden: 'VENC',
        fechaPedido: '2026-02-15',
        fechaRecepcion: '2026-03-01',
        diasCredito: 30,
        fechaPagoProyectada: '2026-03-31',
      }),
      // recibida con crédito 0 (pago el día de la entrada)
      compra({
        noOrden: 'CRED0',
        fechaPedido: '2026-05-25',
        fechaRecepcion: '2026-06-01',
        diasCredito: 0,
        fechaPagoProyectada: '2026-06-01',
      }),
      // workflow cerrado sin cancelar (no cuenta como stale aunque sea vieja)
      compra({ noOrden: 'WF', fechaPedido: '2026-01-01', estadoSiguiente: '999' }),
      // recepción antes del pedido
      compra({
        noOrden: 'INV',
        fechaPedido: '2026-05-10',
        fechaRecepcion: '2026-05-01',
        fechaPagoProyectada: '2026-05-31',
      }),
      // sin fecha de pedido
      compra({ noOrden: 'NODATE', fechaPedido: '' }),
      // cancelada con factura (contradicción)
      compra({ noOrden: 'CANCFACT', cancelada: true, facturada: true, noFactura: 'F-9' }),
      // cancelada normal: no genera nada
      compra({ noOrden: 'CANC', cancelada: true }),
      // USD a la par
      compra({ noOrden: 'USD', moneda: 'USD', tipoCambio: 1, importeTotal: 100 }),
      // importe en 0
      compra({ noOrden: 'ZERO', importeTotal: 0 }),
      // posible duplicado: misma firma en dos órdenes distintas
      compra({ noOrden: 'DUP-A', fechaPedido: '2026-06-02', importeTotal: 750 }),
      compra({ noOrden: 'DUP-B', fechaPedido: '2026-06-02', importeTotal: 750 }),
      // multi-línea de la MISMA orden: NO es duplicado
      compra({ noOrden: 'ML', lineaOrden: 1, fechaPedido: '2026-06-03', importeTotal: 320 }),
      compra({ noOrden: 'ML', lineaOrden: 2, fechaPedido: '2026-06-03', importeTotal: 320 }),
    ];

    const insights = buildComprasDepuracionInsights(records, AS_OF);
    const byId = Object.fromEntries(insights.map((i) => [i.id, i]));

    expect(byId.staleSinEntrada?.count).toBe(1);
    expect(byId.staleSinEntrada?.totalMxn).toBe(5000);
    expect(byId.staleSinEntrada?.keys).toEqual(['00001::STALE::1']);

    expect(byId.recibidaSinFacturaVencida?.keys).toEqual(['00001::VENC::1']);
    expect(byId.creditoCero?.keys).toEqual(['00001::CRED0::1']);
    expect(byId.workflowCerrado?.keys).toEqual(['00001::WF::1']);
    expect(byId.recepcionAntesPedido?.keys).toEqual(['00001::INV::1']);
    expect(byId.sinFechaPedido?.keys).toEqual(['00001::NODATE::1']);
    expect(byId.canceladaConFactura?.keys).toEqual(['00001::CANCFACT::1']);
    expect(byId.extranjeraSinTc?.keys).toEqual(['00001::USD::1']);
    expect(byId.importeNoPositivo?.keys).toEqual(['00001::ZERO::1']);

    expect(byId.posibleDuplicado?.count).toBe(2);
    expect(byId.posibleDuplicado?.keys).toEqual(['00001::DUP-A::1', '00001::DUP-B::1']);
    expect(byId.posibleDuplicado?.totalMxn).toBe(1500);

    // danger primero (extranjeraSinTc es el único danger del roster)
    expect(insights[0].id).toBe('extranjeraSinTc');
    expect(insights[0].severity).toBe('danger');
  });

  it('returns nothing for a clean dataset', () => {
    const records = [
      compra({ noOrden: 'A', fechaPedido: '2026-06-01' }),
      compra({
        noOrden: 'B',
        fechaPedido: '2026-05-20',
        fechaRecepcion: '2026-06-01',
        diasCredito: 30,
        fechaPagoProyectada: '2026-07-01',
      }),
    ];
    expect(buildComprasDepuracionInsights(records, AS_OF)).toEqual([]);
  });

  it('does not flag stale window edge: exactly STALE_OPEN_ORDER_DAYS is not stale yet', () => {
    const edge = compra({ fechaPedido: '2026-03-12' }); // 90 días exactos al 2026-06-10
    expect(daysSinceIso(edge.fechaPedido, AS_OF)).toBe(STALE_OPEN_ORDER_DAYS);
    expect(isStaleSinEntrada(edge, AS_OF)).toBe(false);
  });
});

describe('comprasToCsv', () => {
  it('serializes records with derived estado and MXN amount, escaping cells', () => {
    const csv = comprasToCsv([
      compra({
        noOrden: 'OC-77',
        nombreProveedor: 'ACME, S.A. de C.V.',
        moneda: 'USD',
        tipoCambio: 17,
        importeTotal: 100,
      }),
    ]);
    const [header, row] = csv.split('\n');
    expect(header).toContain('Importe MXN');
    expect(header).toContain('Edo. sig.');
    expect(row).toContain('"ACME, S.A. de C.V."');
    expect(row).toContain('OC-77');
    expect(row).toContain('1700.00');
    expect(row).toContain('Sin entrada');
  });
});

describe('comprasRecordKey', () => {
  it('matches the fetch dedup key shape', () => {
    expect(comprasRecordKey(compra({ cia: '00011', noOrden: 'X', lineaOrden: 3 }))).toBe('00011::X::3');
  });
});
