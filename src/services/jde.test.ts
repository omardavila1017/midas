import { afterEach, describe, expect, it, vi } from 'vitest';
import { __internal, fetchBankStatements, fetchIndicadoresCobranza, fetchNomina, normalizeCobranzaPayments, normalizeInvoiceRef } from './jde';

afterEach(() => {
  vi.unstubAllGlobals();
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
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
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
});
