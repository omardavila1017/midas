import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearDailyCache, primeDailyCache } from './dailyApiCache';
import {
  __internal,
  type AuxiliarContableRecord,
  fetchBankStatements,
  fetchIndicadoresCobranza,
  fetchIndicadoresCobranzaRange,
  fetchNomina,
  normalizeCobranzaPayments,
  normalizeInvoiceRef,
} from './jde';

afterEach(async () => {
  vi.unstubAllGlobals();
  await primeDailyCache();
  await clearDailyCache('banks.SWIFT');
});

function auxRecord(partial: Partial<AuxiliarContableRecord>): AuxiliarContableRecord {
  return {
    cia: '00011',
    cuentaContable: '11.1180.0000',
    idCuenta: 'id-1',
    cuentaObjeto: '1180',
    nombreCuenta: 'IVA ACREDITABLE',
    cuentaBanco: '',
    tipoDocto: 'PV',
    noDocto: 1,
    noFactura: '',
    noOrdenCompra: '',
    fechaContable: '2026-05-10',
    tipoLibro: 'AA',
    noBatch: 0,
    tipoBatch: 'V',
    estatusConciliado: '',
    importe: 1600,
    moneda: 'MXP',
    tipoCambio: 1,
    posteo: 'P',
    reversa: '',
    concepto: '',
    explicacion: '',
    nombre: '',
    tipoPago: '',
    noPago: '',
    fechaPago: '',
    documentoOriginal: '',
    importeOriginal: 0,
    ...partial,
  };
}

describe('AuxiliarContable IVA discovery', () => {
  const candidates = [
    { ini: '1000', fin: '1999' },
    { ini: '2000', fin: '2999' },
  ];

  it('incluye el rango pasivo cuando discovery encuentra solo acreditable', () => {
    const objetos = __internal.selectIvaFullObjetoRanges([
      auxRecord({ cuentaObjeto: '1180', nombreCuenta: 'IVA ACREDITABLE' }),
    ], candidates);

    expect(objetos).toEqual([
      { ini: '1180', fin: '1180' },
      { ini: '2000', fin: '2999' },
    ]);
  });

  it('incluye el rango activo cuando discovery encuentra solo causado', () => {
    const objetos = __internal.selectIvaFullObjetoRanges([
      auxRecord({ cuentaObjeto: '2360', nombreCuenta: 'IVA POR ENTERAR' }),
    ], candidates);

    expect(objetos).toEqual([
      { ini: '1000', fin: '1999' },
      { ini: '2360', fin: '2360' },
    ]);
  });

  it('usa objetos exactos cuando discovery encuentra acreditable y causado', () => {
    const objetos = __internal.selectIvaFullObjetoRanges([
      auxRecord({ cuentaObjeto: '1180', nombreCuenta: 'IVA ACREDITABLE' }),
      auxRecord({ cuentaObjeto: '2160', nombreCuenta: 'IVA TRASLADADO' }),
    ], candidates);

    expect(objetos).toEqual([
      { ini: '1180', fin: '1180' },
      { ini: '2160', fin: '2160' },
    ]);
  });

  it('genera namespaces distintos para sets de objetos distintos', () => {
    expect(__internal.ivaCacheNamespace([{ ini: '1180', fin: '1180' }]))
      .not.toBe(__internal.ivaCacheNamespace([{ ini: '1180', fin: '1180' }, { ini: '2000', fin: '2999' }]));
  });
});

describe('normalizeCobranzaPayments', () => {
  it('agrupa filas repetidas por Id Pago y mantiene importes en el nivel correcto', () => {
    const payments = normalizeCobranzaPayments([
      {
        'Id Pago': 'PAY-1',
        CIA: '11',
        'Fecha Cobro': '2026-02-10T00:00:00',
        'Fecha Contable': '2026-02-10T00:00:00',
        'cta bancaria': '11.1020.0011302',
        Banco: 'BANAMEX',
        'No Recibo': 'RI - 90829',
        'Importe Recibo': '1740.00',
        'Pendiente de Aplicar': '0',
        'No Cliente': 'C-9001',
        Cliente: 'CLIENTE A',
        'Tipo Docto': 'RI',
        'No Factura': 'RI - 90829',
        'Fecha Factura': '2026-01-01',
        'Fecha vencimiento': '2026-02-01',
        'Dias Antiguedad FAFV': '9',
        'Importe Cobrado': '1160.00',
        'Importe Original Factura': '1160.00',
        'Importe Pte Factura': '0',
        'tasa iva': 'IVA16',
        'Importe Iva Factura original': '160.00',
        'no batch': 'B-1',
      },
      {
        'Id Pago': 'PAY-1',
        CIA: '00011',
        'Fecha Cobro': '2026-02-10T00:00:00',
        'cta bancaria': '11.1020.0011302',
        Banco: 'BANAMEX',
        'No Recibo': 'RI - 90829',
        'Importe Recibo': '1740.00',
        'No Cliente': 'C-9001',
        Cliente: 'CLIENTE A',
        'Tipo Docto': 'RI',
        'No Factura': 'RI-90830',
        'Importe Cobrado': '580.00',
        'Importe Original Factura': '580.00',
        'Importe Pte Factura': '0',
        'tasa iva': 'IVA16',
        'Importe Iva Factura original': '80.00',
      },
    ]);

    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      idPago: 'PAY-1',
      cia: '00011',
      fechaCobro: '2026-02-10',
      cuentaBancaria: '11.1020.0011302',
      // No_Recibo de cobranzaindicadores se normaliza a solo dígitos
      // (últimos 8 si hubiese más) para cruzar con el banco.
      noRecibo: '90829',
      importeRecibo: 1740,
    });
    expect(payments[0].applications).toHaveLength(2);
    expect(payments[0].applications.map(app => app.importeCobrado)).toEqual([1160, 580]);
    expect(payments[0].applications.map(app => app.noFacturaNormalizada)).toEqual(['RI-90829', 'RI-90830']);
  });

  it('normaliza referencias de factura con espacios alrededor del guion', () => {
    expect(normalizeInvoiceRef('RI - 90829')).toBe(normalizeInvoiceRef('RI-90829'));
  });

  it('normaliza No_Recibo del API de bancos hacia la línea bancaria', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        cia: '11',
        Cuenta_Contable: '11.1020.0011302',
        Cuenta_Bancos: '000123',
        Nombre_cuenta_Contable: 'BANAMEX CTA',
        Fecha_Estado_Cuenta: '2026-02-10',
        Importe: '1000.00',
        Tipo_Movimiento: 'CREDITO',
        Referencia_Cliente: 'SPEI',
        No_Recibo: 'RI-100',
      },
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const statements = await fetchBankStatements({
      fechaEstadoCuenta: '2026-02-10',
      formatoElectronico: 'SWIFT',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/jde/bancos', expect.objectContaining({
      method: 'POST',
    }));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(statements[0].cia).toBe('00011');
    expect(statements[0].movimientos[0].cia).toBe('00011');
    // El banco devuelve "RI-100" → normalizado a solo dígitos: "100".
    expect(statements[0].movimientos[0].noRecibo).toBe('100');
  });

  it('recorta No_Recibo del banco a los últimos 8 dígitos para cruzar con cobranzaindicadores', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        cia: '11',
        Cuenta_Contable: '11.1020.0011302',
        Cuenta_Bancos: '000123',
        Nombre_cuenta_Contable: 'BANAMEX CTA',
        Fecha_Estado_Cuenta: '2026-02-10',
        Importe: '1000.00',
        Tipo_Movimiento: 'CREDITO',
        Referencia_Cliente: 'SPEI',
        // 14 dígitos en el banco — debemos quedarnos con los últimos 8.
        No_Recibo: '00000012345678',
      },
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const statements = await fetchBankStatements({
      fechaEstadoCuenta: '2026-02-10',
      formatoElectronico: 'SWIFT',
    });

    expect(statements[0].movimientos[0].noRecibo).toBe('12345678');
  });

  it('descarta filas de saldo-snapshot (sin transacción) pero conserva la cuenta y su saldo', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        // Fila de saldo-snapshot: Cuenta_Bancos vacío, Importe 0, sin
        // gsaid/referencia/concepto/recibo → NO es un movimiento.
        cia: '56',
        Cuenta_Bancos: '',
        Nombre_cuenta_Contable: 'BANAMEX SENDA SERVICIOS FINANCIEROS',
        Fecha_Estado_Cuenta: '2026-02-10',
        Importe: '0',
        Saldo_Inicial: '8583129.39',
        Saldo_Final: '8583129.39',
        DESC039: 'Concentradora',
      },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const statements = await fetchBankStatements({
      fechaEstadoCuenta: '2026-02-10',
      formatoElectronico: 'SWIFT',
    });

    expect(statements).toHaveLength(1);
    expect(statements[0].cia).toBe('00056');
    expect(statements[0].movimientos).toHaveLength(0);
    expect(statements[0].saldoFinal).toBe(8583129.39);
  });

  it('conserva el movimiento real y omite la fila fantasma en la misma cuenta', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        cia: '11',
        Cuenta_Contable: '11.1020.0011302',
        Cuenta_Bancos: '000777',
        Nombre_cuenta_Contable: 'BANAMEX CTA',
        Fecha_Estado_Cuenta: '2026-02-10',
        Importe: '1500.00',
        Tipo_Movimiento: 'CREDITO',
        Referencia_Cliente: 'SPEI',
        No_Recibo: 'RI-7',
        Saldo_Final: '5000.00',
      },
      {
        cia: '11',
        Cuenta_Contable: '11.1020.0011302',
        Cuenta_Bancos: '000777',
        Nombre_cuenta_Contable: 'BANAMEX CTA',
        Fecha_Estado_Cuenta: '2026-02-10',
        Importe: '0',
        Saldo_Final: '5000.00',
      },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const statements = await fetchBankStatements({
      fechaEstadoCuenta: '2026-02-10',
      formatoElectronico: 'SWIFT',
    });

    expect(statements).toHaveLength(1);
    expect(statements[0].movimientos).toHaveLength(1);
    expect(statements[0].movimientos[0].importe).toBe(1500);
    expect(statements[0].saldoFinal).toBe(5000);
  });

  it('consulta cobranzaindicadores por el proxy JDE estándar por cía', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        'Id Pago': 'PAY-1',
        CIA: '00011',
        'Fecha Cobro': '2026-04-10',
        'cta bancaria': '11.1020.0011302',
        'No Recibo': 'RI-1',
        'Importe Recibo': '1000',
        'No Factura': 'F-1',
        'Importe Cobrado': '1000',
      },
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const payments = await fetchIndicadoresCobranza({
      cia: '00011',
      fechaInicial: '2026-04-01',
      fechaFinal: '2026-04-30',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/jde/cobranzaindicadores', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        cia: '00011',
        fechaInicial: '2026-04-01',
        fechaFinal: '2026-04-30',
      }),
    }));
    expect(payments).toHaveLength(1);
    expect(payments[0].idPago).toBe('PAY-1');
  });

  it('parte cobranzaindicadores por mes para evitar timeouts de rangos largos', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { fechaInicial: string; fechaFinal: string };
      return new Response(JSON.stringify([
        {
          'Id Pago': `PAY-${body.fechaInicial}`,
          CIA: '00011',
          'Fecha Cobro': body.fechaInicial,
          'cta bancaria': '11.1020.0011302',
          'No Recibo': 'RI-1',
          'Importe Recibo': '1000',
          'No Factura': 'F-1',
          'Importe Cobrado': '1000',
        },
      ]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const payments = await fetchIndicadoresCobranzaRange(
      '00011',
      '2026-04-15',
      '2026-05-10',
      { concurrency: 1 },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/jde/cobranzaindicadores', expect.objectContaining({
      body: JSON.stringify({
        cia: '00011',
        fechaInicial: '2026-04-15',
        fechaFinal: '2026-04-30',
      }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/jde/cobranzaindicadores', expect.objectContaining({
      body: JSON.stringify({
        cia: '00011',
        fechaInicial: '2026-05-01',
        fechaFinal: '2026-05-10',
      }),
    }));
    expect(payments).toHaveLength(2);
  });
});

describe('normalizeBankAccountNumber', () => {
  const { normalizeBankAccountNumber } = __internal;

  it('quita nombre de banco, paréntesis y separadores → solo dígitos', () => {
    expect(normalizeBankAccountNumber('BANAMEX - 7014 4758151')).toBe('70144758151');
    expect(normalizeBankAccountNumber('BANAMEX 7013 8411298')).toBe('70138411298');
    expect(normalizeBankAccountNumber('BANAMEX 7013 8805164 (expresso escolar)')).toBe('70138805164');
    expect(normalizeBankAccountNumber('BANAMEX - 7014 26369')).toBe('701426369');
    expect(normalizeBankAccountNumber('0577 117543')).toBe('0577117543');
  });

  it('preserva el texto si no hay dígitos y vacío si vacío', () => {
    expect(normalizeBankAccountNumber('SIN CUENTA')).toBe('SIN CUENTA');
    expect(normalizeBankAccountNumber('')).toBe('');
    expect(normalizeBankAccountNumber(null)).toBe('');
  });
});

describe('fetchBankStatements — cuenta canónica', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('canoniza la cuenta a dígitos aunque venga etiquetada en Nombre_cuenta_Contable', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      {
        cia: '56',
        Cuenta_Contable: '56.1020.0011302',
        Cuenta_Bancos: '',
        Nombre_cuenta_Contable: 'BANAMEX - 7014 4758151',
        Fecha_Estado_Cuenta: '2026-02-10',
        Importe: '100.00',
        Tipo_Movimiento: 'CREDITO',
        Referencia_Cliente: 'SPEI',
        No_Recibo: 'RI-5',
        Saldo_Final: '999.00',
      },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const statements = await fetchBankStatements({
      fechaEstadoCuenta: '2026-02-10',
      formatoElectronico: 'SWIFT',
    });

    expect(statements).toHaveLength(1);
    expect(statements[0].cuenta).toBe('70144758151');
  });
});

describe('Nómina (TRESS) — mapNominaRow', () => {
  const { mapNominaRow, inferCashTreatment } = __internal;

  // Registro representativo del API productivo. El typo `Fechainical` está
  // deliberadamente presente: el contrato real lo tiene así.
  const baseRow = {
    IDEmpresa: 1,
    Empresa: 'TAMAULIPAS FEDERAL',
    Monto: 916049.74,
    Periodo: 18,
    Mes: 'MAYO',
    IDConcepto: 1,
    Concepto: 'SUELDO ORDINARIO',
    TipoNomina: 'Semanal',
    TipoConcepto: 'Percepción',
    Fechainical: '2026-04-27T00:00:00',
    FechaFinal: '2026-05-03T00:00:00',
    FechaPago: '2026-05-07T00:00:00',
  };

  it('mapea el typo `Fechainical` y trimea fechas a YYYY-MM-DD', () => {
    const r = mapNominaRow(baseRow);
    expect(r.periodStartDate).toBe('2026-04-27');
    expect(r.periodEndDate).toBe('2026-05-03');
    expect(r.paymentDate).toBe('2026-05-07');
  });

  it('normaliza la cia con padding a 5 dígitos (IDEmpresa=1 → "00001")', () => {
    expect(mapNominaRow(baseRow).cia).toBe('00001');
    expect(mapNominaRow({ ...baseRow, IDEmpresa: 11 }).cia).toBe('00011');
    expect(mapNominaRow({ ...baseRow, IDEmpresa: 42 }).cia).toBe('00042');
  });

  it('infiere year/month desde FechaPago', () => {
    const r = mapNominaRow(baseRow);
    expect(r.year).toBe(2026);
    expect(r.month).toBe(5);
  });

  it('preserva conceptos, periodo y monto sin re-redondear', () => {
    const r = mapNominaRow(baseRow);
    expect(r.amount).toBe(916049.74);
    expect(r.payrollPeriod).toBe(18);
    expect(r.payrollType).toBe('Semanal');
    expect(r.conceptId).toBe(1);
    expect(r.conceptName).toBe('SUELDO ORDINARIO');
    expect(r.conceptType).toBe('Percepción');
  });

  describe('cashTreatment table cubre todos los TipoConcepto esperados', () => {
    it('Percepción → CASH_OUT', () => {
      expect(inferCashTreatment('Percepción')).toBe('CASH_OUT');
    });
    it('Deducción → DEDUCTION', () => {
      expect(inferCashTreatment('Deducción')).toBe('DEDUCTION');
    });
    it('Aportación → EMPLOYER_TAX', () => {
      expect(inferCashTreatment('Aportación')).toBe('EMPLOYER_TAX');
    });
    it('Aportación Patronal → EMPLOYER_TAX (substring match)', () => {
      expect(inferCashTreatment('Aportación Patronal')).toBe('EMPLOYER_TAX');
    });
    it('Informativo → NON_CASH', () => {
      expect(inferCashTreatment('Informativo')).toBe('NON_CASH');
    });
    it('Obligación Empresa → EMPLOYER_TAX (TRESS prod, refinado a NON_CASH/WITHHOLDING_PAYABLE para exentos/ISR)', () => {
      expect(inferCashTreatment('Obligación Empresa')).toBe('EMPLOYER_TAX');
      expect(inferCashTreatment('Obligacion Empresa')).toBe('EMPLOYER_TAX');
    });
    it('Prestación → NON_CASH (mayoría son vales; CASH_OUT real lo promueve refineCashTreatment)', () => {
      expect(inferCashTreatment('Prestación')).toBe('NON_CASH');
      expect(inferCashTreatment('Prestacion')).toBe('NON_CASH');
    });
    it('TipoConcepto vacío o desconocido → NON_CASH (conservador)', () => {
      expect(inferCashTreatment('')).toBe('NON_CASH');
      expect(inferCashTreatment('Algo Raro Que No Existe')).toBe('NON_CASH');
    });
  });

  it('Σ amount events == bruto bruto del periodo (snapshot básico)', () => {
    // Fixture con un periodo completo: percepciones + deducciones + patronal.
    // El test asegura que el mapper preserve los montos exactos para que
    // payrollModuleService pueda hacer la fórmula del cash neto sin pérdida.
    const periodo = [
      { ...baseRow, IDConcepto: 1, Concepto: 'SUELDO ORDINARIO', TipoConcepto: 'Percepción', Monto: 100_000 },
      { ...baseRow, IDConcepto: 2, Concepto: 'BONO PUNTUALIDAD', TipoConcepto: 'Percepción', Monto: 5_000 },
      { ...baseRow, IDConcepto: 90, Concepto: 'ISR', TipoConcepto: 'Deducción', Monto: 15_000 },
      { ...baseRow, IDConcepto: 91, Concepto: 'IMSS EMPLEADO', TipoConcepto: 'Deducción', Monto: 2_500 },
      { ...baseRow, IDConcepto: 200, Concepto: 'IMSS PATRONAL', TipoConcepto: 'Aportación Patronal', Monto: 18_000 },
    ];
    const mapped = periodo.map(mapNominaRow);

    const percepciones = mapped.filter(r => r.cashTreatment === 'CASH_OUT').reduce((s, r) => s + r.amount, 0);
    const deducciones = mapped.filter(r => r.cashTreatment === 'DEDUCTION').reduce((s, r) => s + r.amount, 0);
    const patronal = mapped.filter(r => r.cashTreatment === 'EMPLOYER_TAX').reduce((s, r) => s + r.amount, 0);

    expect(percepciones).toBe(105_000);
    expect(deducciones).toBe(17_500);
    expect(patronal).toBe(18_000);
    // Cash neto al empleado en FechaPago = Σ Percepciones − Σ Deducciones que reducen pago.
    // (La distinción WITHHOLDING_PAYABLE vs DEDUCTION fina vive en payrollModuleService PR2.)
    expect(percepciones - deducciones).toBe(87_500);
  });

  it('rellena array vacío sin error si el API devuelve { data: [] }', async () => {
    // idEmpresa=99 dispara el fan-out (POST por empresa 1/11/17/42 + red de
    // seguridad), así que el mock debe devolver un Response NUEVO por llamada:
    // un solo Response compartido consume su body en la 1ª lectura y la 2ª
    // revienta como "Respuesta no es JSON válido".
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: 200, success: true, message: 'OK', data: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchNomina({ idEmpresa: 99, tipoNomina: 99, anio: 2026, mes: 5 });

    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/tress/Nomina'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ idEmpresa: 99, tipoNomina: 99, anio: 2026, mes: 5 }),
      }),
    );
  });

  it('trocea por tipoNómina cuando la response trae percepciones/deducciones pero ninguna aportación (truncamiento de EMPLOYER_TAX)', async () => {
    // Firma específica del bug: el gateway corta el bloque de Obligación
    // Empresa, así que la nómina llega "completa" salvo las aportaciones →
    // Aportaciones = $0 en la UI. `isNominaResponseSuspect` no la detecta
    // (tiene deducciones), así que sin `nominaLacksEmployerTax` el troceo por
    // tipoNómina nunca disparaba.
    const sinAportacion = [
      { ...baseRow, TipoConcepto: 'Percepción', Monto: 100_000 },
      { ...baseRow, TipoConcepto: 'Deducción', Monto: 15_000 },
    ];
    const conAportacion = [
      ...sinAportacion,
      { ...baseRow, TipoConcepto: 'Aportación Patronal', Monto: 18_000 },
    ];
    const tipoCalls: number[] = [];
    const fetchMock = vi.fn(async (_url: string, options: { body: string }) => {
      const body = JSON.parse(options.body) as { tipoNomina: number };
      tipoCalls.push(body.tipoNomina);
      // tipoNomina=99 (empresa-level) llega truncado; el split por tipo 1/3 sí
      // trae las aportaciones.
      const data = body.tipoNomina === 99 ? sinAportacion : conAportacion;
      return new Response(
        JSON.stringify({ status: 200, success: true, message: 'OK', data }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchNomina({ idEmpresa: 99, tipoNomina: 99, anio: 2026, mes: 5 });

    // El troceo disparó sub-requests por tipoNómina 1 y 3 para cada empresa.
    expect(tipoCalls).toContain(1);
    expect(tipoCalls).toContain(3);
    // Y el resultado final ya incluye aportaciones (EMPLOYER_TAX).
    expect(result.some(r => r.cashTreatment === 'EMPLOYER_TAX')).toBe(true);
  });
});
