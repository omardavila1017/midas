import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBankStatements, fetchIndicadoresCobranza, normalizeCobranzaPayments, normalizeInvoiceRef } from './jde';

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
      noRecibo: 'RI - 90829',
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
    expect(statements[0].cia).toBe('00011');
    expect(statements[0].movimientos[0].cia).toBe('00011');
    expect(statements[0].movimientos[0].noRecibo).toBe('RI-100');
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
