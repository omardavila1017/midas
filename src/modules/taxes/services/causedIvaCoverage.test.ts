import { describe, expect, it } from 'vitest';
import type { CobranzaPayment, CobranzaRecord } from '../../../services/jdeTypes';
import {
  assessCausedIvaCoverage,
  implausibleCausedIvaPeriods,
  DEFAULT_MIN_EXPECTED_IVA,
} from './causedIvaCoverage';

function payment(partial: {
  cia?: string;
  fechaCobro: string;
  apps: Array<{ cobrado: number; original: number; iva: number }>;
}): CobranzaPayment {
  return {
    cia: partial.cia ?? '00011',
    idPago: 1,
    fechaCobro: partial.fechaCobro,
    importeRecibo: partial.apps.reduce((sum, a) => sum + a.cobrado, 0),
    applications: partial.apps.map((a, i) => ({
      noFactura: `F-${i}`,
      fechaAplicacion: partial.fechaCobro,
      importeCobrado: a.cobrado,
      importeOriginalFactura: a.original,
      importeIvaFacturaOriginal: a.iva,
    })),
  } as unknown as CobranzaPayment;
}

function invoice(partial: { cia?: string; fechaCobro: string; iva: number }): CobranzaRecord {
  return {
    cia: partial.cia ?? '00011',
    fechaCobro: partial.fechaCobro,
    importeIVA: partial.iva,
  } as unknown as CobranzaRecord;
}

const CURRENT = '2026-08';

/**
 * Regla de reconocimiento para estas pruebas: sólo el prorrateo por la porción
 * cobrada. Se inyecta explícita porque el módulo NO tiene default — la regla
 * real vive en `taxModuleService` y su equivalencia con el motor se prueba allá
 * ("la cobertura mide lo mismo que el motor suma"). Aquí lo que se prueba es la
 * comparación (umbrales, periodo en curso, filtros), no el reconocimiento.
 */
const prorate = (app: CobranzaPayment['applications'][number]): number => {
  const cobrado = app.importeCobrado;
  const original = app.importeOriginalFactura;
  const iva = app.importeIvaFacturaOriginal;
  return original > 0 && iva > 0 ? iva * Math.min(1, cobrado / original) : 0;
};

describe('assessCausedIvaCoverage', () => {
  it('marca implausible el periodo cerrado cuya tabla de aplicaciones viene vacía', () => {
    // Marzo 2026 medido en la BD: la tabla de aplicaciones trae una fracción
    // mínima del cobro real, así que el causado sale ~98% bajo.
    const coverage = assessCausedIvaCoverage({
      recognizeIva: prorate,
      payments: [payment({ fechaCobro: '2026-03-10', apps: [{ cobrado: 1_000_000, original: 1_000_000, iva: 616_766 }] })],
      invoices: [invoice({ fechaCobro: '2026-03-12', iva: 35_362_508 })],
      currentPeriod: CURRENT,
    });
    const march = coverage.get('2026-03');
    expect(march?.implausible).toBe(true);
    expect(march?.coverageRatio).toBeLessThan(0.05);
    expect(march?.expectedIva).toBe(35_362_508);
  });

  it('no marca un periodo con cobertura completa', () => {
    const coverage = assessCausedIvaCoverage({
      recognizeIva: prorate,
      payments: [payment({ fechaCobro: '2026-07-10', apps: [{ cobrado: 1_000_000, original: 1_000_000, iva: 25_000_000 }] })],
      invoices: [invoice({ fechaCobro: '2026-07-12', iva: 25_894_778 })],
      currentPeriod: CURRENT,
    });
    expect(coverage.get('2026-07')?.implausible).toBe(false);
  });

  it('nunca marca el periodo en curso: sus dos lados están parciales a propósito', () => {
    const coverage = assessCausedIvaCoverage({
      recognizeIva: prorate,
      payments: [],
      invoices: [invoice({ fechaCobro: '2026-08-03', iva: 8_116_019 })],
      currentPeriod: CURRENT,
    });
    const august = coverage.get('2026-08');
    expect(august?.coverageRatio).toBe(0);
    expect(august?.implausible).toBe(false);
  });

  it('no marca periodos por debajo del piso de materialidad', () => {
    const coverage = assessCausedIvaCoverage({
      recognizeIva: prorate,
      payments: [],
      invoices: [invoice({ fechaCobro: '2026-02-05', iva: DEFAULT_MIN_EXPECTED_IVA - 1 })],
      currentPeriod: CURRENT,
    });
    expect(coverage.get('2026-02')?.implausible).toBe(false);
  });

  it('replica el prorrateo del motor: IVA de la factura por la porción cobrada', () => {
    const coverage = assessCausedIvaCoverage({
      recognizeIva: prorate,
      payments: [payment({ fechaCobro: '2026-04-10', apps: [{ cobrado: 250, original: 1_000, iva: 160 }] })],
      invoices: [],
      currentPeriod: CURRENT,
    });
    // 160 × (250 / 1 000) = 40
    expect(coverage.get('2026-04')?.reportedIva).toBeCloseTo(40, 6);
  });

  it('respeta el filtro por compañía y el rango de fechas', () => {
    const coverage = assessCausedIvaCoverage({
      recognizeIva: prorate,
      payments: [
        payment({ cia: '00011', fechaCobro: '2026-03-10', apps: [{ cobrado: 100, original: 100, iva: 16 }] }),
        payment({ cia: '00038', fechaCobro: '2026-03-10', apps: [{ cobrado: 900, original: 900, iva: 144 }] }),
      ],
      invoices: [
        invoice({ cia: '00011', fechaCobro: '2026-03-11', iva: 20 }),
        invoice({ cia: '00038', fechaCobro: '2026-03-11', iva: 500 }),
        invoice({ cia: '00011', fechaCobro: '2025-12-31', iva: 9_999 }),
      ],
      companyCode: '00011',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      currentPeriod: CURRENT,
    });
    expect(coverage.get('2026-03')?.reportedIva).toBe(16);
    expect(coverage.get('2026-03')?.expectedIva).toBe(20);
    expect(coverage.has('2025-12')).toBe(false);
  });

  it('sin referencia independiente no inventa un veredicto', () => {
    const coverage = assessCausedIvaCoverage({
      recognizeIva: prorate,
      payments: [payment({ fechaCobro: '2026-03-10', apps: [{ cobrado: 100, original: 100, iva: 16 }] })],
      invoices: [],
      currentPeriod: CURRENT,
    });
    const march = coverage.get('2026-03');
    expect(march?.coverageRatio).toBeNull();
    expect(march?.implausible).toBe(false);
  });
});

describe('implausibleCausedIvaPeriods', () => {
  it('lista sólo los marcados, en orden cronológico', () => {
    const coverage = assessCausedIvaCoverage({
      recognizeIva: prorate,
      payments: [payment({ fechaCobro: '2026-07-10', apps: [{ cobrado: 1_000, original: 1_000, iva: 25_000_000 }] })],
      invoices: [
        invoice({ fechaCobro: '2026-05-12', iva: 39_568_602 }),
        invoice({ fechaCobro: '2026-03-12', iva: 35_362_508 }),
        invoice({ fechaCobro: '2026-07-12', iva: 25_894_778 }),
      ],
      currentPeriod: CURRENT,
    });
    expect(implausibleCausedIvaPeriods(coverage).map((e) => e.period)).toEqual(['2026-03', '2026-05']);
  });
});
