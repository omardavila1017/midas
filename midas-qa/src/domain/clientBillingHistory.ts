import type { Client } from './types';
import type { CobranzaRecord } from '../services/jdeTypes';

/**
 * Per-client monthly billing derived from real CXC (cobranza) invoices.
 *
 * Lookup persistido: usa `Client.jdeAccounts` (cia+noCliente) — el matching
 * difuso por RFC/nombre vive en `clientCobranzaMatcher.ts` y corre solo al
 * auto-seed o desde el wizard. Aquí solo sumamos.
 *
 * - Historical months come from the sum of `importeBrutoPesos` grouped by
 *   `fechaFactura` month, sobre la unión de facturas de todas las cuentas
 *   JDE enlazadas al client.
 * - Future months use ordinary-least-squares linear regression over the
 *   available historical months. If <2 historical points exist, the
 *   projection falls back to the historical mean (flat).
 */
export interface ClientMonthlyBilling {
  /** length 12, MXN, sin IVA. Historical for past months, projection for future. */
  values: number[];
  /** true when the month came from real cobranza; false when it's a projection. */
  isHistorical: boolean[];
  /** Número de meses con facturas reales contribuyendo a la proyección. */
  historicalMonths: number;
  /** Slope (MXN/month) from the linear regression. 0 when not enough data. */
  slope: number;
  /** Cantidad total de facturas usadas para construir el histórico. */
  invoiceCount: number;
}

/**
 * Índice precomputado: `${cia}::${noCliente}` → lista de facturas.
 * Construir una vez por render y reutilizar para todos los clientes.
 */
export type CobranzaByAccount = Map<string, CobranzaRecord[]>;

export function buildCobranzaByAccount(records: CobranzaRecord[]): CobranzaByAccount {
  const map: CobranzaByAccount = new Map();
  for (const r of records) {
    const key = `${r.cia}::${r.noCliente}`;
    const arr = map.get(key);
    if (arr) arr.push(r);
    else map.set(key, [r]);
  }
  return map;
}

function parseMonth(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  return year * 12 + (month - 1);
}

/** Reúne todas las facturas enlazadas a un cliente vía `jdeAccounts`. */
export function getCobranzaForClient(
  client: Client,
  byAccount: CobranzaByAccount,
): CobranzaRecord[] {
  if (!client.jdeAccounts || client.jdeAccounts.length === 0) return [];
  const out: CobranzaRecord[] = [];
  for (const link of client.jdeAccounts) {
    const recs = byAccount.get(`${link.cia}::${link.noCliente}`);
    if (recs) out.push(...recs);
  }
  return out;
}

/**
 * Compute the historical+projected monthly billing for one client and one
 * target calendar year, sobre las facturas de sus cuentas JDE enlazadas.
 *
 * `referenceMonth` is the absolute month index (year*12+month) representing
 * "today" — months strictly before it are historical, the rest are projected.
 */
export function computeMonthlyBilling(
  client: Client,
  byAccount: CobranzaByAccount,
  year: number,
  referenceMonth: number,
): ClientMonthlyBilling {
  const records = getCobranzaForClient(client, byAccount);
  return computeMonthlyBillingFromRecords(records, year, referenceMonth, client.monthlyBilling);
}

/**
 * Variante low-level: opera directamente sobre una lista de facturas. La usa
 * `clientGrouping.ts` para agregar facturación por grupo (unión de varias
 * cuentas de varios clientes).
 */
export function computeMonthlyBillingFromRecords(
  records: CobranzaRecord[],
  year: number,
  referenceMonth: number,
  fallback: readonly number[] = new Array(12).fill(0),
): ClientMonthlyBilling {
  const yearStart = year * 12;
  const byAbsMonth = new Map<number, number>();
  let invoiceCount = 0;
  for (const r of records) {
    const am = parseMonth(r.fechaFactura);
    if (am == null) continue;
    const amt = r.importeBrutoPesos ?? 0;
    if (!Number.isFinite(amt)) continue;
    byAbsMonth.set(am, (byAbsMonth.get(am) ?? 0) + amt);
    invoiceCount++;
  }

  const values = new Array<number>(12).fill(0);
  const isHistorical = new Array<boolean>(12).fill(false);

  const fitPoints: Array<{ x: number; y: number }> = [];
  for (const [am, amt] of byAbsMonth.entries()) {
    if (am < referenceMonth) fitPoints.push({ x: am, y: amt });
  }
  fitPoints.sort((a, b) => a.x - b.x);

  let slope = 0;
  let intercept = 0;
  if (fitPoints.length >= 2) {
    const n = fitPoints.length;
    const meanX = fitPoints.reduce((s, p) => s + p.x, 0) / n;
    const meanY = fitPoints.reduce((s, p) => s + p.y, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of fitPoints) {
      num += (p.x - meanX) * (p.y - meanY);
      den += (p.x - meanX) ** 2;
    }
    if (den > 0) {
      slope = num / den;
      intercept = meanY - slope * meanX;
    } else {
      intercept = meanY;
    }
  } else if (fitPoints.length === 1) {
    intercept = fitPoints[0].y;
  }

  let historicalMonthsInYear = 0;
  for (let m = 0; m < 12; m++) {
    const am = yearStart + m;
    if (am < referenceMonth) {
      // Mes pasado: siempre histórico. Si no hubo facturas, el real es 0.
      // No usamos regresión para rellenar meses pasados — sería ficción
      // (el dato real es "no se facturó"), no una proyección.
      const real = byAbsMonth.get(am) ?? 0;
      values[m] = real;
      isHistorical[m] = true;
      historicalMonthsInYear++;
    } else if (fitPoints.length >= 2) {
      values[m] = Math.max(0, intercept + slope * am);
    } else if (fitPoints.length === 1) {
      values[m] = Math.max(0, intercept);
    } else {
      values[m] = fallback[m] ?? 0;
    }
  }

  return {
    values,
    isHistorical,
    historicalMonths: historicalMonthsInYear,
    slope,
    invoiceCount,
  };
}
