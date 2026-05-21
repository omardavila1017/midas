/**
 * providerRecentSpend — promedio de pagos por proveedor en una ventana
 * rolling de N meses calendario.
 *
 * Reemplaza el `gastoMinimoMensual` precomputado del catálogo (basado en
 * 2025 completo × multiplicador de frecuencia) con un cálculo en tiempo
 * real desde `PagoProveedorRecord` (pagos efectivamente ejecutados).
 *
 * El "promedio mes" es: Σ pagos en los últimos N meses / N.
 * Para mantener el comportamiento estable, "últimos N meses" cuenta meses
 * calendario COMPLETOS anteriores al mes en curso. Hoy 2026-05-13 con
 * N=3 → ene, feb, mar… no, espera: feb, mar, abr 2026. El mes en curso
 * está incompleto y arrastra el promedio hacia abajo.
 */

import type { PagoProveedorRecord } from '../services/jdeTypes';
import type { Provider } from './types';
import { normalizeJdeKey, normalizeProviderName } from './providerIdentity';
import { todayISO } from '../formatters';

export interface ProviderSpendStats {
  totalSpend: number;
  monthlyAverage: number;
  paymentCount: number;
  monthsCovered: number;
  monthsInWindow: number;
  lastPaymentDate?: string;
}

export interface ProviderSpendIndex {
  byJde: Map<string, ProviderSpendStats>;
  byName: Map<string, ProviderSpendStats>;
  windowStart: string; // ISO date inclusive
  windowEnd: string;   // ISO date inclusive
  monthsInWindow: number;
}

interface BuildOptions {
  /** Cuántos meses calendario completos hacia atrás. Default 3. */
  months?: number;
  /** Fecha "hoy" para anclar la ventana. Default: today UTC. */
  asOfDate?: string;
}

/**
 * Devuelve la ventana [startISO, endISO] de N meses calendario completos
 * anteriores al mes de `asOfDate`. Ej: asOf=2026-05-13, months=3 →
 * { start: '2026-02-01', end: '2026-04-30' }.
 */
export function recentSpendWindow(asOfDate: string, months = 3): { start: string; end: string } {
  const safe = /^\d{4}-\d{2}-\d{2}/.test(asOfDate)
    ? asOfDate.slice(0, 10)
    : todayISO();
  const [y, m] = safe.split('-').map(Number);
  // Fin: último día del mes anterior al mes en curso.
  const endDate = new Date(Date.UTC(y, m - 1, 0));
  // Inicio: primer día del mes (months-1) más atrás desde endDate.
  const startMonth = endDate.getUTCMonth() - (months - 1);
  const startYear = endDate.getUTCFullYear() + Math.floor(startMonth / 12);
  const safeMonth = ((startMonth % 12) + 12) % 12;
  const startDate = new Date(Date.UTC(startYear, safeMonth, 1));
  return {
    start: startDate.toISOString().slice(0, 10),
    end: endDate.toISOString().slice(0, 10),
  };
}

/**
 * Construye un índice de gasto promedio por proveedor desde pagos reales.
 * Sólo cuenta pagos a proveedores (no a empleados — vale/nómina/reembolsos).
 */
export function buildProviderSpendIndex(
  pagos: PagoProveedorRecord[],
  options: BuildOptions = {},
): ProviderSpendIndex {
  const months = options.months ?? 3;
  const asOfDate = options.asOfDate ?? todayISO();
  const { start, end } = recentSpendWindow(asOfDate, months);

  interface Acc {
    totalSpend: number;
    paymentCount: number;
    monthsTouched: Set<string>;
    lastPaymentDate?: string;
    name: string;
  }
  const accByJde = new Map<string, Acc>();
  const accByName = new Map<string, Acc>();

  for (const pago of pagos) {
    // Skip pagos a empleados (nómina/vales/reembolsos) — no son proveedores.
    if (isEmployeePayment(pago)) continue;
    if (!pago.fechaPago || pago.fechaPago < start || pago.fechaPago > end) continue;
    const amount = pago.importePesos;
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const jdeKey = normalizeJdeKey(pago.claveProveedor);
    const nameKey = normalizeProviderName(pago.nombreProveedor);
    const ym = pago.fechaPago.slice(0, 7);

    const targets: Array<{ map: Map<string, Acc>; key: string }> = [];
    if (jdeKey) targets.push({ map: accByJde, key: jdeKey });
    if (nameKey) targets.push({ map: accByName, key: nameKey });

    for (const t of targets) {
      let acc = t.map.get(t.key);
      if (!acc) {
        acc = {
          totalSpend: 0,
          paymentCount: 0,
          monthsTouched: new Set<string>(),
          name: pago.nombreProveedor || '',
        };
        t.map.set(t.key, acc);
      }
      acc.totalSpend += amount;
      acc.paymentCount += 1;
      acc.monthsTouched.add(ym);
      if (!acc.lastPaymentDate || pago.fechaPago > acc.lastPaymentDate) {
        acc.lastPaymentDate = pago.fechaPago;
      }
    }
  }

  const toStats = (acc: Acc): ProviderSpendStats => ({
    totalSpend: acc.totalSpend,
    monthlyAverage: acc.totalSpend / Math.max(1, months),
    paymentCount: acc.paymentCount,
    monthsCovered: acc.monthsTouched.size,
    monthsInWindow: months,
    lastPaymentDate: acc.lastPaymentDate,
  });

  const byJde = new Map<string, ProviderSpendStats>();
  const byName = new Map<string, ProviderSpendStats>();
  for (const [k, v] of accByJde) byJde.set(k, toStats(v));
  for (const [k, v] of accByName) byName.set(k, toStats(v));

  return { byJde, byName, windowStart: start, windowEnd: end, monthsInWindow: months };
}

/**
 * Mira un Provider del catálogo y devuelve sus stats de gasto reciente, o null.
 */
export function lookupRecentSpend(
  index: ProviderSpendIndex,
  provider: Pick<Provider, 'numProveedorJDE' | 'name'>,
): ProviderSpendStats | null {
  const jdeKey = normalizeJdeKey(provider.numProveedorJDE);
  if (jdeKey) {
    const hit = index.byJde.get(jdeKey);
    if (hit) return hit;
  }
  const nameKey = normalizeProviderName(provider.name);
  if (nameKey) {
    const hit = index.byName.get(nameKey);
    if (hit) return hit;
  }
  return null;
}

/**
 * Devuelve una copia de cada Provider con `montoPromedioPago` +
 * `gastoMinimoMensual` derivados del índice de gasto reciente. Cuando no hay
 * pagos en la ventana, se conservan los valores del catálogo como fallback.
 */
export function enrichProvidersWithRecentSpend(
  providers: Provider[],
  index: ProviderSpendIndex,
): Provider[] {
  return providers.map((p) => {
    const stats = lookupRecentSpend(index, p);
    if (!stats || stats.monthsCovered === 0) return p;
    const monthlyAvg = stats.monthlyAverage;
    const avgPerPayment = stats.paymentCount > 0
      ? stats.totalSpend / stats.paymentCount
      : (p.montoPromedioPago ?? 0);
    return {
      ...p,
      montoPromedioPago: avgPerPayment,
      gastoMinimoMensual: monthlyAvg,
    };
  });
}

function isEmployeePayment(p: PagoProveedorRecord): boolean {
  return (p.tipoBusqueda || '').trim().toLowerCase() === 'employees';
}
