import type { CobranzaRecord } from '../services/jdeTypes';

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Venta NETA (sin IVA) de una factura de cobranza, con fallbacks tolerantes:
 *   1. `subTotal` directo si viene poblado.
 *   2. `importeBrutoPesos - importeIVA` cuando el IVA viene explícito (incluye
 *      el caso exento, IVA=0 → regresa el bruto, que ya es sin IVA).
 *   3. Sin dato de IVA: estima asumiendo 16% (estándar MX) — `bruto / 1.16`.
 *
 * FUENTE ÚNICA — no reimplementes esta fórmula ni leas `importeBrutoPesos`
 * crudo para presentar "venta". `importeBrutoPesos` es el importe CON IVA, así
 * que usarlo bajo una etiqueta "sin IVA" no sólo infla la cifra un 16%: si
 * encima se le aplica IVA para derivar un total, el impuesto se cobra dos veces
 * (fue exactamente el defecto de Clientes → "Total con IVA" = bruto × 1.16).
 * Venta y Clientes consumen esta función para que las dos superficies no puedan
 * discrepar sobre el mismo hecho.
 */
export function cobranzaVenta(r: CobranzaRecord): number {
  if (isFinitePositive(r.subTotal)) return r.subTotal;
  const bruto = Number.isFinite(r.importeBrutoPesos) ? r.importeBrutoPesos : 0;
  if (typeof r.importeIVA === 'number' && Number.isFinite(r.importeIVA)) {
    const net = bruto - r.importeIVA;
    return net > 0 ? net : bruto;
  }
  return bruto > 0 ? bruto / 1.16 : 0;
}
