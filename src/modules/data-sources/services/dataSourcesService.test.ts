/**
 * TEMPORAL fuentes-datos (2026-07-10) — tests del service del módulo
 * "Fuentes y Datos". Borrar junto con src/modules/data-sources/.
 */
import { describe, expect, it } from 'vitest';
import type { BankAccountStatement, RolRecord } from '../../../services/jde';
import type { PayrollCostRecord } from '../../shared-finance/types';
import {
  buildBankFreshnessRows,
  buildJdeEntityRows,
  buildRolFreshnessRows,
  buildTressFreshnessRows,
  daysSince,
  freshnessTone,
  maxIsoDay,
  normalizeIsoDay,
  summarizeViajesEspeciales,
} from './dataSourcesService';

function statement(over: Partial<BankAccountStatement>): BankAccountStatement {
  return {
    cia: '00011',
    banco: 'BAJIO',
    nombreBanco: 'BanBajío',
    cuenta: '70141027881',
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-07-01',
    movimientos: [],
    ...over,
  };
}

function mov(fechaOperacion: string) {
  return {
    cia: '00011',
    banco: 'BAJIO',
    cuenta: '70141027881',
    moneda: 'MXN',
    fechaOperacion,
    referencia: '',
    concepto: 'x',
    tipoMovimiento: 'ABONO' as const,
    importe: 1,
  };
}

describe('date helpers', () => {
  it('normaliza fechas ISO y descarta basura', () => {
    expect(normalizeIsoDay('2026-07-08')).toBe('2026-07-08');
    expect(normalizeIsoDay('2026-07-08T10:00:00')).toBe('2026-07-08');
    expect(normalizeIsoDay('0000-00-00')).toBeNull();
    expect(normalizeIsoDay('')).toBeNull();
    expect(normalizeIsoDay('no-date')).toBeNull();
  });

  it('maxIsoDay toma el máximo ignorando inválidos', () => {
    expect(maxIsoDay(['2026-01-01', 'garbage', '2026-07-08', null])).toBe('2026-07-08');
    expect(maxIsoDay([])).toBeNull();
  });

  it('daysSince y freshnessTone semaforizan', () => {
    expect(daysSince('2026-07-08', '2026-07-10')).toBe(2);
    expect(daysSince('2026-07-12', '2026-07-10')).toBe(-2); // fecha futura
    expect(freshnessTone(0)).toBe('fresh');
    expect(freshnessTone(5)).toBe('stale');
    expect(freshnessTone(30)).toBe('old');
    expect(freshnessTone(null)).toBe('none');
  });
});

describe('buildBankFreshnessRows', () => {
  it('reporta la fecha del MOVIMIENTO más reciente por cuenta, ordenada desc (caso Bajío 8-jul)', () => {
    const rows = buildBankFreshnessRows([
      // Bajío: la carga manual se quedó en el 2 de julio.
      statement({ fechaEstadoCuenta: '2026-07-08', saldoFinal: 528_400, movimientos: [mov('2026-07-01'), mov('2026-07-02')] }),
      // Santander: al día.
      statement({
        banco: 'SANT', nombreBanco: 'Santander', cuenta: '999', fechaEstadoCuenta: '2026-07-08',
        saldoFinal: 100, movimientos: [mov('2026-07-08')],
      }),
    ]);
    expect(rows).toHaveLength(2);
    // Ordena de más reciente a más antigua.
    expect(rows[0].cuenta).toBe('999');
    expect(rows[0].latestMovementDate).toBe('2026-07-08');
    // La fila Bajío expone el atraso: último movimiento ≠ fecha del estado de cuenta.
    expect(rows[1].latestMovementDate).toBe('2026-07-02');
    expect(rows[1].latestStatementDate).toBe('2026-07-08');
    expect(rows[1].saldoFinal).toBe(528_400);
    expect(rows[1].movimientos).toBe(2);
  });

  it('agrega múltiples statements de la misma cuenta y conserva el saldo más reciente', () => {
    const rows = buildBankFreshnessRows([
      statement({ fechaEstadoCuenta: '2026-07-01', saldoFinal: 100, movimientos: [mov('2026-07-01')] }),
      statement({ fechaEstadoCuenta: '2026-07-05', saldoFinal: 200, movimientos: [mov('2026-07-05')] }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].latestMovementDate).toBe('2026-07-05');
    expect(rows[0].saldoFinal).toBe(200);
  });
});

describe('buildJdeEntityRows', () => {
  it('calcula la fecha más reciente por entidad desde los records reales', () => {
    const rows = buildJdeEntityRows({
      companies: [{ cia: '00011', nombre: 'Senda' }],
      cobranzaRecords: [
        { fechaFactura: '2026-07-01', fechaCobro: '2026-07-09' } as never,
        { fechaFactura: '2026-06-01', fechaCobro: '' } as never,
      ],
      cxpRecords: [{ fechaFactura: '2026-07-03' } as never],
      pagoProveedorRecords: [{ fechaPago: '2026-07-07' } as never],
      comprasRecords: [{ fechaPedido: '2026-06-20', fechaRecepcion: '2026-07-02' } as never],
      bankJdeStatements: [statement({ movimientos: [mov('2026-07-04')] })],
      auxiliarRecords: [{ fechaContable: '2026-07-06' } as never],
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.empresas.registros).toBe(1);
    expect(byId.empresas.latestDate).toBeNull();
    expect(byId.cobranza.latestDate).toBe('2026-07-09');
    expect(byId.cxp.latestDate).toBe('2026-07-03');
    expect(byId.pagos.latestDate).toBe('2026-07-07');
    expect(byId.compras.latestDate).toBe('2026-07-02');
    expect(byId.bancos.latestDate).toBe('2026-07-04');
    expect(byId.auxiliar.latestDate).toBe('2026-07-06');
  });
});

describe('buildTressFreshnessRows', () => {
  it('agrupa por empresa de nómina con el último pago y periodo', () => {
    const rec = (over: Partial<PayrollCostRecord>): PayrollCostRecord => ({
      cia: '00011', empresaNomina: 'SENDA NL', year: 2026, month: 6, paymentDate: '2026-06-27',
      payrollPeriod: 26, payrollType: 'SEMANAL', conceptId: 1, conceptName: 'Sueldo',
      conceptType: 'PERCEPCION', cashTreatment: 'CASH' as never, amount: 100,
      ...over,
    });
    const rows = buildTressFreshnessRows([
      rec({}),
      rec({ paymentDate: '2026-07-04', month: 7 }),
      rec({ empresaNomina: 'SENDA COAH', paymentDate: '2026-06-20' }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].empresaNomina).toBe('SENDA NL');
    expect(rows[0].latestPaymentDate).toBe('2026-07-04');
    expect(rows[0].latestPeriod).toBe('2026-07');
    expect(rows[0].registros).toBe(2);
    expect(rows[1].latestPaymentDate).toBe('2026-06-20');
  });
});

describe('ROL / viajes especiales', () => {
  it('agrupa viajes por empresa con la fecha de viaje más reciente', () => {
    const rol = (over: Partial<RolRecord>): RolRecord => ({
      cia: '00011', empresa: 'SENDA', kCliente: 1, cCliente: 'C1', dCliente: 'Cliente',
      rfc: '', claveJDE: '', facturacionTipo: '', iva: 0, tipoViaje: '', ruta: '',
      costoRuta: 0, viajes: 1, subTotal: 100, despachado: true, efectuado: true,
      anio: 2026, semana: 27, fechaViaje: '2026-07-05',
      ...over,
    });
    const rows = buildRolFreshnessRows([
      rol({}),
      rol({ fechaViaje: '2026-07-08' }),
      rol({ empresa: 'MULTI', fechaViaje: '2026-07-01' }),
    ]);
    expect(rows[0].empresa).toBe('SENDA');
    expect(rows[0].latestFechaViaje).toBe('2026-07-08');
    expect(rows[0].registros).toBe(2);
    expect(rows[1].empresa).toBe('MULTI');
  });

  it('resume viajes especiales con fallback de fechas', () => {
    const out = summarizeViajesEspeciales([
      { fRegresoUltima: '2026-07-03', fSalidaPrimera: '2026-07-01' } as never,
      { fechaFactura: '2026-07-06' } as never,
    ]);
    expect(out.registros).toBe(2);
    expect(out.latestDate).toBe('2026-07-06');
  });
});
