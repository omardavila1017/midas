import { describe, expect, it } from 'vitest';
import type { CXPRecord } from '../../../domain/persistence';
import type {
  BankAccountStatement,
  BankStatementLine,
  CobranzaPayment,
  CobranzaRecord,
} from '../../../services/jdeTypes';
import type { FinancialMovement, ForecastRun } from '../../shared-finance/types';
import { buildKpiRows } from './kpiCatalog';

describe('buildKpiRows', () => {
  it('deriva KPIs ejecutivos de caja, CXP, cobranza y bancos', () => {
    const rows = buildKpiRows(
      {
        today: '2026-05-29',
        bankStatements: [
          statement({
            saldoInicial: 900,
            saldoFinal: 0,
            movimientos: [
              bankLine({ fechaOperacion: '2026-04-30', tipoMovimiento: 'CARGO', importe: 80 }),
              bankLine({ fechaOperacion: '2026-05-05', tipoMovimiento: 'ABONO', importe: 280 }),
              bankLine({ fechaOperacion: '2026-05-10', tipoMovimiento: 'CARGO', importe: 100 }),
            ],
          }),
        ],
        cobranzaRecords: [
          cobranzaRecord({ importePendientePesos: 400 }),
        ],
        cobranzaPayments: [
          payment({ fechaCobro: '2026-05-05', importeRecibo: 300, pendienteAplicar: 40 }),
          payment({ fechaCobro: '2026-04-05', importeRecibo: 100, pendienteAplicar: 0 }),
        ],
        cxpRecords: [
          cxp({ fechaVence: '2026-05-01', diasVencida: 28, importePendientePesos: 250 }),
          cxp({ fechaVence: '2026-06-10', diasVencida: 0, importePendientePesos: 500 }),
        ],
      },
      [],
    );

    const value = (key: string) => rows.find((row) => row.key === key)?.value;
    const delta = (key: string) => rows.find((row) => row.key === key)?.deltaPrev;

    expect(value('system:caja_actual')).toBe(1_000);
    expect(value('system:flujo_neto_mes')).toBe(200);
    expect(delta('system:flujo_neto_mes')).toBe(180);
    expect(value('system:cobertura_cxp_caja')).toBeCloseTo(1_000 / 750);
    expect(value('system:liquidez_inmediata')).toBeCloseTo(1_000 / 250);
    expect(value('system:cobertura_caja_cxc')).toBeCloseTo(1_400 / 750);
    expect(value('system:capital_trabajo_operativo')).toBe(650);
    expect(value('system:cobertura_flujo_30d')).toBeCloseTo(300 / 180);
    expect(value('system:dso_cobranza')).toBeCloseTo(400 / (400 / 90));
    expect(value('system:dpo_cxp')).toBeCloseTo(750 / (180 / 90));
    expect(value('system:cxp_vencida')).toBe(250);
    expect(value('system:pct_cxp_vencida')).toBeCloseTo(250 / 750);
    expect(value('system:cxp_por_vencer_30d')).toBe(500);
    expect(value('system:runway_caja_dias')).toBeCloseTo(1000 / (180 / 30));
    expect(value('system:ticket_promedio_cobranza_mes')).toBe(300);
    expect(value('system:cobranza_pendiente_aplicar')).toBe(40);
    expect(value('system:cuentas_bancarias_activas')).toBe(1);
  });

  it('marca KPIs no calculables con emptyReason en vez de ceros engañosos', () => {
    const rows = buildKpiRows(
      {
        today: '2026-05-29',
        bankStatements: [],
        cobranzaRecords: [],
        cobranzaPayments: [],
        cxpRecords: [],
      },
      [],
    );

    const row = (key: string) => rows.find((item) => item.key === key);

    expect(row('system:caja_actual')?.value).toBeNull();
    expect(row('system:caja_actual')?.emptyReason).toBe('Sin saldo bancario');
    expect(row('system:runway_caja_dias')?.value).toBeNull();
    expect(row('system:runway_caja_dias')?.emptyReason).toBe('Sin saldo bancario');
    expect(row('system:liquidez_inmediata')?.value).toBeNull();
    expect(row('system:liquidez_inmediata')?.emptyReason).toBe('Sin saldo bancario');
  });

  it('prefiere la base de Planeación para ingresos, egresos y caja proyectada', () => {
    const rows = buildKpiRows(
      {
        today: '2026-05-29',
        companyCode: '00011',
        bankStatements: [
          statement({
            movimientos: [
              bankLine({ fechaOperacion: '2026-05-10', tipoMovimiento: 'CARGO', importe: 999 }),
            ],
          }),
        ],
        cobranzaRecords: [cobranzaRecord({ importePendientePesos: 400 })],
        cobranzaPayments: [
          payment({ fechaCobro: '2026-05-05', importeRecibo: 333, pendienteAplicar: 0 }),
        ],
        cxpRecords: [cxp({ importePendientePesos: 200 })],
        planning: {
          currentCash: 5_000,
          run: forecastRun([
            movement('INFLOW', 'AR_COLLECTION', 1_000, '2026-05-06'),
            movement('OUTFLOW', 'AP_PAYMENT', 250, '2026-05-12'),
            movement('INFLOW', 'AR_COLLECTION', 500, '2026-04-10'),
            movement('OUTFLOW', 'OPEX', 100, '2026-04-20'),
          ]),
        },
      },
      [],
    );

    const value = (key: string) => rows.find((row) => row.key === key)?.value;

    expect(value('system:caja_actual')).toBe(5_000);
    expect(value('system:cobranza_mes')).toBe(1_000);
    expect(value('system:gasto_mes')).toBe(250);
    expect(value('system:flujo_neto_mes')).toBe(750);
    expect(value('system:caja_final_planeacion')).toBe(9_000);
    expect(value('system:deficit_dias_planeacion')).toBe(2);
  });
  // `/cobranza` reporta `Importe_Pendiente` inflado porque `jde.Cobranza_Citi`
  // no aplica los cobros que `/cobranzaindicadores` sí registra (medido
  // 2026-09-07: 1,694 facturas por $345.3M). El KPI mide "cuánto falta cobrar",
  // así que descuenta lo ya cobrado — misma regla que MOTOR 2 y el calendario,
  // y sólo a la baja.
  it('descuenta del CXC pendiente lo que los recibos ya reportan cobrado', () => {
    const run = (applications: CobranzaPayment['applications']) => buildKpiRows(
      {
        today: '2026-05-29',
        bankStatements: [statement({ saldoInicial: 1_000, saldoFinal: 1_000 })],
        cobranzaRecords: [
          cobranzaRecord({ noFactura: 'RI-500', importeBrutoPesos: 400, importePendientePesos: 400 }),
        ],
        cobranzaPayments: [payment({ importeRecibo: 400, applications })],
        cxpRecords: [cxp({ importePendientePesos: 750 })],
      },
      [],
    ).find((row) => row.key === 'system:cobertura_caja_cxc')?.value;

    // Sin aplicaciones: degrada solo — el pendiente reportado entra completo.
    expect(run([])).toBeCloseTo((1_000 + 400) / 750);
    // Recibo del folio completo (formato con espacios de Indicadores): el
    // pendiente se va a 0 y el KPI deja de contar dinero ya cobrado.
    expect(run([application({ noFactura: 'RI - 500', importeCobrado: 400 })]))
      .toBeCloseTo(1_000 / 750);
    // Cobro parcial: sólo el residuo.
    expect(run([application({ noFactura: 'RI-500', importeCobrado: 300 })]))
      .toBeCloseTo((1_000 + 100) / 750);
  });
});

function application(
  patch: Partial<CobranzaPayment['applications'][number]>,
): CobranzaPayment['applications'][number] {
  return {
    idPago: 'P',
    cia: '00011',
    fechaAplicacion: '2026-05-05',
    noCliente: 'C',
    cliente: 'Cliente',
    tipoDocto: 'RI',
    noFactura: 'RI-500',
    noFacturaNormalizada: 'RI-500',
    fechaFactura: '2026-05-01',
    fechaVencimiento: '2026-05-31',
    diasAntiguedadFafv: 0,
    importeCobrado: 0,
    importeOriginalFactura: 400,
    tasaIva: '16',
    importeIvaFacturaOriginal: 0,
    ...patch,
  };
}

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

function forecastRun(movements: FinancialMovement[]): ForecastRun {
  return {
    id: 'forecast-approved-monthly-2026',
    name: 'Aprobado',
    scenarioId: 'approved',
    status: 'SIMULATED',
    granularity: 'monthly',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    generatedAt: '2026-05-29T00:00:00.000Z',
    movements,
    buckets: [],
    summary: {
      currentCash: 5_000,
      projectedCash7: 6_000,
      projectedCash30: 7_000,
      projectedCash90: 8_000,
      minimumCashRequired: 20_000_000,
      deficitDays: 2,
      averageConfidence: 100,
      totalInflows: 1_500,
      totalOutflows: 350,
      finalCash: 9_000,
      minCash: 5_000,
      creditRequired: 0,
    },
    alerts: [],
  };
}

function movement(
  type: FinancialMovement['type'],
  category: FinancialMovement['category'],
  amount: number,
  date: string,
): FinancialMovement {
  return {
    id: `${type}:${category}:${amount}:${date}`,
    sourceSystem: type === 'INFLOW' ? 'JDE' : 'BANK',
    type,
    category,
    concept: category,
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    actualDate: date,
    projectedDate: date,
    confidenceScore: 100,
    confidenceBand: 'CONFIRMED',
    forecastMethod: 'RULE',
    status: 'REAL',
    lockState: 'LOCKED',
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`,
  };
}
