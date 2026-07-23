import { describe, expect, it } from 'vitest';
import type { CobranzaPayment, CobranzaPaymentApplication, CobranzaRecord, RolRecord } from '../services/jdeTypes';
import { buildRolCobranzaCross } from './rolCobranzaMatch';

function rol(patch: Partial<RolRecord> = {}): RolRecord {
  return {
    cia: '00001',
    empresa: 'SERVICIO INDUSTRIAL',
    kCliente: 125,
    cCliente: 'CLI',
    dCliente: 'CLIENTE ALFA',
    rfc: 'XAXX010101000',
    claveJDE: '9001',
    facturacionTipo: 'MENSUAL',
    iva: 16,
    tipoViaje: 'SENCILL',
    ruta: 'RUTA TEST',
    costoRuta: 200,
    viajes: 5,
    subTotal: 1000,
    despachado: true,
    efectuado: true,
    anio: 2026,
    semana: 19,
    fechaViaje: '2026-05-04',
    ...patch,
  };
}

function factura(patch: Partial<CobranzaRecord> = {}): CobranzaRecord {
  return {
    cia: '00001',
    noCliente: '9001',
    nombreCliente: 'CLIENTE ALFA',
    noFactura: 'RI-305405',
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

function paymentApp(patch: Partial<CobranzaPaymentApplication> = {}): CobranzaPaymentApplication {
  return {
    idPago: 'P-1',
    cia: '00001',
    fechaAplicacion: '2026-05-20',
    noCliente: '9001',
    cliente: 'CLIENTE ALFA',
    tipoDocto: 'RI',
    noFactura: 'RI-305405',
    noFacturaNormalizada: 'RI-305405',
    fechaFactura: '2026-05-05',
    fechaVencimiento: '2026-06-04',
    diasAntiguedadFafv: 0,
    importeCobrado: 1160,
    importeOriginalFactura: 1160,
    tasaIva: '16',
    importeIvaFacturaOriginal: 160,
    ...patch,
  };
}

function payment(apps: CobranzaPaymentApplication[], patch: Partial<CobranzaPayment> = {}): CobranzaPayment {
  return {
    idPago: 'P-1',
    cia: '00001',
    fechaCobro: '2026-05-20',
    fechaContable: '2026-05-20',
    cuentaBancaria: '123',
    banco: 'BANAMEX',
    noRecibo: '90829',
    importeRecibo: 1160,
    pendienteAplicar: 0,
    noCliente: '9001',
    cliente: 'CLIENTE ALFA',
    noBatch: 'B-1',
    tipoCambio: 1,
    applications: apps,
    ...patch,
  };
}

describe('buildRolCobranzaCross · clasificación base', () => {
  it('viaje sin factura ni uuid → predicted', () => {
    const cross = buildRolCobranzaCross([rol()], [factura()]);
    expect(cross.predicted).toHaveLength(1);
    expect(cross.matches).toHaveLength(0);
    expect(cross.invoicedOrphans).toHaveLength(0);
  });

  it('placeholders de factura ("-", "0", "N/A") cuentan como sin factura', () => {
    const cross = buildRolCobranzaCross(
      [rol({ factura: '-' }), rol({ factura: '0' }), rol({ factura: 'N/A' })],
      [factura()],
    );
    expect(cross.predicted).toHaveLength(3);
    expect(cross.invoicedOrphans).toHaveLength(0);
  });

  it('match exacto por folio', () => {
    const cross = buildRolCobranzaCross([rol({ factura: 'RI-305405' })], [factura()]);
    expect(cross.matches).toHaveLength(1);
    expect(cross.matches[0].source).toBe('factura');
    expect(cross.matches[0].cobranza?.noFactura).toBe('RI-305405');
  });

  it('factura realmente inexistente en cobranza y pagos → huérfano', () => {
    const cross = buildRolCobranzaCross([rol({ factura: 'RI-999999' })], [factura()]);
    expect(cross.invoicedOrphans).toHaveLength(1);
  });
});

describe('buildRolCobranzaCross · variantes de formato (antes huérfanos)', () => {
  it('espacios alrededor del guion: "RI - 305405" cruza con "RI-305405"', () => {
    const cross = buildRolCobranzaCross([rol({ factura: 'RI - 305405' })], [factura()]);
    expect(cross.matches).toHaveLength(1);
    expect(cross.matches[0].source).toBe('factura');
  });

  it('case-insensitive y espacios sueltos: "ri-305405 " cruza', () => {
    const cross = buildRolCobranzaCross([rol({ factura: ' ri-305405 ' })], [factura()]);
    expect(cross.matches).toHaveLength(1);
  });

  it('folio sin prefijo: "305405" cruza con "RI-305405" por núcleo numérico', () => {
    const cross = buildRolCobranzaCross([rol({ factura: '305405' })], [factura()]);
    expect(cross.matches).toHaveLength(1);
    expect(cross.matches[0].source).toBe('factura-digits');
  });

  it('ceros a la izquierda: "RI-0305405" cruza con "RI-305405"', () => {
    const cross = buildRolCobranzaCross([rol({ factura: 'RI-0305405' })], [factura()]);
    expect(cross.matches).toHaveLength(1);
    expect(cross.matches[0].source).toBe('factura-digits');
  });

  it('campo multi-folio "RI-111/RI-305405" cruza con cualquiera de los folios', () => {
    const cross = buildRolCobranzaCross([rol({ factura: 'RI-111/RI-305405' })], [factura()]);
    expect(cross.matches).toHaveLength(1);
    expect(cross.matches[0].cobranza?.noFactura).toBe('RI-305405');
  });

  it('UUID con formato distinto (minúsculas / sin guiones) cruza', () => {
    const uuid = '85A17FEE-C11C-4F3A-8EC4-3896F8468AE3';
    const cross = buildRolCobranzaCross(
      [rol({ factura: 'FOLIO-DESCONOCIDO', uuidFiscal: '85a17feec11c4f3a8ec43896f8468ae3' })],
      [factura({ noFactura: 'OTRA-REF', uuidFiscal: uuid })],
    );
    expect(cross.matches).toHaveLength(1);
    expect(cross.matches[0].source).toBe('uuid');
  });
});

describe('buildRolCobranzaCross · guardia de cliente y desempate', () => {
  it('núcleo numérico NO cruza clientes distintos (guardia)', () => {
    const cross = buildRolCobranzaCross(
      [rol({ factura: '305405', claveJDE: '9001' })],
      [factura({ noFactura: 'RI-305405', noCliente: '7777' })],
    );
    expect(cross.matches).toHaveLength(0);
    expect(cross.invoicedOrphans).toHaveLength(1);
  });

  it('con folio duplicado en varias cías, prefiere misma cía y mismo cliente', () => {
    const cross = buildRolCobranzaCross(
      [rol({ factura: 'RI-305405', cia: '00002', claveJDE: '9001' })],
      [
        factura({ cia: '00001', noCliente: '7777' }),
        factura({ cia: '00002', noCliente: '9001' }),
      ],
    );
    expect(cross.matches).toHaveLength(1);
    expect(cross.matches[0].cobranza?.cia).toBe('00002');
    expect(cross.matches[0].cobranza?.noCliente).toBe('9001');
  });
});

describe('buildRolCobranzaCross · pagos aplicados (CobranzaIndicadores)', () => {
  it('factura cobrada que ya no está en CXC cruza contra el pago aplicado (no huérfano)', () => {
    const cross = buildRolCobranzaCross(
      [rol({ factura: 'RI-305405' })],
      [], // CXC sin la factura (ya cobrada / fuera de ventana)
      [payment([paymentApp()])],
    );
    expect(cross.invoicedOrphans).toHaveLength(0);
    expect(cross.matches).toHaveLength(1);
    expect(cross.matches[0].source).toBe('pago');
    expect(cross.matches[0].payment?.noFactura).toBe('RI-305405');
  });

  it('factura con MÁS DE UN pago aplicado cruza una sola vez', () => {
    const cross = buildRolCobranzaCross(
      [rol({ factura: 'RI-305405' })],
      [],
      [
        payment([paymentApp({ idPago: 'P-1', importeCobrado: 600 })]),
        payment([paymentApp({ idPago: 'P-2', importeCobrado: 560 })], { idPago: 'P-2' }),
      ],
    );
    expect(cross.matches).toHaveLength(1);
    expect(cross.invoicedOrphans).toHaveLength(0);
  });

  it('el pago también respeta la guardia de cliente', () => {
    const cross = buildRolCobranzaCross(
      [rol({ factura: 'RI-305405', claveJDE: '9001' })],
      [],
      [payment([paymentApp({ noCliente: '7777' })])],
    );
    expect(cross.matches).toHaveLength(0);
    expect(cross.invoicedOrphans).toHaveLength(1);
  });
});

describe('buildRolCobranzaCross · sin clave de cliente (Clave_JDE nula en CITI)', () => {
  // Auditoría BD 2026-07-22: 102 viajes efectuados en 8 semanas llegaron con
  // Clave_JDE NULL (un solo cliente). Antes pasaban silenciosos a predicted/
  // invoicedOrphans; ahora tienen bucket propio, accionable con CITI.
  it('viaje efectuado SIN factura y SIN clave → sinClaveCliente, no predicted', () => {
    const cross = buildRolCobranzaCross(
      [rol({ claveJDE: '', dCliente: 'CLIENTE ACME' })],
      [factura()],
    );
    expect(cross.sinClaveCliente).toHaveLength(1);
    expect(cross.predicted).toHaveLength(0);
    expect(cross.invoicedOrphans).toHaveLength(0);
    expect(cross.matches).toHaveLength(0);
  });

  it('clave con solo espacios cuenta como sin clave', () => {
    const cross = buildRolCobranzaCross([rol({ claveJDE: '   ' })], []);
    expect(cross.sinClaveCliente).toHaveLength(1);
    expect(cross.predicted).toHaveLength(0);
  });

  it('viaje CON factura no encontrada y SIN clave → sinClaveCliente; huérfanos NO se inflan', () => {
    const cross = buildRolCobranzaCross(
      [rol({ claveJDE: '', factura: 'RI-999999' })],
      [factura()],
    );
    expect(cross.sinClaveCliente).toHaveLength(1);
    expect(cross.invoicedOrphans).toHaveLength(0);
  });

  it('viaje SIN clave pero con folio EXACTO en cobranza sigue siendo match (identificación afirmativa)', () => {
    const cross = buildRolCobranzaCross(
      [rol({ claveJDE: '', factura: 'RI-305405' })],
      [factura()],
    );
    expect(cross.matches).toHaveLength(1);
    expect(cross.sinClaveCliente).toHaveLength(0);
  });

  it('viaje CON clave conserva el comportamiento previo (predicted / huérfano)', () => {
    const cross = buildRolCobranzaCross(
      [rol(), rol({ factura: 'RI-999999' })],
      [factura()],
    );
    expect(cross.predicted).toHaveLength(1);
    expect(cross.invoicedOrphans).toHaveLength(1);
    expect(cross.sinClaveCliente).toHaveLength(0);
  });

  it('summarizeRolCrossByClient agrupa los sin-clave por razón social con conteo y monto', async () => {
    const { summarizeRolCrossByClient } = await import('./rolCobranzaMatch');
    const cross = buildRolCobranzaCross(
      [
        rol({ claveJDE: '', dCliente: 'CLIENTE ACME', viajes: 3, subTotal: 600 }),
        rol({ claveJDE: '', dCliente: 'CLIENTE ACME', viajes: 2, subTotal: 400 }),
      ],
      [],
    );
    const summary = summarizeRolCrossByClient(cross);
    const acme = summary.find((s) => s.dCliente === 'CLIENTE ACME');
    expect(acme?.sinClaveTrips).toBe(5);
    expect(acme?.sinClaveAmount).toBe(1000);
    expect(acme?.predictedTrips).toBe(0);
  });
});
