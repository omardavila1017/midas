/**
 * providerDerivation.branches.test.ts — cobertura de RAMAS del derivador de
 * proveedores. Hermano de `providerDerivation.test.ts` (que cubre los casos
 * de negocio principales); aquí se ejercitan los caminos condicionales que
 * quedaban muertos: overlay de score (todos los umbrales), placeholders de
 * clasificación, condPago, notación científica en la rama de merge, nombres
 * vacíos / "(NO USAR)", y los acumuladores sin señales.
 *
 * No toca código fuente. Cualquier aserción documenta el comportamiento REAL
 * observado del módulo.
 */
import { describe, expect, it } from 'vitest';
import {
  buildScoreOverlay,
  deriveProvidersFromJde,
  EMPLOYEE_PROVIDER_TYPE,
  type AgedRecordLike,
  type ScoreEntry,
} from './providerDerivation';
import type { ComprasRecord, PagoProveedorRecord } from '../services/jdeTypes';

function aged(patch: Partial<AgedRecordLike>): AgedRecordLike {
  return {
    noProveedor: '107671',
    nombre: 'PROVEEDOR DEMO',
    clasificacionProveedor: '',
    clasifica: '',
    importePendientePesos: 1000,
    fechaFactura: '2026-01-15',
    condPago: '30',
    ...patch,
  };
}

function pago(patch: Partial<PagoProveedorRecord>): PagoProveedorRecord {
  return {
    tipoPago: 'PT',
    noPago: 'P1',
    cia: '00011',
    nombreCia: 'CIA',
    cuentaBancaria: '',
    cuentaBanco: '',
    fechaPago: '2026-01-20',
    importePesos: 5000,
    moneda: 'MXP',
    batchPago: 'B1',
    claveProveedor: '200500',
    rfcProveedor: '',
    nombreProveedor: 'JUAN PEREZ',
    tipoBusqueda: '',
    clasificacionProveedor: '',
    clasificacionProveedorFinanciera: '',
    comentarioPago: '',
    ...patch,
  };
}

function compra(patch: Partial<ComprasRecord>): ComprasRecord {
  return {
    cia: '00001',
    noProveedor: '107671',
    nombreProveedor: 'PROVEEDOR DEMO',
    noOrden: '18889',
    tipoOrden: 'OS',
    descTipoOrden: 'Catalogadas almacén',
    lineaOrden: 1,
    noProducto: '500102003103',
    descProducto: 'Producto test',
    concepto: 'Concepto test',
    cantidad: 10,
    precioUnitario: 100,
    importeTotal: 1000,
    moneda: 'MXP',
    tipoCambio: 1,
    fechaPedido: '2026-03-04',
    fechaRecepcion: '2026-03-14',
    diasCredito: 45,
    fechaPagoProyectada: '2026-04-28',
    noFactura: '',
    centroCostos: '101',
    categoria: 'IND',
    descCategoria: 'Indirectos',
    familia: 'PLI',
    descFamilia: 'PRODUCTOS DE LIMPIEZA',
    subFamilia: 'QDA',
    descSubFamilia: 'QUÍMICOS DE LIMPIEZA',
    estadoSiguiente: '380',
    tasaFiscal: 'IVA16',
    cancelada: false,
    facturada: false,
    ...patch,
  };
}

function scoreEntry(patch: Partial<ScoreEntry>): ScoreEntry {
  return {
    numProveedor: '107671',
    nombre: 'PROVEEDOR DEMO',
    score: 90,
    ...patch,
  };
}

describe('buildScoreOverlay', () => {
  it('indexa por llave JDE y por nombre normalizado, conservando el PRIMER nombre', () => {
    const overlay = buildScoreOverlay([
      scoreEntry({ numProveedor: '107671', nombre: 'Proveedor Demo', score: 90 }),
      // Mismo nombre normalizado → NO pisa al primero (guard `!byName.has`).
      scoreEntry({ numProveedor: '999999', nombre: 'PROVEEDOR  DEMO', score: 10 }),
    ]);
    expect(overlay.byJde.get('107671')?.score).toBe(90);
    expect(overlay.byJde.get('999999')?.score).toBe(10);
    expect(overlay.byName.get('PROVEEDOR DEMO')?.score).toBe(90);
  });

  it('descarta entradas sin llave JDE ni nombre usable', () => {
    const overlay = buildScoreOverlay([
      scoreEntry({ numProveedor: '', nombre: '', score: 50 }),
    ]);
    expect(overlay.byJde.size).toBe(0);
    expect(overlay.byName.size).toBe(0);
  });
});

describe('deriveProvidersFromJde — umbrales de score → clasificación / flexibilidad / riesgo', () => {
  const cases: Array<{
    score: number;
    automatica: string;
    flexibility: string;
    risk: string;
  }> = [
    { score: 95, automatica: 'CRITICO', flexibility: 'inamovible', risk: 'Alto' },
    { score: 80, automatica: 'CRITICO', flexibility: 'inamovible', risk: 'Alto' },
    { score: 70, automatica: 'ALTO', flexibility: 'revisar', risk: 'Alto' },
    { score: 60, automatica: 'ALTO', flexibility: 'revisar', risk: 'Alto' },
    { score: 50, automatica: 'MEDIO', flexibility: 'revisar', risk: 'Medio' },
    { score: 40, automatica: 'MEDIO', flexibility: 'revisar', risk: 'Medio' },
    { score: 39, automatica: 'BAJO', flexibility: 'flexible', risk: 'Bajo' },
    { score: 0, automatica: 'BAJO', flexibility: 'flexible', risk: 'Bajo' },
  ];

  for (const c of cases) {
    it(`score ${c.score} → ${c.automatica} / ${c.flexibility} / ${c.risk}`, () => {
      const providers = deriveProvidersFromJde({
        agedBalanceRecords: [aged({ noProveedor: '107671' })],
        scoreOverlay: buildScoreOverlay([scoreEntry({ score: c.score })]),
      });
      expect(providers).toHaveLength(1);
      expect(providers[0].clasificacionAutomatica).toBe(c.automatica);
      expect(providers[0].flexibility).toBe(c.flexibility);
      expect(providers[0].risk).toBe(c.risk);
      expect(providers[0].score).toBe(c.score);
    });
  }

  it('score no finito (NaN) se trata como sin clasificación', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '107671' })],
      scoreOverlay: buildScoreOverlay([scoreEntry({ score: Number.NaN })]),
    });
    expect(providers[0].clasificacionAutomatica).toBeUndefined();
    expect(providers[0].flexibility).toBe('unknown');
    // Sin clasificación el riesgo por default es 'Medio' (no 'Bajo').
    expect(providers[0].risk).toBe('Medio');
  });

  it('overlay sin la llave JDE cruza por nombre normalizado y arrastra los campos de gasto', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '555000', nombre: 'Proveedor Demo' })],
      scoreOverlay: buildScoreOverlay([
        scoreEntry({
          numProveedor: '107671',
          nombre: 'PROVEEDOR DEMO',
          score: 65,
          scoreCriterios: {
            sustituibilidad: 4,
            impactoOperativo: 5,
            riesgoLegal: 2,
            diasCredito: 3,
          },
          frecuencia: 'MENSUAL',
          montoPromedioPago: 1234,
          numPagos2025: 12,
          montoTotal2025: 14808,
          gastoMinimoMensual: 1234,
        }),
      ]),
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].score).toBe(65);
    expect(providers[0].scoreCriterios?.impactoOperativo).toBe(5);
    expect(providers[0].frecuenciaHistorica).toBe('MENSUAL');
    expect(providers[0].montoPromedioPago).toBe(1234);
    expect(providers[0].numPagos2025).toBe(12);
    expect(providers[0].montoTotal2025).toBe(14808);
    expect(providers[0].gastoMinimoMensual).toBe(1234);
  });

  it('overlay presente pero sin match deja los campos de score/gasto en undefined', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '888777', nombre: 'OTRO PROVEEDOR SA' })],
      scoreOverlay: buildScoreOverlay([scoreEntry({})]),
    });
    expect(providers[0].score).toBeUndefined();
    expect(providers[0].scoreCriterios).toBeUndefined();
    expect(providers[0].frecuenciaHistorica).toBeUndefined();
    expect(providers[0].montoPromedioPago).toBeUndefined();
    expect(providers[0].numPagos2025).toBeUndefined();
    expect(providers[0].montoTotal2025).toBeUndefined();
    expect(providers[0].gastoMinimoMensual).toBeUndefined();
    expect(providers[0].clasificacionAlberto).toBe('SIN_CLASIFICAR');
  });

  it('entrada de overlay con score null → sin clasificación automática', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '107671' })],
      scoreOverlay: buildScoreOverlay([scoreEntry({ score: null })]),
    });
    expect(providers[0].score).toBeUndefined();
    expect(providers[0].clasificacionAutomatica).toBeUndefined();
  });
});

describe('deriveProvidersFromJde — selección de nombre y de señal de categoría', () => {
  it('penaliza los nombres marcados "(NO USAR)" frente a la variante limpia', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '107671', nombre: 'ACME SA DE CV (NO USAR)' })],
      pagoProveedorRecords: [pago({ claveProveedor: '107671', nombreProveedor: 'ACME SA' })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe('ACME SA');
  });

  it('sin ningún nombre usable cae al placeholder "Proveedor <num>"', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '404404', nombre: '   ' })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe('Proveedor 404404');
    expect(providers[0].type).toBe('Sin categoría');
  });

  it('compras (familia) gana sobre CXP y sobre pagoProveedor como señal de categoría', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '107671', clasificacionProveedor: 'DIESEL' })],
      comprasRecords: [compra({ noProveedor: '107671', descFamilia: 'LLANTAS' })],
      pagoProveedorRecords: [pago({
        claveProveedor: '107671',
        clasificacionProveedorFinanciera: '220 - Refacciones',
      })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].type).toBe('LLANTAS');
  });

  it('descarta placeholders "Por Clasificar" / "Sin clasificar" / "N/A" como señal', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({
        noProveedor: '107671',
        clasificacionProveedor: 'Por Clasificar',
        clasifica: 'SIN CLASIFICAR',
      })],
      pagoProveedorRecords: [pago({
        claveProveedor: '107671',
        clasificacionProveedor: 'N/A',
        clasificacionProveedorFinanciera: 'NA',
      })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].type).toBe('Sin categoría');
  });

  it('strip del prefijo numérico de clasificacionProveedorFinanciera', () => {
    const providers = deriveProvidersFromJde({
      pagoProveedorRecords: [pago({
        claveProveedor: '600100',
        clasificacionProveedorFinanciera: '220 - Refacciones',
      })],
    });
    expect(providers[0].type).toBe('Refacciones');
  });

  it('regla de negocio Busbud → categoría Federal aunque JDE mande otra cosa', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({
        noProveedor: '910001',
        nombre: 'BUSBUD INC',
        clasificacionProveedor: 'SERVICIOS DIGITALES',
      })],
    });
    expect(providers[0].type).toBe('Federal');
  });

  it('empleado detectado en la última pasada por señal de compras (no la ve el loop por fuente)', () => {
    const providers = deriveProvidersFromJde({
      comprasRecords: [compra({
        noProveedor: '770077',
        nombreProveedor: 'MARIA LOPEZ RUIZ',
        descFamilia: 'VALES DE DESPENSA',
        descCategoria: '',
      })],
    });
    expect(providers[0].isEmployee).toBe(true);
    expect(providers[0].type).toBe(EMPLOYEE_PROVIDER_TYPE);
  });
});

describe('deriveProvidersFromJde — registros descartados y campos ausentes', () => {
  it('descarta registros sin número de proveedor en las tres fuentes', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '' })],
      comprasRecords: [compra({ noProveedor: '   ' })],
      pagoProveedorRecords: [pago({ claveProveedor: '' })],
    });
    expect(providers).toHaveLength(0);
  });

  it('importes ausentes/NaN no rompen la acumulación de volumen', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({
        noProveedor: '107671',
        importePendientePesos: undefined as unknown as number,
      })],
      comprasRecords: [compra({
        noProveedor: '107671',
        importeTotal: undefined as unknown as number,
      })],
      pagoProveedorRecords: [pago({
        claveProveedor: '107671',
        importePesos: undefined as unknown as number,
      })],
    });
    expect(providers).toHaveLength(1);
  });

  it('sin fecha en ninguna fuente, lastUpdatedAt queda undefined', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '107671', fechaFactura: '' })],
    });
    expect(providers[0].lastUpdatedAt).toBeUndefined();
  });

  it('conserva la fecha MÁS RECIENTE de todas las fuentes', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [
        aged({ noProveedor: '107671', fechaFactura: '2026-02-01' }),
        aged({ noProveedor: '107671', fechaFactura: '2026-01-01' }),
      ],
      pagoProveedorRecords: [pago({ claveProveedor: '107671', fechaPago: '2026-03-09' })],
    });
    expect(providers[0].lastUpdatedAt).toBe('2026-03-09T00:00:00.000Z');
  });
});

describe('deriveProvidersFromJde — condPago → paymentPeriod', () => {
  const cases: Array<[string | undefined, string]> = [
    ['C', 'Contado'],
    ['CONTADO', 'Contado'],
    ['0', 'Contado'],
    ['15', '15 días'],
    ['7', '15 días'],
    ['30', '30 días'],
    ['45', '45 días'],
    ['60', '60 días'],
    ['120', '90 días'],
    // Sin condPago usable → default 30 días.
    ['', '30 días'],
    [undefined, '30 días'],
    ['XX', '30 días'],
  ];

  for (const [condPago, expected] of cases) {
    it(`condPago ${JSON.stringify(condPago)} → ${expected}`, () => {
      const providers = deriveProvidersFromJde({
        agedBalanceRecords: [aged({
          noProveedor: '107671',
          condPago: condPago as unknown as string,
        })],
      });
      expect(providers[0].paymentPeriod).toBe(expected);
    });
  }

  it('compras aporta diasCredito cuando CXP no dio pista numérica', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '107671', condPago: 'XX' })],
      comprasRecords: [compra({ noProveedor: '107671', diasCredito: 60 })],
    });
    expect(providers[0].paymentPeriod).toBe('60 días');
  });

  it('compras con diasCredito 0 NO fija la pista (queda el default)', () => {
    const providers = deriveProvidersFromJde({
      comprasRecords: [compra({ noProveedor: '881122', diasCredito: 0 })],
    });
    expect(providers[0].paymentPeriod).toBe('30 días');
  });

  it('la primera pista numérica gana: un segundo CXP no la reemplaza', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [
        aged({ noProveedor: '107671', condPago: '15' }),
        aged({ noProveedor: '107671', condPago: '90' }),
      ],
    });
    expect(providers[0].paymentPeriod).toBe('15 días');
  });
});

describe('deriveProvidersFromJde — merge de llaves científicas (ramas del merge)', () => {
  it('el registro íntegro que llega DESPUÉS del científico repara numProveedor y limpia lossyKey', () => {
    const providers = deriveProvidersFromJde({
      // Ambos normalizan a la MISMA llave (52783500): el científico primero.
      pagoProveedorRecords: [
        pago({ claveProveedor: '5.27835e+007', nombreProveedor: 'ACME SA' }),
        pago({ claveProveedor: '52783500', nombreProveedor: 'ACME SA' }),
      ],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].numProveedorJDE).toBe('52783500');
  });

  it('el merge arrastra empleado, fecha más reciente y pista de crédito al destino', () => {
    const providers = deriveProvidersFromJde({
      // Destino íntegro sin condPago numérico ni empleado.
      agedBalanceRecords: [aged({
        noProveedor: '52783473',
        nombre: 'ALMA ROSA CHAVES',
        condPago: 'XX',
        fechaFactura: '2026-01-01',
      })],
      // Origen científico: empleado, fecha posterior.
      pagoProveedorRecords: [pago({
        claveProveedor: '5.27835e+007',
        nombreProveedor: 'ALMA ROSA CHAVES',
        tipoBusqueda: 'Employees',
        fechaPago: '2026-06-30',
      })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].isEmployee).toBe(true);
    expect(providers[0].lastUpdatedAt).toBe('2026-06-30T00:00:00.000Z');
  });

  it('el merge NO pisa la pista de crédito ni la fecha del destino cuando el destino ya las tiene', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({
        noProveedor: '52783473',
        nombre: 'ALMA ROSA CHAVES',
        condPago: '15',
        fechaFactura: '2026-09-30',
      })],
      pagoProveedorRecords: [pago({
        claveProveedor: '5.27835e+007',
        nombreProveedor: 'ALMA ROSA CHAVES',
        fechaPago: '2026-02-01',
      })],
    });
    expect(providers).toHaveLength(1);
    expect(providers[0].paymentPeriod).toBe('15 días');
    expect(providers[0].lastUpdatedAt).toBe('2026-09-30T00:00:00.000Z');
  });

  it('un acumulador científico sin ningún nombre normalizable no se fusiona', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [aged({ noProveedor: '52783473', nombre: 'ALMA ROSA CHAVES' })],
      pagoProveedorRecords: [pago({
        claveProveedor: '5.27835e+007',
        nombreProveedor: '',
      })],
    });
    expect(providers).toHaveLength(2);
  });

  it('sin ningún acumulador científico el merge es no-op', () => {
    const providers = deriveProvidersFromJde({
      agedBalanceRecords: [
        aged({ noProveedor: '100001', nombre: 'UNO SA' }),
        aged({ noProveedor: '100002', nombre: 'DOS SA' }),
      ],
    });
    expect(providers.map((p) => p.name)).toEqual(['DOS SA', 'UNO SA']);
  });
});
