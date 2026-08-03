import { describe, it, expect } from 'vitest';
import {
  buildCitiCellBreakdown,
  citiCollectionGroupKey,
  createCitiClientResolver,
  selectCitiCollectionByClient,
} from './citiClientCollection';
import type { CobranzaRecord } from '../../../services/jdeTypes';
import type { Client } from '../../../domain/types';

function rec(patch: Partial<CobranzaRecord> = {}): CobranzaRecord {
  return {
    cia: '00011',
    noCliente: '103246',
    nombreCliente: '3M MEXICO S.A. DE C.V.',
    noFactura: 'RI-301306',
    fechaFactura: '2025-12-16',
    fechaVence: '2026-02-14',
    fechaCobro: '2026-02-12',
    diasVencida: 0,
    importeBrutoPesos: 221_201.53,
    importePendientePesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30',
    estatus: 'PAGADA',
    tipoCambio: 1,
    ...patch,
  };
}

const resolver = () => createCitiClientResolver([]);
const wantsAll = () => true;

describe('selectCitiCollectionByClient', () => {
  it('agrupa por (cía, mes de cobro) y cliente, sumando importes y conservando las facturas', () => {
    const byGroup = selectCitiCollectionByClient({
      records: [
        rec({ noFactura: 'RI-301711', fechaCobro: '2026-02-12', importeBrutoPesos: 13_906.08 }),
        rec({ noFactura: 'RI-302177', fechaCobro: '2026-02-12', importeBrutoPesos: 20_859.12 }),
        rec({ noFactura: 'RI-303194', fechaCobro: '2026-02-25', importeBrutoPesos: 20_859.12 }),
        // Otro mes → otro grupo.
        rec({ noFactura: 'RI-304447', fechaCobro: '2026-04-30', importeBrutoPesos: 23_176.80 }),
      ],
      wantsGroup: wantsAll,
      resolveClient: resolver(),
    });

    const feb = byGroup.get('00011::2026-02')!.get('103246')!;
    expect(feb.amount).toBeCloseTo(55_624.32, 2);
    expect(feb.invoices.map((i) => i.noFactura)).toEqual(['RI-301711', 'RI-302177', 'RI-303194']);
    expect(byGroup.get('00011::2026-04')!.get('103246')!.amount).toBeCloseTo(23_176.80, 2);
  });

  it('normaliza la cía en la llave: sin padding cae en el mismo grupo que con padding', () => {
    const byGroup = selectCitiCollectionByClient({
      records: [rec({ cia: '11' }), rec({ cia: '00011', noFactura: 'RI-2' })],
      wantsGroup: wantsAll,
      resolveClient: resolver(),
    });
    expect([...byGroup.keys()]).toEqual(['00011::2026-02']);
    expect(byGroup.get('00011::2026-02')!.get('103246')!.invoices).toHaveLength(2);
  });

  it('acota por wantsGroup: los periodos que no interesan no se recorren', () => {
    const byGroup = selectCitiCollectionByClient({
      records: [rec({ fechaCobro: '2026-02-12' }), rec({ fechaCobro: '2026-03-12', noFactura: 'RI-2' })],
      wantsGroup: (key) => key === '00011::2026-02',
      resolveClient: resolver(),
    });
    expect([...byGroup.keys()]).toEqual(['00011::2026-02']);
  });

  it('descarta lo que el criterio Citi excluye: sin fecha de cobro, importe no positivo y nombre de persona', () => {
    const byGroup = selectCitiCollectionByClient({
      records: [
        rec({ fechaCobro: '', noFactura: 'SIN-COBRO' }),
        rec({ importeBrutoPesos: 0, noFactura: 'CERO' }),
        rec({ noCliente: 'P-1', nombreCliente: 'JUAN PEREZ GARCIA', noFactura: 'PERSONA' }),
        rec({ noFactura: 'VALIDA' }),
      ],
      wantsGroup: wantsAll,
      resolveClient: resolver(),
    });
    const clients = byGroup.get('00011::2026-02')!;
    expect([...clients.keys()]).toEqual(['103246']);
    expect(clients.get('103246')!.invoices.map((i) => i.noFactura)).toEqual(['VALIDA']);
  });

  it('colapsa al grupo comercial del catálogo, igual que el counterpartyId del motor', () => {
    const catalog: Client[] = [{
      id: 'catalog-corning',
      name: 'CORNING OPTICAL COMMUNICATIONS',
      commercialGroupId: 'group-corning',
      commercialGroupName: 'Corning',
      paymentDay: { kind: 'ANY' },
      frequency: 'Mensual',
      creditDays: 30,
      monthlyBilling: Array.from({ length: 12 }, () => 0),
      complianceRate: 1,
    }];
    const byGroup = selectCitiCollectionByClient({
      records: [rec({ noCliente: '46371819', nombreCliente: 'CORNING OPTICAL COMMUNICATIONS' })],
      wantsGroup: wantsAll,
      resolveClient: createCitiClientResolver(catalog),
    });
    const clients = byGroup.get('00011::2026-02')!;
    expect([...clients.keys()]).toEqual(['group-corning']);
    expect(clients.get('group-corning')!.name).toBe('Corning');
  });

  it('devuelve objetos nuevos en cada llamada: mutar el peso de un consumidor no afecta al otro', () => {
    const records = [rec()];
    const first = selectCitiCollectionByClient({ records, wantsGroup: wantsAll, resolveClient: resolver() });
    first.get('00011::2026-02')!.get('103246')!.amount = 0;
    const second = selectCitiCollectionByClient({ records, wantsGroup: wantsAll, resolveClient: resolver() });
    expect(second.get('00011::2026-02')!.get('103246')!.amount).toBeCloseTo(221_201.53, 2);
  });
});

describe('buildCitiCellBreakdown', () => {
  const records = [
    rec({ noFactura: 'RI-303194', fechaCobro: '2026-02-25', importeBrutoPesos: 20_859.12 }),
    rec({ noFactura: 'RI-301711', fechaCobro: '2026-02-12', importeBrutoPesos: 13_906.08 }),
    rec({ noFactura: 'RI-302177', fechaCobro: '2026-02-12', importeBrutoPesos: 20_859.12 }),
  ];

  it('factor 1.000 cuando el depósito se acreditó completo, y ordena las facturas por fecha de cobro', () => {
    const breakdown = buildCitiCellBreakdown({
      records,
      clients: [],
      cia: '00011',
      yearMonth: '2026-02',
      clientId: '103246',
      attributedAmount: 55_624.32,
    })!;
    expect(breakdown.invoicedTotal).toBeCloseTo(55_624.32, 2);
    expect(breakdown.factor).toBeCloseTo(1, 3);
    expect(breakdown.invoices.map((i) => i.noFactura)).toEqual(['RI-301711', 'RI-302177', 'RI-303194']);
  });

  it('declara el factor < 1 del reparto proporcional en vez de esconder la diferencia', () => {
    const breakdown = buildCitiCellBreakdown({
      records,
      clients: [],
      cia: '00011',
      yearMonth: '2026-02',
      clientId: '103246',
      // El depósito sólo alcanzó para el 84% de su cobranza.
      attributedAmount: 55_624.32 * 0.84,
    })!;
    expect(breakdown.factor).toBeCloseTo(0.84, 3);
    // Las facturas siguen sumando su importe REAL: el factor es lo que explica
    // la diferencia contra lo atribuido, no un ajuste a las facturas.
    expect(breakdown.invoicedTotal).toBeCloseTo(55_624.32, 2);
    expect(breakdown.attributedAmount).toBeLessThan(breakdown.invoicedTotal);
  });

  it('devuelve null cuando el cliente no tiene cobranza en ese periodo', () => {
    expect(buildCitiCellBreakdown({
      records, clients: [], cia: '00011', yearMonth: '2026-01', clientId: '103246', attributedAmount: 100,
    })).toBeNull();
    expect(buildCitiCellBreakdown({
      records, clients: [], cia: '00011', yearMonth: '2026-02', clientId: 'OTRO', attributedAmount: 100,
    })).toBeNull();
  });

  it('tolera la cía sin padding, igual que el motor', () => {
    expect(buildCitiCellBreakdown({
      records, clients: [], cia: '11', yearMonth: '2026-02', clientId: '103246', attributedAmount: 55_624.32,
    })).not.toBeNull();
  });
});

describe('citiCollectionGroupKey', () => {
  it('normaliza la cía a 5 dígitos', () => {
    expect(citiCollectionGroupKey('11', '2026-02')).toBe('00011::2026-02');
    expect(citiCollectionGroupKey('00011', '2026-02')).toBe('00011::2026-02');
    expect(citiCollectionGroupKey(undefined, '2026-02')).toBe('::2026-02');
  });
});
