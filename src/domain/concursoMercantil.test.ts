import { describe, expect, it } from 'vitest';
import {
  CONCURSO_MERCANTIL_CUTOFF,
  aggregateConcursoByCia,
  aggregateConcursoByProvider,
  aggregateConcursoByYear,
  excludeConcursoMercantil,
  getConcursoProviderIds,
  isConcursoMercantil,
  normalizeFechaFactura,
  normalizeProviderId,
  onlyConcursoMercantil,
} from './concursoMercantil';
import type { CXPRecord } from './persistence';

function rec(partial: Partial<CXPRecord>): CXPRecord {
  return {
    cia: '00011',
    noProveedor: 'P001',
    nombre: 'PROVEEDOR UNO',
    noFactura: 'F-001',
    fechaFactura: '2024-01-15',
    fechaVence: '2024-02-15',
    fechaProgramacionPago: '',
    diasVencida: 0,
    importeBrutoPesos: 1000,
    importePendientePesos: 1000,
    importeSubtotalPesos: 1000,
    importeImpuestosPesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30D',
    clasifica: '',
    clasificacionProveedor: '',
    edoPago: 'PENDIENTE',
    tipoCambio: 1,
    porVencer: 0,
    v1_30: 0,
    v31_60: 0,
    v61_90: 0,
    v91_120: 0,
    v121_150: 0,
    v151_180: 0,
    mas180: 0,
    ...partial,
  };
}

describe('concursoMercantil', () => {
  it('cutoff is 2022-12-31', () => {
    expect(CONCURSO_MERCANTIL_CUTOFF).toBe('2022-12-31');
  });

  it('isConcursoMercantil: invoice on or before cutoff returns true', () => {
    expect(isConcursoMercantil({ fechaFactura: '2022-12-31' })).toBe(true);
    expect(isConcursoMercantil({ fechaFactura: '2022-12-30' })).toBe(true);
    expect(isConcursoMercantil({ fechaFactura: '2019-06-01' })).toBe(true);
    expect(isConcursoMercantil({ fechaFactura: '2000-01-01' })).toBe(true);
  });

  it('isConcursoMercantil: invoice after cutoff returns false', () => {
    expect(isConcursoMercantil({ fechaFactura: '2023-01-01' })).toBe(false);
    expect(isConcursoMercantil({ fechaFactura: '2024-05-14' })).toBe(false);
    expect(isConcursoMercantil({ fechaFactura: '2026-12-31' })).toBe(false);
  });

  it('isConcursoMercantil: missing/short date returns false (do not flag)', () => {
    expect(isConcursoMercantil({ fechaFactura: '' })).toBe(false);
    expect(isConcursoMercantil({ fechaFactura: '202' })).toBe(false);
  });

  it('isConcursoMercantil: handles Mexican DD-MM-YYYY format', () => {
    // 01-02-2023 = 1-Feb-2023 → NOT concurso (after cutoff)
    expect(isConcursoMercantil({ fechaFactura: '01-02-2023' })).toBe(false);
    // 31-12-2022 = 31-Dec-2022 → concurso (at cutoff)
    expect(isConcursoMercantil({ fechaFactura: '31-12-2022' })).toBe(true);
    // 15-06-2019 → concurso
    expect(isConcursoMercantil({ fechaFactura: '15-06-2019' })).toBe(true);
    // 20-12-2025 → NOT concurso
    expect(isConcursoMercantil({ fechaFactura: '20-12-2025' })).toBe(false);
  });

  it('isConcursoMercantil: handles DD/MM/YYYY slash format', () => {
    expect(isConcursoMercantil({ fechaFactura: '15/06/2019' })).toBe(true);
    expect(isConcursoMercantil({ fechaFactura: '01/01/2024' })).toBe(false);
  });

  it('normalizeFechaFactura returns ISO YYYY-MM-DD or null', () => {
    expect(normalizeFechaFactura('2024-01-15')).toBe('2024-01-15');
    expect(normalizeFechaFactura('01-02-2023')).toBe('2023-02-01');
    expect(normalizeFechaFactura('15/06/2019')).toBe('2019-06-15');
    expect(normalizeFechaFactura('garbage')).toBe(null);
    expect(normalizeFechaFactura('')).toBe(null);
    expect(normalizeFechaFactura(null)).toBe(null);
    // 32-01-2024 is invalid day → null
    expect(normalizeFechaFactura('32-01-2024')).toBe(null);
  });

  it('excludeConcursoMercantil drops old records, keeps new ones', () => {
    const records = [
      rec({ noFactura: 'OLD-1', fechaFactura: '2020-05-01' }),
      rec({ noFactura: 'NEW-1', fechaFactura: '2024-01-15' }),
      rec({ noFactura: 'EDGE', fechaFactura: '2022-12-31' }),
      rec({ noFactura: 'NEW-2', fechaFactura: '2023-01-01' }),
    ];
    const kept = excludeConcursoMercantil(records);
    expect(kept.map((r) => r.noFactura)).toEqual(['NEW-1', 'NEW-2']);
  });

  it('onlyConcursoMercantil keeps old records, drops new ones', () => {
    const records = [
      rec({ noFactura: 'OLD-1', fechaFactura: '2020-05-01' }),
      rec({ noFactura: 'NEW-1', fechaFactura: '2024-01-15' }),
      rec({ noFactura: 'EDGE', fechaFactura: '2022-12-31' }),
    ];
    const kept = onlyConcursoMercantil(records);
    expect(kept.map((r) => r.noFactura)).toEqual(['OLD-1', 'EDGE']);
  });

  it('aggregateConcursoByProvider sums per provider sorted desc by total', () => {
    const records = [
      rec({ noProveedor: 'A', nombre: 'A', importePendientePesos: 100, fechaFactura: '2020-01-01' }),
      rec({ noProveedor: 'A', nombre: 'A', importePendientePesos: 200, fechaFactura: '2019-06-01' }),
      rec({ noProveedor: 'B', nombre: 'B', importePendientePesos: 50, fechaFactura: '2021-03-01' }),
    ];
    const result = aggregateConcursoByProvider(records);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ noProveedor: 'A', total: 300, count: 2, oldestFecha: '2019-06-01' });
    expect(result[1]).toMatchObject({ noProveedor: 'B', total: 50, count: 1 });
  });

  it('aggregateConcursoByCia tracks unique providers', () => {
    const records = [
      rec({ cia: '00011', noProveedor: 'A', importePendientePesos: 100 }),
      rec({ cia: '00011', noProveedor: 'A', importePendientePesos: 200 }),
      rec({ cia: '00011', noProveedor: 'B', importePendientePesos: 50 }),
      rec({ cia: '00038', noProveedor: 'A', importePendientePesos: 999 }),
    ];
    const result = aggregateConcursoByCia(records);
    expect(result.find((r) => r.cia === '00011')).toMatchObject({ count: 3, providers: 2, total: 350 });
    expect(result.find((r) => r.cia === '00038')).toMatchObject({ count: 1, providers: 1, total: 999 });
  });

  it('getConcursoProviderIds returns trim+upper set of noProveedor for concurso CXP only', () => {
    const records = [
      rec({ noProveedor: 'P-100', fechaFactura: '2020-05-01' }),    // concurso → in
      rec({ noProveedor: 'p-100', fechaFactura: '2024-01-15' }),    // post-cutoff for same provider → still in via OLD invoice above
      rec({ noProveedor: 'P-200', fechaFactura: '2024-06-01' }),    // never concurso → out
      rec({ noProveedor: '  P-300  ', fechaFactura: '2019-01-01' }),// trimmed → in
      rec({ noProveedor: '', fechaFactura: '2018-01-01' }),         // empty id → skipped
    ];
    const set = getConcursoProviderIds(records);
    expect(set.has('P-100')).toBe(true);
    expect(set.has('P-300')).toBe(true);
    expect(set.has('P-200')).toBe(false);
    expect(set.has('')).toBe(false);
    expect(set.size).toBe(2);
  });

  it('getConcursoProviderIds: case + whitespace insensitive', () => {
    const records = [
      rec({ noProveedor: 'abc-1', fechaFactura: '2020-01-01' }),
    ];
    const set = getConcursoProviderIds(records);
    expect(set.has('ABC-1')).toBe(true);
    expect(normalizeProviderId('  abc-1  ')).toBe('ABC-1');
  });

  it('normalizeProviderId handles null/undefined/empty', () => {
    expect(normalizeProviderId(null)).toBe('');
    expect(normalizeProviderId(undefined)).toBe('');
    expect(normalizeProviderId('')).toBe('');
    expect(normalizeProviderId('  ')).toBe('');
    expect(normalizeProviderId('p123')).toBe('P123');
  });

  it('aggregateConcursoByYear groups by 4-digit year asc', () => {
    const records = [
      rec({ fechaFactura: '2019-06-01', importePendientePesos: 100 }),
      rec({ fechaFactura: '2020-01-15', importePendientePesos: 50 }),
      rec({ fechaFactura: '2019-12-31', importePendientePesos: 25 }),
    ];
    const result = aggregateConcursoByYear(records);
    expect(result).toEqual([
      { year: '2019', total: 125, count: 2 },
      { year: '2020', total: 50, count: 1 },
    ]);
  });
});
