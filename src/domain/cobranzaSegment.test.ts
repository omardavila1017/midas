import { describe, expect, it } from 'vitest';
import { SEGMENT_UNCLASSIFIED, segmentOf, listSegments, buildSegmentBreakdown, buildSegmentByFactura } from './cobranzaSegment';
import type { CobranzaPayment, CobranzaRecord } from '../services/jdeTypes';

function inv(tipoServicio: string | undefined, bruto = 1000, pendiente = 0): CobranzaRecord {
  return {
    cia: '00011',
    noCliente: '1',
    nombreCliente: 'X',
    noFactura: 'RI-1',
    fechaFactura: '2026-01-10',
    fechaVence: '',
    fechaCobro: '',
    diasVencida: 0,
    importeBrutoPesos: bruto,
    importePendientePesos: pendiente,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXP',
    condPago: '',
    estatus: 'COBRADA',
    tipoCambio: 1,
    tipoServicio,
  } as CobranzaRecord;
}

describe('segmentOf — tolerant (B2.3)', () => {
  it('returns the trimmed tipoServicio when present', () => {
    expect(segmentOf(inv('  Dedicado  '))).toBe('Dedicado');
  });
  it('buckets missing / empty into "Sin clasificar"', () => {
    expect(segmentOf(inv(undefined))).toBe(SEGMENT_UNCLASSIFIED);
    expect(segmentOf(inv(''))).toBe(SEGMENT_UNCLASSIFIED);
    expect(segmentOf(inv('   '))).toBe(SEGMENT_UNCLASSIFIED);
  });
});

describe('buildSegmentBreakdown', () => {
  it('groups by segment (case-insensitive), sums bruto/pendiente, sorts by bruto desc with "Sin clasificar" last', () => {
    const rows = buildSegmentBreakdown([
      inv('Dedicado', 1000, 100),
      inv('DEDICADO', 500, 0), // mismo segmento, casing distinto
      inv('Spot', 3000, 0),
      inv(undefined, 200, 200),
    ]);
    expect(rows.map(r => r.segment)).toEqual(['Spot', 'Dedicado', SEGMENT_UNCLASSIFIED]);
    const dedicado = rows.find(r => r.segment === 'Dedicado')!;
    expect(dedicado.invoiceCount).toBe(2);
    expect(dedicado.bruto).toBe(1500);
    expect(dedicado.pendiente).toBe(100);
  });

  it('is tolerant when no record carries a segment (everything Sin clasificar)', () => {
    const rows = buildSegmentBreakdown([inv(undefined), inv('')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].segment).toBe(SEGMENT_UNCLASSIFIED);
    expect(rows[0].invoiceCount).toBe(2);
  });
});

describe('listSegments', () => {
  it('lists distinct segments with "Sin clasificar" last', () => {
    expect(listSegments([inv('Spot'), inv('Dedicado'), inv(undefined), inv('spot')]))
      .toEqual(['Dedicado', 'Spot', SEGMENT_UNCLASSIFIED]);
  });
});

// `jde.Cobranza_Citi` (la fuente de /cobranza) NO tiene columna `Tipo_Servicio`,
// así que `record.tipoServicio` viene vacío SIEMPRE y el filtro "Segmento" —que
// sólo se pinta con ≥1 segmento clasificado— nunca aparecía. La columna sí
// existe, al 100%, en `jde.Cobranza_Indicadores`, que Midas ya baja y ya mapea.
describe('segmento derivado del recibo (/cobranzaindicadores)', () => {
  function pago(tipoServicio: string | undefined, noFactura: string): CobranzaPayment {
    return {
      idPago: 'P-1',
      cia: '00011',
      fechaCobro: '2026-01-20',
      fechaContable: '2026-01-20',
      cuentaBancaria: '123',
      banco: 'BANAMEX',
      noRecibo: 'R',
      importeRecibo: 1000,
      pendienteAplicar: 0,
      noCliente: '1',
      cliente: 'X',
      noBatch: 'B',
      tipoCambio: 1,
      tipoServicio,
      applications: [{
        idPago: 'P-1',
        cia: '00011',
        fechaAplicacion: '2026-01-20',
        noCliente: '1',
        cliente: 'X',
        tipoDocto: 'RI',
        noFactura,
        noFacturaNormalizada: noFactura,
        fechaFactura: '2026-01-10',
        fechaVencimiento: '2026-02-10',
        diasAntiguedadFafv: 0,
        importeCobrado: 1000,
        importeOriginalFactura: 1000,
        tasaIva: '16',
        importeIvaFacturaOriginal: 0,
      }],
    } as CobranzaPayment;
  }

  it('clasifica la factura con el segmento de su recibo, cruzando el drift de folio', () => {
    // Indicadores manda "RI - 1"; /cobranza manda "RI-1".
    const overlay = buildSegmentByFactura([pago('Dedicado', 'RI - 1')]);
    expect(segmentOf(inv(undefined), overlay)).toBe('Dedicado');
    expect(listSegments([inv(undefined)], overlay)).toEqual(['Dedicado']);
    expect(buildSegmentBreakdown([inv(undefined, 500, 100)], overlay)[0])
      .toMatchObject({ segment: 'Dedicado', invoiceCount: 1, bruto: 500, pendiente: 100 });
  });

  it('el dato propio de la factura MANDA sobre el del recibo', () => {
    const overlay = buildSegmentByFactura([pago('Dedicado', 'RI-1')]);
    expect(segmentOf(inv('Spot'), overlay)).toBe('Spot');
  });

  it('nunca inventa: sin recibo, sin segmento en el recibo o sin overlay sigue Sin clasificar', () => {
    expect(segmentOf(inv(undefined), buildSegmentByFactura([pago(undefined, 'RI-1')])))
      .toBe(SEGMENT_UNCLASSIFIED);
    expect(segmentOf(inv(undefined), buildSegmentByFactura([pago('Dedicado', 'RI-999')])))
      .toBe(SEGMENT_UNCLASSIFIED);
    expect(segmentOf(inv(undefined))).toBe(SEGMENT_UNCLASSIFIED);
    expect(buildSegmentByFactura(undefined).size).toBe(0);
  });
});

/**
 * El PENDIENTE del desglose aplica el overlay de recibos (2026-09-08).
 *
 * Ironía estructural que hace crítico este caso: el segmento SÓLO existe cuando
 * hay recibo, así que toda fila clasificada de la tabla es justo la que trae el
 * pendiente inflado por `jde.Cobranza_Citi`. Medido 2026-09-08: $354.4M de
 * "Pendiente", $341.9M ya cobrados (96.5%).
 */
describe('pendiente del desglose: overlay de recibos, sólo a la baja', () => {
  function linea(
    noFactura: string,
    bruto: number,
    pendiente: number,
    tipoServicio?: string,
  ): CobranzaRecord {
    return { ...inv(tipoServicio, bruto, pendiente), noFactura } as CobranzaRecord;
  }

  function aplicado(entries: Array<[string, number]>): Map<string, number> {
    return new Map(entries.map(([folio, monto]) => [`00011::${folio}`, monto]));
  }

  it('descuenta el cobro que los recibos reportan y /cobranza aún no aplica', () => {
    // Cifras del segmento medido: la factura sigue "abierta" en /cobranza con su
    // pendiente completo, pero el recibo ya la cobró entera.
    const records = [linea('RI-1', 3_000_000, 3_000_000, 'SIR CONTRATO')];
    const rows = buildSegmentBreakdown(records, undefined, {
      allRecords: records,
      appliedByFactura: aplicado([['RI-1', 3_000_000]]),
    });
    expect(rows[0]).toMatchObject({ segment: 'SIR CONTRATO', bruto: 3_000_000, pendiente: 0 });
  });

  it('reparte el pozo POR FOLIO entre sus líneas, no lo resta íntegro a cada una', () => {
    // Un folio, dos líneas de 100k; el recibo cubrió 150k. Queda 50k por cobrar.
    const records = [
      linea('RI-7', 100_000, 100_000, 'IMSS'),
      linea('RI-7', 100_000, 100_000, 'IMSS'),
    ];
    const rows = buildSegmentBreakdown(records, undefined, {
      allRecords: records,
      appliedByFactura: aplicado([['RI-7', 150_000]]),
    });
    expect(rows[0].pendiente).toBe(50_000);
  });

  it('el filtro NO hace desaparecer cobranza real: el pozo se agota sobre el set completo', () => {
    // Mismo folio de arriba, pero el filtro sólo deja ver la segunda línea. Su
    // pendiente correcto es 50k (el recibo agotó los 100k de la primera).
    // Consumir el pozo sobre lo filtrado le restaría los 150k enteros → 0.
    const l1 = linea('RI-7', 100_000, 100_000, 'IMSS');
    const l2 = linea('RI-7', 100_000, 100_000, 'IMSS');
    const rows = buildSegmentBreakdown([l2], undefined, {
      allRecords: [l1, l2],
      appliedByFactura: aplicado([['RI-7', 150_000]]),
    });
    expect(rows[0]).toMatchObject({ invoiceCount: 1, bruto: 100_000, pendiente: 50_000 });
  });

  it('nunca suma: un recibo mayor que el saldo vivo no vuelve negativo el pendiente', () => {
    const records = [linea('RI-9', 100_000, 40_000, 'FEDERAL')];
    const rows = buildSegmentBreakdown(records, undefined, {
      allRecords: records,
      appliedByFactura: aplicado([['RI-9', 500_000]]),
    });
    expect(rows[0].pendiente).toBe(0);
  });

  it('degrada solo: sin recibos el resultado es idéntico al previo', () => {
    const records = [linea('RI-1', 500, 100, 'Dedicado')];
    const base = buildSegmentBreakdown(records);
    expect(buildSegmentBreakdown(records, undefined, { allRecords: records })).toEqual(base);
    expect(
      buildSegmentBreakdown(records, undefined, { allRecords: records, appliedByFactura: new Map() }),
    ).toEqual(base);
    expect(base[0].pendiente).toBe(100);
  });
});
