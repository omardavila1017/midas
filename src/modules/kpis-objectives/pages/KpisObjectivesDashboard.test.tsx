import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CXPRecord } from '../../../domain/persistence';
import type {
  BankAccountStatement,
  BankStatementLine,
  CobranzaPayment,
  CobranzaRecord,
} from '../../../services/jdeTypes';
import type { FinancialProjectionSourceInput } from '../../financial-projection/services/financialProjectionService';
import KpisObjectivesDashboard from './KpisObjectivesDashboard';

// Espía sobre la fuente de proyección: este tablero es el ÚNICO que la
// construye por su cuenta (síncrono, `enablePredictive:false`), así que un
// input de dinero que Proyección/Planeación sí mandan puede faltar aquí sin
// que ninguna otra suite lo note.
const captured = vi.hoisted(() => ({ inputs: [] as FinancialProjectionSourceInput[] }));

vi.mock('../../financial-projection/services/financialProjectionService', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../financial-projection/services/financialProjectionService')
  >();
  return {
    ...actual,
    buildFinancialProjectionSourceData: (input: FinancialProjectionSourceInput) => {
      captured.inputs.push(input);
      return actual.buildFinancialProjectionSourceData(input);
    },
  };
});

describe('KpisObjectivesDashboard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-29T18:00:00.000Z'));
    localStorage.clear();
    captured.inputs.length = 0;
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

  // El overlay de recibos (`/cobranza` reporta `Importe_Pendiente` inflado
  // porque `jde.Cobranza_Citi` no aplica los cobros) sólo descuenta si los
  // recibos LLEGAN al motor. Este tablero arma su propia fuente, así que sin
  // pasarlos seguía proyectando como entrada FUTURA dinero ya cobrado — el
  // mismo doble conteo que MOTOR 2 cerró para Proyección y Planeación.
  it('pasa los recibos de cobranza a la fuente de proyección', () => {
    render(
      <KpisObjectivesDashboard
        bankStatements={[statement({ saldoInicial: 900, saldoFinal: 900 })]}
        cobranzaRecords={[cobranzaRecord({ importePendientePesos: 400 })]}
        cobranzaPayments={[
          payment({
            idPago: 'P-1',
            importeRecibo: 400,
            applications: [{
              idPago: 'P-1',
              cia: '00011',
              fechaAplicacion: '2026-05-05',
              noCliente: 'C',
              cliente: 'Cliente',
              tipoDocto: 'RI',
              noFactura: 'F',
              noFacturaNormalizada: 'F',
              fechaFactura: '2026-05-01',
              fechaVencimiento: '2026-05-31',
              diasAntiguedadFafv: 0,
              importeCobrado: 400,
              importeOriginalFactura: 400,
              tasaIva: '16',
              importeIvaFacturaOriginal: 0,
            }],
          }),
        ]}
        cxpRecords={[]}
        assumptions={{ year: 2026, globalCompliance: 1, factorajeDays: 30 }}
      />,
    );

    expect(captured.inputs.length).toBeGreaterThan(0);
    const last = captured.inputs[captured.inputs.length - 1];
    const applied = (last.cobranzaPayments ?? [])
      .flatMap((p) => p.applications ?? [])
      .reduce((sum, app) => sum + app.importeCobrado, 0);
    expect(applied).toBe(400);
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
