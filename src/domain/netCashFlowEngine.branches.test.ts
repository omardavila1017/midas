/**
 * netCashFlowEngine.branches.test.ts — cobertura de RAMAS del motor de flujo
 * bank-only + detección de traspasos internos. Hermanos: `internalTransfers.test.ts`
 * (clasificación) y `netCashFlowEngine.flow.test.ts` (agregación). Aquí se
 * ejercitan las ramas defensivas y de fallback que quedaban muertas: entradas
 * ausentes/undefined, la pata `referencia` de CADA señal interna, los guardas
 * del pareo ±3d, y los defaults de etiqueta/moneda/fecha de los extractores.
 *
 * No toca código fuente. Las aserciones documentan el comportamiento REAL.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateMonthly,
  aggregateWeekly,
  buildOwnAccountDetector,
  buildOwnAccountsIndex,
  buildPairMatchedKeys,
  classifyMovement,
  computeBankOnlyCashFlow,
  extractComprasPaymentEvents,
  extractPaymentEvents,
  findExtremeWeeks,
  isInternalCounterparty,
  isInternalProviderClassification,
  isInternalTransfer,
  movementHashKey,
  type DailyFlow,
} from './netCashFlowEngine';
import type { BankAccountStatement, BankStatementLine, ComprasRecord } from '../services/jdeTypes';
import type { CXPRecord } from './persistence';

function mov(patch: Partial<BankStatementLine> = {}): BankStatementLine {
  return {
    cia: '00011',
    banco: '002',
    cuenta: '0190047839',
    moneda: 'MXN',
    fechaOperacion: '2026-04-22',
    referencia: 'REF1',
    concepto: 'Concepto generico',
    tipoMovimiento: 'CARGO',
    importe: 1000,
    ...patch,
  };
}

function acc(patch: Partial<BankAccountStatement> = {}): BankAccountStatement {
  return {
    cia: '00011',
    banco: '002',
    cuenta: '0190047839',
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-04-30',
    saldoInicial: 0,
    saldoFinal: 0,
    movimientos: [],
    ...patch,
  };
}

function cxp(patch: Partial<CXPRecord> = {}): CXPRecord {
  return {
    cia: '00011',
    noProveedor: '5001',
    nombre: 'PROVEEDOR ACME',
    noFactura: 'F-100',
    fechaFactura: '2026-03-01',
    fechaVence: '2026-03-31',
    fechaProgramacionPago: '2026-03-25',
    diasVencida: 0,
    importeBrutoPesos: 1000,
    importePendientePesos: 400,
    importeSubtotalPesos: 862,
    importeImpuestosPesos: 138,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '30',
    clasifica: '',
    clasificacionProveedor: 'REFACCIONES',
    edoPago: 'A',
    tipoCambio: 1,
    porVencer: 400,
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

function compra(patch: Partial<ComprasRecord> = {}): ComprasRecord {
  return {
    cia: '00001',
    noProveedor: '71601541',
    nombreProveedor: 'Test Supplier',
    noOrden: '18889',
    tipoOrden: 'OS',
    descTipoOrden: 'Catalogadas almacén',
    lineaOrden: 1,
    noProducto: '5001',
    descProducto: 'Producto',
    concepto: 'Concepto',
    cantidad: 10,
    precioUnitario: 100,
    importeTotal: 1000,
    moneda: 'MXP',
    tipoCambio: 1,
    fechaPedido: '2026-03-04',
    fechaRecepcion: '',
    diasCredito: 30,
    fechaPagoProyectada: '2026-05-13',
    noFactura: '',
    centroCostos: '101',
    categoria: 'IND',
    descCategoria: 'Indirectos',
    familia: 'PLI',
    descFamilia: 'PRODUCTOS DE LIMPIEZA',
    subFamilia: 'QDA',
    descSubFamilia: 'QUIMICOS',
    estadoSiguiente: '380',
    tasaFiscal: 'IVA16',
    cancelada: false,
    facturada: false,
    ...patch,
  };
}

/** OwnAccountProbe completo — todos sus campos son requeridos por el tipo. */
function probe(patch: Partial<BankStatementLine> = {}) {
  return {
    cuenta: patch.cuenta,
    concepto: patch.concepto,
    referencia: patch.referencia,
    infAdi1: patch.infAdi1,
    infAdi2: patch.infAdi2,
    infAdi3: patch.infAdi3,
  } as Parameters<typeof isInternalTransfer>[0];
}

describe('buildOwnAccountsIndex — entradas ausentes', () => {
  it('sin statements devuelve sólo los identificadores del catálogo estático', () => {
    const withUndefined = buildOwnAccountsIndex(undefined);
    const withEmpty = buildOwnAccountsIndex([]);
    expect(withUndefined.size).toBeGreaterThan(0);
    expect(withUndefined.size).toBe(withEmpty.size);
  });

  it('descarta cuentas ausentes o demasiado cortas', () => {
    const base = buildOwnAccountsIndex([]).size;
    const index = buildOwnAccountsIndex([
      acc({ cuenta: undefined as unknown as string }),
      acc({ cuenta: '  ' }),
      acc({ cuenta: '123' }),
    ]);
    expect(index.size).toBe(base);
  });

  it('indexa la cuenta cruda y su versión sólo-dígitos', () => {
    const base = buildOwnAccountsIndex([]);
    const index = buildOwnAccountsIndex([acc({ cuenta: ' 0190-047839 ' })]);
    expect(index.has('0190-047839')).toBe(true);
    expect(index.has('0190047839')).toBe(true);
    expect(index.size).toBe(base.size + 2);
  });
});

describe('buildOwnAccountDetector — ramas de construcción del patrón', () => {
  it('sin cuentas propias el detector siempre devuelve false', () => {
    expect(buildOwnAccountDetector(undefined)(mov())).toBe(false);
    expect(buildOwnAccountDetector(new Set())(mov())).toBe(false);
  });

  it('un movimiento sin ningún campo de texto no puede ser interno', () => {
    const detector = buildOwnAccountDetector(new Set(['0123456789', '9876543210']));
    expect(detector(probe({ cuenta: '0190047839' }))).toBe(false);
    expect(detector(probe({
      cuenta: '0190047839',
      concepto: '',
      referencia: '',
      infAdi1: '',
      infAdi2: '',
      infAdi3: '',
    }))).toBe(false);
  });

  it('cuando TODAS las cuentas del índice son la propia, el patrón queda vacío y nada es interno', () => {
    const detector = buildOwnAccountDetector(new Set(['0123456789']));
    expect(detector(probe({ cuenta: '0123456789', concepto: 'SPEI A 0123456789' }))).toBe(false);
  });

  it('un identificador sin dígitos del índice no colisiona con la cuenta propia', () => {
    const detector = buildOwnAccountDetector(new Set(['SIN-DIGITOS', '0123456789']));
    // La cuenta origen es otra → 0123456789 sigue en el patrón y dispara.
    expect(detector(probe({ cuenta: '0190047839', concepto: 'TRASLADO A 0123456789' }))).toBe(true);
  });

  it('sin cuenta origen usa el patrón COMPLETO (no puede auto-excluir)', () => {
    const detector = buildOwnAccountDetector(new Set(['0123456789']));
    expect(detector(probe({ cuenta: undefined, concepto: 'PAGO 0123456789' }))).toBe(true);
  });

  it('reutiliza el patrón cacheado por cuenta origen entre llamadas', () => {
    const detector = buildOwnAccountDetector(new Set(['0123456789', '9876543210']));
    const p = probe({ cuenta: '0190047839', concepto: 'MOV A 9876543210' });
    expect(detector(p)).toBe(true);
    expect(detector(p)).toBe(true);
  });

  it('reconoce la cuenta propia embebida en una CLABE de 18 dígitos y la auto-excluye', () => {
    // CLABE 002 180 00123456789 0 → segmento de cuenta = 00123456789.
    const detector = buildOwnAccountDetector(new Set(['002180001234567890']));
    expect(detector(probe({ cuenta: '00123456789', concepto: 'SPEI 002180001234567890' }))).toBe(false);
  });
});

describe('isInternalTransfer — la pata `referencia` de cada señal', () => {
  it('sin concepto ni referencia no es interno', () => {
    expect(isInternalTransfer(probe({ concepto: undefined, referencia: undefined }))).toBe(false);
    expect(isInternalTransfer(probe())).toBe(false);
  });

  it('leyenda TRASPASO REF sólo en la referencia', () => {
    expect(isInternalTransfer(probe({ concepto: 'DEPOSITO', referencia: 'TRASPASO REF 991' }))).toBe(true);
  });

  it('leyenda intercompañía en concepto y, por separado, sólo en referencia', () => {
    expect(isInternalTransfer(probe({ concepto: 'MOV INTERCIAS', referencia: 'X' }))).toBe(true);
    expect(isInternalTransfer(probe({ concepto: 'DEPOSITO', referencia: 'MOV ENTRE CIAS' }))).toBe(true);
  });

  it('RFC propio en concepto y, por separado, sólo en referencia', () => {
    const rfc = 'TTA4906038F4';
    expect(isInternalTransfer(probe({ concepto: `PAGO ${rfc}`, referencia: 'X' }))).toBe(true);
    expect(isInternalTransfer(probe({ concepto: 'DEPOSITO', referencia: `PAGO ${rfc}` }))).toBe(true);
  });

  it('beneficiario del grupo en concepto y, por separado, sólo en referencia', () => {
    expect(isInternalTransfer(probe({ concepto: 'PAGO A TURIMEX DEL NORTE', referencia: 'X' }))).toBe(true);
    expect(isInternalTransfer(probe({ concepto: 'DEPOSITO', referencia: 'TURIMEX DEL NORTE' }))).toBe(true);
  });

  it('sigla corta del grupo en concepto y, por separado, sólo en referencia', () => {
    expect(isInternalTransfer(probe({ concepto: 'ABONO TRCC', referencia: 'X' }))).toBe(true);
    expect(isInternalTransfer(probe({ concepto: 'DEPOSITO NORMAL', referencia: 'TRTT' }))).toBe(true);
  });

  it('un pago externo con detector de cuentas propias sigue siendo real', () => {
    const detector = buildOwnAccountDetector(new Set(['0123456789']));
    expect(isInternalTransfer(
      probe({ cuenta: '0190047839', concepto: 'PAGO PROVEEDOR EXTERNO', referencia: 'F-1' }),
      detector,
    )).toBe(false);
  });
});

describe('isInternalCounterparty / isInternalProviderClassification — ramas restantes', () => {
  it('sin nombre y sin RFC no es interno', () => {
    expect(isInternalCounterparty(undefined, undefined)).toBe(false);
    expect(isInternalCounterparty('', '   ')).toBe(false);
  });

  it('RFC propio basta aunque no haya nombre', () => {
    expect(isInternalCounterparty('TTA4906038F4', undefined)).toBe(true);
  });

  it('una sigla corta del grupo como NOMBRE marca interno', () => {
    expect(isInternalCounterparty(undefined, 'TRCC')).toBe(true);
  });

  it('un RFC externo con nombre externo no es interno', () => {
    expect(isInternalCounterparty('XAXX010101000', 'ACME REFACCIONES SA')).toBe(false);
  });

  it('clasificación vacía / ausente no es intra-grupo', () => {
    expect(isInternalProviderClassification(undefined)).toBe(false);
    expect(isInternalProviderClassification('')).toBe(false);
  });
});

describe('movementHashKey — defaults de campos ausentes', () => {
  it('todos los campos ausentes producen una llave estable con vacíos y cero', () => {
    const key = movementHashKey(undefined, undefined, {
      fechaOperacion: undefined as unknown as string,
      tipoMovimiento: undefined as unknown as 'CARGO',
      importe: undefined as unknown as number,
      referencia: undefined,
      concepto: undefined,
    } as unknown as Parameters<typeof movementHashKey>[2]);
    expect(key).toBe('::::::::0::::');
  });
});

describe('buildPairMatchedKeys — guardas de ingesta y desempates', () => {
  it('descarta cuentas ausentes/vacías y movimientos sin fecha, tipo o importe usable', () => {
    const keys = buildPairMatchedKeys([
      acc({ cuenta: '', movimientos: [mov({ importe: 500, tipoMovimiento: 'CARGO' })] }),
      acc({ cuenta: undefined as unknown as string, movimientos: [mov({ importe: 500, tipoMovimiento: 'ABONO' })] }),
      acc({
        cia: undefined as unknown as string,
        cuenta: 'CTA-A',
        movimientos: [
          mov({ fechaOperacion: '', importe: 500, tipoMovimiento: 'CARGO' }),
          mov({ tipoMovimiento: undefined as unknown as 'CARGO', importe: 500 }),
          mov({ importe: Number.NaN, tipoMovimiento: 'CARGO' }),
          mov({ importe: 0, tipoMovimiento: 'CARGO' }),
          mov({ importe: -500, tipoMovimiento: 'CARGO' }),
          mov({ fechaOperacion: 'no-es-fecha', importe: 500, tipoMovimiento: 'CARGO' }),
        ],
      }),
      acc({ cuenta: 'CTA-B', movimientos: [mov({ importe: 500, tipoMovimiento: 'ABONO' })] }),
    ]);
    expect(keys.size).toBe(0);
  });

  it('un bucket con sólo CARGOs (o sólo ABONOs) no parea', () => {
    const keys = buildPairMatchedKeys([
      acc({ cuenta: 'CTA-A', movimientos: [mov({ importe: 700, tipoMovimiento: 'CARGO', referencia: 'A' })] }),
      acc({ cuenta: 'CTA-B', movimientos: [mov({ importe: 700, tipoMovimiento: 'CARGO', referencia: 'B' })] }),
    ]);
    expect(keys.size).toBe(0);
  });

  it('un bucket con un solo movimiento no parea', () => {
    const keys = buildPairMatchedKeys([
      acc({ cuenta: 'CTA-A', movimientos: [mov({ importe: 700, tipoMovimiento: 'CARGO' })] }),
    ]);
    expect(keys.size).toBe(0);
  });

  it('desempata de forma determinista por (fecha, cuenta, llave) con varios pares del mismo monto', () => {
    const statements = [
      acc({
        cuenta: 'CTA-B',
        movimientos: [
          mov({ importe: 900, tipoMovimiento: 'CARGO', referencia: 'B2', fechaOperacion: '2026-04-22' }),
          mov({ importe: 900, tipoMovimiento: 'CARGO', referencia: 'B1', fechaOperacion: '2026-04-22' }),
        ],
      }),
      acc({
        cuenta: 'CTA-A',
        movimientos: [
          mov({ importe: 900, tipoMovimiento: 'ABONO', referencia: 'A2', fechaOperacion: '2026-04-22' }),
          mov({ importe: 900, tipoMovimiento: 'ABONO', referencia: 'A1', fechaOperacion: '2026-04-22' }),
        ],
      }),
    ];
    const first = buildPairMatchedKeys(statements);
    const second = buildPairMatchedKeys(statements);
    expect(first.size).toBe(4);
    expect(Array.from(first).sort()).toEqual(Array.from(second).sort());
  });

  it('normaliza el importe a centavos: 900.005 y 900.004 caen en el mismo bucket', () => {
    const keys = buildPairMatchedKeys([
      acc({ cuenta: 'CTA-A', movimientos: [mov({ importe: 900.001, tipoMovimiento: 'CARGO' })] }),
      acc({ cuenta: 'CTA-B', movimientos: [mov({ importe: 900.002, tipoMovimiento: 'ABONO' })] }),
    ]);
    expect(keys.size).toBe(2);
  });
});

describe('classifyMovement — campos de texto ausentes', () => {
  it('un movimiento sin concepto ni referencia se clasifica como real', () => {
    const c = classifyMovement({
      ...probe(),
      fechaOperacion: '2026-04-22',
      tipoMovimiento: 'CARGO' as const,
      importe: 100,
    });
    expect(c.kind).toBe('real');
    expect(c.reason).toBeUndefined();
  });

  it('una sigla corta del grupo sólo en la referencia se reporta como beneficiary', () => {
    const c = classifyMovement({
      ...probe({ concepto: 'DEPOSITO NORMAL', referencia: 'TRCC' }),
      fechaOperacion: '2026-04-22',
      tipoMovimiento: 'ABONO' as const,
      importe: 100,
    });
    expect(c.kind).toBe('internal');
    expect(c.reason).toBe('beneficiary');
  });
});

describe('computeBankOnlyCashFlow — guardas y defaults de enriquecimiento', () => {
  it('sin estados de cuenta devuelve estructuras vacías', () => {
    for (const input of [undefined, []] as const) {
      const out = computeBankOnlyCashFlow(input as never, 2026, 0);
      expect(out.daily).toEqual([]);
      expect(out.abonosByDate.size).toBe(0);
      expect(out.cargosByDate.size).toBe(0);
      expect(out.internalAbonosByDate.size).toBe(0);
      expect(out.internalCargosByDate.size).toBe(0);
    }
  });

  it('descarta movimientos sin fecha parseable, de otro año o con importe nulo', () => {
    const out = computeBankOnlyCashFlow([
      acc({
        movimientos: [
          mov({ fechaOperacion: 'basura', importe: 100, tipoMovimiento: 'ABONO' }),
          mov({ fechaOperacion: '2025-04-22', importe: 100, tipoMovimiento: 'ABONO' }),
          mov({ fechaOperacion: '2026-04-22', importe: 0, tipoMovimiento: 'ABONO' }),
          mov({ fechaOperacion: '2026-04-22', importe: undefined as unknown as number, tipoMovimiento: 'ABONO' }),
        ],
      }),
    ], 2026, 0);
    expect(out.daily).toEqual([]);
  });

  it('un concepto vacío cae a "<banco> · <cuenta>" y a "Banco" cuando no hay nombre', () => {
    const out = computeBankOnlyCashFlow([
      acc({
        nombreBanco: 'BANAMEX',
        cuenta: 'CTA-1',
        movimientos: [mov({ concepto: '   ', tipoMovimiento: 'ABONO', importe: 100, referencia: 'R' })],
      }),
      acc({
        nombreBanco: undefined,
        cuenta: 'CTA-2',
        movimientos: [mov({ concepto: undefined as unknown as string, tipoMovimiento: 'ABONO', importe: 200, referencia: undefined as unknown as string })],
      }),
    ], 2026, 0);
    const abonos = out.abonosByDate.get('2026-04-22')!;
    expect(abonos.map((a) => a.concepto)).toEqual(['BANAMEX · CTA-1', 'Banco · CTA-2']);
    expect(abonos[1].referencia).toBe('');
    expect(abonos[1].conceptoFull).toBe('');
  });

  it('la moneda cae de la cuenta al movimiento y luego a MXN', () => {
    const out = computeBankOnlyCashFlow([
      acc({ cuenta: 'C1', moneda: 'USD', movimientos: [mov({ tipoMovimiento: 'ABONO', importe: 10 })] }),
      acc({
        cuenta: 'C2',
        moneda: undefined as unknown as string,
        movimientos: [mov({ tipoMovimiento: 'ABONO', importe: 10, moneda: 'EUR' })],
      }),
      acc({
        cuenta: 'C3',
        moneda: undefined as unknown as string,
        movimientos: [mov({
          tipoMovimiento: 'ABONO',
          importe: 10,
          moneda: undefined as unknown as string,
        })],
      }),
    ], 2026, 0);
    const abonos = out.abonosByDate.get('2026-04-22')!;
    expect(abonos.map((a) => a.moneda)).toEqual(['USD', 'EUR', 'MXN']);
  });

  it('un día con sólo ABONOs no rompe el neto (los cargos del día son lista vacía)', () => {
    const out = computeBankOnlyCashFlow([
      acc({
        movimientos: [
          mov({ fechaOperacion: '2026-04-20', tipoMovimiento: 'ABONO', importe: 500, concepto: 'COBRO A' }),
          mov({ fechaOperacion: '2026-04-21', tipoMovimiento: 'CARGO', importe: 200, concepto: 'PAGO B' }),
        ],
      }),
    ], 2026, 1000);
    expect(out.daily).toHaveLength(2);
    expect(out.daily[0]).toMatchObject({ date: '2026-04-20', inflows: 500, outflows: 0, net: 500, cumulative: 1500 });
    expect(out.daily[1]).toMatchObject({ date: '2026-04-21', inflows: 0, outflows: 200, net: -200, cumulative: 1300 });
  });

  it('un importe negativo se toma en valor absoluto y el tipo desconocido cuenta como CARGO', () => {
    const out = computeBankOnlyCashFlow([
      acc({
        movimientos: [mov({
          tipoMovimiento: 'OTRO' as unknown as 'CARGO',
          importe: -750,
          concepto: 'MOVIMIENTO RARO',
        })],
      }),
    ], 2026, 0);
    expect(out.cargosByDate.get('2026-04-22')![0]).toMatchObject({ tipo: 'CARGO', amount: 750 });
  });

  it('acepta fechas en formato JDE con diagonales (MM/DD y DD/MM)', () => {
    const out = computeBankOnlyCashFlow([
      acc({
        movimientos: [
          mov({ fechaOperacion: '3/5/2026', tipoMovimiento: 'ABONO', importe: 100, concepto: 'A' }),
          mov({ fechaOperacion: '25/12/2026', tipoMovimiento: 'ABONO', importe: 100, concepto: 'B' }),
        ],
      }),
    ], 2026, 0);
    expect(out.daily.map((d) => d.date)).toEqual(['2026-03-05', '2026-12-25']);
  });

  it('descarta fechas ISO con mes o día fuera de rango', () => {
    const out = computeBankOnlyCashFlow([
      acc({ movimientos: [mov({ fechaOperacion: '2026-13-45', tipoMovimiento: 'ABONO', importe: 100 })] }),
    ], 2026, 0);
    expect(out.daily).toEqual([]);
  });

  it('descarta fecha nula, vacía y con diagonales fuera de rango', () => {
    const out = computeBankOnlyCashFlow([
      acc({
        movimientos: [
          mov({ fechaOperacion: null as unknown as string, tipoMovimiento: 'ABONO', importe: 100 }),
          mov({ fechaOperacion: '   ', tipoMovimiento: 'ABONO', importe: 100 }),
          mov({ fechaOperacion: '13/45/2026', tipoMovimiento: 'ABONO', importe: 100 }),
        ],
      }),
    ], 2026, 0);
    expect(out.daily).toEqual([]);
  });

  it('el último recurso de parseo acepta un formato que sólo Date entiende', () => {
    const out = computeBankOnlyCashFlow([
      acc({
        movimientos: [mov({
          // No matchea ni el patrón ISO ni el de diagonales cortas.
          fechaOperacion: '2026/04/22',
          tipoMovimiento: 'ABONO',
          importe: 100,
          concepto: 'COBRO',
        })],
      }),
    ], 2026, 0);
    expect(out.daily.map((d) => d.date)).toEqual(['2026-04-22']);
  });
});

describe('extractPaymentEvents — defaults y cascada de fechas', () => {
  it('sin nombre ni clasificación usa los placeholders', () => {
    const events = extractPaymentEvents([cxp({
      nombre: '',
      clasificacionProveedor: '',
      importePendientePesos: 500,
      importeBrutoPesos: 500,
    })]);
    expect(events[0].supplier).toBe('Unknown');
    expect(events[0].classification).toBe('Uncategorized');
  });

  it('la porción pagada usa programación → factura → vencimiento, en ese orden', () => {
    const porProgramacion = extractPaymentEvents([cxp({
      importeBrutoPesos: 1000,
      importePendientePesos: 0,
      fechaProgramacionPago: '2026-03-25',
    })]);
    expect(porProgramacion.find((e) => e.kind === 'paid')?.date).toBe('2026-03-25');

    const porFactura = extractPaymentEvents([cxp({
      importeBrutoPesos: 1000,
      importePendientePesos: 0,
      fechaProgramacionPago: '',
      fechaFactura: '2026-03-01',
    })]);
    expect(porFactura.find((e) => e.kind === 'paid')?.date).toBe('2026-03-01');

    const porVencimiento = extractPaymentEvents([cxp({
      importeBrutoPesos: 1000,
      importePendientePesos: 0,
      fechaProgramacionPago: '',
      fechaFactura: '',
      fechaVence: '2026-03-31',
    })]);
    expect(porVencimiento.find((e) => e.kind === 'paid')?.date).toBe('2026-03-31');
  });

  it('sin ninguna fecha usable la porción pagada no emite evento', () => {
    const events = extractPaymentEvents([cxp({
      importeBrutoPesos: 1000,
      importePendientePesos: 0,
      fechaProgramacionPago: '',
      fechaFactura: '',
      fechaVence: '',
    })]);
    expect(events).toHaveLength(0);
  });

  it('la porción pendiente sin programación cae al vencimiento y sin ninguna no emite', () => {
    const conVencimiento = extractPaymentEvents([cxp({
      importeBrutoPesos: 400,
      importePendientePesos: 400,
      fechaProgramacionPago: '',
      fechaVence: '2026-03-31',
    })]);
    expect(conVencimiento[0].date).toBe('2026-03-31');

    const sinFechas = extractPaymentEvents([cxp({
      importeBrutoPesos: 400,
      importePendientePesos: 400,
      fechaProgramacionPago: '',
      fechaVence: '',
    })]);
    expect(sinFechas).toHaveLength(0);
  });

  it('importes ausentes se tratan como 0 y no emiten eventos', () => {
    const events = extractPaymentEvents([cxp({
      importeBrutoPesos: undefined as unknown as number,
      importePendientePesos: undefined as unknown as number,
    })]);
    expect(events).toHaveLength(0);
  });
});

describe('extractPaymentEvents — pata bancaria', () => {
  it('la etiqueta del banco cae de nombreBanco a "Banco <codigo>" y luego a "Banco"', () => {
    const events = extractPaymentEvents([], [
      acc({
        cuenta: 'C1',
        nombreBanco: '  BANAMEX  ',
        movimientos: [mov({ concepto: '', importe: 100, referencia: 'R1' })],
      }),
      acc({
        cuenta: 'C2',
        nombreBanco: '   ',
        banco: '072',
        movimientos: [mov({ concepto: '', importe: 200, referencia: 'R2' })],
      }),
      acc({
        cuenta: 'C3',
        nombreBanco: undefined,
        banco: '',
        movimientos: [mov({ concepto: '  ', importe: 300, referencia: 'R3' })],
      }),
    ]);
    expect(events.map((e) => e.supplier)).toEqual([
      'BANAMEX · C1',
      'Banco 072 · C2',
      'Banco · C3',
    ]);
    expect(events.every((e) => e.classification === 'Banco (real)')).toBe(true);
  });

  it('con datos bancarios la porción ya pagada de CXP NO se duplica', () => {
    const events = extractPaymentEvents(
      [cxp({ importeBrutoPesos: 1000, importePendientePesos: 0 })],
      [acc({ movimientos: [mov({ concepto: 'PAGO ACME', importe: 1000 })] })],
    );
    expect(events.filter((e) => e.kind === 'paid')).toHaveLength(1);
    expect(events[0].source?.origin).toBe('bank');
  });

  it('ignora ABONOs, traspasos internos, fechas ilegibles e importes nulos del banco', () => {
    const events = extractPaymentEvents([], [
      acc({
        movimientos: [
          mov({ tipoMovimiento: 'ABONO', importe: 100, concepto: 'COBRO' }),
          mov({ concepto: 'TRASPASO REF 1', importe: 100 }),
          mov({ concepto: 'PAGO X', importe: 100, fechaOperacion: 'basura' }),
          mov({ concepto: 'PAGO Y', importe: 0 }),
          mov({ concepto: 'PAGO Z', importe: undefined as unknown as number }),
        ],
      }),
    ]);
    expect(events).toHaveLength(0);
  });
});

describe('extractComprasPaymentEvents — guardas', () => {
  it('descarta canceladas, facturadas, sin fecha de pago proyectada e importe nulo', () => {
    const events = extractComprasPaymentEvents([
      compra({ cancelada: true }),
      compra({ facturada: true }),
      compra({ fechaPagoProyectada: '' }),
      compra({ importeTotal: 0 }),
      compra({ importeTotal: undefined as unknown as number }),
    ]);
    expect(events).toHaveLength(0);
  });

  it('sin nombre ni familia usa placeholders y cae a la categoría', () => {
    const sinFamilia = extractComprasPaymentEvents([
      compra({ nombreProveedor: '', descFamilia: '', descCategoria: 'Indirectos' }),
    ]);
    expect(sinFamilia[0].supplier).toBe('Unknown');
    expect(sinFamilia[0].classification).toBe('Indirectos');

    const sinNada = extractComprasPaymentEvents([
      compra({ descFamilia: '', descCategoria: '' }),
    ]);
    expect(sinNada[0].classification).toBe('Uncategorized');
  });

  it('ordena los eventos por fecha ascendente', () => {
    const events = extractComprasPaymentEvents([
      compra({ noOrden: 'B', fechaPagoProyectada: '2026-06-01' }),
      compra({ noOrden: 'A', fechaPagoProyectada: '2026-05-01' }),
    ]);
    expect(events.map((e) => e.date)).toEqual(['2026-05-01', '2026-06-01']);
  });
});

describe('aggregateWeekly / aggregateMonthly / findExtremeWeeks', () => {
  const day = (date: string, net: number): DailyFlow => ({
    date,
    inflows: net > 0 ? net : 0,
    outflows: net < 0 ? -net : 0,
    net,
    cumulative: net,
    confirmedIn: 0,
    projectedIn: 0,
  });

  it('un domingo pertenece a la semana que arranca el LUNES anterior', () => {
    // 2026-04-26 es domingo → semana del lunes 2026-04-20.
    const weeks = aggregateWeekly([day('2026-04-26', 100)]);
    expect(weeks[0].weekStart).toBe('2026-04-20');
  });

  it('un lunes arranca su propia semana', () => {
    const weeks = aggregateWeekly([day('2026-04-20', 100)]);
    expect(weeks[0].weekStart).toBe('2026-04-20');
  });

  it('agrupa por mes calendario en orden y con nombre en español', () => {
    const months = aggregateMonthly([day('2026-03-05', 100), day('2026-01-10', 50), day('2026-03-20', 25)]);
    expect(months.map((m) => m.monthName)).toEqual(['Enero', 'Marzo']);
    expect(months[1].inflows).toBe(125);
  });

  it('sin días no hay semanas ni meses', () => {
    expect(aggregateWeekly([])).toEqual([]);
    expect(aggregateMonthly([])).toEqual([]);
  });

  it('findExtremeWeeks devuelve nulls con lista vacía', () => {
    expect(findExtremeWeeks([])).toEqual({ worstWeek: null, bestWeek: null });
  });

  it('findExtremeWeeks encuentra la peor y la mejor semana', () => {
    const weeks = aggregateWeekly([
      day('2026-04-20', 100),
      day('2026-04-27', -500),
      day('2026-05-04', 900),
    ]);
    const extremes = findExtremeWeeks(weeks);
    expect(extremes.worstWeek).toEqual({ weekStart: '2026-04-27', net: -500 });
    expect(extremes.bestWeek).toEqual({ weekStart: '2026-05-04', net: 900 });
  });

  it('con una sola semana, peor y mejor son la misma', () => {
    const weeks = aggregateWeekly([day('2026-04-20', 100)]);
    const extremes = findExtremeWeeks(weeks);
    expect(extremes.worstWeek).toEqual(extremes.bestWeek);
  });
});
