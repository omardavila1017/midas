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
