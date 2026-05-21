import { describe, it, expect } from 'vitest';
import {
  computeLeadTimeStats,
  leadTimeFor,
  DEFAULT_LEAD_TIME_DAYS,
} from './comprasLeadTime';
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

describe('computeLeadTimeStats', () => {
  it('returns null buckets when no records have both fechaPedido and fechaRecepcion', () => {
    const stats = computeLeadTimeStats([
      record({ fechaRecepcion: '' }),
      record({ fechaPedido: '' }),
    ]);
    expect(stats.global).toBeNull();
  });

  it('returns null bucket when sample size < MIN_SAMPLE_SIZE', () => {
    const stats = computeLeadTimeStats([
      record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-10' }),
      record({ fechaPedido: '2026-01-05', fechaRecepcion: '2026-01-15' }),
    ]);
    expect(stats.global).toBeNull();
  });

  it('computes median for global bucket with sufficient samples', () => {
    const records = [
      record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-05' }), // 4d
      record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-11' }), // 10d
      record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-15' }), // 14d
    ];
    const stats = computeLeadTimeStats(records);
    expect(stats.global?.sampleSize).toBe(3);
    expect(stats.global?.medianDays).toBe(10);
  });

  it('drops outliers (>180 days and negatives)', () => {
    const records = [
      record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-08' }), // 7d ✓
      record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-10' }), // 9d ✓
      record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-12' }), // 11d ✓
      record({ fechaPedido: '2026-01-01', fechaRecepcion: '2027-01-01' }), // 365d ✗ outlier
      record({ fechaPedido: '2026-02-01', fechaRecepcion: '2026-01-01' }), // negative ✗
    ];
    const stats = computeLeadTimeStats(records);
    expect(stats.global?.sampleSize).toBe(3);
    expect(stats.global?.medianDays).toBe(9);
  });

  it('skips cancelled records', () => {
    const records = [
      record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-10', cancelada: true }),
      record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-10', cancelada: true }),
      record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-10', cancelada: true }),
    ];
    expect(computeLeadTimeStats(records).global).toBeNull();
  });

  it('buckets by familia, subfamilia, categoria', () => {
    const make = (familia: string, subFamilia: string, days: number) =>
      record({
        fechaPedido: '2026-01-01',
        fechaRecepcion: new Date(Date.UTC(2026, 0, 1 + days)).toISOString().slice(0, 10),
        familia,
        subFamilia,
      });
    const stats = computeLeadTimeStats([
      make('PLI', 'QDA', 5),
      make('PLI', 'QDA', 7),
      make('PLI', 'QDA', 9),
      make('REF', 'OTR', 20),
      make('REF', 'OTR', 25),
      make('REF', 'OTR', 30),
    ]);
    expect(stats.byFamilia.get('PLI')?.medianDays).toBe(7);
    expect(stats.byFamilia.get('REF')?.medianDays).toBe(25);
    expect(stats.bySubfamilia.get('QDA')?.medianDays).toBe(7);
  });
});

describe('leadTimeFor', () => {
  const stats = computeLeadTimeStats([
    record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-04', familia: 'PLI', subFamilia: 'QDA', categoria: 'IND' }),
    record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-06', familia: 'PLI', subFamilia: 'QDA', categoria: 'IND' }),
    record({ fechaPedido: '2026-01-01', fechaRecepcion: '2026-01-08', familia: 'PLI', subFamilia: 'QDA', categoria: 'IND' }),
  ]);

  it('prefers cia+subfamilia when available', () => {
    const lt = leadTimeFor(stats, { cia: '00001', subFamilia: 'QDA', familia: 'PLI', categoria: 'IND' });
    expect(lt.source).toBe('cia-subfamilia');
    // Deltas [3, 5, 7], median = 5
    expect(lt.days).toBe(5);
  });

  it('falls back to familia when subfamilia missing', () => {
    const lt = leadTimeFor(stats, { cia: '99999', familia: 'PLI', categoria: 'IND' });
    expect(['cia-familia', 'familia']).toContain(lt.source);
  });

  it('falls back to default when nothing matches', () => {
    const empty = computeLeadTimeStats([]);
    const lt = leadTimeFor(empty, { cia: 'X', familia: 'X', categoria: 'X' });
    expect(lt.source).toBe('default');
    expect(lt.days).toBe(DEFAULT_LEAD_TIME_DAYS);
  });
});
