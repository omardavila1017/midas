import { describe, expect, it } from 'vitest';
import {
  buildCobranzaByAccount,
  computeMonthlyBillingFromRecords,
  isCancelledInvoice,
} from './clientBillingHistory';
import type { CobranzaRecord } from '../services/jdeTypes';

function inv(partial: Partial<CobranzaRecord>): CobranzaRecord {
  return {
    cia: '00011',
    noCliente: '1',
    nombreCliente: 'Cliente A',
    noFactura: 'RI-1',
    fechaFactura: '2026-03-10',
    fechaVence: '',
    fechaCobro: '',
    diasVencida: 0,
    importeBrutoPesos: 1000,
    // Exenta por defecto (IVA=0) para que el bruto de cada fixture YA sea la
    // venta neta: así estos casos siguen midiendo lo suyo (meses, cancelados,
    // post-fechadas) y no la conversión sin-IVA, que tiene sus propios tests.
    importeIVA: 0,
    importePendientePesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXP',
    condPago: '',
    estatus: 'COBRADA',
    tipoCambio: 1,
    ...partial,
  } as CobranzaRecord;
}

const YEAR = 2026;
// "Hoy" = julio 2026 (índice de mes 6).
const REFERENCE_MONTH = YEAR * 12 + 6;

describe('isCancelledInvoice', () => {
  it('detects CANCELADA / ANULADA regardless of case', () => {
    expect(isCancelledInvoice(inv({ estatus: 'CANCELADA' }))).toBe(true);
    expect(isCancelledInvoice(inv({ estatus: 'cancelado' }))).toBe(true);
    expect(isCancelledInvoice(inv({ estatus: 'ANULADA' }))).toBe(true);
    expect(isCancelledInvoice(inv({ estatus: 'COBRADA' }))).toBe(false);
    expect(isCancelledInvoice(inv({ estatus: 'PENDIENTE' }))).toBe(false);
  });
});

describe('buildCobranzaByAccount', () => {
  it('keys by cia::noCliente', () => {
    const map = buildCobranzaByAccount([inv({ cia: '00011', noCliente: '7' }), inv({ cia: '00011', noCliente: '7' })]);
    expect(map.get('00011::7')).toHaveLength(2);
  });
});

describe('computeMonthlyBillingFromRecords — B2.7', () => {
  it('sums non-cancelled invoices into their fechaFactura month', () => {
    const b = computeMonthlyBillingFromRecords(
      [inv({ fechaFactura: '2026-03-10', importeBrutoPesos: 1000 }), inv({ fechaFactura: '2026-03-20', importeBrutoPesos: 500 })],
      YEAR,
      REFERENCE_MONTH,
    );
    expect(b.values[2]).toBe(1500); // marzo (índice 2)
    expect(b.isHistorical[2]).toBe(true);
    expect(b.invoiceCount).toBe(2);
  });

  it('excludes cancelled invoices from billing (sin cancelados)', () => {
    const b = computeMonthlyBillingFromRecords(
      [
        inv({ fechaFactura: '2026-03-10', importeBrutoPesos: 1000, estatus: 'COBRADA' }),
        inv({ fechaFactura: '2026-03-15', importeBrutoPesos: 9999, estatus: 'CANCELADA' }),
      ],
      YEAR,
      REFERENCE_MONTH,
    );
    expect(b.values[2]).toBe(1000); // la cancelada de 9999 NO cuenta
    expect(b.invoiceCount).toBe(1);
  });

  /**
   * La UI rotula esta serie "Facturación mensual (sin IVA)" y encima deriva
   * "IVA (16%)" y "Total con IVA" multiplicándola. Sumar `importeBrutoPesos`
   * —que viene CON IVA— inflaba la base 16% y cobraba el impuesto dos veces.
   */
  it('suma la venta NETA, no el bruto con IVA', () => {
    const b = computeMonthlyBillingFromRecords(
      [inv({ fechaFactura: '2026-03-10', importeBrutoPesos: 11_600, importeIVA: 1_600 })],
      YEAR,
      REFERENCE_MONTH,
    );
    expect(b.values[2]).toBe(10_000);
  });

  it('prefiere subTotal cuando viene poblado', () => {
    const b = computeMonthlyBillingFromRecords(
      [inv({ fechaFactura: '2026-03-10', importeBrutoPesos: 11_600, subTotal: 10_000 })],
      YEAR,
      REFERENCE_MONTH,
    );
    expect(b.values[2]).toBe(10_000);
  });

  it('estima al 16% cuando la factura no trae desglose de IVA', () => {
    const b = computeMonthlyBillingFromRecords(
      [inv({ fechaFactura: '2026-03-10', importeBrutoPesos: 11_600, importeIVA: undefined })],
      YEAR,
      REFERENCE_MONTH,
    );
    expect(b.values[2]).toBeCloseTo(10_000, 6);
  });

  it('ignores post-dated invoices beyond the reference month (hasta fecha reciente)', () => {
    const b = computeMonthlyBillingFromRecords(
      [
        inv({ fechaFactura: '2026-03-10', importeBrutoPesos: 1000 }),
        inv({ fechaFactura: '2026-11-01', importeBrutoPesos: 8888 }), // futuro > julio
      ],
      YEAR,
      REFERENCE_MONTH,
    );
    expect(b.invoiceCount).toBe(1);
    // Noviembre (índice 10) es futuro → proyección, NO el 8888 post-fechado.
    expect(b.values[10]).not.toBe(8888);
  });

  it('marks past months historical and future months as projection', () => {
    const b = computeMonthlyBillingFromRecords(
      [
        inv({ fechaFactura: '2026-01-15', importeBrutoPesos: 1000 }),
        inv({ fechaFactura: '2026-02-15', importeBrutoPesos: 1200 }),
      ],
      YEAR,
      REFERENCE_MONTH,
    );
    expect(b.isHistorical[0]).toBe(true); // enero
    expect(b.isHistorical[1]).toBe(true); // febrero
    expect(b.isHistorical[8]).toBe(false); // septiembre (futuro)
    expect(b.historicalMonths).toBe(REFERENCE_MONTH - YEAR * 12); // ene..jun = 6
    expect(b.values[8]).toBeGreaterThan(0); // pronóstico por regresión
  });
});
