import { describe, expect, it } from 'vitest';
import type { CashFlowAssumptions, Client } from './types';
import type { CobranzaRecord, RolRecord } from '../services/jdeTypes';
import { buildRolProjectedInflows } from './rolProjectionEngine';

/**
 * Pin de regresión del criterio ROL → ingreso proyectado (D.2, reproceso
 * backend 2026-07). Fija el contrato del frontend: efectuado-only, cruce
 * predicted-only (sin doble conteo con cxc:), fechado por la regla del
 * catálogo del cliente, futuro-only por default e IVA por viaje (default 16%).
 * Si el criterio del API cambia y esto truena, el fechado/cruce del lado
 * Midas debe revisarse a propósito — no ajustar el test a ciegas.
 */

const ASSUMPTIONS: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

function makeClient(overrides: Partial<Client> = {}): Client {
  return {
    id: overrides.id ?? '9001',
    name: overrides.name ?? 'CLIENTE ALFA',
    paymentDay: overrides.paymentDay ?? { kind: 'DOW', days: [5] },
    paymentDayRaw: overrides.paymentDayRaw ?? 'Viernes',
    frequency: overrides.frequency ?? 'Mensual',
    creditDays: overrides.creditDays ?? 30,
    monthlyBilling: overrides.monthlyBilling ?? new Array(12).fill(1000),
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
    viajes: 1,
    subTotal: 1000,
    despachado: true,
    efectuado: true,
    anio: 2026,
    semana: 1,
    fechaViaje: '2026-01-01',
    ...overrides,
  };
}

function makeCobranza(
  overrides: Partial<CobranzaRecord> & Pick<CobranzaRecord, 'noFactura'>,
): CobranzaRecord {
  return {
    cia: '00011',
    noCliente: '9001',
    nombreCliente: 'CLIENTE ALFA',
    fechaFactura: '2026-01-05',
    fechaVence: '2026-02-04',
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
    ...overrides,
  };
}

describe('buildRolProjectedInflows', () => {
  it('fecha el cobro por la regla del catálogo (crédito + día de pago) y agrega por cia::cliente::fecha', () => {
    const result = buildRolProjectedInflows({
      rolRecords: [makeRol(), makeRol({ ruta: 'RUTA 2', viajes: 2, subTotal: 500 })],
      cobranzaRecords: [],
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      asOfDate: '2026-01-02',
    });

    // 2026-01-01 + 30d crédito = 2026-01-31 (sábado) → siguiente viernes.
    expect(result.inflows).toHaveLength(1);
    const inflow = result.inflows[0];
    expect(inflow.date).toBe('2026-02-06');
    expect(inflow.ruleReason).toContain('30 dias credito');
    expect(inflow.subTotal).toBe(1500);
    expect(inflow.tripCount).toBe(3);
    // IVA por viaje (16%): bruto = subTotal × 1.16.
    expect(inflow.grossAmount).toBeCloseTo(1500 * 1.16, 6);
    expect(result.coverageByClientMonth.get('9001')?.has('2026-02')).toBe(true);
  });

  it('sólo proyecta viajes EFECTUADOS (despachado-no-efectuado queda fuera)', () => {
    const result = buildRolProjectedInflows({
      rolRecords: [makeRol({ efectuado: false })],
      cobranzaRecords: [],
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      asOfDate: '2026-01-02',
    });
    expect(result.inflows).toHaveLength(0);
  });

  it('excluye viajes ya facturados en cobranza (predicted-only, sin doble conteo con cxc:)', () => {
    const result = buildRolProjectedInflows({
      rolRecords: [makeRol({ factura: 'RI-100' })],
      cobranzaRecords: [makeCobranza({ noFactura: 'RI-100' })],
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      asOfDate: '2026-01-02',
    });
    expect(result.inflows).toHaveLength(0);
  });

  it('futuro-only por default; includePastDates conserva cobros calendarizados en el pasado', () => {
    const args = {
      rolRecords: [makeRol()],
      cobranzaRecords: [],
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      asOfDate: '2026-03-01', // el cobro calculado (2026-02-06) ya pasó
    };
    expect(buildRolProjectedInflows(args).inflows).toHaveLength(0);
    expect(buildRolProjectedInflows({ ...args, includePastDates: true }).inflows).toHaveLength(1);
  });

  it('sin cliente en catálogo no proyecta (conservador) y lo reporta como unmatched', () => {
    const result = buildRolProjectedInflows({
      rolRecords: [makeRol({ claveJDE: '77777', dCliente: 'DESCONOCIDO XYZ', cCliente: 'XYZ' })],
      cobranzaRecords: [],
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      asOfDate: '2026-01-02',
    });
    expect(result.inflows).toHaveLength(0);
    expect(result.unmatchedTrips).toBe(1);
    expect(result.unmatchedAmount).toBe(1000);
  });

  it('aplica el IVA del viaje cuando viene poblado y cae a 16% cuando falta', () => {
    const result = buildRolProjectedInflows({
      rolRecords: [makeRol({ iva: 8 }), makeRol({ iva: 0, ruta: 'R2' })],
      cobranzaRecords: [],
      clients: [makeClient()],
      assumptions: ASSUMPTIONS,
      asOfDate: '2026-01-02',
    });
    // Misma fecha/cliente → una línea agregada: 1000×1.08 + 1000×1.16.
    expect(result.inflows).toHaveLength(1);
    expect(result.inflows[0].grossAmount).toBeCloseTo(1000 * 1.08 + 1000 * 1.16, 6);
  });
});
