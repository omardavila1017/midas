import type { EnrichedBankMovement } from './netCashFlowEngine';

/**
 * Flujo neto por empresa (B2.5) — agrega los abonos/cargos bancarios REALES
 * (ya sin traspasos internos, tal como los devuelve `computeBankOnlyCashFlow`)
 * por compañía, opcionalmente acotado a un mes. Display-only: no recomputa el
 * flujo, sólo lo re-agrupa por `cia`.
 */
export interface CompanyFlowTotal {
  cia: string;
  inflows: number;
  outflows: number;
  net: number;
}

export const UNKNOWN_CIA = '—';

/**
 * Número de compañía legible: quita el padding de 5 dígitos que usa el
 * dominio (`00033` → `33`) para mostrarlo junto al nombre. Los códigos no
 * numéricos se devuelven tal cual; la cía desconocida se muestra como `—`.
 */
export function displayCia(cia: string): string {
  if (!cia || cia === UNKNOWN_CIA) return UNKNOWN_CIA;
  return /^\d+$/.test(cia) ? String(Number(cia)) : cia;
}

/** ¿La fecha `YYYY-MM-DD` cae en el mes filtrado (índice 0-11) o es 'all'? */
function dateInMonth(date: string, month: number | 'all'): boolean {
  return month === 'all' || Number(date.slice(5, 7)) - 1 === month;
}

export function sumBankFlowByCompany(
  abonosByDate: Map<string, EnrichedBankMovement[]>,
  cargosByDate: Map<string, EnrichedBankMovement[]>,
  opts: { month?: number | 'all' } = {},
): CompanyFlowTotal[] {
  const month = opts.month ?? 'all';
  const map = new Map<string, { cia: string; inflows: number; outflows: number }>();
  const bump = (byDate: Map<string, EnrichedBankMovement[]>, field: 'inflows' | 'outflows') => {
    for (const [date, movs] of byDate) {
      if (!dateInMonth(date, month)) continue;
      for (const m of movs) {
        const cia = m.cia || UNKNOWN_CIA;
        let row = map.get(cia);
        if (!row) {
          row = { cia, inflows: 0, outflows: 0 };
          map.set(cia, row);
        }
        row[field] += Number.isFinite(m.amount) ? m.amount : 0;
      }
    }
  };
  bump(abonosByDate, 'inflows');
  bump(cargosByDate, 'outflows');
  return Array.from(map.values())
    .map(r => ({ ...r, net: r.inflows - r.outflows }))
    .sort((a, b) => b.net - a.net);
}
