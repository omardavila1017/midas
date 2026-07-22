import { describe, expect, it } from 'vitest';
import {
  toISODate,
  buildSaleEntries,
  aggregateByDay,
  aggregateByMonth,
  aggregateByCompany,
  aggregateBySegment,
  entriesForMonth,
  filterEntriesBySegment,
  listVentaSegments,
  saleSourceAttribution,
  SEGMENT_POR_FACTURAR,
  toCsv,
} from './salesCalendarService';
import { SEGMENT_UNCLASSIFIED } from '../../../domain/cobranzaSegment';
import type { CobranzaRecord, RolRecord, ViajeEspecialRecord } from '../../../services/jde';

function cobranza(partial: Partial<CobranzaRecord>): CobranzaRecord {
  return {
    cia: '00011',
    noCliente: '1',
    nombreCliente: 'Cliente A',
    noFactura: 'RI-1',
    fechaFactura: '2026-03-10',
    fechaVence: '',
    fechaCobro: '',
    diasVencida: 0,
    importeBrutoPesos: 1160,
    importePendientePesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXP',
    condPago: '',
    estatus: '',
    tipoCambio: 1,
    ...partial,
  } as CobranzaRecord;
}

function rol(partial: Partial<RolRecord>): RolRecord {
  return {
    cia: '00011',
    empresa: '',
    kCliente: 1,
    cCliente: 'ABB',
    dCliente: 'ABB MEXICO',
    rfc: '',
    claveJDE: '40317168',
    facturacionTipo: 'MENSUAL',
    iva: 16,
    tipoViaje: 'SENCILL',
    ruta: 'RUTA-1',
    costoRuta: 100,
    viajes: 1,
    subTotal: 1000,
    despachado: true,
    efectuado: true,
    anio: 2026,
    semana: 11,
    fechaViaje: '2026-03-09',
    ...partial,
  } as RolRecord;
}

function especial(partial: Partial<ViajeEspecialRecord>): ViajeEspecialRecord {
  return {
    cia: '00011',
    empresaCodigo: 'SIRS2',
    kRenta: 722862,
    kCliente: 27756,
    dCliente: 'INSTITUTO X',
    rfc: '',
    claveJDE: '1270361',
    totalNegociado: 2000,
    diasCredito: 30,
    fSalidaPrimera: '2026-03-15',
    ...partial,
  } as ViajeEspecialRecord;
}

describe('toISODate', () => {
  it('accepts plain dates and datetimes', () => {
    expect(toISODate('2026-03-10')).toBe('2026-03-10');
    expect(toISODate('2026-03-10T13:40:00')).toBe('2026-03-10');
  });
  it('rejects sentinels and garbage', () => {
    expect(toISODate('1899-12-31')).toBeNull();
    expect(toISODate('')).toBeNull();
    expect(toISODate('not-a-date')).toBeNull();
    expect(toISODate(undefined)).toBeNull();
  });
});

describe('buildSaleEntries — facturado (cobranza)', () => {
  it('uses subtotal when present, dated by fechaFactura', () => {
    const entries = buildSaleEntries({
      cobranza: [cobranza({ subTotal: 1000, importeBrutoPesos: 1160 })],
      rol: [],
      viajesEspeciales: [],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'facturado', amount: 1000, date: '2026-03-10', source: 'cobranza' });
  });

  it('falls back to gross minus IVA when subtotal missing', () => {
    const entries = buildSaleEntries({
      cobranza: [cobranza({ subTotal: undefined, importeBrutoPesos: 1160, importeIVA: 160 })],
      rol: [],
      viajesEspeciales: [],
    });
    expect(entries[0].amount).toBe(1000);
  });
});

describe('buildSaleEntries — por facturar (ROL + especiales) without double counting', () => {
  it('includes executed ROL trips that are NOT yet invoiced', () => {
    const entries = buildSaleEntries({
      cobranza: [],
      rol: [rol({ efectuado: true, factura: '' })],
      viajesEspeciales: [],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'por-facturar', amount: 1000, source: 'rol' });
  });

  it('excludes ROL trips already invoiced (avoids double count with cobranza)', () => {
    const entries = buildSaleEntries({
      cobranza: [],
      rol: [rol({ efectuado: true, factura: 'RI-99' })],
      viajesEspeciales: [],
    });
    expect(entries).toHaveLength(0);
  });

  it('excludes non-executed ROL trips', () => {
    const entries = buildSaleEntries({
      cobranza: [],
      rol: [rol({ efectuado: false, factura: '' })],
      viajesEspeciales: [],
    });
    expect(entries).toHaveLength(0);
  });

  // B2.6 — predicho → facturado: un viaje ROL con `factura` VACÍO pero ya
  // facturado en cobranza (cruza por UUID fiscal) NO debe re-contarse como
  // "por facturar"; solo cuenta su venta facturada (capa 1). Antes el dedup
  // miraba solo `r.factura` y lo contaba doble.
  it('excludes an executed ROL trip already invoiced in cobranza via UUID even when its factura field is empty (no double count)', () => {
    const uuid = 'ABCDEF0123456789';
    const entries = buildSaleEntries({
      cobranza: [cobranza({ noFactura: 'RI-500', uuidFiscal: uuid, subTotal: 1000, fechaFactura: '2026-03-10' })],
      rol: [rol({ efectuado: true, factura: '', uuidFiscal: uuid, subTotal: 1000, fechaViaje: '2026-03-09' })],
      viajesEspeciales: [],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'facturado', source: 'cobranza' });
  });

  // Placeholders JDE ("-"/"0"/"N/A") = SIN factura: el viaje sigue siendo
  // "por facturar", no debe desaparecer por un folio placeholder.
  it('counts an executed ROL trip whose factura folio is a placeholder ("0") as por-facturar', () => {
    const entries = buildSaleEntries({
      cobranza: [],
      rol: [rol({ efectuado: true, factura: '0' })],
      viajesEspeciales: [],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('por-facturar');
  });

  it('counts a special trip whose facturaJDE folio is a placeholder ("-") as por-facturar', () => {
    const entries = buildSaleEntries({
      cobranza: [],
      rol: [],
      viajesEspeciales: [especial({ facturaJDE: '-', fSalidaPrimera: '2026-03-15' })],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'por-facturar', source: 'especial' });
  });

  it('includes special trips without a JDE invoice, dated by departure', () => {
    const entries = buildSaleEntries({
      cobranza: [],
      rol: [],
      viajesEspeciales: [especial({ facturaJDE: '', fSalidaPrimera: '2026-03-15' })],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'por-facturar', amount: 2000, source: 'especial', date: '2026-03-15' });
  });

  it('excludes invoiced special trips', () => {
    const entries = buildSaleEntries({
      cobranza: [],
      rol: [],
      viajesEspeciales: [especial({ facturaJDE: 'RI-305588' })],
    });
    expect(entries).toHaveLength(0);
  });
});

describe('aggregation', () => {
  const entries = buildSaleEntries({
    cobranza: [cobranza({ fechaFactura: '2026-03-10', subTotal: 1000 })],
    rol: [rol({ fechaViaje: '2026-03-10', subTotal: 500, factura: '' })],
    viajesEspeciales: [especial({ fSalidaPrimera: '2026-04-01', totalNegociado: 2000, facturaJDE: '' })],
  });

  it('sums by day, splitting facturado vs por facturar', () => {
    const byDay = aggregateByDay(entries);
    const march10 = byDay.get('2026-03-10')!;
    expect(march10.facturado).toBe(1000);
    expect(march10.porFacturar).toBe(500);
    expect(march10.total).toBe(1500);
    expect(march10.count).toBe(2);
  });

  it('sums by month', () => {
    const byMonth = aggregateByMonth(entries);
    expect(byMonth.get('2026-03')!.total).toBe(1500);
    expect(byMonth.get('2026-04')!.total).toBe(2000);
  });

  it('filters entries for a month', () => {
    expect(entriesForMonth(entries, '2026-04')).toHaveLength(1);
    expect(entriesForMonth(entries, '2026-03')).toHaveLength(2);
  });
});

describe('cobranzaVenta IVA derivation', () => {
  it('strips IVA when explicit, even without a subtotal', () => {
    const [e] = buildSaleEntries({
      cobranza: [cobranza({ subTotal: undefined, importeBrutoPesos: 1160, importeIVA: 160 })],
      rol: [],
      viajesEspeciales: [],
    });
    expect(e.amount).toBe(1000);
  });

  it('estimates 16% when neither subtotal nor IVA is present', () => {
    const [e] = buildSaleEntries({
      cobranza: [cobranza({ subTotal: undefined, importeBrutoPesos: 1160, importeIVA: undefined })],
      rol: [],
      viajesEspeciales: [],
    });
    expect(e.amount).toBeCloseTo(1000, 2);
  });

  it('treats an explicit IVA of 0 (exento) as already net', () => {
    const [e] = buildSaleEntries({
      cobranza: [cobranza({ subTotal: undefined, importeBrutoPesos: 1000, importeIVA: 0 })],
      rol: [],
      viajesEspeciales: [],
    });
    expect(e.amount).toBe(1000);
  });
});

describe('aggregateByCompany', () => {
  it('groups by cia and sorts by total desc', () => {
    const result = aggregateByCompany(
      buildSaleEntries({
        cobranza: [
          cobranza({ cia: '00011', subTotal: 1000 }),
          cobranza({ cia: '00038', subTotal: 3000, noFactura: 'RI-2' }),
        ],
        rol: [],
        viajesEspeciales: [],
      }),
    );
    expect(result.map((r) => r.cia)).toEqual(['00038', '00011']);
    expect(result[0].total).toBe(3000);
  });
});

describe('segmento / tipo de servicio (C.1)', () => {
  const entries = () =>
    buildSaleEntries({
      cobranza: [
        cobranza({ noFactura: 'RI-1', subTotal: 1000, tipoServicio: 'Contrato' }),
        cobranza({ noFactura: 'RI-2', subTotal: 2000, tipoServicio: 'Viaje Especial' }),
        cobranza({ noFactura: 'RI-3', subTotal: 500 }), // sin dato → Sin clasificar
      ],
      rol: [rol({ subTotal: 300 })], // por facturar: sin segmento
      viajesEspeciales: [],
    });

  it('sets segmento on the facturado layer only (ROL/Especiales have none)', () => {
    const all = entries();
    const facturado = all.filter((e) => e.status === 'facturado');
    expect(facturado.map((e) => e.segmento).sort()).toEqual(['Contrato', 'Sin clasificar', 'Viaje Especial']);
    const porFacturar = all.filter((e) => e.status === 'por-facturar');
    expect(porFacturar.every((e) => e.segmento === undefined)).toBe(true);
  });

  it('listVentaSegments returns distinct segments with Sin clasificar last', () => {
    expect(listVentaSegments(entries())).toEqual(['Contrato', 'Viaje Especial', SEGMENT_UNCLASSIFIED]);
    expect(listVentaSegments([])).toEqual([]);
  });

  it('filterEntriesBySegment keeps only the matching facturado entries (por-facturar drops)', () => {
    const filtered = filterEntriesBySegment(entries(), 'Contrato');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].referencia).toBe('RI-1');
    expect(filterEntriesBySegment(entries(), null)).toHaveLength(4);
  });

  it('aggregateBySegment groups totals with por-facturar bucketed last', () => {
    const rows = aggregateBySegment(entries());
    expect(rows.map((r) => r.segment)).toEqual([
      'Viaje Especial',
      'Contrato',
      SEGMENT_UNCLASSIFIED,
      SEGMENT_POR_FACTURAR,
    ]);
    expect(rows.find((r) => r.segment === SEGMENT_POR_FACTURAR)?.porFacturar).toBe(300);
    expect(rows.find((r) => r.segment === 'Contrato')?.facturado).toBe(1000);
  });

  it('toCsv includes the Segmento column', () => {
    const csv = toCsv(entries());
    expect(csv.split('\n')[0]).toContain('Segmento');
    expect(csv).toContain('Contrato');
    expect(csv).toContain('Viaje Especial');
  });
});

describe('saleSourceAttribution', () => {
  it('maps each SaleSource to its datalake source, single-source (no cross)', () => {
    expect(saleSourceAttribution('cobranza').sources).toEqual(['cobranza']);
    expect(saleSourceAttribution('rol').sources).toEqual(['rol']);
    expect(saleSourceAttribution('especial').sources).toEqual(['viajes-especiales']);
    expect(saleSourceAttribution('rol').crossed).toBe(false);
  });

  it('exposes the label used by the CSV Fuente column', () => {
    expect(saleSourceAttribution('cobranza').label).toBe('Cobranza JDE');
    expect(saleSourceAttribution('especial').label).toBe('Viajes Especiales');
  });
});

describe('toCsv', () => {
  it('emits a header and one row per entry, escaping commas', () => {
    const csv = toCsv(
      buildSaleEntries({
        cobranza: [cobranza({ nombreCliente: 'ACME, S.A.', subTotal: 1000, fechaFactura: '2026-03-10' })],
        rol: [],
        viajesEspeciales: [],
      }),
    );
    const lines = csv.split('\n');
    expect(lines[0]).toContain('Fecha');
    expect(lines[0]).toContain('Importe sin IVA');
    expect(lines[1]).toContain('"ACME, S.A."'); // coma escapada
    expect(lines[1]).toContain('1000.00');
  });

  // B3.8 — la fecha se exporta como dd/mm/aaaa (Excel es-MX).
  it('formats the date column as dd/mm/aaaa', () => {
    const csv = toCsv(
      buildSaleEntries({
        cobranza: [cobranza({ subTotal: 1000, fechaFactura: '2026-03-10' })],
        rol: [],
        viajesEspeciales: [],
      }),
    );
    expect(csv.split('\n')[1]).toContain('10/03/2026');
    expect(csv.split('\n')[1]).not.toContain('2026-03-10');
  });
});
