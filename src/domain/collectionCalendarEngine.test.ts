import { describe, expect, it } from 'vitest';
import type { BankAccountStatement, BankStatementLine, CobranzaPayment, CobranzaRecord, RolRecord } from '../services/jdeTypes';
import type { CashFlowAssumptions, Client } from './types';
import { reconcileRealCollections } from './realReconciliationEngine';
import { buildRolProjectedInflows } from './rolProjectionEngine';
import {
  buildCollectionCalendar,
  calendarEventMatchesSourceFilter,
  listPromesasPago,
  recomputeClientCreditDaysFromCobranza,
} from './collectionCalendarEngine';

const ASSUMPTIONS: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: overrides.id ?? '9001',
    name: overrides.name ?? 'CLIENTE ALFA',
    paymentDay: overrides.paymentDay ?? { kind: 'ANY' },
    frequency: overrides.frequency ?? 'Mensual',
    creditDays: overrides.creditDays ?? 0,
    monthlyBilling: overrides.monthlyBilling ?? new Array(12).fill(1000),
    ...overrides,
  };
}

function makeFactura(
  overrides: Partial<CobranzaRecord> & Pick<CobranzaRecord, 'cia' | 'noFactura' | 'noCliente' | 'nombreCliente' | 'importeBrutoPesos'>,
): CobranzaRecord {
  return {
    fechaFactura: '2026-01-01',
    fechaVence: '2026-01-31',
    fechaCobro: '',
    diasVencida: 0,
    importePendientePesos: overrides.importePendientePesos ?? overrides.importeBrutoPesos,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30',
    estatus: 'PENDIENTE',
    tipoCambio: 1,
    ...overrides,
  };
}

function makeRol(overrides: Partial<RolRecord> = {}): RolRecord {
  return {
    cia: '00011',
    empresa: 'SERVICIO INDUSTRIAL',
    kCliente: 125,
    cCliente: 'ALFA',
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
    semana: 23,
    fechaViaje: '2026-06-01',
    ...overrides,
  };
}

function makeAbono(
  overrides: Partial<BankStatementLine> & Pick<BankStatementLine, 'cia' | 'cuenta' | 'fechaOperacion' | 'importe'>,
): BankStatementLine {
  return {
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    moneda: 'MXN',
    fechaValor: undefined,
    referencia: 'REF',
    concepto: 'PAGO CLIENTE ALFA',
    tipoMovimiento: 'ABONO',
    saldo: undefined,
    ...overrides,
  };
}

function makeAccount(params: {
  cia: string;
  cuenta: string;
  movimientos: BankStatementLine[];
}): BankAccountStatement {
  return {
    cia: params.cia,
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    cuenta: params.cuenta,
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-01-31',
    saldoInicial: 0,
    saldoFinal: 0,
    movimientos: params.movimientos,
  };
}

describe('buildCollectionCalendar', () => {
  it('usa fecha de banco cuando una factura CXC cruza con un ABONO', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-100',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 1000,
    });
    const abono = makeAbono({
      cia: '00011',
      cuenta: '123',
      fechaOperacion: '2026-01-30',
      importe: 1000,
      referencia: 'DEP-100',
    });
    const reconciliation = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '123', movimientos: [abono] })],
    );
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation,
    });

    const event = calendar.events.find(e => e.source === 'BANK_MATCHED');
    expect(event?.date).toBe('2026-01-30');
    expect(event?.noFactura).toBe('F-100');
    expect(event?.bank?.referencia).toBe('DEP-100');
    expect(calendar.events.some(e => e.noFactura === 'F-100' && e.source === 'JDE_OPEN_PROJECTED')).toBe(false);
  });

  it('muestra JDE cobrado sin bankStatements como JDE_PAID_UNMATCHED', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-JDE',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 2500,
      importePendientePesos: 0,
      fechaCobro: '2026-02-03',
      estatus: 'PAGADA',
    });
    const reconciliation = reconcileRealCollections([factura], []);
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation,
    });

    const event = calendar.events.find(e => e.source === 'JDE_PAID_UNMATCHED');
    expect(event?.date).toBe('2026-02-03');
    expect(event?.amount).toBe(2500);
    expect(event?.statusLabel).toContain('JDE');
  });

  // Cifras del caso REAL medido en `jde.Cobranza_Citi`: la factura ZS-74684
  // (cía 00038, dic-2025) trae Importe_Factura 46,136,786.43 con
  // Importe_Pendiente 17,122,092.43 — o sea 29,014,694.00 YA cobrados. Antes
  // el calendario emitía SÓLO la proyección del saldo y esos $29M no
  // aparecían como ingreso en ningún día.
  describe('factura parcialmente cobrada', () => {
    const PARCIAL = {
      cia: '00038',
      noFactura: 'ZS-74684',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 46136786.43,
      importePendientePesos: 17122092.43,
      fechaCobro: '2025-12-30',
      fechaFactura: '2025-12-29',
    } as const;

    it('emite el cobro parcial como ingreso Y el saldo como proyección', () => {
      const factura = makeFactura({ ...PARCIAL });
      const calendar = buildCollectionCalendar({
        clients: [makeClient()],
        assumptions: ASSUMPTIONS,
        cobranzaRecords: [factura],
        reconciliation: reconcileRealCollections([factura], []),
      });

      const cobrado = calendar.events.find(e => e.source === 'JDE_PAID_UNMATCHED');
      expect(cobrado?.date).toBe('2025-12-30');
      expect(cobrado?.amount).toBeCloseTo(29014694, 2);
      expect(cobrado?.statusLabel).toContain('parcial');

      const saldo = calendar.events.find(e => e.source === 'JDE_OPEN_PROJECTED');
      expect(saldo?.amount).toBeCloseTo(17122092.43, 2);

      // Ni un peso de más: los dos eventos suman exactamente el bruto.
      const total = calendar.events.reduce((s, e) => s + e.amount, 0);
      expect(total).toBeCloseTo(46136786.43, 2);
    });

    // El cruce bancario es contra el BRUTO (`reconcileRealCollections` no
    // modela pagos parciales), así que un ABONO cruzado significa factura
    // completa: el calendario NO debe emitir además el saldo, o duplicaría.
    it('con la factura cruzada en banco no emite ningún evento JDE encima', () => {
      const factura = makeFactura({
        cia: '00038',
        noFactura: 'ZS-CRUZADA',
        noCliente: '9001',
        nombreCliente: 'CLIENTE ALFA',
        importeBrutoPesos: 46136786.43,
      });
      const abono = makeAbono({
        cia: '00038',
        cuenta: '123',
        fechaOperacion: '2025-12-30',
        importe: 46136786.43,
        referencia: 'DEP-TOTAL',
      });
      const calendar = buildCollectionCalendar({
        clients: [makeClient()],
        assumptions: ASSUMPTIONS,
        cobranzaRecords: [factura],
        reconciliation: reconcileRealCollections(
          [factura],
          [makeAccount({ cia: '00038', cuenta: '123', movimientos: [abono] })],
        ),
      });

      expect(calendar.events.some(e => e.source === 'BANK_MATCHED')).toBe(true);
      expect(calendar.events.some(e => e.source === 'JDE_PAID_UNMATCHED')).toBe(false);
      expect(calendar.events.some(e => e.source === 'JDE_OPEN_PROJECTED')).toBe(false);
      const total = calendar.events.reduce((s, e) => s + e.amount, 0);
      expect(total).toBeCloseTo(46136786.43, 2);
    });
  });

  // `jde.Cobranza_Citi` no aplica los recibos que `jde.Cobranza_Indicadores`
  // sí registra. Medido 2026-08-17 (jul–ago 2026): 1,151 de 2,811 facturas
  // cobradas no traen `Fecha_Pago`, y 1,111 siguen con `Importe_Pendiente > 0`
  // por $227.41M que el calendario proyectaba como cobrable ya estando cobrado.
  describe('saldo por cobrar corregido con los recibos de Indicadores', () => {
    function makePayment(
      noFactura: string,
      importeCobrado: number,
      overrides: Partial<CobranzaPayment> = {},
    ): CobranzaPayment {
      return {
        idPago: '1',
        cia: '00011',
        fechaCobro: '2026-07-15',
        fechaContable: '2026-07-15',
        cuentaBancaria: '123',
        banco: 'BANAMEX',
        noRecibo: '681244',
        importeRecibo: importeCobrado,
        pendienteAplicar: 0,
        noCliente: '9001',
        cliente: 'CLIENTE ALFA',
        noBatch: '1',
        tipoCambio: 1,
        applications: [{
          idPago: '1',
          cia: '00011',
          fechaAplicacion: '2026-07-15',
          noCliente: '9001',
          cliente: 'CLIENTE ALFA',
          tipoDocto: 'RI',
          noFactura,
          noFacturaNormalizada: noFactura,
          fechaFactura: '2026-06-01',
          fechaVencimiento: '2026-07-01',
          diasAntiguedadFafv: 30,
          importeCobrado,
          importeOriginalFactura: importeCobrado,
          tasaIva: '16',
          importeIvaFacturaOriginal: 0,
        }],
        ...overrides,
      };
    }

    const ABIERTA = {
      cia: '00011',
      noFactura: 'RI-310198',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 100000,
      fechaFactura: '2026-06-01',
      fechaVence: '2026-07-01',
    } as const;

    function build(payments?: CobranzaPayment[]) {
      const factura = makeFactura({ ...ABIERTA });
      return buildCollectionCalendar({
        clients: [makeClient()],
        assumptions: ASSUMPTIONS,
        cobranzaRecords: [factura],
        reconciliation: reconcileRealCollections([factura], []),
        cobranzaPayments: payments,
      });
    }

    it('quita de la proyección la factura que el recibo ya liquidó', () => {
      const calendar = build([makePayment('RI - 310198', 100000)]);
      expect(calendar.events.some(e => e.source === 'JDE_OPEN_PROJECTED')).toBe(false);
      // …y NO la convierte en ingreso: ese dinero ya está del lado banco.
      expect(calendar.events.some(e => e.source === 'JDE_PAID_UNMATCHED')).toBe(false);
    });

    it('cruza el folio pese al drift de formato entre los dos endpoints', () => {
      // Indicadores manda "RI - 310198"; /cobranza manda "RI-310198".
      expect(build([makePayment('RI - 310198', 40000)]).events
        .find(e => e.source === 'JDE_OPEN_PROJECTED')?.amount).toBe(60000);
    });

    it('acumula varias aplicaciones sobre el mismo folio', () => {
      const calendar = build([
        makePayment('RI - 310198', 30000),
        makePayment('RI - 310198', 25000, { idPago: '2', noRecibo: '681245' }),
      ]);
      expect(calendar.events.find(e => e.source === 'JDE_OPEN_PROJECTED')?.amount).toBe(45000);
    });

    it('confiesa el ajuste en el detalle del día', () => {
      const event = build([makePayment('RI - 310198', 40000)]).events
        .find(e => e.source === 'JDE_OPEN_PROJECTED');
      expect(event?.statusLabel).toContain('ajustado');
      expect(event?.dateReason).toContain('/cobranzaindicadores');
    });

    it('sin recibos deja el saldo intacto', () => {
      expect(build().events.find(e => e.source === 'JDE_OPEN_PROJECTED')?.amount).toBe(100000);
      expect(build([]).events.find(e => e.source === 'JDE_OPEN_PROJECTED')?.amount).toBe(100000);
    });

    it('no descuenta dos veces el recibo que /cobranza YA aplicó', () => {
      // /cobranza ya reconoce el cobro parcial (pendiente 30k de 100k) y el
      // recibo reporta ESE MISMO cobro de 70k. Restar sobre el pendiente
      // daría 0; comparar contra el bruto conserva los 30k reales.
      const factura = makeFactura({ ...ABIERTA, importePendientePesos: 30000, fechaCobro: '2026-07-15' });
      const calendar = buildCollectionCalendar({
        clients: [makeClient()],
        assumptions: ASSUMPTIONS,
        cobranzaRecords: [factura],
        reconciliation: reconcileRealCollections([factura], []),
        cobranzaPayments: [makePayment('RI - 310198', 70000)],
      });
      expect(calendar.events.find(e => e.source === 'JDE_OPEN_PROJECTED')?.amount).toBe(30000);
      // El ingreso sigue saliendo de /cobranza, no del recibo.
      expect(calendar.events.find(e => e.source === 'JDE_PAID_UNMATCHED')?.amount).toBe(70000);
      const total = calendar.events.reduce((s, e) => s + e.amount, 0);
      expect(total).toBe(100000);
    });

    it('reparte el recibo entre las líneas de una factura multi-línea', () => {
      // `/cobranza` devuelve una factura en VARIAS líneas y el merge del repo
      // NO las colapsa por folio a propósito (colapsarlas sub-cuenta Venta/CXC
      // — ver `mergeCobranzaBackfillRange`). El recibo de Indicadores es del
      // FOLIO COMPLETO, así que aplicarlo entero a cada línea borra saldo real.
      const lineas = [
        makeFactura({ ...ABIERTA, importeBrutoPesos: 100000 }),
        makeFactura({ ...ABIERTA, importeBrutoPesos: 100000 }),
      ];
      const calendar = buildCollectionCalendar({
        clients: [makeClient()],
        assumptions: ASSUMPTIONS,
        cobranzaRecords: lineas,
        reconciliation: reconcileRealCollections(lineas, []),
        cobranzaPayments: [makePayment('RI - 310198', 150000)],
      });
      const proyectado = calendar.events
        .filter(e => e.source === 'JDE_OPEN_PROJECTED')
        .reduce((s, e) => s + e.amount, 0);
      // 200k facturados − 150k cobrados = 50k que siguen por cobrar.
      expect(proyectado).toBe(50000);
      expect(calendar.events.some(e => e.source === 'JDE_PAID_UNMATCHED')).toBe(false);
    });

    it('no descuenta de una línea más de lo que el recibo alcanza a cubrir', () => {
      // El excedente del recibo se consume línea por línea: la primera absorbe
      // lo que puede y la segunda conserva su saldo íntegro.
      const lineas = [
        makeFactura({ ...ABIERTA, importeBrutoPesos: 40000 }),
        makeFactura({ ...ABIERTA, importeBrutoPesos: 100000 }),
      ];
      const calendar = buildCollectionCalendar({
        clients: [makeClient()],
        assumptions: ASSUMPTIONS,
        cobranzaRecords: lineas,
        reconciliation: reconcileRealCollections(lineas, []),
        cobranzaPayments: [makePayment('RI - 310198', 40000)],
      });
      const montos = calendar.events
        .filter(e => e.source === 'JDE_OPEN_PROJECTED')
        .map(e => e.amount)
        .sort((a, b) => a - b);
      expect(montos).toEqual([100000]);
    });

    it('ignora aplicaciones sin folio o de importe no positivo', () => {
      const calendar = build([
        makePayment('', 50000),
        makePayment('RI - 310198', 0),
        makePayment('RI - 310198', -5000, { idPago: '3' }),
      ]);
      expect(calendar.events.find(e => e.source === 'JDE_OPEN_PROJECTED')?.amount).toBe(100000);
    });
  });

  // Medido en la BD: RI-296064 trae Fecha_Pago '2508-08-27' y RI-43996
  // '2125-12-02'. No son el centinela 1899 que el mapper corta.
  it('re-fecha un cobro con Fecha_Pago imposible y lo confiesa', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'RI-296064',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 10672,
      importePendientePesos: 0,
      fechaFactura: '2025-08-11',
      fechaVence: '2025-08-09',
      fechaCobro: '2508-08-27',
    });
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: reconcileRealCollections([factura], []),
    });

    const event = calendar.events.find(e => e.source === 'JDE_PAID_UNMATCHED');
    expect(event?.date).toBe('2025-08-09');
    expect(event?.amount).toBe(10672);
    expect(event?.dateReason).toContain('2508-08-27');
    // Un lag contra una fecha imposible no significa nada.
    expect(event?.paymentLagDays).toBeUndefined();
  });

  it('calendariza una factura JDE pendiente con regla de cliente', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-RULE',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 1000,
      fechaFactura: '2026-01-01',
      fechaVence: '2026-01-31',
    });
    const client = makeClient({
      creditDays: 30,
      paymentDay: { kind: 'DOW', days: [5] },
      paymentDayRaw: 'Viernes',
    });
    const calendar = buildCollectionCalendar({
      clients: [client],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: reconcileRealCollections([factura], []),
    });

    const event = calendar.events.find(e => e.source === 'JDE_OPEN_PROJECTED' && e.noFactura === 'F-RULE');
    expect(event?.date).toBe('2026-02-06');
    expect(event?.ruleApplied).toContain('Viernes');
    expect(event?.dateReason).toContain('30 dias');
    expect(event?.statusLabel).toContain('JDE');
  });

  it('propaga fechaPromesaPago (informativa) a la factura del evento sin alterar el fechado', () => {
    const conPromesa = makeFactura({
      cia: '00011',
      noFactura: 'F-PROM',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 1000,
      fechaFactura: '2026-01-01',
      fechaVence: '2026-01-31',
      fechaPromesaPago: '2026-02-20',
    });
    const sinPromesa = makeFactura({
      cia: '00011',
      noFactura: 'F-SINP',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 500,
    });
    const client = makeClient({
      creditDays: 30,
      paymentDay: { kind: 'DOW', days: [5] },
      paymentDayRaw: 'Viernes',
    });
    const calendar = buildCollectionCalendar({
      clients: [client],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [conPromesa, sinPromesa],
      reconciliation: reconcileRealCollections([conPromesa, sinPromesa], []),
    });

    const event = calendar.events.find(e => e.noFactura === 'F-PROM');
    expect(event?.facturas[0]?.fechaPromesaPago).toBe('2026-02-20');
    // Informativa: el fechado sigue saliendo de la regla del cliente, no de la promesa.
    expect(event?.date).toBe('2026-02-06');
    const otro = calendar.events.find(e => e.noFactura === 'F-SINP');
    expect(otro?.facturas[0]?.fechaPromesaPago).toBeUndefined();
  });

  it('usa la regla del API (Nombre_Dia_Pago_CC13 + Dias_Credito) sobre el catálogo', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-API',
      noCliente: '9001',
      nombreCliente: 'IMPULSORA INDUSTRIAL MONTERREY',
      importeBrutoPesos: 1000,
      fechaFactura: '2026-01-01',
      fechaVence: '2026-01-31',
      diaPagoNombre: 'Viernes',
      diasCredito: 30,
    });
    // Catálogo viejo/incorrecto: lunes, 999 días. El API debe ganar.
    const client = makeClient({
      creditDays: 999,
      paymentDay: { kind: 'DOW', days: [1] },
      paymentDayRaw: 'Lunes',
    });
    const calendar = buildCollectionCalendar({
      clients: [client],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: reconcileRealCollections([factura], []),
    });

    const event = calendar.events.find(e => e.source === 'JDE_OPEN_PROJECTED' && e.noFactura === 'F-API');
    expect(event?.date).toBe('2026-02-06');
    expect(event?.dateReason).toContain('30 dias');
    expect(event?.dateReason).toContain('dia pago API');
  });

  it('no proyecta facturas intercompañía (RFC de empresa propia del grupo)', () => {
    const interna = makeFactura({
      cia: '00011',
      noFactura: 'F-INTER',
      noCliente: '9001',
      nombreCliente: 'TRANSPORTES TAMAULIPAS',
      rfc: 'TTA4906038F4',
      importeBrutoPesos: 5000,
      fechaFactura: '2026-01-01',
      fechaVence: '2026-01-31',
    });
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [interna],
      reconciliation: reconcileRealCollections([interna], []),
    });

    expect(calendar.events.some(e => e.noFactura === 'F-INTER')).toBe(false);
  });

  it('calendariza factura JDE pendiente sin regla en fecha de vencimiento', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-NORULE',
      noCliente: '777',
      nombreCliente: 'CLIENTE SIN CATALOGO',
      importeBrutoPesos: 1200,
      fechaVence: '2026-03-15',
    });
    const calendar = buildCollectionCalendar({
      clients: [makeClient({ id: '9001', name: 'CLIENTE ALFA' })],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation: reconcileRealCollections([factura], []),
    });

    const event = calendar.events.find(e => e.source === 'JDE_OPEN_PROJECTED');
    expect(event?.date).toBe('2026-03-15');
    expect(event?.ruleApplied).toBe('Sin regla confiable');
    expect(calendarEventMatchesSourceFilter(event!, 'unruled')).toBe(true);
  });

  it('NO genera proyección genérica de catálogo: sin ROL ni facturas no hay eventos', () => {
    // El estimado de collectionEngine (CLIENT_PROJECTED) se eliminó: un
    // cliente con monthlyBilling pero sin viaje ejecutado ni factura no
    // proyecta nada (el calendario solo proyecta sobre datos reales).
    const client = makeClient({
      creditDays: 0,
      monthlyBilling: new Array(12).fill(1000),
    });
    const calendar = buildCollectionCalendar({
      clients: [client],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [],
      reconciliation: reconcileRealCollections([], []),
    });

    expect(calendar.events).toHaveLength(0);
  });

  it('filtra eventos por fuente del calendario', () => {
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'F-JDE',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 2500,
      importePendientePesos: 0,
      fechaCobro: '2026-02-03',
    });
    const unmatchedAbono = makeAbono({
      cia: '00011',
      cuenta: '123',
      fechaOperacion: '2026-02-10',
      importe: 9999,
      concepto: 'ANTICIPO SIN FACTURA',
    });
    const reconciliation = reconcileRealCollections(
      [factura],
      [makeAccount({ cia: '00011', cuenta: '123', movimientos: [unmatchedAbono] })],
    );
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [factura],
      reconciliation,
    });
    const bank = calendar.events.find(e => e.source === 'BANK_UNMATCHED');
    const jde = calendar.events.find(e => e.source === 'JDE_PAID_UNMATCHED');

    expect(bank && calendarEventMatchesSourceFilter(bank, 'bank')).toBe(false);
    expect(bank && calendarEventMatchesSourceFilter(bank, 'bank_unmatched')).toBe(true);
    expect(bank && calendarEventMatchesSourceFilter(bank, 'jde')).toBe(false);
    expect(jde && calendarEventMatchesSourceFilter(jde, 'jde')).toBe(true);
  });

  it('emite ABONOs de cuentas Federal como BANK_FEDERAL (ingreso real del día)', () => {
    // 70138237069 = "CONCENTRADORA VENTA FEDERAL" en el catálogo de bancos
    // (unidadNegocio = FEDERAL). Venta directa a banco, sin factura JDE.
    const federalAbono = makeAbono({
      cia: '00011',
      cuenta: '70138237069',
      fechaOperacion: '2026-02-12',
      importe: 5000,
      concepto: 'VENTA TAQUILLA',
    });
    const reconciliation = reconcileRealCollections(
      [],
      [makeAccount({ cia: '00011', cuenta: '70138237069', movimientos: [federalAbono] })],
    );
    const calendar = buildCollectionCalendar({
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [],
      reconciliation,
    });

    const event = calendar.events.find(e => e.source === 'BANK_FEDERAL');
    expect(event).toBeTruthy();
    expect(event?.date).toBe('2026-02-12');
    expect(event?.amount).toBe(5000);
    expect(event?.clientName).toBe('Venta Federal');
    expect(event?.bank?.cuenta).toBe('70138237069');
    expect(calendar.summaryBySource.BANK_FEDERAL.amount).toBe(5000);
    expect(calendarEventMatchesSourceFilter(event!, 'bank')).toBe(true);
    expect(calendar.events.some(e => e.source === 'BANK_UNMATCHED')).toBe(false);
  });

  it('proyecta viajes ROL ejecutados sin facturar como ROL_PROJECTED con la regla del cliente', () => {
    const client = makeClient({
      id: '9001',
      creditDays: 30,
      paymentDay: { kind: 'ANY' },
      monthlyBilling: new Array(12).fill(0),
    });
    const rolProjection = buildRolProjectedInflows({
      rolRecords: [makeRol({ subTotal: 1000, iva: 16, viajes: 5, fechaViaje: '2026-06-01' })],
      cobranzaRecords: [],
      clients: [client],
      assumptions: ASSUMPTIONS,
      asOfDate: '2026-06-02',
    });
    const calendar = buildCollectionCalendar({
      clients: [client],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [],
      reconciliation: reconcileRealCollections([], []),
      rolProjection,
    });

    const event = calendar.events.find(e => e.source === 'ROL_PROJECTED');
    expect(event).toBeTruthy();
    // 1000 subtotal × 1.16 = 1160 bruto; viaje 1-jun + 30d crédito → julio.
    expect(event?.amount).toBeCloseTo(1160);
    expect(event?.date).toBe('2026-07-01');
    expect(event?.cia).toBe('00011');
    expect(event?.clientId).toBe('9001');
    expect(event?.dateReason).toContain('ROL CITI');
    expect(calendarEventMatchesSourceFilter(event!, 'projected')).toBe(true);
    expect(calendar.summaryBySource.ROL_PROJECTED.amount).toBeCloseTo(1160);
  });

  it('ROL es la única proyección sin factura: nada más se emite junto a él', () => {
    const client = makeClient({
      id: '9001',
      creditDays: 0,
      paymentDay: { kind: 'ANY' },
      monthlyBilling: new Array(12).fill(1000),
    });
    const rolProjection = buildRolProjectedInflows({
      rolRecords: [makeRol({ fechaViaje: '2026-06-08', subTotal: 2000 })],
      cobranzaRecords: [],
      clients: [client],
      assumptions: ASSUMPTIONS,
      asOfDate: '2026-06-02',
    });
    const calendar = buildCollectionCalendar({
      clients: [client],
      assumptions: ASSUMPTIONS,
      cobranzaRecords: [],
      reconciliation: reconcileRealCollections([], []),
      rolProjection,
    });

    expect(calendar.events.some(e => e.source === 'ROL_PROJECTED' && e.date.startsWith('2026-06'))).toBe(true);
    // Sin estimado genérico de catálogo: TODO evento del calendario es ROL.
    expect(calendar.events.every(e => e.source === 'ROL_PROJECTED')).toBe(true);
  });

  it('buildRolProjectedInflows con includePastDates conserva cobros calendarizados en el pasado', () => {
    const client = makeClient({ id: '9001', creditDays: 30, paymentDay: { kind: 'ANY' } });
    const args = {
      rolRecords: [makeRol({ fechaViaje: '2026-01-05', subTotal: 1000 })],
      cobranzaRecords: [],
      clients: [client],
      assumptions: ASSUMPTIONS,
      asOfDate: '2026-06-10',
    };

    // Default: el cobro (2026-02-04) quedó antes de asOfDate → se descarta.
    expect(buildRolProjectedInflows(args).inflows).toHaveLength(0);

    // Calendario de Cobranza: lo conserva para comparar contra el real.
    const withPast = buildRolProjectedInflows({ ...args, includePastDates: true });
    expect(withPast.inflows).toHaveLength(1);
    expect(withPast.inflows[0].date < '2026-06-10').toBe(true);
    expect(withPast.inflows[0].grossAmount).toBeCloseTo(1160);
  });
});

describe('recomputeClientCreditDaysFromCobranza · frecuencia de facturación', () => {
  it('la frecuencia del API (CC17) sobre-escribe el catálogo y prende frequencyFromApi', () => {
    const client = makeClient({ id: '9001', name: 'CLIENTE ALFA', frequency: 'Mensual' });
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'RI-1',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 1000,
      frecuenciaFacturacionClave: '1',
      frecuenciaFacturacionNombre: 'SEMANAL                       ',
    });
    const [patched] = recomputeClientCreditDaysFromCobranza([client], [factura]);
    expect(patched.frequency).toBe('Semanal');
    expect(patched.frequencyFromApi).toBe(true);
  });

  it('una frecuencia no clasificable NO pisa el catálogo (no cae a Mensual)', () => {
    const client = makeClient({ id: '9001', name: 'CLIENTE ALFA', frequency: 'Quincenal' });
    const factura = makeFactura({
      cia: '00011',
      noFactura: 'RI-2',
      noCliente: '9001',
      nombreCliente: 'CLIENTE ALFA',
      importeBrutoPesos: 1000,
      frecuenciaFacturacionNombre: 'ESPECIAL CONVENIO',
    });
    const [patched] = recomputeClientCreditDaysFromCobranza([client], [factura]);
    expect(patched.frequency).toBe('Quincenal');
    expect(patched.frequencyFromApi).not.toBe(true);
  });
});

describe('listPromesasPago', () => {
  it('dedup + orden ascendente + recorte a fecha, ignorando facturas sin promesa', () => {
    expect(
      listPromesasPago([
        { fechaPromesaPago: '2026-02-25T00:00:00' },
        { fechaPromesaPago: undefined },
        { fechaPromesaPago: '2026-02-20' },
        { fechaPromesaPago: '2026-02-25' },
      ]),
    ).toEqual(['2026-02-20', '2026-02-25']);
    expect(listPromesasPago([{ fechaPromesaPago: undefined }])).toEqual([]);
  });
});
