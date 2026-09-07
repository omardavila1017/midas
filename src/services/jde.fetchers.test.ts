/**
 * Cobertura de los fetchers + mappers de jde.ts que NO cubre jde.test.ts:
 * antigüedad de saldos, empresas, cobranza (fetch directo + range), compras
 * (mapper + range mensual cacheado), pago a proveedor (mapper dd-mm-yyyy +
 * range diario cacheado), ROL CITI (mapper + range day-by-day), viajes
 * especiales (mapper + range day-by-day) y el fetch de IVA del libro mayor
 * (discovery en dos fases).
 *
 * Los helpers puros NO exportados (splitIntoFixedDayWindows, addDaysIso,
 * isoWeekMonday, toBool, trimDmyDate, toIsoDate, extractCiaFromCuentaContable)
 * se cubren a través de los fetchers/mappers que los consumen — NO se agregan
 * exports al código fuente.
 *
 * Patrón espejo de jde.test.ts: fetch mockeado con vi.stubGlobal, daily cache
 * primed + limpiado por namespace en afterEach (memory-only en jsdom).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDailyCache, primeDailyCache } from './dailyApiCache';
import { AUX_IVA_PARAMS } from '../domain/auxiliarReconciliationConfig';
import {
  __internal,
  fetchAgedBalances,
  fetchAuxiliarContableIvaRange,
  fetchBankStatements,
  fetchCobranza,
  fetchCobranzaRange,
  fetchCompanies,
  fetchCompras,
  fetchComprasRange,
  fetchPagoProveedor,
  fetchPagoProveedorRange,
  fetchRol,
  fetchRolRange,
  fetchViajesEspeciales,
  fetchViajesEspecialesRange,
} from './jde';

function jsonResponse(rows: unknown): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bodyOf(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

// Namespaces del cache tocados por estos tests (limpiar SIEMPRE para no
// contaminar entre tests — el keyIndex es estado de módulo).
const IVA_DISCOVERY_NS = `${__internal.ivaCacheNamespace(AUX_IVA_PARAMS.discoveryObjetos)}:discovery`;
const IVA_FULL_NS = __internal.ivaCacheNamespace([
  { ini: '1180', fin: '1180' },
  { ini: '2000', fin: '2999' },
]);

afterEach(async () => {
  vi.unstubAllGlobals();
  await primeDailyCache();
  await clearDailyCache('banks.SWIFT');
  await clearDailyCache('M:compras');
  await clearDailyCache('pagoproveedor');
  await clearDailyCache(IVA_DISCOVERY_NS);
  await clearDailyCache(IVA_FULL_NS);
});

// ───────────────────────────────────────────────────────────────
// 1. Antigüedad de saldos — fetchAgedBalances + mapAgedBalance
// ───────────────────────────────────────────────────────────────

describe('fetchAgedBalances — mapAgedBalance', () => {
  it('postea a /antiguedadsaldos y mapea campo por campo con cia a 5 dígitos', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([
      {
        Cia: '150',
        No_Proveedor: 'P-77',
        Nombre: 'ACEROS DEL NORTE  ',
        No_Factura: 'F-1001',
        Fecha_Factura: '2026-03-05T00:00:00',
        Fecha_Vence: '2026-04-04T00:00:00',
        Fecha_Programacion_Pago: '2026-04-10T00:00:00',
        Dias_Vencida: '12',
        Importe_Bruto_Pesos: '11,600.00',
        Importe_Pendiente_Pesos: '5,800.50',
        Importe_Subtotal_Pesos: '10,000.00',
        Importe_Impuestos_Pesos: '1,600.00',
        Moneda: 'MXP',
        Cond_Pago: '30D',
        Clasifica: 'REFACCIONES',
        Clasificacion_Proveedor: 'Impacto alto',
        Edo_Pago: 'A',
        Tipo_Cambio: '1',
        Por_Vencer: '100',
        V1_30: '200',
        V31_60: '300',
        V61_90: '0',
        Mas180: '50',
      },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const records = await fetchAgedBalances({ cia: '00150' });

    expect(fetchMock).toHaveBeenCalledWith('/api/jde/antiguedadsaldos', expect.objectContaining({ method: 'POST' }));
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.cia).toBe('00150');
    expect(r.noProveedor).toBe('P-77');
    expect(r.nombre).toBe('ACEROS DEL NORTE');
    expect(r.noFactura).toBe('F-1001');
    // trimIsoDate: ISO+hora recortado a day-precision (contrato de cleanDate).
    expect(r.fechaFactura).toBe('2026-03-05');
    expect(r.fechaVence).toBe('2026-04-04');
    expect(r.fechaProgramacionPago).toBe('2026-04-10');
    expect(r.diasVencida).toBe(12);
    // toNum tolera comas de miles.
    expect(r.importeBrutoPesos).toBe(11600);
    expect(r.importePendientePesos).toBe(5800.5);
    expect(r.importeSubtotalPesos).toBe(10000);
    expect(r.importeImpuestosPesos).toBe(1600);
    expect(r.moneda).toBe('MXP');
    expect(r.condPago).toBe('30D');
    expect(r.clasificacionProveedor).toBe('Impacto alto');
    expect(r.tipoCambio).toBe(1);
    expect(r.porVencer).toBe(100);
    expect(r.v1_30).toBe(200);
    expect(r.v31_60).toBe(300);
    expect(r.mas180).toBe(50);
  });

  it('tolera respuesta envuelta en { data: [...] }', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      data: [{ Cia: '11', No_Proveedor: 'P-1', Importe_Pendiente_Pesos: 100 }],
    })));

    const records = await fetchAgedBalances({ cia: '00011' });
    expect(records).toHaveLength(1);
    expect(records[0].cia).toBe('00011');
    expect(records[0].importePendientePesos).toBe(100);
  });

  // `jde.Antiguedad_Saldos` es la ÚNICA tabla del espejo que guarda sus fechas
  // como varchar `DD-MM-YYYY` (auditoría 2026-09-07, verificado con su propio
  // `Dias_Vencida`). Si el SP deja de convertir a ISO, sin esto TODA factura se
  // queda sin vencimiento en silencio: `cleanDate` y `parseDateToIso` exigen
  // `YYYY-MM-DD`, así que "Vencido / Por vencer / A pagar este mes" saldría en
  // $0 y los egresos `cxp:` se re-fecharían al asOfDate.
  it('normaliza el DD-MM-YYYY que guarda la tabla origen', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      {
        Cia: '00011',
        No_Proveedor: 'P-9',
        No_Factura: 'F-9',
        Fecha_Factura: '31-08-2026',
        Fecha_Vence: '30-09-2026',
        Fecha_Programacion_Pago: '05-10-2026',
        Importe_Pendiente_Pesos: 100,
      },
    ])));

    const [r] = await fetchAgedBalances({ cia: '00011' });
    expect(r.fechaFactura).toBe('2026-08-31');
    expect(r.fechaVence).toBe('2026-09-30');
    // Día ≤ 12: se lee DD-MM (formato medido de la tabla), no MM-DD.
    expect(r.fechaProgramacionPago).toBe('2026-10-05');
  });

  it('deja intacto el ISO y no inventa fecha con un valor irreconocible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      {
        Cia: '00011',
        No_Proveedor: 'P-9',
        Fecha_Factura: '2026-08-31 00:00:00.000',
        Fecha_Vence: '2026/09/30',
        Fecha_Programacion_Pago: '',
        Importe_Pendiente_Pesos: 100,
      },
    ])));

    const [r] = await fetchAgedBalances({ cia: '00011' });
    expect(r.fechaFactura).toBe('2026-08-31');
    // Diagonales: `M/D/YYYY` es formato US y sería ambiguo — passthrough.
    expect(r.fechaVence).toBe('2026/09/30');
    expect(r.fechaProgramacionPago).toBe('');
  });
});

// ───────────────────────────────────────────────────────────────
// 2. Empresas — fetchCompanies + mapCompany
// ───────────────────────────────────────────────────────────────

describe('fetchCompanies — mapCompany', () => {
  it('GET /empresas, normaliza cia, mapea activa S/N y filtra filas sin cia', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([
      { No_Cia: '11', Nombre_Cia: 'SIR', RFC: 'SIR123', Moneda_Base: 'MXP', Activa: 'S' },
      { No_Cia: '38', Nombre_Empresa: 'STDN', Activa: 'N' },
      { No_Cia: '42', Razon_Social: 'TAM' },
      { No_Cia: '', Nombre_Cia: 'SIN CODIGO' },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const companies = await fetchCompanies();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/jde/empresas');
    expect(init.method).toBe('GET');

    // La fila sin cia se filtra.
    expect(companies).toHaveLength(3);
    expect(companies[0]).toMatchObject({
      cia: '00011',
      nombre: 'SIR',
      rfc: 'SIR123',
      monedaBase: 'MXP',
      activa: true,
    });
    expect(companies[1]).toMatchObject({ cia: '00038', nombre: 'STDN', activa: false });
    // Sin campo activa → undefined (no inventar estado).
    expect(companies[2].cia).toBe('00042');
    expect(companies[2].nombre).toBe('TAM');
    expect(companies[2].activa).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────
// 3. Cobranza — fetchCobranza + mapCobranza + fetchCobranzaRange
// ───────────────────────────────────────────────────────────────

describe('fetchCobranza — mapCobranza sobre el shape real del API', () => {
  const cobradaRow = {
    Cia: '11',
    No_Cliente: 99999988,
    Nombre_Cliente: 'RITA PRADO VAZQUEZ           ',
    RFC: 'PAVR7405221A9       ',
    Factura: 'RI-85022',
    Dias_Credito: '30 ',
    Fecha_Factura: '2026-01-05T00:00:00',
    Fecha_Vencimiento: '2026-02-04T00:00:00',
    Fecha_Pago: '2026-02-10T00:00:00',
    Fecha_Contable: '2026-01-05T00:00:00',
    Dias_Fecha_Vencimiento_vs_Fecha_Pago: 6,
    TasaFiscal: 'IVA16          ',
    SubTotal: 1000,
    Importe_IVA: 160,
    Importe_RETENCION: 0,
    Importe_Factura: 1160,
    Importe_Pendiente: 0,
    UUID_Fiscal: 'AAAA-BBBB-CCCC',
    No_Cliente_Padre: '0',
  };

  it('fuerza la coma trailing en cia y mapea la factura cobrada campo por campo', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([cobradaRow]));
    vi.stubGlobal('fetch', fetchMock);

    const records = await fetchCobranza({ cia: '00011', fechaInicial: '2026-01-01', fechaFinal: '2026-03-01' });

    // Contrato JDE: la cia viaja con coma trailing en el body.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/jde/cobranza');
    expect(bodyOf(init)).toMatchObject({ cia: '00011,', fechaInicial: '2026-01-01', fechaFinal: '2026-03-01' });

    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.cia).toBe('00011');
    expect(r.noCliente).toBe('99999988');
    expect(r.nombreCliente).toBe('RITA PRADO VAZQUEZ');
    expect(r.rfc).toBe('PAVR7405221A9');
    expect(r.noFactura).toBe('RI-85022');
    // Fechas ISO+hora recortadas a YYYY-MM-DD.
    expect(r.fechaFactura).toBe('2026-01-05');
    expect(r.fechaVence).toBe('2026-02-04');
    expect(r.fechaCobro).toBe('2026-02-10');
    expect(r.fechaContable).toBe('2026-01-05');
    // Importe_Factura es el gross final; Importe_Pendiente el saldo abierto.
    expect(r.importeBrutoPesos).toBe(1160);
    expect(r.importePendientePesos).toBe(0);
    expect(r.subTotal).toBe(1000);
    expect(r.importeIVA).toBe(160);
    expect(r.importeRetencion).toBe(0);
    expect(r.uuidFiscal).toBe('AAAA-BBBB-CCCC');
    // Cobrada: el campo del API manda (positivo = pagó tarde).
    expect(r.diasVencida).toBe(6);
    // Derivados: estatus, moneda default, crédito numérico, padre '0' → undefined.
    expect(r.estatus).toBe('COBRADA');
    expect(r.moneda).toBe('MXN');
    expect(r.condPago).toBe('30');
    expect(r.diasCredito).toBe(30);
    expect(r.noClientePadre).toBeUndefined();
    expect(r.tasaFiscal).toBe('IVA16');
  });

  it('deriva PENDIENTE (saldo abierto) y CANCELADA (sin saldo ni fecha de pago)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      { ...cobradaRow, Factura: 'RI-1', Importe_Pendiente: 500, Fecha_Pago: '', Fecha_Vencimiento: '', Dias_Fecha_Vencimiento_vs_Fecha_Pago: 0 },
      { ...cobradaRow, Factura: 'RI-2', Importe_Pendiente: 0, Fecha_Pago: '' },
    ])));

    const records = await fetchCobranza({ cia: '00011', fechaInicial: '2026-01-01', fechaFinal: '2026-03-01' });
    expect(records.map(r => r.estatus)).toEqual(['PENDIENTE', 'CANCELADA']);
  });

  it('fetchCobranzaRange es UNA sola llamada por cía con progreso 0/1 → 1/1', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([cobradaRow]));
    vi.stubGlobal('fetch', fetchMock);
    const progress: Array<[number, number]> = [];

    const records = await fetchCobranzaRange('00011', '2025-07-01', '2026-07-01', {
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
    expect(progress).toEqual([[0, 1], [1, 1]]);
  });
});

// ───────────────────────────────────────────────────────────────
// 4. Compras — fetchCompras + mapCompras + fetchComprasRange
// ───────────────────────────────────────────────────────────────

function comprasRow(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    Cia: '11',
    C_Proveedor: 'P-9',
    N_Proveedor: 'FERRETERA',
    N_Orden: 'OC-1',
    L_Orden: 1,
    Precio_T: '1000',
    D_Credito: 30,
    ...partial,
  };
}

describe('fetchCompras — mapCompras', () => {
  it('requiere cia en el body (contrato 2026-05-19) y mapea la OC recibida', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([
      comprasRow({
        F_Orden: '2026-04-01T00:00:00',
        F_Recepcion: '2026-04-10T00:00:00',
        F_Cancelada: '1899-12-31T00:00:00',
        N_Factura: '',
        T_Moneda: 'USD',
        Tipo_Cambio: '17.5',
        Cantidad: 4,
        Precio_U: 250,
        Edo_Sig: '400',
      }),
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const records = await fetchCompras({ cia: '00011', fechaInicial: '2026-04-01', fechaFinal: '2026-04-30' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/jde/compras');
    expect(bodyOf(init)).toMatchObject({ cia: '00011', fechaInicial: '2026-04-01', fechaFinal: '2026-04-30' });

    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.cia).toBe('00011');
    expect(r.noOrden).toBe('OC-1');
    expect(r.lineaOrden).toBe(1);
    expect(r.fechaPedido).toBe('2026-04-01');
    expect(r.fechaRecepcion).toBe('2026-04-10');
    // addDaysIso: recepción + días de crédito = fecha de pago proyectada.
    expect(r.fechaPagoProyectada).toBe('2026-05-10');
    // Centinela 1899- en F_Cancelada = NO cancelada.
    expect(r.cancelada).toBe(false);
    expect(r.facturada).toBe(false);
    expect(r.importeTotal).toBe(1000);
    expect(r.moneda).toBe('USD');
    expect(r.tipoCambio).toBe(17.5);
    expect(r.cantidad).toBe(4);
    expect(r.precioUnitario).toBe(250);
    expect(r.estadoSiguiente).toBe('400');
  });

  it('acepta el alias legacy F_Pedido y trata la recepción centinela como pendiente', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      comprasRow({
        F_Pedido: '2026-03-15T00:00:00',
        F_Recepcion: '1899-12-31T00:00:00',
        F_Cancelada: '2026-04-02T00:00:00',
        N_Factura: 'F-88',
      }),
    ])));

    const [r] = await fetchCompras({ cia: '00011', fechaInicial: '2026-03-01', fechaFinal: '2026-03-31' });
    expect(r.fechaPedido).toBe('2026-03-15');
    // Recepción centinela → sin recepción → sin fecha de pago proyectada.
    expect(r.fechaRecepcion).toBe('');
    expect(r.fechaPagoProyectada).toBe('');
    // F_Cancelada real → cancelada; N_Factura poblada → facturada.
    expect(r.cancelada).toBe(true);
    expect(r.facturada).toBe(true);
    // Defaults: moneda MXP, tipoCambio 1.
    expect(r.moneda).toBe('MXP');
    expect(r.tipoCambio).toBe(1);
  });
});

describe('fetchComprasRange — troceo mensual + dedup + cache', () => {
  it('pide meses calendario completos, dedupea por cia::orden::linea y sirve del cache la 2a vez', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = bodyOf(init) as { fechaInicial: string };
      const month = body.fechaInicial.slice(0, 7);
      if (month === '2026-04') {
        return jsonResponse([
          comprasRow({ N_Orden: 'OC-1', F_Orden: '2026-04-05' }),
          comprasRow({ N_Orden: 'OC-2', F_Orden: '2026-04-06' }),
        ]);
      }
      // Mayo re-entrega OC-1 (overlap) — debe deduplicarse.
      return jsonResponse([comprasRow({ N_Orden: 'OC-1', F_Orden: '2026-04-05' })]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = await fetchComprasRange('00011', '2026-04-05', '2026-05-20');

    // Un request por mes, siempre con ventana de mes completo.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls
      .map(call => bodyOf(call[1] as RequestInit) as { cia: string; fechaInicial: string; fechaFinal: string })
      .sort((a, b) => a.fechaInicial.localeCompare(b.fechaInicial));
    expect(bodies).toEqual([
      { cia: '00011', fechaInicial: '2026-04-01', fechaFinal: '2026-04-30' },
      { cia: '00011', fechaInicial: '2026-05-01', fechaFinal: '2026-05-31' },
    ]);

    // Dedup por (cia, noOrden, lineaOrden): OC-1 repetida entre meses cuenta una vez.
    expect(records.map(r => r.noOrden).sort()).toEqual(['OC-1', 'OC-2']);

    // Segunda corrida: ambos meses (pasados) salen del cache — cero red.
    fetchMock.mockClear();
    const again = await fetchComprasRange('00011', '2026-04-05', '2026-05-20');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(again.map(r => r.noOrden).sort()).toEqual(['OC-1', 'OC-2']);
  });

  it('revalidateMonths re-pide un mes cacheado y sobreescribe la entrada', async () => {
    const first = vi.fn(async () => jsonResponse([comprasRow({ N_Orden: 'OC-1', Precio_T: '0' })]));
    vi.stubGlobal('fetch', first);
    await fetchComprasRange('00011', '2026-04-01', '2026-04-30');
    expect(first).toHaveBeenCalledTimes(1);

    // El SP corrigió el importe; el mes revalidado debe traer el dato nuevo.
    const second = vi.fn(async () => jsonResponse([comprasRow({ N_Orden: 'OC-1', Precio_T: '999' })]));
    vi.stubGlobal('fetch', second);
    const records = await fetchComprasRange('00011', '2026-04-01', '2026-04-30', {
      revalidateMonths: new Set(['2026-04']),
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(records[0].importeTotal).toBe(999);
  });
});

// ───────────────────────────────────────────────────────────────
// 5. PagoProveedor — mapper dd-mm-yyyy + range diario cacheado
// ───────────────────────────────────────────────────────────────

function pagoRow(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    Tipo_Pago: 'PN',
    No_Pago: '70001',
    No_Cia: '11',
    Nombre_Cia: 'SIR',
    Cuenta_Bancaria: '11.1110.0011302',
    Cuenta_Banco: '877732401',
    Fecha_Pago: '02-06-2026',
    Importe_Pago_Pesos: '5,000.00',
    Batch_pago: 'B-9',
    Clave_Proveedor: 'PR-1',
    RFC_Proveedor: 'AAA010101AAA',
    Nombre_Proveedor: 'TRANSPORTES XYZ',
    ...partial,
  };
}

describe('fetchPagoProveedor — mapPagoProveedor', () => {
  it('convierte Fecha_Pago DD-MM-YYYY → ISO y normaliza cia/importes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([pagoRow({})]));
    vi.stubGlobal('fetch', fetchMock);

    const records = await fetchPagoProveedor({ fechaInicial: '2026-06-02', fechaFinal: '2026-06-02' });

    expect(fetchMock).toHaveBeenCalledWith('/api/jde/pagoproveedor', expect.objectContaining({ method: 'POST' }));
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.cia).toBe('00011');
    expect(r.noPago).toBe('70001');
    // trimDmyDate: día-primero → ISO (único endpoint con ese formato).
    expect(r.fechaPago).toBe('2026-06-02');
    expect(r.importePesos).toBe(5000);
    expect(r.moneda).toBe('MXP'); // default cuando el API no la manda
    expect(r.batchPago).toBe('B-9');
    expect(r.claveProveedor).toBe('PR-1');
    expect(r.rfcProveedor).toBe('AAA010101AAA');
    expect(r.nombreProveedor).toBe('TRANSPORTES XYZ');
    expect(r.cuentaBancaria).toBe('11.1110.0011302');
  });

  it('trimDmyDate cae a trimIsoDate si el API cambia a ISO', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      pagoRow({ Fecha_Pago: '2026-06-02T00:00:00' }),
    ])));
    const [r] = await fetchPagoProveedor({ fechaInicial: '2026-06-02', fechaFinal: '2026-06-02' });
    expect(r.fechaPago).toBe('2026-06-02');
  });
});

describe('fetchPagoProveedorRange — troceo diario + dedup + cache', () => {
  it('pide día por día (fechaInicial === fechaFinal), dedupea por cia::noPago y cachea', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = bodyOf(init) as { fechaInicial: string };
      // El mismo pago aparece en ambos días (reentrega del API) + uno propio del día 3.
      return body.fechaInicial === '2026-06-02'
        ? jsonResponse([pagoRow({ No_Pago: '70001', Fecha_Pago: '02-06-2026' })])
        : jsonResponse([
            pagoRow({ No_Pago: '70001', Fecha_Pago: '02-06-2026' }),
            pagoRow({ No_Pago: '70002', Fecha_Pago: '03-06-2026' }),
          ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    // 2026-06-02/03 = martes/miércoles (días hábiles, no festivos MX).
    const records = await fetchPagoProveedorRange('2026-06-02', '2026-06-03');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const body = bodyOf(call[1] as RequestInit) as { fechaInicial: string; fechaFinal: string };
      expect(body.fechaInicial).toBe(body.fechaFinal);
    }
    expect(records.map(r => r.noPago).sort()).toEqual(['70001', '70002']);

    // Días pasados quedan cacheados: la segunda corrida no toca la red.
    fetchMock.mockClear();
    const again = await fetchPagoProveedorRange('2026-06-02', '2026-06-03');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(again.map(r => r.noPago).sort()).toEqual(['70001', '70002']);
  });

  it('salta fines de semana sin pegarle al API (isNonOperatingDay)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([pagoRow({})]));
    vi.stubGlobal('fetch', fetchMock);

    // 2026-06-06/07 = sábado/domingo.
    const records = await fetchPagoProveedorRange('2026-06-06', '2026-06-07');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────
// 6. ROL CITI — fetchRol + mapRol + fetchRolRange
// ───────────────────────────────────────────────────────────────

function rolRow(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    cia: '11',
    D_Empresa: 'SENDA',
    K_Cliente: 77,
    C_Cliente: 'C77',
    D_Cliente: 'CLIENTE ROL',
    RFC: 'RRR010101RRR',
    Clave_JDE: '  123 ',
    D_Facturacion_Tipo: 'SEMANAL',
    IVA: 16,
    D_Tipo_Viaje: 'REGULAR',
    D_Ruta: 'MTY-SLP',
    Costo_Ruta: 100,
    Viajes: 2,
    SubTotal: 200,
    B_Despachado: '1',
    B_Efectuado: 'true',
    Anio: 2026,
    Semana: 10,
    Factura: '',
    UUID_Fiscal: 'uuid-1',
    Plaza_CITI: 'MTY',
    ...partial,
  };
}

describe('fetchRol — mapRol', () => {
  it('postea al proxy CITI y fecha el viaje con el lunes ISO de (anio, semana)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([rolRow({})]));
    vi.stubGlobal('fetch', fetchMock);

    const records = await fetchRol({ f_Inicio: '2026-03-02', f_Final: '2026-03-02', k_Servidor: -1 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/citi/roldiario');
    expect(bodyOf(init)).toMatchObject({ f_Inicio: '2026-03-02', f_Final: '2026-03-02', k_Servidor: -1 });

    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.cia).toBe('00011');
    expect(r.kCliente).toBe(77);
    expect(r.claveJDE).toBe('123'); // toStr trimea el padding
    // isoWeekMonday(2026, 10): semana 1 = la del 4-ene (domingo) → lunes 2025-12-29;
    // semana 10 = +63 días = 2026-03-02.
    expect(r.fechaViaje).toBe('2026-03-02');
    expect(r.despachado).toBe(true); // toBool('1')
    expect(r.efectuado).toBe(true);  // toBool('true')
    expect(r.subTotal).toBe(200);
    expect(r.viajes).toBe(2);
    expect(r.factura).toBeUndefined(); // vacío → undefined
    expect(r.uuidFiscal).toBe('uuid-1');
    expect(r.plazaCiti).toBe('MTY');
  });

  it('toBool: acepta si/sí/1 y rechaza 0/false/basura; semana inválida → sin fecha', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      rolRow({ B_Despachado: 'si', B_Efectuado: 0, Anio: 2026, Semana: 99 }),
      rolRow({ B_Despachado: 'no', B_Efectuado: 'sí', K_Cliente: 78 }),
    ])));

    const records = await fetchRol({ f_Inicio: '2026-03-02', f_Final: '2026-03-02' });
    expect(records[0].despachado).toBe(true);
    expect(records[0].efectuado).toBe(false);
    // isoWeekMonday: semana fuera de [1..53] → ''.
    expect(records[0].fechaViaje).toBe('');
    expect(records[1].despachado).toBe(false);
    expect(records[1].efectuado).toBe(true);
  });
});

describe('fetchRolRange — ventanas de 1 día + dedup last-wins', () => {
  it('trocea day-by-day y la ventana MÁS reciente gana el dedup (viaje que adquirió factura)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = bodyOf(init) as { f_Inicio: string };
      // Misma llave semanal en ambos días: el snapshot del día 2 ya trae factura.
      return body.f_Inicio === '2026-06-02'
        ? jsonResponse([rolRow({ Factura: '' })])
        : jsonResponse([rolRow({ Factura: 'RI-500' })]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = await fetchRolRange('2026-06-02', '2026-06-03', { concurrency: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const body = bodyOf(call[1] as RequestInit) as { f_Inicio: string; f_Final: string; k_Servidor: number };
      expect(body.f_Inicio).toBe(body.f_Final);
      expect(body.k_Servidor).toBe(-1); // default
    }
    // Dedup por (cia, kCliente, anio, semana, ruta, tipoViaje) — last-wins.
    expect(records).toHaveLength(1);
    expect(records[0].factura).toBe('RI-500');
  });

  it('rango invertido → [] sin tocar la red (splitIntoFixedDayWindows vacío)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([rolRow({})]));
    vi.stubGlobal('fetch', fetchMock);
    const records = await fetchRolRange('2026-06-05', '2026-06-02');
    expect(records).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────
// 7. Viajes Especiales — fetchViajesEspeciales + range
// ───────────────────────────────────────────────────────────────

function viajeRow(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    Clave_JDE_Empresa: '11',
    K_Empresa: 'E1',
    K_Renta: 555,
    K_Cliente: 9,
    D_Cliente: ' ACME SA ',
    Rrc_Cliente: ' RFC-1 ',
    Clave_JDE: ' 100 ',
    Total_Negociado: '25,000.50',
    Dias_Credito: 15,
    Factura_JDE: ' ri-9 ',
    UUID: ' abc-uuid ',
    f_salida_primera: '2026-04-09T09:00:00',
    f_Regreso_ultima: '2026-04-11T18:00:00',
    Fecha_Factura: '2026-04-12T00:00:00',
    Numero_Batch: 'B1',
    Referencia_Deposito: 'REF-7',
    ...partial,
  };
}

describe('fetchViajesEspeciales — mapViajeEspecial', () => {
  it('postea a /Servicios y normaliza factura/UUID a trim+upper con fechas day-precision', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([viajeRow({})]));
    vi.stubGlobal('fetch', fetchMock);

    const records = await fetchViajesEspeciales({ f_Inicio: '2026-04-09', f_Final: '2026-04-09' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/viajes-especiales/Servicios');
    expect(bodyOf(init)).toMatchObject({ f_Inicio: '2026-04-09', f_Final: '2026-04-09' });

    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.cia).toBe('00011');
    expect(r.kRenta).toBe(555);
    expect(r.dCliente).toBe('ACME SA');
    expect(r.rfc).toBe('RFC-1');
    expect(r.claveJDE).toBe('100');
    expect(r.totalNegociado).toBe(25000.5);
    expect(r.diasCredito).toBe(15);
    // Normalización para el cruce con cobranza: trim + upper.
    expect(r.facturaJDE).toBe('RI-9');
    expect(r.uuidFiscal).toBe('ABC-UUID');
    // toIsoDate recorta el timestamp.
    expect(r.fSalidaPrimera).toBe('2026-04-09');
    expect(r.fRegresoUltima).toBe('2026-04-11');
    expect(r.fechaFactura).toBe('2026-04-12');
    expect(r.numeroBatch).toBe('B1');
    expect(r.referenciaDeposito).toBe('REF-7');
  });

  it('sin factura/UUID → undefined (no cadena vacía)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([
      viajeRow({ Factura_JDE: '', UUID: '', Numero_Batch: '', Referencia_Deposito: '', f_salida_primera: '' }),
    ])));
    const [r] = await fetchViajesEspeciales({ f_Inicio: '2026-04-09', f_Final: '2026-04-09' });
    expect(r.facturaJDE).toBeUndefined();
    expect(r.uuidFiscal).toBeUndefined();
    expect(r.numeroBatch).toBeUndefined();
    expect(r.referenciaDeposito).toBeUndefined();
    expect(r.fSalidaPrimera).toBeUndefined();
  });
});

describe('fetchViajesEspecialesRange — ventanas de 1 día + dedup por K_Renta', () => {
  it('trocea day-by-day y el mismo K_Renta en dos ventanas cuenta una vez (first-wins)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = bodyOf(init) as { f_Inicio: string };
      return body.f_Inicio === '2026-04-09'
        ? jsonResponse([viajeRow({ K_Renta: 555 }), viajeRow({ K_Renta: 556 })])
        : jsonResponse([viajeRow({ K_Renta: 555 })]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = await fetchViajesEspecialesRange('2026-04-09', '2026-04-10', { concurrency: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const body = bodyOf(call[1] as RequestInit) as { f_Inicio: string; f_Final: string };
      expect(body.f_Inicio).toBe(body.f_Final);
    }
    expect(records.map(r => r.kRenta).sort()).toEqual([555, 556]);
  });
});

// ───────────────────────────────────────────────────────────────
// 8. Bancos — cia derivada de Cuenta_Contable (extractCiaFromCuentaContable)
// ───────────────────────────────────────────────────────────────

describe('fetchBankStatements — cia desde Cuenta_Contable', () => {
  it('sin campo cia, extrae la Business Unit de Cuenta_Contable con padding a 5', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([
      {
        // SIN campo `cia`: debe derivarse de la BU "38" → "00038".
        Cuenta_Contable: '38.1020.0011305',
        Cuenta_Bancos: '000123',
        Nombre_cuenta_Contable: 'BANAMEX CTA',
        Fecha_Estado_Cuenta: '2026-02-10',
        Importe: '1000.00',
        Tipo_Movimiento: 'CREDITO',
        Referencia_Cliente: 'SPEI',
        No_Recibo: 'RI-1',
      },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    const statements = await fetchBankStatements({
      fechaEstadoCuenta: '2026-02-10',
      formatoElectronico: 'SWIFT',
    });

    expect(statements).toHaveLength(1);
    expect(statements[0].cia).toBe('00038');
    expect(statements[0].movimientos[0].cia).toBe('00038');
  });
});

// ───────────────────────────────────────────────────────────────
// 9. IVA del libro mayor — fetchAuxiliarContableIvaRange (dos fases)
// ───────────────────────────────────────────────────────────────

describe('fetchAuxiliarContableIvaRange — discovery + full en dos fases', () => {
  function auxIvaRow(fecha: string, objeto: string, nombre: string, noDocto: number): Record<string, unknown> {
    return {
      Cia: '00011',
      IdCuenta: `id-${objeto}-${noDocto}`,
      Cuenta_Objeto: objeto,
      Nombre_Cta: nombre,
      Tipo_Docto: 'PV',
      No_Docto: noDocto,
      Fecha_Contable: fecha,
      Importe: '1600',
    };
  }

  it('descubre el objeto acreditable por nombre y pide el rango completo solo de esos objetos (+ candidato pasivo)', async () => {
    let nextDocto = 1;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = bodyOf(init) as { fechaInicial: string; objIni: string; objFin: string };
      // Discovery (rango candidato activo 1000-1999): expone la cuenta 1180.
      if (body.objIni === '1000') {
        return jsonResponse([auxIvaRow(body.fechaInicial, '1180', 'IVA ACREDITABLE', nextDocto++)]);
      }
      // Fase B sobre el objeto exacto descubierto.
      if (body.objIni === '1180') {
        return jsonResponse([auxIvaRow(body.fechaInicial, '1180', 'IVA ACREDITABLE', nextDocto++)]);
      }
      // Rango pasivo candidato (2000-2999): sin cuentas de IVA causado.
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const records = await fetchAuxiliarContableIvaRange('00011', '2026-05-04', '2026-05-08');

    // Fase B: como discovery NO encontró causado, se pide el objeto exacto
    // 1180 + el rango candidato pasivo completo (falla suave documentada).
    const phaseBBodies = fetchMock.mock.calls
      .map(call => bodyOf(call[1] as RequestInit) as { objIni: string; objFin: string; fechaInicial: string; fechaFinal: string })
      .filter(b => b.fechaInicial === '2026-05-04');
    expect(phaseBBodies.map(b => `${b.objIni}-${b.objFin}`).sort()).toEqual(['1180-1180', '2000-2999']);
    // La ventana de la fase B cubre el rango pedido completo (chunk de 7 días).
    expect(phaseBBodies.every(b => b.fechaFinal === '2026-05-08')).toBe(true);

    // El resultado es SOLO la fase B (un chunk → una fila en 2026-05-04).
    expect(records).toHaveLength(1);
    expect(records[0].cia).toBe('00011');
    expect(records[0].cuentaObjeto).toBe('1180');
    expect(records[0].nombreCuenta).toBe('IVA ACREDITABLE');
    expect(records[0].importe).toBe(1600);
    expect(records[0].fechaContable).toBe('2026-05-04');
  });

  it('cia fuera del allowlist auxiliar → [] sin tocar la red', async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const records = await fetchAuxiliarContableIvaRange('00099', '2026-05-04', '2026-05-08');
    expect(records).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
