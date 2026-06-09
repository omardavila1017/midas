/**
 * nominaDebug — herramienta de diagnóstico read-only para la pestaña Nómina.
 *
 * Expone `window.__midas__.nomina` en la consola del navegador para inspeccionar
 * qué hay realmente en el heavy-store (IndexedDB `midas-heavy-store`, key
 * `nominaRecords`) vs. lo que dicen las llaves de carga (`nominaLoadedKeys`,
 * localStorage `midas-v12`). El problema recurrente es que el fetch a TRESS llega
 * truncado (AWS API Gateway corta payloads >1MB) y un mes queda con Percepciones
 * pero sin Aportaciones Patronales (`EMPLOYER_TAX`) — la firma `apor=0`.
 *
 * Reusa `loadHeavyRecords` para que el reensamblado de chunks (key::0, key::1, …)
 * lo maneje el código existente y no haya una segunda implementación que se
 * desincronice. NO toca estado de React ni dispara fetches: solo lee.
 *
 * Uso desde consola:
 *   await window.__midas__.nomina.dump()   // console.table por mes + loadedKeys
 *   await window.__midas__.nomina.byMonth() // mismo resumen, devuelto como objeto
 */

import { loadHeavyRecords } from '../../../services/heavyStoreIDB';
import { getLastNominaRawSample } from '../../../services/jde';
import type { PayrollCostRecord } from '../../shared-finance/types';

const STORE_KEY = 'midas-v12';

export interface NominaMonthSummary {
  recs: number;
  cias: string;
  /** Σ CASH_OUT — Nómina Bruta (Percepciones). */
  bruta: number;
  /** Σ EMPLOYER_TAX — Aportaciones Patronales. `apor === 0` con recs>0 = truncado. */
  apor: number;
  /** Σ WITHHOLDING_PAYABLE — Retenciones (ISR/IMSS empleado). */
  reten: number;
  /** Σ DEDUCTION. */
  ded: number;
  /** true cuando hay registros pero ninguna aportación patronal (firma de truncamiento). */
  truncadoApor0: boolean;
}

/** Resume registros de nómina por `YYYY-MM`, agregando por `cashTreatment`. */
export function summarizeNominaByMonth(
  records: PayrollCostRecord[],
): Record<string, NominaMonthSummary> {
  const byM = new Map<
    string,
    { recs: number; bruta: number; apor: number; reten: number; ded: number; cias: Set<string> }
  >();
  for (const r of records) {
    if (!r.year || !r.month) continue;
    const k = `${r.year}-${String(r.month).padStart(2, '0')}`;
    const e =
      byM.get(k) ?? { recs: 0, bruta: 0, apor: 0, reten: 0, ded: 0, cias: new Set<string>() };
    e.recs += 1;
    e.cias.add(r.cia);
    if (r.cashTreatment === 'CASH_OUT') e.bruta += r.amount;
    if (r.cashTreatment === 'EMPLOYER_TAX') e.apor += r.amount;
    if (r.cashTreatment === 'WITHHOLDING_PAYABLE') e.reten += r.amount;
    if (r.cashTreatment === 'DEDUCTION') e.ded += r.amount;
    byM.set(k, e);
  }
  const out: Record<string, NominaMonthSummary> = {};
  for (const [k, v] of Array.from(byM.entries()).sort()) {
    out[k] = {
      recs: v.recs,
      cias: Array.from(v.cias).sort().join(','),
      bruta: Math.round(v.bruta),
      apor: Math.round(v.apor),
      reten: Math.round(v.reten),
      ded: Math.round(v.ded),
      truncadoApor0: v.apor === 0 && v.recs > 0,
    };
  }
  return out;
}

function readLoadedKeys(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { nominaLoadedKeys?: Record<string, string> };
    return parsed.nominaLoadedKeys ?? null;
  } catch {
    return null;
  }
}

async function byMonth(): Promise<Record<string, NominaMonthSummary>> {
  const records = await loadHeavyRecords('nominaRecords');
  return summarizeNominaByMonth(records);
}

async function dump(): Promise<{
  total: number;
  byMonth: Record<string, NominaMonthSummary>;
  loadedKeys: Record<string, string> | null;
}> {
  const records = await loadHeavyRecords('nominaRecords');
  const summary = summarizeNominaByMonth(records);
  const loadedKeys = readLoadedKeys();
  // eslint-disable-next-line no-console
  console.log(`[nomina-debug] heavy-store nominaRecords total = ${records.length}`);
  // eslint-disable-next-line no-console
  console.table(summary);
  // eslint-disable-next-line no-console
  console.log('[nomina-debug] nominaLoadedKeys:', loadedKeys ?? '(vacío)');
  return { total: records.length, byMonth: summary, loadedKeys };
}

/**
 * Imprime y devuelve la forma CRUDA del último fetch de nómina (nombres de
 * campo reales del API TRESS, antes del strip/mapeo). Útil cuando el dashboard
 * sale con todo en "Sin tipo" / "No monetario": revela si el API renombró
 * `TipoConcepto` / `TipoNomina`.
 */
function rawShape(): { keys: string[]; sample: Record<string, unknown> } | null {
  const s = getLastNominaRawSample();
  // eslint-disable-next-line no-console
  console.log('[nomina-debug] forma cruda del último fetch TRESS:', s ?? '(aún no hay fetch en esta sesión)');
  return s;
}

/**
 * Monta `window.__midas__.nomina`. Idempotente y tolerante: si `window` no
 * existe (SSR/jsdom) o algo falla, no tira. Mergea sobre el namespace que ya
 * crea `runtimeGuardian`.
 */
export function installNominaDebug(): void {
  try {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __midas__?: Record<string, unknown> };
    w.__midas__ = { ...(w.__midas__ ?? {}), nomina: { dump, byMonth, rawShape } };
  } catch {
    /* ignore */
  }
}
