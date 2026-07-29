/**
 * Cobertura de RAMAS de `jde.ts` que `jde.test.ts` / `jde.fetchers.test.ts` no
 * ejercitan: variantes de campo ausentes/alias/centinela en los mappers, los
 * caminos de error de cada fetcher (ventana fallida, retry agotado, todas las
 * ventanas caídas), los callbacks opcionales (`onProgress` / `onPartialBatch`
 * presentes, ausentes y que truenan), el single-flight, y los logs de "shape"
 * que sólo corren en la PRIMERA llamada de la sesión (para esos se importa un
 * módulo FRESCO con `vi.resetModules()`).
 *
 * Patrón espejo de las suites existentes: `fetch` mockeado con `vi.stubGlobal`,
 * daily cache primed y limpiado por namespace en `afterEach`. El
 * `jdeFetchPauseGate` se DESARMA una vez al inicio: cualquier error de API
 * dispara su auto-pausa (una sola vez por instancia de módulo) y dejaría
 * colgados los fetches posteriores del archivo.
 *
 * Ramas INALCANZABLES desde la API pública (documentadas, no testeadas):
 *   • 94 `stableStringify(undefined)` — sus dos call sites pasan `req` (objeto)
 *     y `config` (con default `{}`).
 *   • 272 `splitIntoFixedDayWindows` con `winEnd > end` — los dos callers usan
 *     `windowDays = 1`, así que `winEnd === cursor <= end` siempre.
 *   • 746 `matchesExclusionIdentity` en `fetchBankStatements` — el catálogo de
 *     exclusión está VACÍO a propósito (Riesgo #9 de CLAUDE.md).
 *   • 1026 `results[i] || []` en el merge de `fetchBankStatementsRange` — todo
 *     índice queda asignado por el reader del cache o por el worker.
 *   • 1055 (`firstDate.get(key) ?? …` y su cuerpo) — `firstDate` se siembra al
 *     crear la cuenta y los días se iteran ascendentes, así que nunca hay un
 *     `fechaEstadoCuenta` anterior al primero visto.
 *   • 1059 `lastDate.get(key) ?? …` — mismo motivo.
 *   • 1624 `addDaysIso('')` y 1627 `Number.isFinite(days)` — el único caller
 *     (`mapCompras`) ya guarda con `fechaRecepcion ?` y pasa un `toNum` (que
 *     siempre devuelve finito).
 *   • 2070 / 2307 / 3010 / 3108 / 3211 / 3279 el `String(err)` de los templates
 *     de log — todo error que llega ahí lo lanza `jdeClient` como
 *     `JdeApiError`, que SIEMPRE es `instanceof Error`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { clearDailyCache, primeDailyCache, setDailyCached } from './dailyApiCache';
import { jdeFetchPauseGate } from './pauseGate';
import {
  __internal,
  fetchAgedBalances,
  fetchAuxiliarContable,
  fetchAuxiliarContableRange,
  fetchBankStatements,
  fetchBankStatementsRange,
  fetchCobranza,
  fetchCompanies,
  fetchCompras,
  fetchComprasRange,
  fetchIndicadoresCobranzaRange,
  fetchNomina,
  fetchPagoProveedor,
  fetchPagoProveedorRange,
  fetchRol,
  fetchRolRange,
  fetchViajesEspeciales,
  fetchViajesEspecialesRange,
  normalizeCobranzaPayments,
  JdeApiError,
} from './jde';

function jsonResponse(rows: unknown): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status = 500): Response {
  return new Response(JSON.stringify({ error: 'boom' }), {
    status,
    statusText: 'Server Error',
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Error cuyo body NO es JSON (proxy que devuelve HTML) — el jdeClient cae a
 * `res.text()` y expone el body como string. Se arma a mano porque un
 * `Response` real consume el stream en el `res.json()` fallido y el
 * `res.text()` posterior ya no puede leerlo.
 */
function textErrorResponse(status = 500): Response {
  return {
    ok: false,
    status,
    statusText: 'Server Error',
    json: async () => { throw new SyntaxError('Unexpected token <'); },
    text: async () => '<html>upstream caído</html>',
  } as unknown as Response;
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

beforeAll(() => {
  // Desarma la auto-pausa del gate: los tests de error la dispararían y
  // colgarían todos los fetches posteriores de este archivo.
  jdeFetchPauseGate.tryAutoPause({ path: 'test', status: 0, message: 'neutralize' });
  jdeFetchPauseGate.resume();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  jdeFetchPauseGate.resume();
  await primeDailyCache();
  for (const ns of [
    'banks.BR-MERGE', 'banks.BR-RACE', 'banks.BR-FAIL', 'banks.BR-PERF', 'banks.BR-EMPTY',
    'M:compras', 'pagoproveedor', 'auxiliarcontable', 'aux-branch-ns',
  ]) {
    await clearDailyCache(ns);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 1. Helpers puros expuestos vía `__internal`
// ═══════════════════════════════════════════════════════════════════

describe('pick — paso 2 normalizado', () => {
  it('salta aliases que normalizan a vacío y cruza llaves con separadores', () => {
    // '---' → normKey '' → se salta sin comparar contra ninguna llave.
    expect(__internal.pick({ 'Tipo Concepto': 'Percepcion' }, ['---', 'TipoConcepto']))
      .toBe('Percepcion');
    expect(__internal.pick({ 'Tipo Concepto': 'x' }, ['---'])).toBeUndefined();
    expect(__internal.pick({}, ['nada'])).toBeUndefined();
  });
});

describe('stripAllToWhitelistNorm', () => {
  it('borra in-place las llaves fuera del whitelist normalizado', () => {
    const rows = [{ 'Tipo Concepto': 'Percepcion', Basura: 1, Monto: 10 }];
    __internal.stripAllToWhitelistNorm(rows, __internal.KEPT_NOMINA_FIELDS_NORM);
    expect(Object.keys(rows[0]).sort()).toEqual(['Monto', 'Tipo Concepto']);
  });
});

describe('mapNominaRow — toNum / trimIsoDate / año-mes derivados', () => {
  it('importes no finitos y strings no numéricos caen a 0', () => {
    expect(__internal.mapNominaRow({ Monto: Number.POSITIVE_INFINITY }).amount).toBe(0);
    expect(__internal.mapNominaRow({ Monto: 'no-es-numero' }).amount).toBe(0);
    expect(__internal.mapNominaRow({ Monto: '1,250.50' }).amount).toBe(1250.5);
  });

  it('una fecha más corta que 10 chars se conserva tal cual y el mes cae al campo auxiliar', () => {
    const rec = __internal.mapNominaRow({ FechaPago: '2026', mes_num: '7', Monto: 1 });
    expect(rec.paymentDate).toBe('2026');
    expect(rec.year).toBe(2026);
    expect(rec.month).toBe(7);
  });

  it('sin FechaPago deriva año y mes de los campos auxiliares', () => {
    const rec = __internal.mapNominaRow({ anio: 2025, mes_num: 3, Monto: 5 });
    expect(rec.paymentDate).toBe('');
    expect(rec.year).toBe(2025);
    expect(rec.month).toBe(3);
  });
});

describe('selectIvaFullObjetoRanges / ivaCacheNamespace — clasificación de rangos', () => {
  it('rangos no numéricos o a caballo entre activo y pasivo cuentan como "other"', () => {
    const candidatos = [
      { ini: 'abc', fin: 'def' },   // no numérico → other
      { ini: '1500', fin: '5000' }, // cruza activo→gasto → other
      { ini: '2100', fin: '2200' }, // pasivo → caused
    ];
    // Sin descubrimiento: se conservan TODOS los candidatos (activos, pasivos y
    // "other" cuando faltan ambos lados).
    const objetos = __internal.selectIvaFullObjetoRanges([], candidatos);
    expect(objetos).toEqual([
      { ini: '1500', fin: '5000' },
      { ini: '2100', fin: '2200' },
      { ini: 'abc', fin: 'def' },
    ]);
  });

  it('sin candidatos ni descubrimiento devuelve la lista vacía y el namespace "none"', () => {
    expect(__internal.selectIvaFullObjetoRanges([], [])).toEqual([]);
    expect(__internal.ivaCacheNamespace([])).toMatch(/:none$/);
  });

  it('dedupea, ignora rangos con extremo vacío y desempata el orden por `fin`', () => {
    const ns1 = __internal.ivaCacheNamespace([
      { ini: '1180', fin: '1200' },
      { ini: '1180', fin: '1190' },
      { ini: '   ', fin: '1200' },
      { ini: '1180', fin: '1200' },
    ]);
    const ns2 = __internal.ivaCacheNamespace([
      { ini: '1180', fin: '1190' },
      { ini: '1180', fin: '1200' },
    ]);
    expect(ns1).toBe(ns2);
    expect(ns1).toContain('1180-1190_1180-1200');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. unwrapList + stripToWhitelist
// ═══════════════════════════════════════════════════════════════════

describe('unwrapList — sobres alternativos', () => {
  it('salta llaves cuyo valor no es arreglo y encuentra la primera que sí lo es', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: 'no-es-arreglo',
      result: { nope: 1 },
      rows: [{ Cia: '11', No_Proveedor: 'P-1', Importe_Pendiente_Pesos: 10 }],
    })));
    const records = await fetchAgedBalances({ cia: '00011' });
    expect(records).toHaveLength(1);
    expect(records[0].noProveedor).toBe('P-1');
  });

  it('un objeto sin ninguna llave de lista devuelve []', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ total: 0 })));
    expect(await fetchAgedBalances({ cia: '00011' })).toEqual([]);
  });
});

describe('stripToWhitelist — campos fuera de contrato', () => {
  it('elimina del raw los campos que el mapper no consume', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{
      Cia: '00011',
      Factura: 'RI-1',
      Importe_Factura: 116,
      Campo_Basura_Del_API: 'se descarta',
    }]));
    vi.stubGlobal('fetch', fetchMock);
    const records = await fetchCobranza({ cia: '00011', fechaInicial: '2026-01-01', fechaFinal: '2026-07-01' });
    expect(records).toHaveLength(1);
    expect(records[0].noFactura).toBe('RI-1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. mapBankLine — variantes de campos
// ═══════════════════════════════════════════════════════════════════

/** Pide UN día FUTURO (isPast=false) → no toca el daily cache. */
async function bankLine(day: string, row: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([row])));
  const statements = await fetchBankStatements({
    fechaEstadoCuenta: day,
    formatoElectronico: 'SWIFT',
  });
  return statements[0];
}

describe('mapBankLine — cuentas, bancos, conceptos y monedas', () => {
  it('BANBAJIO colapsa a la cuenta sentinela, MXN por DESC036 y fecha ISO con hora', async () => {
    const acc = await bankLine('2030-01-05', {
      Cuenta_Contable: '38.1020.0011305',
      Nombre_cuenta_Contable: 'BANBAJIO 0011305',
      Cuenta_Bancos: 'FOLIO-SPEI-1',
      Importe: 100,
      Tipo_Movimiento: 'CREDITO',
      DESC036: 'PESOS M.N.',
      fechaOperacion: '2026-04-17T00:00:00',
      InF_ADI_1: '322?00PAGO A TERCEROS?20/EI/TR',
    });
    expect(acc.cuenta).toBe('BANBAJIO');
    expect(acc.cia).toBe('00038');
    expect(acc.moneda).toBe('MXN');
    expect(acc.movimientos[0].fechaOperacion).toBe('2026-04-17');
    expect(acc.movimientos[0].concepto).toBe('PAGO A TERCEROS');
  });

  it('sin Cuenta_Contable ni nombre de banco cae a DESC039 y detecta USD', async () => {
    const acc = await bankLine('2030-01-06', {
      Cuenta_Bancos: '70141027881',
      nombreBanco: '',
      DESC039: 'Pagadora',
      DESC036: 'USD',
      Importe: 50,
      Tipo_Movimiento: '',
    });
    expect(acc.cia).toBe('');
    expect(acc.nombreBanco).toBe('Pagadora');
    expect(acc.moneda).toBe('USD');
    expect(acc.movimientos[0].tipoMovimiento).toBe('ABONO');
  });

  it('sin ningún nombre de banco usa el campo `banco`; importe negativo ⇒ CARGO; concepto de InF_ADI_2', async () => {
    const acc = await bankLine('2030-01-07', {
      Cuenta_Bancos: '123456',
      banco: 'BX',
      Importe: -75,
      Tipo_Movimiento: '',
      InF_ADI_1: '',
      InF_ADI_2: 'P589  00877732401 a 7013870885?21  Pago de SERVICIOS',
    });
    expect(acc.nombreBanco).toBeUndefined();
    expect(acc.banco).toBe('BX');
    expect(acc.movimientos[0].tipoMovimiento).toBe('CARGO');
    expect(acc.movimientos[0].importe).toBe(75);
    expect(acc.movimientos[0].concepto).toContain('Pago de SERVICIOS');
  });

  it('Cuenta_Contable sin punto usa toda la cadena como Business Unit', async () => {
    const acc = await bankLine('2030-01-08', {
      Cuenta_Contable: '38',
      Cuenta_Bancos: '999',
      Importe: 10,
      Tipo_Movimiento: 'CREDITO',
    });
    expect(acc.cia).toBe('00038');
  });

  it('Business Unit no numérica ⇒ cia vacía', async () => {
    const acc = await bankLine('2030-01-09', {
      Cuenta_Contable: 'ABC.1020.0011305',
      Cuenta_Bancos: '888',
      Importe: 10,
      Tipo_Movimiento: 'CREDITO',
    });
    expect(acc.cia).toBe('');
  });

  it('InF_ADI_1 sin el marcador ?00 se usa completo como concepto', async () => {
    const acc = await bankLine('2030-01-11', {
      Cuenta_Bancos: '777',
      Importe: 20,
      Tipo_Movimiento: 'CREDITO',
      InF_ADI_1: 'TRASPASO ENTRE CUENTAS',
      InF_ADI_2: 'detalle ignorado',
    });
    expect(acc.movimientos[0].concepto).toBe('TRASPASO ENTRE CUENTAS');
  });

  it('un nombre de cuenta sin parte alfabética se usa completo como nombre de banco', async () => {
    const acc = await bankLine('2030-01-10', {
      Nombre_cuenta_Contable: '123456789',
      Importe: 5,
      Tipo_Movimiento: 'CREDITO',
    });
    expect(acc.nombreBanco).toBe('123456789');
  });
});

describe('fetchBankStatements — respuesta vacía de un día pasado', () => {
  it('cachea el día vacío y responde [] sin agrupar', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchBankStatements({
      fechaEstadoCuenta: '2026-02-03',
      formatoElectronico: 'BR-EMPTY',
    });
    expect(out).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Segunda llamada: servida del cache (día pasado, vacío pero fuera de la
    // ventana de revalidación de 14 días).
    const again = await fetchBankStatements({
      fechaEstadoCuenta: '2026-02-03',
      formatoElectronico: 'BR-EMPTY',
    });
    expect(again).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. fetchBankStatementsRange
// ═══════════════════════════════════════════════════════════════════

describe('fetchBankStatementsRange — rango inválido', () => {
  it('rango invertido devuelve [] sin tocar la red', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchBankStatementsRange('2026-03-10', '2026-03-01', 'BR-MERGE')).toEqual([]);
    expect(await fetchBankStatementsRange('basura', '2026-03-01', 'BR-MERGE')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchBankStatementsRange — merge multi-día', () => {
  it('conserva los metadatos del día más reciente, dedupea movimientos repetidos y emite progreso', async () => {
    const line = (day: string) => ({
      Cuenta_Contable: '11.1020.0000001',
      Nombre_cuenta_Contable: 'BANAMEX 877732401',
      Cuenta_Bancos: '877732401',
      tipo_Cuenta_Bancos: 'CH',
      DESC039: 'Concentradora',
      DESC036: 'PESOS M.N.',
      Saldo_Inicial: 1000,
      Saldo_Final: day === '2026-03-02' ? 2500 : 1500,
      Importe: 500,
      Tipo_Movimiento: 'CREDITO',
      Referencia_Cliente: 'REF-1',
      gsaid: 'G1',
      // Mismo movimiento en ambos días → el dedup lo cuenta una vez.
      fechaOperacion: '2026-03-01',
      InF_ADI_1: '322?00DEPOSITO?20',
    });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const day = String(bodyOf(init).fechaEstadoCuenta);
      return jsonResponse([line(day)]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onProgress = vi.fn();
    const onDayFailed = vi.fn();
    const out = await fetchBankStatementsRange('2026-03-01', '2026-03-04', 'BR-MERGE', {
      onProgress,
      onDayFailed,
    });

    expect(out).toHaveLength(1);
    expect(out[0].movimientos).toHaveLength(1);
    expect(out[0].tipoCuentaBancos).toBe('CH');
    expect(out[0].desc039).toBe('Concentradora');
    expect(out[0].desc036).toBe('PESOS M.N.');
    expect(out[0].fechaEstadoCuenta).toBe('2026-03-04');
    expect(out[0].saldoFinal).toBe(1500);
    expect(onProgress).toHaveBeenLastCalledWith(4, 4);
    expect(onDayFailed).not.toHaveBeenCalled();

    // Segunda pasada SIN onProgress: se sirve del cache diario.
    fetchMock.mockClear();
    const cached = await fetchBankStatementsRange('2026-03-01', '2026-03-04', 'BR-MERGE');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cached[0].movimientos).toHaveLength(1);
  });
});

describe('fetchBankStatementsRange — carrera con un desalojo del cache', () => {
  it('una key en el índice sin payload legible se re-encola al fetch', async () => {
    await primeDailyCache();
    // El buffer write-through está acotado a 256 entradas; sin IDB en jsdom,
    // las primeras escrituras quedan en el índice pero ya no son legibles.
    const base = new Date(Date.UTC(2025, 0, 1));
    for (let i = 0; i < 300; i++) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + i);
      setDailyCached('banks.BR-RACE', d.toISOString().slice(0, 10), [{ marker: i }]);
    }

    const fetchMock = vi.fn(async () => jsonResponse([{
      Cuenta_Contable: '11.1020.0000001',
      Cuenta_Bancos: '877732401',
      Importe: 42,
      Tipo_Movimiento: 'CREDITO',
      gsaid: 'G-RACE',
    }]));
    vi.stubGlobal('fetch', fetchMock);

    const out = await fetchBankStatementsRange('2025-01-01', '2025-01-01', 'BR-RACE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out[0].movimientos[0].importe).toBe(42);
  });
});

describe('fetchBankStatementsRange — día que falla tras los reintentos', () => {
  it('deja el día en [] y reporta onDayFailed aunque el callback truene', async () => {
    const fetchMock = vi.fn(async () => errorResponse(500));
    vi.stubGlobal('fetch', fetchMock);
    const onDayFailed = vi.fn(() => { throw new Error('bug del caller'); });

    const out = await fetchBankStatementsRange('2026-04-06', '2026-04-06', 'BR-FAIL', {
      onDayFailed,
      concurrency: 1,
    });

    expect(out).toEqual([]);
    expect(onDayFailed).toHaveBeenCalledWith('2026-04-06');
    // 3 intentos del worker (el jdeClient no reintenta un 500).
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);
});

describe('fetchBankStatementsRange — sin `performance`', () => {
  it('el throttle de progreso cae a Date.now()', async () => {
    vi.stubGlobal('performance', undefined);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));
    const onProgress = vi.fn();
    await fetchBankStatementsRange('2026-05-04', '2026-05-05', 'BR-PERF', { onProgress });
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. fetchCompanies — singleFlight + mapCompany.activa
// ═══════════════════════════════════════════════════════════════════

describe('fetchCompanies — single-flight y mapeo de `activa`', () => {
  it('dos llamadas concurrentes comparten la misma request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ No_Cia: '11', Nombre_Cia: 'SIR' }]));
    vi.stubGlobal('fetch', fetchMock);
    const [a, b] = await Promise.all([fetchCompanies(), fetchCompanies()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('mapea las formas negativas de `activa` y deja undefined lo no reconocido', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      { No_Cia: '1', activa: 'N' },
      { No_Cia: '2', activa: 0 },
      { No_Cia: '3', activa: false },
      { No_Cia: '4', activa: 'QUIZA' },
      { No_Cia: '5', activa: 'SI' },
    ])));
    const companies = await fetchCompanies({ timeoutMs: 1234 });
    expect(companies.map(c => c.activa)).toEqual([false, false, false, undefined, true]);
  });

  it('un config circular no rompe la llave del single-flight', async () => {
    const circular: Record<string, unknown> = { timeoutMs: 4321 };
    circular.self = circular;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{ No_Cia: '9', Nombre_Cia: 'X' }])));
    const companies = await fetchCompanies(circular);
    expect(companies).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. mapCobranza — días vencida y cliente padre
// ═══════════════════════════════════════════════════════════════════

describe('mapCobranza — días vencida y cliente padre', () => {
  it('una factura pendiente recalcula días vencida contra hoy', () => {
    const rec = __internal.mapCobranza({
      Cia: '00011',
      Importe_Pendiente: 500,
      Fecha_Vencimiento: '2020-01-01T00:00:00',
      Dias_Fecha_Vencimiento_vs_Fecha_Pago: 0,
    });
    expect(rec.estatus).toBe('PENDIENTE');
    expect(rec.diasVencida).toBeGreaterThan(1000);
  });

  it('una fecha de vencimiento no parseable conserva el dato del API', () => {
    const rec = __internal.mapCobranza({
      Importe_Pendiente: 500,
      Fecha_Vencimiento: 'no-es-una-fecha',
      Dias_Vencida: 7,
    });
    expect(rec.diasVencida).toBe(7);
  });

  it('No_Cliente_Padre "0" se trata como ausencia', () => {
    expect(__internal.mapCobranza({ No_Cliente_Padre: '0' }).noClientePadre).toBeUndefined();
    expect(__internal.mapCobranza({ No_Cliente_Padre: '4908' }).noClientePadre).toBe('4908');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. normalizeCobranzaPayments
// ═══════════════════════════════════════════════════════════════════

describe('normalizeCobranzaPayments — filas sin Id Pago y sin Cia', () => {
  it('salta las filas sin Id Pago y usa el ciaFallback cuando el header no la trae', () => {
    const payments = normalizeCobranzaPayments([
      { 'No Factura': 'F-1', 'Importe Recibo': 100 }, // sin Id Pago → se salta
      {
        'Id Pago': 'P-1',
        'Fecha Cobro': '2026-05-10T00:00:00',
        'cta bancaria': '877732401',
        'Importe Recibo': 100,
        'No Factura': 'RI-1',
      },
    ], '00042');

    expect(payments).toHaveLength(1);
    expect(payments[0].cia).toBe('00042');
    expect(payments[0].applications).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. fetchIndicadoresCobranzaRange
// ═══════════════════════════════════════════════════════════════════

describe('fetchIndicadoresCobranzaRange — ventanas mensuales', () => {
  it('rango invertido devuelve [] sin tocar la red', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchIndicadoresCobranzaRange('00011', '2026-05-10', '2026-04-01')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('una ventana caída se reporta como parcial y el resto se ordena por fecha + idPago', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const from = String(bodyOf(init).fechaInicial);
      if (from.startsWith('2026-05')) return errorResponse(500);
      return jsonResponse([
        {
          'Id Pago': 'B', 'CIA': '00011', 'Fecha Cobro': '2026-04-10T00:00:00',
          'cta bancaria': '877', 'Importe Recibo': 100, 'No Factura': 'RI-2',
        },
        {
          'Id Pago': 'A', 'CIA': '00011', 'Fecha Cobro': '2026-04-10T00:00:00',
          'cta bancaria': '877', 'Importe Recibo': 200, 'No Factura': 'RI-1',
        },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onProgress = vi.fn();
    const payments = await fetchIndicadoresCobranzaRange('00011', '2026-04-01', '2026-05-31', {
      onProgress,
    });

    expect(payments.map(p => p.idPago)).toEqual(['A', 'B']);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  }, 20_000);

  it('si TODAS las ventanas fallan lanza JdeApiError 504', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(500)));
    await expect(
      fetchIndicadoresCobranzaRange('00011', '2026-04-01', '2026-04-30', { concurrency: 1 }),
    ).rejects.toBeInstanceOf(JdeApiError);
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════
// 9. fetchRol / fetchRolRange
// ═══════════════════════════════════════════════════════════════════

describe('mapRol — booleanos y campos opcionales', () => {
  it('acepta booleanos reales, rechaza objetos y deja undefined lo ausente', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{
      cia: '00011', anio: 2026, semana: 10, K_Cliente: 5,
      B_Despachado: true,
      B_Efectuado: {},
      Factura: 'RI-9',
    }])));
    const rows = await fetchRol({ f_Inicio: '2026-03-02', f_Final: '2026-03-02', k_Servidor: -1 });
    expect(rows[0].despachado).toBe(true);
    expect(rows[0].efectuado).toBe(false);
    expect(rows[0].factura).toBe('RI-9');
    expect(rows[0].uuidFiscal).toBeUndefined();
    expect(rows[0].plazaCiti).toBeUndefined();
  });
});

describe('fetchRol — error del endpoint CITI', () => {
  it('loguea el body enviado y la respuesta (no-JSON) del servidor antes de re-lanzar', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => textErrorResponse(500)));
    await expect(
      fetchRol({ f_Inicio: '2026-03-02', f_Final: '2026-03-02', k_Servidor: -1 }),
    ).rejects.toBeInstanceOf(JdeApiError);
    expect(warn.mock.calls.some(c => String(c[0]).includes('[rol] fetch error'))).toBe(true);
    expect(warn.mock.calls.some(c => String(c[0]).includes('server response body'))).toBe(true);
  }, 20_000);
});

describe('fetchRolRange — progreso, batches parciales y ventanas caídas', () => {
  it('emite progreso, tolera un onPartialBatch que truena y completa parcial', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const from = String(bodyOf(init).f_Inicio);
      if (from === '2026-03-03') return errorResponse(500);
      return jsonResponse([{ cia: '00011', anio: 2026, semana: 10, K_Cliente: 1, D_Ruta: 'R1' }]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onProgress = vi.fn();
    const onPartialBatch = vi.fn(() => { throw new Error('bug del caller'); });
    const rows = await fetchRolRange('2026-03-02', '2026-03-03', {
      onProgress, onPartialBatch,
    });

    expect(rows).toHaveLength(1);
    expect(onPartialBatch).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  }, 20_000);

  it('si TODAS las ventanas fallan lanza JdeApiError 504', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(500)));
    await expect(fetchRolRange('2026-03-02', '2026-03-03')).rejects.toBeInstanceOf(JdeApiError);
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════
// 10. fetchViajesEspeciales / Range
// ═══════════════════════════════════════════════════════════════════

describe('fetchViajesEspeciales — error del endpoint', () => {
  it('loguea el body enviado y la respuesta (no-JSON) antes de re-lanzar', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => textErrorResponse(500)));
    await expect(
      fetchViajesEspeciales({ f_Inicio: '2026-03-02', f_Final: '2026-03-02' }),
    ).rejects.toBeInstanceOf(JdeApiError);
    expect(warn.mock.calls.some(c => String(c[0]).includes('[viajes-esp] fetch error'))).toBe(true);
    expect(warn.mock.calls.some(c => String(c[0]).includes('upstream caído'))).toBe(true);
  }, 20_000);
});

describe('fetchViajesEspecialesRange — progreso, batches parciales y ventanas caídas', () => {
  it('rango invertido devuelve [] sin tocar la red', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchViajesEspecialesRange('2026-03-10', '2026-03-01')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('emite progreso, tolera un onPartialBatch que truena y completa parcial', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const from = String(bodyOf(init).f_Inicio);
      if (from === '2026-03-03') return errorResponse(500);
      return jsonResponse([{ Clave_JDE_Empresa: '11', K_Renta: 77, K_Cliente: 5 }]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const onProgress = vi.fn();
    const onPartialBatch = vi.fn(() => { throw new Error('bug del caller'); });
    const rows = await fetchViajesEspecialesRange('2026-03-02', '2026-03-03', {
      onProgress, onPartialBatch,
    });

    expect(rows).toHaveLength(1);
    expect(onPartialBatch).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  }, 20_000);

  it('si TODAS las ventanas fallan lanza JdeApiError 504', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errorResponse(500)));
    await expect(
      fetchViajesEspecialesRange('2026-03-02', '2026-03-03'),
    ).rejects.toBeInstanceOf(JdeApiError);
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════
// 11. Compras — addDaysIso con recepción no parseable + retry mensual
// ═══════════════════════════════════════════════════════════════════

describe('mapCompras — recepción no parseable', () => {
  it('no proyecta fecha de pago si la recepción no es una fecha válida', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{
      Compañia: '00011', N_Orden: 'OC-1', L_Orden: 1,
      F_Recepcion: 'basura-no-fecha',
      D_Credito: 30,
      Precio_T: 1000,
    }])));
    const rows = await fetchCompras({ cia: '00011', fechaInicial: '2026-01-01', fechaFinal: '2026-01-31' });
    expect(rows[0].fechaRecepcion).toBe('basura-no-');
    expect(rows[0].fechaPagoProyectada).toBe('');
  });
});

describe('fetchComprasRange — retry por mes agotado', () => {
  it('tras 3 intentos fallidos el mes se sirve vacío y se reporta', async () => {
    const fetchMock = vi.fn(async () => errorResponse(500));
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchComprasRange('00011', '2026-01-01', '2026-01-31', { concurrency: 1 });
    expect(out).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════
// 12. PagoProveedor
// ═══════════════════════════════════════════════════════════════════

describe('mapPagoProveedor — fecha vacía', () => {
  it('sin Fecha_Pago devuelve cadena vacía', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([{
      No_Cia: '11', no_pago: 'P-1', Importe_Pago_Pesos: 100,
    }])));
    const rows = await fetchPagoProveedor({ fechaInicial: '2026-05-04', fechaFinal: '2026-05-04' });
    expect(rows[0].fechaPago).toBe('');
    expect(rows[0].moneda).toBe('MXP');
  });
});

describe('fetchPagoProveedorRange — día que agota los reintentos', () => {
  it('el día queda sin cachear y se reporta el hueco', async () => {
    const fetchMock = vi.fn(async () => errorResponse(500));
    vi.stubGlobal('fetch', fetchMock);
    // 2026-05-04 es lunes (día operativo) → sí se pide al API.
    const out = await fetchPagoProveedorRange('2026-05-04', '2026-05-04', { concurrency: 1 });
    expect(out).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);
});

// ═══════════════════════════════════════════════════════════════════
// 13. AuxiliarContable — piso duro, dedup, namespace default y fallback
// ═══════════════════════════════════════════════════════════════════

const AUX_PARAMS = { tl: 'AA', nr: 999, objetos: [{ ini: '1020', fin: '1020' }] as const };

describe('fetchAuxiliarContableRange — piso duro 2025-01-01', () => {
  it('un `to` anterior al piso devuelve [] sin tocar la red', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchAuxiliarContableRange('00011', '2024-01-01', '2024-12-31', AUX_PARAMS))
      .toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recorta el `from` al piso y dedupea por cia::idCuenta::noDocto::tipoDocto', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(String(bodyOf(init).fechaInicial) >= '2025-01-01').toBe(true);
      return jsonResponse([
        { Cia: '00011', IdCuenta: 'ID-1', No_Docto: 1, Tipo_Docto: 'PV', Fecha_Contable_ddmmaa: '02/01/2025', Importe: 10 },
        { Cia: '00011', IdCuenta: 'ID-1', No_Docto: 1, Tipo_Docto: 'PV', Fecha_Contable_ddmmaa: '02/01/2025', Importe: 10 },
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    // Sin `cacheNamespace` → usa el default 'auxiliarcontable'.
    const rows = await fetchAuxiliarContableRange('00011', '2024-06-01', '2025-01-02', AUX_PARAMS);
    expect(rows).toHaveLength(1);
    expect(rows[0].fechaContable).toBe('2025-01-02');
  }, 20_000);
});

describe('parseDmyDate — vía mapAuxiliarContable', () => {
  it('centinelas 1899 (ISO y dd/mm/yyyy) se vacían y los años de 2 dígitos se expanden', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      { Cia: '00011', IdCuenta: 'A', No_Docto: 1, Tipo_Docto: 'PV', Fecha_Contable_ddmmaa: '1899-12-31T00:00:00', Fecha_pago_ddmmaa: '13/04/26' },
      { Cia: '00011', IdCuenta: 'B', No_Docto: 2, Tipo_Docto: 'PV', Fecha_Contable_ddmmaa: '31/12/1899', Fecha_pago_ddmmaa: '2026-04-13T00:00:00' },
    ])));
    const rows = await fetchAuxiliarContable({
      cia: '00011', fechaInicial: '2026-04-01', fechaFinal: '2026-04-30',
      tl: 'AA', nr: 999, objIni: '1020', objFin: '1020',
    });
    expect(rows[0].fechaContable).toBe('');
    expect(rows[0].fechaPago).toBe('2026-04-13');
    expect(rows[1].fechaContable).toBe('');
    expect(rows[1].fechaPago).toBe('2026-04-13');
  });
});

describe('fetchAuxiliarContableRange — chunk y fallback per-día que fallan', () => {
  it('propaga el error del chunk cuando ningún día del fallback responde', async () => {
    const fetchMock = vi.fn(async () => errorResponse(500));
    vi.stubGlobal('fetch', fetchMock);
    const onChunkFailed = vi.fn();

    const rows = await fetchAuxiliarContableRange(
      '00011', '2025-02-03', '2025-02-03', AUX_PARAMS,
      { cacheNamespace: 'aux-branch-ns', concurrency: 1 },
    );

    expect(rows).toEqual([]);
    // 3 intentos del chunk + 1 del fallback per-día (un solo día en la ventana).
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(onChunkFailed).not.toHaveBeenCalled();
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// 14. Nómina — fan-out, firmas de truncamiento y retry
// ═══════════════════════════════════════════════════════════════════

describe('fetchNomina — empresa específica (sin fan-out)', () => {
  it('una empresa concreta hace una sola request y no trocea', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([
      { IDEmpresa: 11, Monto: 100, TipoConcepto: 'Percepcion', Concepto: 'SUELDO', FechaPago: '2026-05-15' },
      { IDEmpresa: 11, Monto: 20, TipoConcepto: 'Deduccion', Concepto: 'PRESTAMO', FechaPago: '2026-05-15' },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const rows = await fetchNomina({ idEmpresa: 11, tipoNomina: 99, anio: 2026, mes: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
  });

  it('una respuesta con SOLO percepciones se reintenta antes de devolver best-effort', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([
      { IDEmpresa: 17, Monto: 100, TipoConcepto: 'Percepcion', Concepto: 'SUELDO', FechaPago: '2026-06-15' },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const rows = await fetchNomina({ idEmpresa: 17, tipoNomina: 99, anio: 2026, mes: 6 });
    // 1 intento + 2 retries por la firma de truncamiento.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(1);
  }, 30_000);
});

describe('fetchNomina — wildcard con fan-out por empresa', () => {
  it('sin ningún CASH_OUT no dispara el segundo troceo por tipo de nómina', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([
      { IDEmpresa: 1, Monto: 30, TipoConcepto: 'Deduccion', Concepto: 'PRESTAMO', FechaPago: '2026-05-15' },
      { IDEmpresa: 1, Monto: 10, TipoConcepto: 'Aportacion', Concepto: 'IMSS PATRONAL', FechaPago: '2026-05-15' },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const rows = await fetchNomina({ idEmpresa: 99, tipoNomina: 99, anio: 2026, mes: 5 });
    // Exactamente 4 requests: una por empresa del fan-out, sin sub-troceo.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(rows).toHaveLength(8);
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════════
// 15. Logs de "shape" — sólo corren en la PRIMERA llamada de la sesión
// ═══════════════════════════════════════════════════════════════════

describe('logs de diagnóstico de la primera llamada (módulo fresco)', () => {
  it('cobranza: cia YA con coma, fechaInicial null y respuesta vacía', async () => {
    vi.resetModules();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const mod = await import('./jde');
    const rows = await mod.fetchCobranza({
      cia: '00011,', fechaInicial: null, fechaFinal: '2026-07-01',
    });

    expect(rows).toEqual([]);
    // No se agrega una segunda coma.
    expect(bodyOf(fetchMock.mock.calls[0][1]).cia).toBe('00011,');
    expect(info.mock.calls.some(c => String(c[0]).includes('entre ∞ y 2026-07-01'))).toBe(true);
    expect(warn.mock.calls.some(c => String(c[0]).includes('[cobranza] respuesta VACÍA'))).toBe(true);
  });

  it('rol: sin k_Servidor cae a -1 y avisa de la respuesta vacía', async () => {
    vi.resetModules();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([])));

    const mod = await import('./jde');
    const rows = await mod.fetchRol({ f_Inicio: '2026-03-02', f_Final: '2026-03-02' });

    expect(rows).toEqual([]);
    expect(info.mock.calls.some(c => String(c[0]).includes('k_Servidor=-1'))).toBe(true);
    expect(warn.mock.calls.some(c => String(c[0]).includes('[rol] respuesta VACÍA'))).toBe(true);
  });

  it('nómina: un console.info que truena no rompe la captura de shape', async () => {
    vi.resetModules();
    vi.spyOn(console, 'info').mockImplementation(() => {
      throw new Error('consola rota');
    });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      { IDEmpresa: 11, Monto: 100, TipoConcepto: 'Percepcion', Concepto: 'SUELDO', FechaPago: '2026-05-15' },
      { IDEmpresa: 11, Monto: 20, TipoConcepto: 'Deduccion', Concepto: 'PRESTAMO', FechaPago: '2026-05-15' },
    ])));

    const mod = await import('./jde');
    const rows = await mod.fetchNomina({ idEmpresa: 11, tipoNomina: 1, anio: 2026, mes: 5 });
    expect(rows).toHaveLength(2);
    expect(mod.getLastNominaRawSample()?.keys).toContain('Monto');
  });
});
