import { describe, it, expect } from 'vitest';
import {
  planCobranzaRefresh,
  mergeCobranzaRevalidationWindow,
  isFreshTimestamp,
  COBRANZA_AUTO_REFRESH_TTL_MS,
  COBRANZA_LOOKBACK_DAYS,
  COBRANZA_REVALIDATE_DAYS,
} from './cobranzaRefreshWindow';
import type { CobranzaRecord } from '../services/jdeTypes';

// Reloj fijo: 2026-07-09T12:00:00Z. El hueco reportado (caso 6-jul: Headsheet/
// ABB/Copamex ausentes) ocurre cuando el heavy-store SOBREVIVE el boot y la cía
// se consideraba "fresca" (< TTL) → se saltaba entera y las facturas dadas de
// alta después del último fetch nunca cargaban.
const NOW_MS = Date.parse('2026-07-09T12:00:00Z');
const FRESH = '2026-07-09T07:00:00.000Z'; // hace 5h  (< TTL 6h)
const STALE = '2026-07-09T05:00:00.000Z'; // hace 7h  (> TTL 6h)
const TODAY = '2026-07-09';
const FULL_FROM = '2024-07-09';      // isoDaysBefore(TODAY, 730)
const REVALIDATE_FROM = '2026-05-25'; // isoDaysBefore(TODAY, 45)

function baseInput(overrides: Partial<Parameters<typeof planCobranzaRefresh>[0]> = {}) {
  return {
    activeCias: ['00001', '00011'],
    force: false,
    heavyHydrated: true,
    recordsLoadedCias: { '00001': FRESH, '00011': FRESH } as Record<string, string | undefined>,
    paymentsLoadedCias: { '00001': FRESH, '00011': FRESH } as Record<string, string | undefined>,
    nowMs: NOW_MS,
    ...overrides,
  };
}

function rec(over: Partial<CobranzaRecord> & { cia: string; noFactura: string; fechaFactura: string }): CobranzaRecord {
  return {
    noCliente: '1',
    nombreCliente: 'X',
    fechaVence: over.fechaFactura,
    fechaCobro: '',
    diasVencida: 0,
    importeBrutoPesos: 100,
    importePendientePesos: 100,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXN',
    condPago: '',
    estatus: 'PENDIENTE',
    tipoCambio: 1,
    ...over,
  };
}

describe('planCobranzaRefresh', () => {
  it('force=true → todas las cías en modo full (refresh manual)', () => {
    const plans = planCobranzaRefresh(baseInput({ force: true }));
    expect(plans.every(p => p.mode === 'full')).toBe(true);
    expect(plans[0]).toEqual({ cia: '00001', mode: 'full', from: FULL_FROM, to: TODAY });
  });

  it('heavyHydrated=false → todas full aunque los timestamps sean frescos (desync guard)', () => {
    const plans = planCobranzaRefresh(baseInput({ heavyHydrated: false }));
    expect(plans.every(p => p.mode === 'full')).toBe(true);
  });

  it('cía fresca en records Y payments → revalidate con ventana reciente', () => {
    const plans = planCobranzaRefresh(baseInput());
    expect(plans).toEqual([
      { cia: '00001', mode: 'revalidate', from: REVALIDATE_FROM, to: TODAY },
      { cia: '00011', mode: 'revalidate', from: REVALIDATE_FROM, to: TODAY },
    ]);
  });

  it('cía fresca en records pero STALE en payments → full (el gate es un OR)', () => {
    const plans = planCobranzaRefresh(baseInput({
      paymentsLoadedCias: { '00001': STALE, '00011': FRESH },
    }));
    expect(plans.find(p => p.cia === '00001')?.mode).toBe('full');
    expect(plans.find(p => p.cia === '00011')?.mode).toBe('revalidate');
  });

  it('cía sin timestamp (nueva) → full', () => {
    const plans = planCobranzaRefresh(baseInput({
      recordsLoadedCias: { '00001': FRESH },        // 00011 ausente
      paymentsLoadedCias: { '00001': FRESH },
    }));
    expect(plans.find(p => p.cia === '00011')?.mode).toBe('full');
  });

  it('constantes por defecto documentadas', () => {
    expect(COBRANZA_LOOKBACK_DAYS).toBe(730);
    expect(COBRANZA_REVALIDATE_DAYS).toBe(45);
    expect(COBRANZA_AUTO_REFRESH_TTL_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe('isFreshTimestamp (nowMs inyectado)', () => {
  it('< TTL es fresco, > TTL es stale, ausente/NaN es stale', () => {
    expect(isFreshTimestamp(FRESH, COBRANZA_AUTO_REFRESH_TTL_MS, NOW_MS)).toBe(true);
    expect(isFreshTimestamp(STALE, COBRANZA_AUTO_REFRESH_TTL_MS, NOW_MS)).toBe(false);
    expect(isFreshTimestamp(undefined, COBRANZA_AUTO_REFRESH_TTL_MS, NOW_MS)).toBe(false);
    expect(isFreshTimestamp('no-es-fecha', COBRANZA_AUTO_REFRESH_TTL_MS, NOW_MS)).toBe(false);
  });
});

describe('mergeCobranzaRevalidationWindow', () => {
  it('REPRODUCE EL HUECO: una factura nueva dentro de la ventana aparece tras el merge', () => {
    // Estado hidratado del navegador (cía fresca) — SIN la factura de Headsheet
    // porque se dio de alta en JDE después del último fetch full.
    const existing = [
      rec({ cia: '00001', noFactura: 'RI-100', fechaFactura: '2026-04-01', nombreCliente: 'Cliente viejo' }),
    ];
    // La ventana de revalidación [2026-05-25, hoy] SÍ trae la factura nueva.
    const windowRecords = [
      rec({ cia: '00001', noFactura: 'RI-200', fechaFactura: '2026-07-06', nombreCliente: 'HEADSHEET' }),
    ];
    const merged = mergeCobranzaRevalidationWindow(existing, windowRecords, REVALIDATE_FROM);
    expect(merged.map(r => r.nombreCliente)).toContain('HEADSHEET');
    // La histórica anterior a la ventana se conserva.
    expect(merged.map(r => r.noFactura)).toEqual(expect.arrayContaining(['RI-100', 'RI-200']));
    expect(merged).toHaveLength(2);
  });

  it('conserva la historia anterior a la ventana intacta', () => {
    const existing = [
      rec({ cia: '00001', noFactura: 'A', fechaFactura: '2025-01-01' }),
      rec({ cia: '00001', noFactura: 'B', fechaFactura: '2026-05-01' }),
    ];
    const merged = mergeCobranzaRevalidationWindow(existing, [], REVALIDATE_FROM);
    // Ambas son < 2026-05-25 → se conservan; la ventana vino vacía.
    expect(merged.map(r => r.noFactura)).toEqual(['A', 'B']);
  });

  it('actualiza una factura reemitida en la ventana sin duplicar (mismo folio)', () => {
    const existing = [
      rec({ cia: '00001', noFactura: 'RI-300', fechaFactura: '2026-06-01', importePendientePesos: 100 }),
    ];
    // El servidor filtra por una fecha que reubica RI-300 en la ventana con
    // importe actualizado (ya cobrada → pendiente 0).
    const windowRecords = [
      rec({ cia: '00001', noFactura: 'RI-300', fechaFactura: '2026-06-01', importePendientePesos: 0 }),
    ];
    const merged = mergeCobranzaRevalidationWindow(existing, windowRecords, REVALIDATE_FROM);
    expect(merged).toHaveLength(1);
    expect(merged[0].importePendientePesos).toBe(0);
  });

  it('no duplica una factura de emisión VIEJA que reaparece en la ventana (server filtra por otra fecha)', () => {
    const existing = [
      rec({ cia: '00001', noFactura: 'RI-400', fechaFactura: '2026-01-15', importePendientePesos: 500 }),
    ];
    // fechaFactura vieja (< ventana) pero el server la devolvió en la ventana
    // (p.ej. filtra por fecha contable/pago). No debe duplicarse.
    const windowRecords = [
      rec({ cia: '00001', noFactura: 'RI-400', fechaFactura: '2026-01-15', importePendientePesos: 250 }),
    ];
    const merged = mergeCobranzaRevalidationWindow(existing, windowRecords, REVALIDATE_FROM);
    expect(merged).toHaveLength(1);
    expect(merged[0].importePendientePesos).toBe(250); // gana la ventana
  });

  it('no colapsa facturas multi-línea con folio vacío fuera de la ventana', () => {
    const existing = [
      rec({ cia: '00001', noFactura: '', fechaFactura: '2025-03-01', importePendientePesos: 10 }),
      rec({ cia: '00001', noFactura: '', fechaFactura: '2025-03-02', importePendientePesos: 20 }),
    ];
    const merged = mergeCobranzaRevalidationWindow(existing, [], REVALIDATE_FROM);
    // Ambas se conservan (no se colapsan bajo una llave `${cia}::`).
    expect(merged).toHaveLength(2);
    expect(merged.map(r => r.importePendientePesos)).toEqual([10, 20]);
  });

  it('remueve del set una factura que estaba en la ventana pero JDE ya no devuelve', () => {
    const existing = [
      rec({ cia: '00001', noFactura: 'VIEJA', fechaFactura: '2025-02-01' }), // fuera de ventana → se conserva
      rec({ cia: '00001', noFactura: 'CANCELADA', fechaFactura: '2026-06-10' }), // dentro de ventana
    ];
    // La ventana ya no trae CANCELADA (se anuló en JDE) → cae del set.
    const windowRecords = [
      rec({ cia: '00001', noFactura: 'RI-500', fechaFactura: '2026-06-20' }),
    ];
    const merged = mergeCobranzaRevalidationWindow(existing, windowRecords, REVALIDATE_FROM);
    expect(merged.map(r => r.noFactura).sort()).toEqual(['RI-500', 'VIEJA']);
  });
});
