import { describe, it, expect } from 'vitest';
import { forecastCashFlow } from './forecastEngine';
import type { BankAccountStatement, AgedBalanceRecord } from '../services/jde';
import type { Client, CashFlowAssumptions } from './types';

function bankMonth(ym: string, income: number, expense: number, cuenta = '01900010A1'): BankAccountStatement {
  const [y, m] = ym.split('-').map(Number);
  const day = (d: number) => `${ym}-${String(d).padStart(2, '0')}`;
  return {
    cia: '00011', banco: 'BANAMEX', cuenta, moneda: 'MXN',
    fechaEstadoCuenta: day(28),
    saldoInicial: 0, saldoFinal: 0,
    movimientos: [
      ...(income > 0 ? [{
        cia: '00011', banco: 'BANAMEX', cuenta, moneda: 'MXN',
        fechaOperacion: day(10), referencia: `IN-${ym}`, concepto: 'COBRANZA CLIENTE',
        tipoMovimiento: 'ABONO' as const, importe: income,
      }] : []),
      ...(expense > 0 ? [{
        cia: '00011', banco: 'BANAMEX', cuenta, moneda: 'MXN',
        fechaOperacion: day(20), referencia: `OUT-${ym}`, concepto: 'PAGO PROVEEDOR',
        tipoMovimiento: 'CARGO' as const, importe: expense,
      }] : []),
    ],
  };
}

function clientMonthly(id: string, name: string, amount: number): Client {
  return {
    id, name,
    paymentDay: { kind: 'DOM' },
    frequency: 'Mensual',
    creditDays: 0,
    monthlyBilling: new Array(12).fill(amount),
    complianceRate: 1,
  };
}

const baseAssumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

describe('forecastCashFlow', () => {
  it('uses moving-average fallback when no clients catalog', () => {
    const today = '2026-05-15';
    const history = [
      bankMonth('2026-01', 100_000, 80_000),
      bankMonth('2026-02', 100_000, 80_000),
      bankMonth('2026-03', 100_000, 80_000),
    ];
    const result = forecastCashFlow({
      today, horizonMonths: 6,
      bankStatements: history, agedBalances: [], clients: [],
      assumptions: baseAssumptions, overrides: {}, companyCode: '00011',
    });
    expect(result.hasClientsCatalog).toBe(false);
    const future = result.months.filter((m) => !m.isHistorical);
    expect(future.length).toBeGreaterThan(0);
    for (const m of future) {
      expect(m.incomeSource).toBe('baseline');
      expect(m.income).toBeCloseTo(100_000, -2);
    }
  });

  it('proyecta con clientes cuando el catálogo existe', () => {
    const today = '2026-05-15';
    const history = [
      bankMonth('2026-01', 100_000, 80_000),
      bankMonth('2026-02', 100_000, 80_000),
      bankMonth('2026-03', 100_000, 80_000),
      bankMonth('2026-04', 100_000, 80_000),
    ];
    // Cliente factura 100K mensual → proyección = 100K por mes.
    const clients = [clientMonthly('c1', 'Cliente A', 100_000)];
    const result = forecastCashFlow({
      today, horizonMonths: 6,
      bankStatements: history, agedBalances: [], clients,
      assumptions: baseAssumptions, overrides: {}, companyCode: '00011',
    });
    expect(result.hasClientsCatalog).toBe(true);
    const junio = result.months.find((m) => m.yearMonth === '2026-06');
    expect(junio).toBeDefined();
    expect(junio!.incomeSource).toBe('clients');
    expect(junio!.incomeFromClientsRaw).toBeCloseTo(100_000, -2);
  });

  it('escala la proyección cuando el catálogo captura solo parte del real', () => {
    const today = '2026-05-15';
    const history = [
      bankMonth('2026-01', 200_000, 80_000),
      bankMonth('2026-02', 200_000, 80_000),
      bankMonth('2026-03', 200_000, 80_000),
      bankMonth('2026-04', 200_000, 80_000),
    ];
    // Catálogo captura la mitad de los ingresos reales (100K vs 200K).
    // El factor debe salir ≈ 2 y la proyección calibrada ≈ 200K.
    const clients = [clientMonthly('c1', 'Cliente A', 100_000)];
    const result = forecastCashFlow({
      today, horizonMonths: 6,
      bankStatements: history, agedBalances: [], clients,
      assumptions: baseAssumptions, overrides: {}, companyCode: '00011',
    });
    expect(result.incomeCalibrationFactor).toBeCloseTo(2, 1);
    const junio = result.months.find((m) => m.yearMonth === '2026-06');
    expect(junio!.income).toBeCloseTo(200_000, -3);
  });

  it('egresos futuros con AntiguedadSaldos toman el programado si supera al baseline', () => {
    const today = '2026-05-15';
    const history = [
      bankMonth('2026-01', 100_000, 50_000),
      bankMonth('2026-02', 100_000, 50_000),
      bankMonth('2026-03', 100_000, 50_000),
    ];
    const aged: AgedBalanceRecord[] = [{
      cia: '00011', noProveedor: 'P1', nombre: 'Prov', noFactura: 'F1',
      fechaFactura: '2026-04-01', fechaVence: '2026-06-15',
      fechaProgramacionPago: '2026-07-15',
      diasVencida: 0, importeBrutoPesos: 300_000, importePendientePesos: 300_000,
      importeSubtotalPesos: 240_000, importeImpuestosPesos: 60_000,
      importeBrutoDolares: 0, importePendienteDolares: 0,
      moneda: 'MXN', condPago: '', clasifica: '', clasificacionProveedor: '',
      edoPago: '', tipoCambio: 20, porVencer: 300_000,
      v1_30: 0, v31_60: 0, v61_90: 0, v91_120: 0, v121_150: 0, v151_180: 0, mas180: 0,
    }];
    const result = forecastCashFlow({
      today, horizonMonths: 6,
      bankStatements: history, agedBalances: aged, clients: [],
      assumptions: baseAssumptions, overrides: {}, companyCode: '00011',
    });
    const julio = result.months.find((m) => m.yearMonth === '2026-07');
    expect(julio).toBeDefined();
    expect(julio!.expenseSource).toBe('committed');
    expect(julio!.expense).toBeGreaterThanOrEqual(300_000);
  });

  it('el override manual gana sobre el motor', () => {
    const today = '2026-05-15';
    const history = [
      bankMonth('2026-01', 100_000, 80_000),
      bankMonth('2026-02', 100_000, 80_000),
      bankMonth('2026-03', 100_000, 80_000),
    ];
    const overrides = { '2026-07': { income: 500_000, expense: 400_000 } };
    const result = forecastCashFlow({
      today, horizonMonths: 6,
      bankStatements: history, agedBalances: [], clients: [],
      assumptions: baseAssumptions, overrides, companyCode: '00011',
    });
    const julio = result.months.find((m) => m.yearMonth === '2026-07');
    expect(julio!.incomeSource).toBe('override');
    expect(julio!.expenseSource).toBe('override');
    expect(julio!.income).toBe(500_000);
    expect(julio!.expense).toBe(400_000);
  });

  it('caja final se encadena entre meses futuros', () => {
    const today = '2026-05-15';
    const history = [
      bankMonth('2026-04', 100_000, 80_000),
    ];
    // Manipular saldo inicial para arrancar de un valor conocido.
    history[0].saldoInicial = 1_000_000;
    const result = forecastCashFlow({
      today, horizonMonths: 3,
      bankStatements: history, agedBalances: [], clients: [],
      assumptions: baseAssumptions, overrides: {}, companyCode: '00011',
    });
    const future = result.months.filter((m) => !m.isHistorical);
    for (let i = 1; i < future.length; i++) {
      const prev = future[i - 1];
      const cur = future[i];
      expect(cur.closingCash).toBeCloseTo(prev.closingCash + cur.income - cur.expense, 0);
    }
  });
});
