import { describe, it, expect } from 'vitest';
import type { CobranzaRecord, ViajeEspecialRecord } from '../services/jdeTypes';
import {
  buildViajesEspecialesCobranzaCross,
  buildViajesEspecialesFacturaKeys,
  summarizeViajesEspecialesByClient,
} from './viajesEspecialesCobranzaMatch';

function viaje(patch: Partial<ViajeEspecialRecord> = {}): ViajeEspecialRecord {
  return {
    cia: '00001',
    empresaCodigo: 'SIRS2',
    kRenta: 1001,
    kCliente: 125,
    dCliente: 'CLIENTE ALFA',
    rfc: 'XAXX010101000',
    claveJDE: '9001',
    totalNegociado: 1000,
    diasCredito: 30,
    facturaJDE: 'RI-700100',
    uuidFiscal: 'AAAA1111-BBBB-2222-CCCC-333344445555',
    fSalidaPrimera: '2026-05-01',
    fRegresoUltima: '2026-05-03',
    fechaFactura: '2026-05-05',
    ...patch,
  };
}

function factura(patch: Partial<CobranzaRecord> = {}): CobranzaRecord {
  return {
    cia: '00001',
    noCliente: '9001',
    nombreCliente: 'CLIENTE ALFA',
    noFactura: 'RI-700100',
    fechaFactura: '2026-05-05',
    fechaVence: '2026-06-04',
    fechaCobro: '',
    diasVencida: 0,
    importeBrutoPesos: 1160,
    importePendientePesos: 1160,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30',
    estatus: 'PENDIENTE',
    tipoCambio: 1,
    ...patch,
  };
}

describe('buildViajesEspecialesCobranzaCross', () => {
  it('matches by exact factura folio (case/space tolerant)', () => {
    const result = buildViajesEspecialesCobranzaCross(
      [viaje({ facturaJDE: '  ri-700100 ', uuidFiscal: '' })],
      [factura({ noFactura: 'RI-700100' })],
    );
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].source).toBe('factura');
    expect(result.unmatched).toHaveLength(0);
    expect(result.withoutInvoice).toHaveLength(0);
  });

  it('falls back to UUID when the folio is not in cobranza', () => {
    const uuid = 'AAAA1111-BBBB-2222-CCCC-333344445555';
    const result = buildViajesEspecialesCobranzaCross(
      [viaje({ facturaJDE: 'RI-999999', uuidFiscal: uuid.toLowerCase() })],
      [factura({ noFactura: 'RI-700100', uuidFiscal: uuid })],
    );
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].source).toBe('uuid');
  });

  it('prefers the factura tier over uuid when both hit', () => {
    const uuid = 'AAAA1111-BBBB-2222-CCCC-333344445555';
    const result = buildViajesEspecialesCobranzaCross(
      [viaje({ facturaJDE: 'RI-700100', uuidFiscal: uuid })],
      [factura({ noFactura: 'RI-700100', uuidFiscal: uuid })],
    );
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].source).toBe('factura');
  });

  it('classifies an invoiced trip absent from cobranza as unmatched', () => {
    const result = buildViajesEspecialesCobranzaCross(
      [viaje({ facturaJDE: 'RI-888888', uuidFiscal: '' })],
      [factura({ noFactura: 'RI-700100' })],
    );
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0].facturaJDE).toBe('RI-888888');
  });

  it('classifies trips without factura and uuid as withoutInvoice, treating placeholders as empty', () => {
    const placeholders = ['', '-', '0', 'N/A', 'na', undefined];
    const viajes = placeholders.map((p, i) =>
      viaje({ kRenta: 2000 + i, facturaJDE: p, uuidFiscal: p }),
    );
    const result = buildViajesEspecialesCobranzaCross(viajes, [factura()]);
    expect(result.withoutInvoice).toHaveLength(placeholders.length);
    expect(result.matched).toHaveLength(0);
    expect(result.unmatched).toHaveLength(0);
  });

  it('matches despite folio format drift — spaces around hyphen and internal whitespace', () => {
    // Antes de compartir normFactura con el cruce ROL, "RI - 700100" NO
    // cruzaba contra "RI-700100": el viaje caía a unmatched y el motor emitía
    // un sintético cxc:especial:viaje: DUPLICANDO el cxc: real en Base.
    const result = buildViajesEspecialesCobranzaCross(
      [viaje({ facturaJDE: 'RI - 700100', uuidFiscal: '' })],
      [factura({ noFactura: 'RI-700100' })],
    );
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].source).toBe('factura');
    expect(result.unmatched).toHaveLength(0);
  });

  it('matches UUIDs despite hyphen/brace drift (hex-purified comparison)', () => {
    const result = buildViajesEspecialesCobranzaCross(
      [viaje({ facturaJDE: 'RI-999999', uuidFiscal: '{aaaa1111-bbbb-2222-cccc-333344445555}' })],
      [factura({ noFactura: 'RI-700100', uuidFiscal: 'AAAA1111BBBB2222CCCC333344445555' })],
    );
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].source).toBe('uuid');
  });

  it('treats ROL-style placeholders (S/F, SIN FACTURA) as empty folio', () => {
    const result = buildViajesEspecialesCobranzaCross(
      [
        viaje({ kRenta: 3001, facturaJDE: 'S/F', uuidFiscal: '' }),
        viaje({ kRenta: 3002, facturaJDE: 'SIN FACTURA', uuidFiscal: '' }),
      ],
      [factura()],
    );
    expect(result.withoutInvoice).toHaveLength(2);
    expect(result.unmatched).toHaveLength(0);
  });

  it('does not let a placeholder folio ("-") match a cobranza placeholder', () => {
    const result = buildViajesEspecialesCobranzaCross(
      [viaje({ facturaJDE: '-', uuidFiscal: '-' })],
      [factura({ noFactura: '-', uuidFiscal: '-' })],
    );
    expect(result.matched).toHaveLength(0);
    expect(result.withoutInvoice).toHaveLength(1);
  });
});

describe('buildViajesEspecialesFacturaKeys', () => {
  it('emits cia::factura keys only for invoiced trips', () => {
    const keys = buildViajesEspecialesFacturaKeys([
      viaje({ cia: '00001', facturaJDE: 'ri-700100' }),
      viaje({ cia: '00033', kRenta: 1002, facturaJDE: 'RI - 700200' }),
      viaje({ kRenta: 1003, facturaJDE: '' }),
      viaje({ kRenta: 1004, facturaJDE: 'N/A' }),
    ]);
    // "RI - 700200" normaliza a "RI-700200" — la misma normFactura que usa el
    // motor para re-etiquetar, así el drift de formato no rompe el join.
    expect(keys).toEqual(new Set(['00001::RI-700100', '00033::RI-700200']));
  });
});

describe('summarizeViajesEspecialesByClient', () => {
  it('aggregates trips/amounts per client per bucket, sorted by total desc', () => {
    const result = buildViajesEspecialesCobranzaCross(
      [
        viaje({ kRenta: 1, claveJDE: '9001', dCliente: 'ALFA', totalNegociado: 1000, facturaJDE: 'RI-1', uuidFiscal: '' }),
        viaje({ kRenta: 2, claveJDE: '9001', dCliente: 'ALFA', totalNegociado: 500, facturaJDE: 'RI-MISSING', uuidFiscal: '' }),
        viaje({ kRenta: 3, claveJDE: '9002', dCliente: 'BETA', totalNegociado: 9000, facturaJDE: '', uuidFiscal: '' }),
      ],
      [factura({ noFactura: 'RI-1' })],
    );

    const summary = summarizeViajesEspecialesByClient(result);

    expect(summary.map((s) => s.claveJDE)).toEqual(['9002', '9001']);
    expect(summary[1]).toEqual({
      claveJDE: '9001',
      dCliente: 'ALFA',
      matchedTrips: 1,
      matchedAmount: 1000,
      unmatchedTrips: 1,
      unmatchedAmount: 500,
      withoutInvoiceTrips: 0,
      withoutInvoiceAmount: 0,
    });
    expect(summary[0].withoutInvoiceTrips).toBe(1);
    expect(summary[0].withoutInvoiceAmount).toBe(9000);
  });
});
