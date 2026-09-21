/**
 * Normalización de las fechas que manda JDE, en un módulo hoja.
 *
 * Mismo patrón que `domain/cia.ts`: la regla vive aquí y `services/jde.ts` la
 * RE-EXPORTA para no romper imports. Está aquí porque hay DOS puertas de
 * entrada de registros de CXP —el fetcher y el import CSV manual— y una fecha
 * no puede significar cosas distintas según por cuál entró.
 *
 * `jde.Antiguedad_Saldos` es la ÚNICA tabla del espejo que guarda sus fechas
 * como varchar `DD-MM-YYYY` (verificado 2026-09-07 con su propia aritmética de
 * `Dias_Vencida`); todas las demás guardan ISO. Los consumidores fechan con
 * `cleanDate` (regex estricto `^\d{4}-\d{2}-\d{2}$`), así que una fecha en el
 * otro formato no falla ruidosamente: se cae en silencio y el CXP se queda sin
 * vencimiento — "Vencido / Por vencer / A pagar este mes" en $0 y los egresos
 * `cxp:` re-fechados al `asOfDate`.
 */

/** Recorta a precisión de día. No valida formato: eso lo hace `normalizeJdeDate`. */
export function trimIsoDate(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  if (!s) return '';
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/**
 * `DD-MM-YYYY` → `YYYY-MM-DD`. **Passthrough** si ya viene ISO, y passthrough
 * si no reconoce la forma (nunca inventa una fecha).
 *
 * SÓLO acepta guiones: `M/D/YYYY` con diagonales es formato US y sería ambiguo.
 */
export function normalizeJdeDate(v: unknown): string {
  const s = trimIsoDate(v);
  if (!s || /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!dmy) return s;
  const [, dd, mm, yyyy] = dmy;
  const day = Number(dd);
  const month = Number(mm);
  if (month < 1 || month > 12 || day < 1 || day > 31) return s;
  return `${yyyy}-${mm}-${dd}`;
}
