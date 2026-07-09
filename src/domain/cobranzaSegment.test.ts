import { describe, expect, it } from 'vitest';
import { SEGMENT_UNCLASSIFIED, segmentOf, listSegments, buildSegmentBreakdown } from './cobranzaSegment';
import type { CobranzaRecord } from '../services/jdeTypes';

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
