import { describe, expect, it } from 'vitest';
import type { ComprasRecord } from '../services/jdeTypes';
import {
  buildPasivoAging,
  buildPasivoPorDistribuir,
  isPasivoPorDistribuir,
  pasivoToCsv,
  pasivoTotalMxn,
} from './pasivoPorDistribuir';

const AS_OF = '2026-06-17';

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
    fechaPedido: '2026-05-01',
    fechaRecepcion: '',
    diasCredito: 30,
    fechaPagoProyectada: '',
    noFactura: '',
    centroCostos: '101',
    categoria: 'CAT',
    descCategoria: 'Refacciones',
    familia: 'FAM',
    descFamilia: 'Flota',
    subFamilia: 'SUB',
    descSubFamilia: 'Llantas',
    estadoSiguiente: '',
    tasaFiscal: 'IVA16',
    cancelada: false,
    facturada: false,
    ...overrides,
  };
}

describe('isPasivoPorDistribuir', () => {
  it('solo recibida sin factura (porPagar) cuenta como pasivo', () => {
    expect(isPasivoPorDistribuir(compra({ fechaRecepcion: '2026-06-01' }))).toBe(true); // recibida sin factura
    expect(isPasivoPorDistribuir(compra({}))).toBe(false); // sin entrada
    expect(isPasivoPorDistribuir(compra({ fechaRecepcion: '2026-06-01', facturada: true, noFactura: 'F' }))).toBe(false); // facturada
    expect(isPasivoPorDistribuir(compra({ fechaRecepcion: '2026-06-01', cancelada: true }))).toBe(false);
  });
});

describe('buildPasivoPorDistribuir', () => {
  it('agrega líneas porPagar por OC con importe y antigüedad, ordenado por antigüedad', () => {
    const records: ComprasRecord[] = [
      // OC-VIEJA: recibida hace mucho, 2 líneas porPagar.
      compra({ noOrden: 'OC-VIEJA', lineaOrden: 1, importeTotal: 1000, fechaRecepcion: '2026-03-01' }),
      compra({ noOrden: 'OC-VIEJA', lineaOrden: 2, importeTotal: 500, fechaRecepcion: '2026-03-10' }),
      // línea facturada de la misma OC → NO cuenta en el pasivo
      compra({ noOrden: 'OC-VIEJA', lineaOrden: 3, importeTotal: 9999, fechaRecepcion: '2026-03-01', facturada: true, noFactura: 'F-1' }),
      // OC-NUEVA: recibida reciente.
      compra({ noOrden: 'OC-NUEVA', lineaOrden: 1, importeTotal: 2000, fechaRecepcion: '2026-06-10' }),
      // sin entrada → fuera
      compra({ noOrden: 'OC-ABIERTA', lineaOrden: 1, importeTotal: 7000 }),
    ];
    const items = buildPasivoPorDistribuir(records, AS_OF);

    expect(items.map((i) => i.noOrden)).toEqual(['OC-VIEJA', 'OC-NUEVA']); // viejo primero

    const vieja = items.find((i) => i.noOrden === 'OC-VIEJA')!;
    expect(vieja.importeMxn).toBe(1500); // 1000 + 500 (la facturada NO suma)
    expect(vieja.lineCount).toBe(2);
    expect(vieja.fechaRecepcion).toBe('2026-03-01'); // la más antigua
    expect(vieja.antiguedadDias).toBeGreaterThan(90);

    expect(pasivoTotalMxn(items)).toBe(3500); // 1500 + 2000
  });

  it('convierte divisa a MXN por tipo de cambio', () => {
    const items = buildPasivoPorDistribuir(
      [compra({ noOrden: 'OC-USD', moneda: 'USD', tipoCambio: 17, importeTotal: 100, fechaRecepcion: '2026-06-01' })],
      AS_OF,
    );
    expect(items[0].importeMxn).toBe(1700);
  });
});

describe('buildPasivoAging', () => {
  it('clasifica por días desde recepción en los cortes 0-30/31-60/61-90/+90', () => {
    const items = buildPasivoPorDistribuir(
      [
        compra({ noOrden: 'A', importeTotal: 100, fechaRecepcion: '2026-06-10' }), // ~7d
        compra({ noOrden: 'B', importeTotal: 200, fechaRecepcion: '2026-03-01' }), // +90d
      ],
      AS_OF,
    );
    const aging = buildPasivoAging(items);
    const byLabel = Object.fromEntries(aging.map((b) => [b.label, b.total]));
    expect(byLabel['0-30 días']).toBe(100);
    expect(byLabel['+90 días']).toBe(200);
  });
});

describe('pasivoToCsv', () => {
  it('emite encabezado + una fila por OC', () => {
    const items = buildPasivoPorDistribuir(
      [compra({ noOrden: 'OC-CSV', importeTotal: 1234, fechaRecepcion: '2026-06-01' })],
      AS_OF,
    );
    const csv = pasivoToCsv(items);
    const [header, row] = csv.split('\n');
    expect(header).toContain('Importe MXN');
    expect(header).toContain('Antigüedad (días)');
    expect(row).toContain('OC-CSV');
  });
});
