import { describe, it, expect } from 'vitest';
import {
  buildCobranzaBankCuadre,
  glConfirmedInvoiceKeysFromSourceConfirmation,
} from './cobranzaBankCuadre';
import type { PaymentReconciliation } from './realReconciliationEngine';

function pay(over: Partial<PaymentReconciliation> & Pick<PaymentReconciliation, 'idPago' | 'status'>): PaymentReconciliation {
  return {
    cia: '00011',
    fechaCobro: '2026-07-01',
    fechaContable: '2026-07-01',
    cuentaBancaria: '11.1020.0011302',
    banco: 'BANAMEX',
    noRecibo: '12345',
    importeRecibo: 1000,
    pendienteAplicar: 0,
    noCliente: 'C1',
    cliente: 'CLIENTE UNO',
    noBatch: 'B1',
    tipoCambio: 1,
    applicationCount: 1,
    importeAplicado: 1000,
    applications: [],
    ...over,
  };
}

function bankMov(importe: number) {
  return {
    movementKey: 'k',
    cia: '00011',
    cuenta: '0011302',
    fechaOperacion: '2026-07-01',
    importe,
    concepto: 'SPEI',
    referencia: 'REF',
  };
}

describe('buildCobranzaBankCuadre — clasificación por recibo', () => {
  it('CONFIRMED_REF con importe igual → cuadrado', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', status: 'CONFIRMED_REF', importeRecibo: 1000, bankMovement: bankMov(1000) }),
    ]);
    expect(res.payments[0].status).toBe('cuadrado');
    expect(res.payments[0].diferencia).toBe(0);
  });

  it('AUTO_UNIQUE con importe distinto (fuera de tolerancia) → descuadre-importe', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', status: 'AUTO_UNIQUE', importeRecibo: 1000, bankMovement: bankMov(950) }),
    ]);
    expect(res.payments[0].status).toBe('descuadre-importe');
    expect(res.payments[0].diferencia).toBe(50);
  });

  it('diferencia dentro de 0.5% → cuadrado (tolerancia)', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', status: 'CONFIRMED_REF', importeRecibo: 1000, bankMovement: bankMov(997) }),
    ]);
    expect(res.payments[0].status).toBe('cuadrado');
  });

  it('UNMATCHED sin movimiento bancario → sin-banco (aplicado en Edwards, no entró al banco)', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', status: 'UNMATCHED', importeRecibo: 1000, bankMovement: undefined }),
    ]);
    expect(res.payments[0].status).toBe('sin-banco');
    expect(res.payments[0].importeBanco).toBe(0);
    expect(res.payments[0].diferencia).toBe(1000);
  });

  it('AMBIGUOUS → revisar', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', status: 'AMBIGUOUS' }),
    ]);
    expect(res.payments[0].status).toBe('revisar');
  });

  it('CONFIRMED_REF pero sin bankMovement (edge) → sin-banco', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', status: 'CONFIRMED_REF', bankMovement: undefined }),
    ]);
    expect(res.payments[0].status).toBe('sin-banco');
  });
});

describe('buildCobranzaBankCuadre — agregación por cliente y totales', () => {
  it('agrupa por cliente y ordena por descuadre desc', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', noCliente: 'A', cliente: 'A', status: 'CONFIRMED_REF', importeRecibo: 500, bankMovement: bankMov(500) }),
      pay({ idPago: 'P2', noCliente: 'A', cliente: 'A', status: 'UNMATCHED', importeRecibo: 300, bankMovement: undefined }),
      pay({ idPago: 'P3', noCliente: 'B', cliente: 'B', status: 'UNMATCHED', importeRecibo: 900, bankMovement: undefined }),
    ]);
    // B tiene más descuadre (900) que A (300) → va primero.
    expect(res.byClient.map(c => c.noCliente)).toEqual(['B', 'A']);
    const a = res.byClient.find(c => c.noCliente === 'A')!;
    expect(a.totalPagos).toBe(2);
    expect(a.cuadrado).toEqual({ count: 1, importe: 500 });
    expect(a.sinBanco).toEqual({ count: 1, importe: 300 });
  });

  it('totales y % cuadrado por importe', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', status: 'CONFIRMED_REF', importeRecibo: 800, bankMovement: bankMov(800) }),
      pay({ idPago: 'P2', status: 'UNMATCHED', importeRecibo: 200, bankMovement: undefined }),
    ]);
    expect(res.totals.totalPagos).toBe(2);
    expect(res.totals.totalEdwards).toBe(1000);
    expect(res.totals.totalBanco).toBe(800);
    expect(res.totals.cuadrado.importe).toBe(800);
    expect(res.totals.sinBanco.importe).toBe(200);
    expect(res.totals.pctCuadradoImporte).toBeCloseTo(80, 5);
  });

  it('AMBIGUOUS no suma su candidato a totalBanco (el motor cuelga el MISMO abono en todo el grupo)', () => {
    // 3 recibos ambiguos contra UN depósito de $1000: sumarlo por recibo
    // reportaría $3000 de banco contra $1000 reales.
    const candidato = bankMov(1000);
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', status: 'AMBIGUOUS', importeRecibo: 1000, bankMovement: candidato }),
      pay({ idPago: 'P2', status: 'AMBIGUOUS', importeRecibo: 1000, bankMovement: candidato }),
      pay({ idPago: 'P3', status: 'AMBIGUOUS', importeRecibo: 1000, bankMovement: candidato }),
    ]);
    expect(res.totals.totalBanco).toBe(0);
    expect(res.payments.every(p => p.importeBanco === 0)).toBe(true);
    expect(res.payments.every(p => p.diferencia === 1000)).toBe(true);
  });

  it('ciaFilter restringe el conjunto', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', cia: '00011', status: 'UNMATCHED' }),
      pay({ idPago: 'P2', cia: '00030', status: 'UNMATCHED' }),
    ], { ciaFilter: new Set(['00030']) });
    expect(res.payments.map(p => p.idPago)).toEqual(['P2']);
  });

  it('cliente sin número no colapsa con otros bajo ""', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', noCliente: '', cliente: 'ANONIMO UNO', status: 'UNMATCHED' }),
      pay({ idPago: 'P2', noCliente: '', cliente: 'ANONIMO DOS', status: 'UNMATCHED' }),
    ]);
    expect(res.byClient).toHaveLength(2);
  });
});

describe('buildCobranzaBankCuadre — corroboración GL (auxiliar)', () => {
  const withApps = (idPago: string, invoices: Array<{ cia: string; noFactura: string }>) =>
    pay({
      idPago,
      status: 'CONFIRMED_REF',
      bankMovement: bankMov(1000),
      applicationCount: invoices.length,
      applications: invoices.map(inv => ({
        cia: inv.cia,
        noFactura: inv.noFactura,
        noFacturaNormalizada: inv.noFactura,
        noCliente: 'C1',
        cliente: 'CLIENTE UNO',
        tipoDocto: 'RI',
        fechaAplicacion: '2026-07-01',
        fechaFactura: '2026-06-01',
        fechaVencimiento: '2026-06-30',
        importeCobrado: 500,
        importeOriginalFactura: 500,
        tasaIva: '16',
        importeIvaFacturaOriginal: 80,
        ivaCausadoProporcional: 80,
      })),
    });

  it('glConfirmado=undefined cuando no se pasa el set', () => {
    const res = buildCobranzaBankCuadre([withApps('P1', [{ cia: '00011', noFactura: 'RI-1' }])]);
    expect(res.payments[0].glConfirmado).toBeUndefined();
  });

  it('glConfirmado=true cuando TODAS las facturas están confirmadas en GL', () => {
    const res = buildCobranzaBankCuadre(
      [withApps('P1', [{ cia: '00011', noFactura: 'RI-1' }, { cia: '00011', noFactura: 'RI-2' }])],
      { glConfirmedInvoiceKeys: new Set(['00011::RI-1', '00011::RI-2']) },
    );
    expect(res.payments[0].glConfirmado).toBe(true);
  });

  it('glConfirmado=false cuando falta alguna factura en GL', () => {
    const res = buildCobranzaBankCuadre(
      [withApps('P1', [{ cia: '00011', noFactura: 'RI-1' }, { cia: '00011', noFactura: 'RI-2' }])],
      { glConfirmedInvoiceKeys: new Set(['00011::RI-1']) },
    );
    expect(res.payments[0].glConfirmado).toBe(false);
  });

  it('glConfirmado cruza con folio normalizado (drift "RI - 1" vs "ri-1 ") — normFactura canónico en ambos lados', () => {
    const res = buildCobranzaBankCuadre(
      // Lado indicadores: folio con espacios alrededor del guión.
      [withApps('P1', [{ cia: '00011', noFactura: 'RI - 1' }])],
      // Lado GL: minúsculas + espacio colgante (formato crudo del ledger).
      { glConfirmedInvoiceKeys: glConfirmedInvoiceKeysFromSourceConfirmation(new Map([
        ['factura:00011::ri-1 ', { confirmed: true, flujo: 'ingreso' }],
      ])) },
    );
    expect(res.payments[0].glConfirmado).toBe(true);
  });

  it('glConfirmado=false para recibo sin aplicaciones', () => {
    const res = buildCobranzaBankCuadre(
      [pay({ idPago: 'P1', status: 'CONFIRMED_REF', bankMovement: bankMov(1000), applications: [] })],
      { glConfirmedInvoiceKeys: new Set(['00011::RI-1']) },
    );
    expect(res.payments[0].glConfirmado).toBe(false);
  });
});

describe('buildCobranzaBankCuadre — clientes con esquema de compensación', () => {
  // Reglas inyectadas espejo del catálogo real (herméticas al seed de producción).
  const RULES = [
    {
      scheme: 'aplica-a-proveedor' as const,
      label: 'TLJ',
      clientKeys: ['00123'],
      namePatterns: [/\bTLJ\b/i],
      cuentaCompensacion: '21.2010.0000123',
    },
    { scheme: 'descuento-en-origen' as const, label: 'APTIV', namePatterns: [/\bAPTIV?\b/i] },
    { scheme: 'descuento-en-origen' as const, label: 'CMI', namePatterns: [/\bCMI\b/i] },
  ];

  it('TLJ (aplica-a-proveedor) sin depósito bancario → compensacion, NO sin-banco', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', noCliente: '123', cliente: 'TLJ SA DE CV', status: 'UNMATCHED', importeRecibo: 1000 }),
    ], { compensationRules: RULES });
    expect(res.payments[0].status).toBe('compensacion');
    expect(res.payments[0].compensacion).toEqual({
      scheme: 'aplica-a-proveedor',
      label: 'TLJ',
      cuentaCompensacion: '21.2010.0000123',
    });
    expect(res.totals.sinBanco).toEqual({ count: 0, importe: 0 });
    expect(res.totals.compensacion).toEqual({ count: 1, importe: 1000 });
  });

  it('TLJ empata por clave JDE aunque el nombre no traiga "TLJ" (tolerante a padding)', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', noCliente: '123', cliente: 'TRANSPORTES LOGISTICOS X', status: 'UNMATCHED' }),
    ], { compensationRules: RULES });
    expect(res.payments[0].status).toBe('compensacion');
  });

  it('APTIV/CMI (descuento-en-origen): depósito neto menor que lo aplicado → compensacion (no descuadre-importe)', () => {
    const res = buildCobranzaBankCuadre([
      // El cliente descontó $200 en origen y depositó el neto.
      pay({ idPago: 'P1', noCliente: 'A1', cliente: 'APTIV CONTRACT SERVICES NORESTE', status: 'CONFIRMED_REF', importeRecibo: 1000, bankMovement: bankMov(800) }),
      pay({ idPago: 'P2', noCliente: 'C1', cliente: 'CMI FILTRATION MEXICO MANUFACTURA', status: 'UNMATCHED', importeRecibo: 500 }),
    ], { compensationRules: RULES });
    expect(res.payments.map(p => p.status)).toEqual(['compensacion', 'compensacion']);
    // El depósito neto real SÍ cuenta como banco (existe el abono).
    expect(res.payments[0].importeBanco).toBe(800);
    expect(res.totals.descuadreImporte).toEqual({ count: 0, importe: 0 });
    expect(res.totals.compensacion).toEqual({ count: 2, importe: 1500 });
  });

  it('descuento-en-origen con banco MAYOR que Edwards NO es compensación → sigue descuadre-importe', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', cliente: 'APTIV CONTRACT SERVICES', status: 'CONFIRMED_REF', importeRecibo: 800, bankMovement: bankMov(1000) }),
    ], { compensationRules: RULES });
    expect(res.payments[0].status).toBe('descuadre-importe');
  });

  it('cliente de compensación cuyo depósito SÍ cuadra completo → cuadrado normal (caso Corning→Bajío no es excepción)', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', cliente: 'APTIV CONTRACT SERVICES', status: 'CONFIRMED_REF', importeRecibo: 1000, bankMovement: bankMov(1000) }),
    ], { compensationRules: RULES });
    expect(res.payments[0].status).toBe('cuadrado');
    expect(res.payments[0].compensacion).toBeUndefined();
  });

  it('cliente normal (fuera del catálogo) NO entra a la excepción → sin-banco', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', cliente: 'CORNING OPTICAL COMMUNICATIONS', status: 'UNMATCHED', importeRecibo: 700 }),
    ], { compensationRules: RULES });
    expect(res.payments[0].status).toBe('sin-banco');
    expect(res.payments[0].compensacion).toBeUndefined();
    expect(res.totals.compensacion).toEqual({ count: 0, importe: 0 });
  });

  it('la compensación sale del % de descuadre: pctCuadradoImporte se calcula sobre la base bancarizable', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', cliente: 'CLIENTE NORMAL', status: 'CONFIRMED_REF', importeRecibo: 800, bankMovement: bankMov(800) }),
      pay({ idPago: 'P2', cliente: 'TLJ SA', status: 'UNMATCHED', importeRecibo: 200 }),
    ], { compensationRules: RULES });
    // Sin la excepción sería 80% (800/1000); con ella la base excluye los $200: 100%.
    expect(res.totals.pctCuadradoImporte).toBeCloseTo(100, 5);
  });

  it('todo el importe es compensación → 100% (no hay descuadre accionable)', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', cliente: 'TLJ SA', status: 'UNMATCHED', importeRecibo: 500 }),
    ], { compensationRules: RULES });
    expect(res.totals.pctCuadradoImporte).toBe(100);
  });

  it('la compensación no cuenta como descuadre en el orden por cliente', () => {
    const res = buildCobranzaBankCuadre([
      pay({ idPago: 'P1', noCliente: 'N1', cliente: 'CLIENTE NORMAL', status: 'UNMATCHED', importeRecibo: 100 }),
      pay({ idPago: 'P2', noCliente: 'T1', cliente: 'TLJ SA', status: 'UNMATCHED', importeRecibo: 9000 }),
    ], { compensationRules: RULES });
    // TLJ tiene más importe pero es compensación (esperado) → el descuadre real va primero.
    expect(res.byClient.map(c => c.noCliente)).toEqual(['N1', 'T1']);
    const tlj = res.byClient.find(c => c.noCliente === 'T1')!;
    expect(tlj.compensacion).toEqual({ count: 1, importe: 9000 });
    expect(tlj.sinBanco).toEqual({ count: 0, importe: 0 });
  });
});

describe('glConfirmedInvoiceKeysFromSourceConfirmation', () => {
  it('extrae sólo facturas de ingreso confirmadas', () => {
    const src = new Map([
      ['factura:00011::RI-1', { confirmed: true, flujo: 'ingreso' }],
      ['factura:00011::RI-2', { confirmed: false, flujo: 'ingreso' }], // no confirmada
      ['factura:00011::RI-3', { confirmed: true, flujo: 'egreso' }],   // egreso
      ['oc:00011::OC-1', { confirmed: true, flujo: 'egreso' }],        // no factura
    ]);
    const keys = glConfirmedInvoiceKeysFromSourceConfirmation(src);
    expect(Array.from(keys)).toEqual(['00011::RI-1']);
  });
});
