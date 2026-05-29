import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CXPRecord } from '../../../domain/persistence';
import type {
  BankAccountStatement,
  BankStatementLine,
  CobranzaPayment,
  CobranzaRecord,
} from '../../../services/jdeTypes';
import KpisObjectivesDashboard from './KpisObjectivesDashboard';

describe('KpisObjectivesDashboard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T18:00:00.000Z'));
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('renderiza la vista ejecutiva sin conteos legacy y con razones financieras', () => {
    render(
      <KpisObjectivesDashboard
        bankStatements={[
          statement({
            saldoInicial: 900,
            saldoFinal: 0,
            movimientos: [
              bankLine({ fechaOperacion: '2026-04-30', tipoMovimiento: 'CARGO', importe: 80 }),
              bankLine({ fechaOperacion: '2026-05-05', tipoMovimiento: 'ABONO', importe: 280 }),
              bankLine({ fechaOperacion: '2026-05-10', tipoMovimiento: 'CARGO', importe: 100 }),
            ],
          }),
        ]}
        cobranzaRecords={[cobranzaRecord({ importePendientePesos: 400 })]}
        cobranzaPayments={[
          payment({ fechaCobro: '2026-05-05', importeRecibo: 300, pendienteAplicar: 40 }),
          payment({ fechaCobro: '2026-04-05', importeRecibo: 100, pendienteAplicar: 0 }),
        ]}
        cxpRecords={[
          cxp({ fechaVence: '2026-05-01', diasVencida: 28, importePendientePesos: 250 }),
          cxp({ fechaVence: '2026-06-10', diasVencida: 0, importePendientePesos: 500 }),
        ]}
      />,
    );

    expect(screen.queryByText(/Mov\. banco/i)).toBeNull();
    expect(screen.getByText('Razones financieras')).toBeTruthy();
    expect(screen.getByText(/Días de caja 167 días/)).toBeTruthy();
  });
});

function statement(patch: Partial<BankAccountStatement>): BankAccountStatement {
  return {
    cia: '00011',
    banco: 'BANAMEX',
    cuenta: '123',
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-05-29',
    saldoInicial: 0,
    saldoFinal: 0,
    movimientos: [],
    ...patch,
  };
}

function bankLine(patch: Partial<BankStatementLine>): BankStatementLine {
  return {
    cia: '00011',
    banco: 'BANAMEX',
    cuenta: '123',
    moneda: 'MXN',
    fechaOperacion: '2026-05-01',
    referencia: 'R',
    concepto: 'Cargo',
    tipoMovimiento: 'CARGO',
    importe: 0,
    ...patch,
  };
}

function cobranzaRecord(patch: Partial<CobranzaRecord>): CobranzaRecord {
  return {
    cia: '00011',
    noCliente: 'C',
    nombreCliente: 'Cliente',
    noFactura: 'F',
    fechaFactura: '2026-05-01',
    fechaVence: '2026-05-31',
    fechaCobro: '',
    diasVencida: 0,
    importeBrutoPesos: 0,
    importePendientePesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '',
    estatus: '',
    tipoCambio: 1,
    ...patch,
  };
}

function payment(patch: Partial<CobranzaPayment>): CobranzaPayment {
  return {
    idPago: 'P',
    cia: '00011',
    fechaCobro: '2026-05-01',
    fechaContable: '2026-05-01',
    cuentaBancaria: '123',
    banco: 'BANAMEX',
    noRecibo: 'R',
    importeRecibo: 0,
    pendienteAplicar: 0,
    noCliente: 'C',
    cliente: 'Cliente',
    noBatch: 'B',
    tipoCambio: 1,
    applications: [],
    ...patch,
  };
}

function cxp(patch: Partial<CXPRecord>): CXPRecord {
  return {
    cia: '00011',
    noProveedor: 'P',
    nombre: 'Proveedor',
    noFactura: 'F',
    fechaFactura: '2026-05-01',
    fechaVence: '2026-05-30',
    fechaProgramacionPago: '2026-05-30',
    diasVencida: 0,
    importeBrutoPesos: 0,
    importePendientePesos: 0,
    importeSubtotalPesos: 0,
    importeImpuestosPesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '',
    clasifica: '',
    clasificacionProveedor: '',
    edoPago: '',
    tipoCambio: 1,
    porVencer: 0,
    v1_30: 0,
    v31_60: 0,
    v61_90: 0,
    v91_120: 0,
    v121_150: 0,
    v151_180: 0,
    mas180: 0,
    ...patch,
  };
}
