/**
 * expensePerProvider.branches.test.ts — cobertura de RAMAS de la proyección de
 * egresos por proveedor. Hermano de `expensePerProvider.test.ts` (que fija los
 * caminos scheduled / recurring / mixed / piso operativo); aquí se ejercitan
 * las guardas de ingesta bancaria (ABONO, traspaso interno, concepto ruidoso,
 * fecha inválida, mes en curso), la estacionalidad por mes calendario, y las
 * ramas de normalización / fallback de nombre.
 *
 * No toca código fuente. Las aserciones documentan el comportamiento REAL.
 */
import { describe, expect, it } from 'vitest';
import {
  buildProviderBankPatterns,
  buildProviderIndex,
  isNoisyBankExpenseConcept,
  matchAgedToProvider,
  matchConceptToProvider,
  paymentPeriodDays,
  projectExpenseByProvider,
} from './expensePerProvider';
import type { Provider } from './types';
import type { AgedBalanceRecord, BankAccountStatement, BankStatementLine } from '../services/jdeTypes';

const TODAY = '2026-04-22';

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

function mov(patch: Partial<BankStatementLine>): BankStatementLine {
  return {
    cia: '00001',
    banco: 'BBVA',
    cuenta: '0190047839',
    moneda: 'MXN',
    fechaOperacion: '2026-01-05',
    referencia: 'R',
    concepto: 'PAGO PROVEEDOR',
    tipoMovimiento: 'CARGO',
    importe: 1000,
    ...patch,
  };
}

function statement(movimientos: BankStatementLine[], cuenta = '0190047839'): BankAccountStatement {
  return {
    cia: '00001',
    banco: 'BBVA',
    cuenta,
    moneda: 'MXN',
    fechaEstadoCuenta: TODAY,
    saldoInicial: 0,
    saldoFinal: 0,
    movimientos: movimientos.map((m) => ({ ...m, cuenta })),
  };
}

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

describe('paymentPeriodDays — ramas de parseo', () => {
  it('un periodo sin dígitos cae al default de 30 días', () => {
    expect(paymentPeriodDays('Por definir' as Provider['paymentPeriod'])).toBe(30);
  });

  it('Contado es 0 aunque no traiga dígitos', () => {
    expect(paymentPeriodDays('Contado')).toBe(0);
  });

  it('45 días se parsea al número embebido', () => {
    expect(paymentPeriodDays('45 días')).toBe(45);
  });
});

describe('buildProviderIndex / matchConceptToProvider — ramas de normalización', () => {
  it('descarta proveedores con nombre vacío o sólo espacios', () => {
    const index = buildProviderIndex([
      provider('  ', { id: 'p-blank' }),
      provider('ACME REFACCIONES', { id: 'p-acme' }),
    ]);
    expect(index.byName.size).toBe(1);
    expect(index.sortedByLen).toHaveLength(1);
  });

  it('match exacto por nombre normalizado (espacios colapsados, mayúsculas)', () => {
    const index = buildProviderIndex([provider('Acme  Refacciones')]);
    expect(matchConceptToProvider('  acme refacciones ', index)?.name).toBe('Acme  Refacciones');
  });

  it('concepto nulo / vacío no matchea', () => {
    const index = buildProviderIndex([provider('ACME REFACCIONES')]);
    expect(matchConceptToProvider(null as unknown as string, index)).toBeNull();
    expect(matchConceptToProvider(undefined as unknown as string, index)).toBeNull();
  });

  it('matchAgedToProvider sin nombre en el registro no matchea', () => {
    const index = buildProviderIndex([provider('ACME REFACCIONES')]);
    expect(matchAgedToProvider({}, index)).toBeNull();
    expect(matchAgedToProvider({ nombre: 'ACME REFACCIONES' }, index)?.name).toBe('ACME REFACCIONES');
  });
});

describe('isNoisyBankExpenseConcept — todos los patrones', () => {
  const noisy = [
    'PAGO TARJETA 1234',
    'PAGO A TARJETA BBVA',
    'TARJ.NO.5579 6211',
    'TARJETA NO 998877',
    'TRANS INTERBANCARIA SPEI',
    'TRANS. INTERBANCARIA SPEI',
    'TRANSF A LA CUENTA 001',
    'TRANSF. A LA CUENTA 001',
    'TRASPASO ENTRE MIS CUENTAS',
    'TRANSFERENCIA ENTRE CUENTAS PROPIAS',
  ];
  for (const c of noisy) {
    it(`marca ruidoso: "${c}"`, () => {
      expect(isNoisyBankExpenseConcept(c)).toBe(true);
    });
  }

  it('concepto vacío NO es ruidoso', () => {
    expect(isNoisyBankExpenseConcept('')).toBe(false);
    expect(isNoisyBankExpenseConcept('   ')).toBe(false);
  });

  it('un pago normal a proveedor NO es ruidoso', () => {
    expect(isNoisyBankExpenseConcept('PAGO ACME REFACCIONES FACT 100')).toBe(false);
  });
});

describe('buildProviderBankPatterns — guardas de ingesta', () => {
  const providers = [provider('ACME REFACCIONES')];

  it('ignora ABONOs (sólo CARGOs alimentan el patrón)', () => {
    const patterns = buildProviderBankPatterns(
      providers,
      [statement([
        mov({ fechaOperacion: '2026-01-05', concepto: 'PAGO ACME REFACCIONES', tipoMovimiento: 'ABONO' }),
        mov({ fechaOperacion: '2026-02-05', concepto: 'PAGO ACME REFACCIONES', tipoMovimiento: 'ABONO' }),
      ])],
      TODAY,
      6,
    );
    expect(patterns.size).toBe(0);
  });

  it('ignora conceptos ruidosos aunque contengan el nombre del proveedor', () => {
    const patterns = buildProviderBankPatterns(
      providers,
      [statement([
        mov({ fechaOperacion: '2026-01-05', concepto: 'TRASPASO ACME REFACCIONES' }),
        mov({ fechaOperacion: '2026-02-05', concepto: 'TRASPASO ACME REFACCIONES' }),
      ])],
      TODAY,
      6,
    );
    expect(patterns.size).toBe(0);
  });

  it('ignora traspasos internos detectados por la cuenta destino en el concepto', () => {
    const cuentaA = '0190047839';
    const cuentaB = '0123456789';
    const patterns = buildProviderBankPatterns(
      providers,
      [
        statement([
          mov({ fechaOperacion: '2026-01-05', concepto: `PAGO ACME REFACCIONES A ${cuentaB}` }),
          mov({ fechaOperacion: '2026-02-05', concepto: `PAGO ACME REFACCIONES A ${cuentaB}` }),
        ], cuentaA),
        statement([], cuentaB),
      ],
      TODAY,
      6,
    );
    expect(patterns.size).toBe(0);
  });

  it('ignora movimientos con fecha vacía o mal formada', () => {
    const patterns = buildProviderBankPatterns(
      providers,
      [statement([
        mov({ fechaOperacion: '', concepto: 'PAGO ACME REFACCIONES' }),
        mov({ fechaOperacion: '2026', concepto: 'PAGO ACME REFACCIONES' }),
        mov({ fechaOperacion: undefined as unknown as string, concepto: 'PAGO ACME REFACCIONES' }),
      ])],
      TODAY,
      6,
    );
    expect(patterns.size).toBe(0);
  });

  it('ignora el mes EN CURSO (parcial) y los meses futuros', () => {
    const patterns = buildProviderBankPatterns(
      providers,
      [statement([
        mov({ fechaOperacion: '2026-04-05', concepto: 'PAGO ACME REFACCIONES' }),
        mov({ fechaOperacion: '2026-06-05', concepto: 'PAGO ACME REFACCIONES' }),
      ])],
      TODAY,
      6,
    );
    expect(patterns.size).toBe(0);
  });

  it('un CARGO cuyo concepto no matchea ningún proveedor no crea patrón', () => {
    const patterns = buildProviderBankPatterns(
      providers,
      [statement([mov({ fechaOperacion: '2026-01-05', concepto: 'PAGO DESCONOCIDO' })])],
      TODAY,
      6,
    );
    expect(patterns.size).toBe(0);
  });

  it('un CARGO sin concepto (campo ausente) se ignora sin romper', () => {
    const patterns = buildProviderBankPatterns(
      providers,
      [statement([
        mov({ fechaOperacion: '2026-01-05', concepto: undefined as unknown as string }),
        mov({ fechaOperacion: '2026-02-05', concepto: undefined as unknown as string }),
      ])],
      TODAY,
      6,
    );
    expect(patterns.size).toBe(0);
  });

  it('un proveedor con pagos SÓLO fuera de la ventana reciente no genera patrón', () => {
    const patterns = buildProviderBankPatterns(
      providers,
      [statement([
        mov({ fechaOperacion: '2024-01-05', concepto: 'PAGO ACME REFACCIONES' }),
        mov({ fechaOperacion: '2024-02-05', concepto: 'PAGO ACME REFACCIONES' }),
      ])],
      TODAY,
      6,
    );
    expect(patterns.size).toBe(0);
  });

  it('importe ausente / negativo se toma en valor absoluto y no rompe el promedio', () => {
    const patterns = buildProviderBankPatterns(
      providers,
      [statement([
        mov({ fechaOperacion: '2026-01-05', concepto: 'PAGO ACME REFACCIONES', importe: -1000 }),
        mov({ fechaOperacion: '2026-02-05', concepto: 'PAGO ACME REFACCIONES', importe: undefined as unknown as number }),
        mov({ fechaOperacion: '2026-03-05', concepto: 'PAGO ACME REFACCIONES', importe: 2000 }),
      ])],
      TODAY,
      6,
    );
    const pat = patterns.get(providers[0].id)!;
    expect(pat.activeMonths).toBe(2); // febrero quedó en 0 → no cuenta como activo
    expect(pat.monthlyAvg).toBe(1500);
  });

  it('día de operación no parseable cae al día 15 como típico', () => {
    const patterns = buildProviderBankPatterns(
      providers,
      [statement([
        mov({ fechaOperacion: '2026-01-XX', concepto: 'PAGO ACME REFACCIONES' }),
        mov({ fechaOperacion: '2026-02-XX', concepto: 'PAGO ACME REFACCIONES' }),
      ])],
      TODAY,
      6,
    );
    expect(patterns.get(providers[0].id)!.typicalPayDay).toBe(15);
  });

  it('acumula varios cargos del MISMO mes en un solo bucket', () => {
    const patterns = buildProviderBankPatterns(
      providers,
      [statement([
        mov({ fechaOperacion: '2026-01-05', concepto: 'PAGO ACME REFACCIONES', importe: 400 }),
        mov({ fechaOperacion: '2026-01-20', concepto: 'PAGO ACME REFACCIONES', importe: 600 }),
      ])],
      TODAY,
      6,
    );
    const pat = patterns.get(providers[0].id)!;
    expect(pat.activeMonths).toBe(1);
    expect(pat.monthlyAvg).toBe(1000);
    expect(pat.lastPaid).toBe('2026-01');
    expect(pat.isRecurring).toBe(false);
  });

  it('promedia el mes calendario por número de AÑOS observados (estacionalidad)', () => {
    const patterns = buildProviderBankPatterns(
      providers,
      [statement([
        mov({ fechaOperacion: '2024-12-05', concepto: 'PAGO ACME REFACCIONES', importe: 100_000 }),
        mov({ fechaOperacion: '2025-12-05', concepto: 'PAGO ACME REFACCIONES', importe: 200_000 }),
        mov({ fechaOperacion: '2026-01-05', concepto: 'PAGO ACME REFACCIONES', importe: 10_000 }),
      ])],
      TODAY,
      6,
    );
    const pat = patterns.get(providers[0].id)!;
    // Diciembre: (100k + 200k) / 2 años observados = 150k.
    expect(pat.monthlyAvgByCalendarMonth[11]).toBe(150_000);
    // Enero: un solo año → el propio importe.
    expect(pat.monthlyAvgByCalendarMonth[0]).toBe(10_000);
    // Meses sin historia quedan en 0.
    expect(pat.monthlyAvgByCalendarMonth[6]).toBe(0);
  });
});

describe('projectExpenseByProvider — guardas del CXP (aged)', () => {
  it('descarta registros sin fecha de programación de pago o con fecha mal formada', () => {
    const months = projectExpenseByProvider({
      providers: [],
      aged: [
        aged_({ nombre: 'A', fechaProgramacionPago: '', importePendientePesos: 100 }),
        aged_({ nombre: 'B', fechaProgramacionPago: '2026', importePendientePesos: 100 }),
        aged_({ nombre: 'C', fechaProgramacionPago: undefined as unknown as string, importePendientePesos: 100 }),
      ],
      bankStatements: [],
      today: TODAY,
      fromYm: '2026-05',
      toYm: '2026-05',
    });
    expect(months[0].lines).toHaveLength(0);
  });

  it('descarta registros con importe pendiente <= 0 o ausente', () => {
    const months = projectExpenseByProvider({
      providers: [],
      aged: [
        aged_({ nombre: 'A', fechaProgramacionPago: '2026-05-10', importePendientePesos: 0 }),
        aged_({ nombre: 'B', fechaProgramacionPago: '2026-05-10', importePendientePesos: -50 }),
        aged_({ nombre: 'C', fechaProgramacionPago: '2026-05-10', importePendientePesos: undefined as unknown as number }),
      ],
      bankStatements: [],
      today: TODAY,
      fromYm: '2026-05',
      toYm: '2026-05',
    });
    expect(months[0].lines).toHaveLength(0);
  });

  it('un registro sin nombre cae al placeholder "Proveedor s/n"', () => {
    const months = projectExpenseByProvider({
      providers: [],
      aged: [aged_({ nombre: '', fechaProgramacionPago: '2026-05-10', importePendientePesos: 500 })],
      bankStatements: [],
      today: TODAY,
      fromYm: '2026-05',
      toYm: '2026-05',
    });
    expect(months[0].lines[0].providerName).toBe('Proveedor s/n');
    expect(months[0].lines[0].paymentPeriod).toBe('30 días');
  });

  it('acumula varias facturas del mismo proveedor y mes en una sola línea', () => {
    const months = projectExpenseByProvider({
      providers: [provider('ACME REFACCIONES')],
      aged: [
        aged_({ nombre: 'ACME REFACCIONES', fechaProgramacionPago: '2026-05-10', importePendientePesos: 500 }),
        aged_({ nombre: 'ACME REFACCIONES', fechaProgramacionPago: '2026-05-25', importePendientePesos: 700 }),
      ],
      bankStatements: [],
      today: TODAY,
      fromYm: '2026-05',
      toYm: '2026-05',
    });
    expect(months[0].lines).toHaveLength(1);
    expect(months[0].lines[0].amount).toBe(1200);
    expect(months[0].scheduledTotal).toBe(1200);
    expect(months[0].recurringTotal).toBe(0);
  });
});

describe('projectExpenseByProvider — estacionalidad y recurrencia', () => {
  const recurringBank = (concepto: string, importe: number) => statement(
    ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03'].map((ym) =>
      mov({ fechaOperacion: `${ym}-05`, concepto, importe })),
  );

  it('sin historia en el mes calendario usa el promedio plano', () => {
    const providers = [provider('ACME REFACCIONES')];
    const months = projectExpenseByProvider({
      providers,
      aged: [],
      bankStatements: [recurringBank('PAGO ACME REFACCIONES', 10_000)],
      today: TODAY,
      fromYm: '2026-07', // julio: sin historia
      toYm: '2026-07',
    });
    expect(months[0].lines[0].amount).toBe(10_000);
    expect(months[0].lines[0].source).toBe('recurring');
  });

  it('con historia en el mes calendario mezcla 50/50 plano + estacional', () => {
    const providers = [provider('ACME REFACCIONES')];
    const bank = statement([
      ...['2025-11', '2025-12', '2026-01', '2026-02'].map((ym) =>
        mov({ fechaOperacion: `${ym}-05`, concepto: 'PAGO ACME REFACCIONES', importe: 10_000 })),
      // Marzo con importe alto: dispara el blend estacional para el mes 03.
      mov({ fechaOperacion: '2026-03-05', concepto: 'PAGO ACME REFACCIONES', importe: 50_000 }),
    ]);
    const months = projectExpenseByProvider({
      providers,
      aged: [],
      bankStatements: [bank],
      today: TODAY,
      fromYm: '2027-03',
      toYm: '2027-03',
    });
    // monthlyAvg = (10k*4 + 50k)/5 = 18k. Estacional marzo = 50k. Blend = 34k.
    expect(months[0].lines[0].amount).toBe(34_000);
  });

  it('un proveedor NO recurrente no genera línea propia sin CXP', () => {
    const providers = [provider('ESPORADICO SA')];
    const months = projectExpenseByProvider({
      providers,
      aged: [],
      bankStatements: [statement([
        mov({ fechaOperacion: '2026-01-05', concepto: 'PAGO ESPORADICO SA', importe: 9_000 }),
      ])],
      today: TODAY,
      fromYm: '2026-05',
      toYm: '2026-05',
    });
    expect(months[0].lines).toHaveLength(0);
  });

  it('un proveedor recurrente con CXP MAYOR al promedio conserva "scheduled"', () => {
    const providers = [provider('ACME REFACCIONES')];
    const months = projectExpenseByProvider({
      providers,
      aged: [aged_({
        nombre: 'ACME REFACCIONES',
        fechaProgramacionPago: '2026-05-10',
        importePendientePesos: 99_000,
      })],
      bankStatements: [recurringBank('PAGO ACME REFACCIONES', 10_000)],
      today: TODAY,
      fromYm: '2026-05',
      toYm: '2026-05',
    });
    expect(months[0].lines[0].source).toBe('scheduled');
    expect(months[0].lines[0].amount).toBe(99_000);
  });

  it('el piso operativo sólo aplica a proveedores CRITICO con gasto mínimo positivo', () => {
    const months = projectExpenseByProvider({
      providers: [
        provider('CRITICO SIN MONTO', { clasificacionAutomatica: 'CRITICO' }),
        provider('CRITICO MONTO CERO', { clasificacionAutomatica: 'CRITICO', gastoMinimoMensual: 0 }),
        provider('CRITICO MONTO INFINITO', {
          clasificacionAutomatica: 'CRITICO',
          gastoMinimoMensual: Number.POSITIVE_INFINITY,
        }),
        provider('ALTO CON MONTO', { clasificacionAutomatica: 'ALTO', gastoMinimoMensual: 50_000 }),
        provider('CRITICO OK', { clasificacionAutomatica: 'CRITICO', gastoMinimoMensual: 12_000 }),
      ],
      aged: [],
      bankStatements: [],
      today: TODAY,
      fromYm: '2026-05',
      toYm: '2026-05',
    });
    expect(months[0].lines.map((l) => l.providerName)).toEqual(['CRITICO OK']);
    expect(months[0].lines[0].amount).toBe(12_000);
  });

  it('un proveedor recurrente crítico eleva su monto al piso operativo', () => {
    const providers = [provider('ACME REFACCIONES', {
      clasificacionAutomatica: 'CRITICO',
      gastoMinimoMensual: 40_000,
    })];
    const months = projectExpenseByProvider({
      providers,
      aged: [],
      bankStatements: [recurringBank('PAGO ACME REFACCIONES', 10_000)],
      today: TODAY,
      fromYm: '2026-05',
      toYm: '2026-05',
    });
    expect(months[0].lines[0].source).toBe('recurring');
    expect(months[0].lines[0].amount).toBe(40_000);
  });

  it('una línea del catálogo sin flexibility declarada cae a "unknown"', () => {
    const providers = [provider('ACME REFACCIONES', {
      flexibility: undefined as unknown as Provider['flexibility'],
      clasificacionAutomatica: 'CRITICO',
      gastoMinimoMensual: 5_000,
    })];
    const months = projectExpenseByProvider({
      providers,
      aged: [],
      bankStatements: [],
      today: TODAY,
      fromYm: '2026-05',
      toYm: '2026-05',
    });
    expect(months[0].lines[0].flexibility).toBe('unknown');
  });

  it('un proveedor recurrente sin flexibility declarada también cae a "unknown"', () => {
    const providers = [provider('ACME REFACCIONES', {
      flexibility: undefined as unknown as Provider['flexibility'],
    })];
    const months = projectExpenseByProvider({
      providers,
      aged: [],
      bankStatements: [recurringBank('PAGO ACME REFACCIONES', 10_000)],
      today: TODAY,
      fromYm: '2026-05',
      toYm: '2026-05',
    });
    expect(months[0].lines[0].flexibility).toBe('unknown');
    expect(months[0].lines[0].source).toBe('recurring');
  });

  it('el rango invertido (from > to) produce cero meses', () => {
    const months = projectExpenseByProvider({
      providers: [],
      aged: [],
      bankStatements: [],
      today: TODAY,
      fromYm: '2026-07',
      toYm: '2026-05',
    });
    expect(months).toHaveLength(0);
  });

  it('las líneas del mes se ordenan por monto descendente', () => {
    const months = projectExpenseByProvider({
      providers: [],
      aged: [
        aged_({ nombre: 'CHICO', fechaProgramacionPago: '2026-05-10', importePendientePesos: 100 }),
        aged_({ nombre: 'GRANDE', fechaProgramacionPago: '2026-05-10', importePendientePesos: 900 }),
      ],
      bankStatements: [],
      today: TODAY,
      fromYm: '2026-05',
      toYm: '2026-05',
    });
    expect(months[0].lines.map((l) => l.providerName)).toEqual(['GRANDE', 'CHICO']);
    expect(months[0].total).toBe(1000);
  });
});
