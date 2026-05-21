import { describe, it, expect } from 'vitest';
import {
  buildProviderIndex,
  matchConceptToProvider,
  buildProviderBankPatterns,
  isNoisyBankExpenseConcept,
  projectExpenseByProvider,
  paymentPeriodDays,
} from './expensePerProvider';
import type { Provider } from './types';
import type { AgedBalanceRecord, BankAccountStatement } from '../services/jdeTypes';

function provider(name: string, overrides: Partial<Provider> = {}): Provider {
  return {
    id: `p-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    type: 'Otro',
    risk: 'Medio',
    paymentPeriod: '30 días',
    flexibility: 'flexible',
    ...overrides,
  };
}

describe('paymentPeriodDays', () => {
  it('maps canonical strings', () => {
    expect(paymentPeriodDays('Contado')).toBe(0);
    expect(paymentPeriodDays('15 días')).toBe(15);
    expect(paymentPeriodDays('30 días')).toBe(30);
    expect(paymentPeriodDays('60 días')).toBe(60);
    expect(paymentPeriodDays('90 días')).toBe(90);
  });
});

describe('buildProviderIndex + matchConceptToProvider', () => {
  it('matches concept by substring, longest wins', () => {
    const providers = [
      provider('FEMSA'),
      provider('FEMSA LOGISTICA'),
      provider('SORIANA'),
    ];
    const index = buildProviderIndex(providers);
    expect(matchConceptToProvider('PAGO FEMSA LOGISTICA MTY', index)?.name).toBe('FEMSA LOGISTICA');
    expect(matchConceptToProvider('PAGO FEMSA DIRECTO', index)?.name).toBe('FEMSA');
    expect(matchConceptToProvider('deposito soriana', index)?.name).toBe('SORIANA');
  });

  it('returns null when no match', () => {
    const index = buildProviderIndex([provider('EXXON')]);
    expect(matchConceptToProvider('PAGO DESCONOCIDO', index)).toBeNull();
    expect(matchConceptToProvider('', index)).toBeNull();
  });

  it('ignores short noise matches (< 4 chars)', () => {
    const index = buildProviderIndex([provider('SA')]);
    expect(matchConceptToProvider('PAGO XYZ SA', index)).toBeNull();
  });
});

describe('buildProviderBankPatterns', () => {
  it('flags provider as recurring when paid in >= 50% of recent months', () => {
    const providers = [provider('NOMINA MX')];
    const bank: BankAccountStatement[] = [{
      cia: '00001', banco: 'BBVA', cuenta: '1', moneda: 'MXN', fechaEstadoCuenta: '2026-04-22',
      saldoInicial: 0, saldoFinal: 0,
      movimientos: [
        mov('2025-11-05', 50_000, 'PAGO NOMINA MX QUINCENAL'),
        mov('2025-12-05', 50_000, 'PAGO NOMINA MX QUINCENAL'),
        mov('2026-01-05', 50_000, 'PAGO NOMINA MX QUINCENAL'),
        mov('2026-02-05', 50_000, 'PAGO NOMINA MX QUINCENAL'),
      ],
    }];
    const patterns = buildProviderBankPatterns(providers, bank, '2026-04-22', 6);
    const pat = patterns.get(providers[0].id);
    expect(pat).toBeDefined();
    expect(pat!.isRecurring).toBe(true);
    expect(pat!.monthlyAvg).toBe(50_000);
    expect(pat!.typicalPayDay).toBe(5);
  });

  it('does not flag sporadic provider as recurring', () => {
    const providers = [provider('ESPORADICO')];
    const bank: BankAccountStatement[] = [{
      cia: '00001', banco: 'BBVA', cuenta: '1', moneda: 'MXN', fechaEstadoCuenta: '2026-04-22',
      saldoInicial: 0, saldoFinal: 0,
      movimientos: [
        // We need >= 6 months spread across the data to enable the >= 50% test.
        mov('2025-10-05', 10_000, 'pago esporadico uno'),
        mov('2025-11-05', 10_000, 'otra linea'),
        mov('2025-12-05', 10_000, 'otra linea'),
        mov('2026-01-05', 10_000, 'otra linea'),
        mov('2026-02-05', 10_000, 'otra linea'),
        mov('2026-03-05', 10_000, 'otra linea'),
      ],
    }];
    const patterns = buildProviderBankPatterns(providers, bank, '2026-04-22', 6);
    // ESPORADICO only paid 1 of 6 months → not recurring
    const pat = patterns.get(providers[0].id);
    expect(pat?.isRecurring).toBe(false);
  });

  it('filters card and own-account style concepts before recurrent matching', () => {
    expect(isNoisyBankExpenseConcept('TARJ.NO.5579 6211 F.TRANS.2')).toBe(true);
    expect(isNoisyBankExpenseConcept('TRANSF. A LA CUENTA NO. 021')).toBe(true);
    expect(isNoisyBankExpenseConcept('PAGO PROVEEDOR DIESEL')).toBe(false);
  });
});

describe('projectExpenseByProvider', () => {
  it('prefers CXP (aged) when available, falls back to recurring for gaps', () => {
    const providers = [
      provider('NOMINA MX', { flexibility: 'inamovible' }),
      provider('PROVEEDOR FLEX', { flexibility: 'flexible' }),
    ];
    const aged: AgedBalanceRecord[] = [
      // NOMINA MX programado explícito para mayo
      aged_({ nombre: 'NOMINA MX', fechaProgramacionPago: '2026-05-15', importePendientePesos: 55_000 }),
      // PROVEEDOR FLEX programado explícito para junio
      aged_({ nombre: 'PROVEEDOR FLEX', fechaProgramacionPago: '2026-06-10', importePendientePesos: 30_000 }),
    ];
    const bank: BankAccountStatement[] = [{
      cia: '00001', banco: 'BBVA', cuenta: '1', moneda: 'MXN', fechaEstadoCuenta: '2026-04-22',
      saldoInicial: 0, saldoFinal: 0,
      movimientos: [
        mov('2025-11-05', 50_000, 'PAGO NOMINA MX'),
        mov('2025-12-05', 50_000, 'PAGO NOMINA MX'),
        mov('2026-01-05', 50_000, 'PAGO NOMINA MX'),
        mov('2026-02-05', 50_000, 'PAGO NOMINA MX'),
        mov('2026-03-05', 50_000, 'PAGO NOMINA MX'),
      ],
    }];
    const months = projectExpenseByProvider({
      providers, aged, bankStatements: bank, today: '2026-04-22',
      fromYm: '2026-05', toYm: '2026-07',
    });
    expect(months).toHaveLength(3);

    // Mayo: NOMINA MX tiene CXP de 55k, el avg mensual es 50k → usamos los 55k
    const may = months.find((m) => m.yearMonth === '2026-05')!;
    const nominaMay = may.lines.find((l) => l.providerName === 'NOMINA MX')!;
    expect(nominaMay.amount).toBe(55_000);
    expect(nominaMay.source).toBe('scheduled');
    expect(nominaMay.flexibility).toBe('inamovible');

    // Junio: NOMINA MX no tiene CXP → recurring
    const jun = months.find((m) => m.yearMonth === '2026-06')!;
    const nominaJun = jun.lines.find((l) => l.providerName === 'NOMINA MX')!;
    expect(nominaJun.source).toBe('recurring');
    expect(nominaJun.amount).toBe(50_000);

    // Junio: PROVEEDOR FLEX tiene CXP de 30k, no tiene historial → scheduled
    const flexJun = jun.lines.find((l) => l.providerName === 'PROVEEDOR FLEX')!;
    expect(flexJun.amount).toBe(30_000);
    expect(flexJun.flexibility).toBe('flexible');
    expect(flexJun.source).toBe('scheduled');

    // Julio: ni CXP ni aged para PROVEEDOR FLEX → no aparece
    const jul = months.find((m) => m.yearMonth === '2026-07')!;
    expect(jul.lines.some((l) => l.providerName === 'PROVEEDOR FLEX')).toBe(false);
  });

  it('handles recurring + CXP mixed: bumps scheduled up to monthly avg', () => {
    const providers = [provider('RENTA MENSUAL', { flexibility: 'inamovible' })];
    const aged: AgedBalanceRecord[] = [
      aged_({ nombre: 'RENTA MENSUAL', fechaProgramacionPago: '2026-05-01', importePendientePesos: 10_000 }),
    ];
    const bank: BankAccountStatement[] = [{
      cia: '00001', banco: 'BBVA', cuenta: '1', moneda: 'MXN', fechaEstadoCuenta: '2026-04-22',
      saldoInicial: 0, saldoFinal: 0,
      movimientos: Array.from({ length: 6 }, (_, i) => {
        const m = 11 + i; // Nov → Apr
        const date = m <= 12 ? `2025-${String(m).padStart(2, '0')}-01` : `2026-${String(m - 12).padStart(2, '0')}-01`;
        return mov(date, 25_000, 'PAGO RENTA MENSUAL');
      }).slice(0, 5), // use 5 of 6 months to ensure recurring
    }];
    const months = projectExpenseByProvider({
      providers, aged, bankStatements: bank, today: '2026-04-22',
      fromYm: '2026-05', toYm: '2026-05',
    });
    const rentLine = months[0].lines.find((l) => l.providerName === 'RENTA MENSUAL')!;
    // CXP said 10k but historical avg is 25k → mixed, amount 25k
    expect(rentLine.amount).toBe(25_000);
    expect(rentLine.source).toBe('mixed');
    expect(rentLine.parts.scheduled).toBe(10_000);
    expect(rentLine.parts.recurring).toBe(15_000);
  });

  it('uses critical provider minimum monthly spend when there is no CXP or bank pattern', () => {
    const providers = [
      provider('OPERACION CRITICA', {
        type: 'OPERACION',
        clasificacionAutomatica: 'CRITICO',
        gastoMinimoMensual: 19_000,
      }),
      provider('FLEXIBLE SIN PISO', {
        clasificacionAutomatica: 'MEDIO',
        gastoMinimoMensual: 99_000,
      }),
    ];

    const months = projectExpenseByProvider({
      providers,
      aged: [],
      bankStatements: [],
      today: '2026-04-22',
      fromYm: '2026-05',
      toYm: '2026-05',
    });

    const critical = months[0].lines.find((l) => l.providerName === 'OPERACION CRITICA');
    expect(critical?.amount).toBe(19_000);
    expect(critical?.parts.recurring).toBe(19_000);
    expect(critical?.providerCategory).toBe('OPERACION');
    expect(months[0].lines.some((l) => l.providerName === 'FLEXIBLE SIN PISO')).toBe(false);
  });

  it('bumps scheduled CXP up to critical provider minimum without duplicating', () => {
    const providers = [
      provider('OPERACION CRITICA', {
        id: 'p-critical',
        type: 'OPERACION',
        clasificacionAutomatica: 'CRITICO',
        gastoMinimoMensual: 19_000,
      }),
    ];
    const months = projectExpenseByProvider({
      providers,
      aged: [aged_({ nombre: 'OPERACION CRITICA', fechaProgramacionPago: '2026-05-10', importePendientePesos: 7_000 })],
      bankStatements: [],
      today: '2026-04-22',
      fromYm: '2026-05',
      toYm: '2026-05',
    });

    const line = months[0].lines.find((l) => l.providerName === 'OPERACION CRITICA');
    expect(line?.amount).toBe(19_000);
    expect(line?.parts.scheduled).toBe(7_000);
    expect(line?.parts.recurring).toBe(12_000);
    expect(months[0].total).toBe(19_000);
  });

  it('unmatched aged records appear with __un:: key and unknown flex', () => {
    const aged: AgedBalanceRecord[] = [
      aged_({ nombre: 'PROVEEDOR NO EN CATALOGO', fechaProgramacionPago: '2026-05-10', importePendientePesos: 7_000 }),
    ];
    const months = projectExpenseByProvider({
      providers: [], aged, bankStatements: [], today: '2026-04-22',
      fromYm: '2026-05', toYm: '2026-05',
    });
    const line = months[0].lines[0];
    expect(line.providerName).toBe('PROVEEDOR NO EN CATALOGO');
    expect(line.flexibility).toBe('unknown');
    expect(line.amount).toBe(7_000);
  });
});

// ── helpers ──────────────────────────────────────────────────────────────

function aged_(o: Partial<AgedBalanceRecord>): AgedBalanceRecord {
  return {
    cia: '00001', noProveedor: '', nombre: '', noFactura: '',
    fechaFactura: '', fechaVence: '', fechaProgramacionPago: '',
    diasVencida: 0, importeBrutoPesos: 0, importePendientePesos: 0,
    importeSubtotalPesos: 0, importeImpuestosPesos: 0,
    importeBrutoDolares: 0, importePendienteDolares: 0,
    moneda: 'MXN', condPago: '', clasifica: '', clasificacionProveedor: '',
    edoPago: '', tipoCambio: 1, porVencer: 0,
    v1_30: 0, v31_60: 0, v61_90: 0, v91_120: 0, v121_150: 0, v151_180: 0, mas180: 0,
    ...o,
  };
}

function mov(fecha: string, importe: number, concepto: string) {
  return {
    cia: '00001', banco: 'BBVA', cuenta: '1', moneda: 'MXN',
    fechaOperacion: fecha, referencia: 'R', concepto,
    tipoMovimiento: 'CARGO' as const, importe,
  };
}
