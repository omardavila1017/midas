/**
 * Ventana de datos por defecto de Midas + helpers de carga diferida por año.
 *
 * Regla de negocio (2026-07): el boot carga **el año en curso completo desde
 * enero + 12 meses atrás del mes actual**. Todo lo anterior a ese piso NO se
 * baja al arrancar — se carga BAJO DEMANDA cuando el usuario consulta un año
 * previo en un filtro (ver `src/contexts/DataWindowContext.tsx` +
 * el controlador de backfill en `AppCore.tsx`).
 *
 * Este módulo es puro y testeable (sin `Date.now()` interno salvo el default
 * del parámetro `now`, que los tests inyectan). Es el único lugar donde vive
 * la definición del piso — todos los boot effects lo consumen para que la
 * ventana sea uniforme entre datasets (Cobranza/Bancos/Nómina bajan de 24m;
 * ROL/Viajes/Auxiliar suben desde YTD; Compras/Pagos quedan ~igual).
 */

/** `YYYY-01-01` del año en curso. */
export function yearStartISO(year: number): string {
  return `${year}-01-01`;
}

/** `YYYY-12-31` del año dado. */
export function yearEndISO(year: number): string {
  return `${year}-12-31`;
}

/**
 * Piso inferior de la ventana por defecto: el MÁS ANTIGUO de
 *   - inicio del año calendario en curso (`YYYY-01-01`), y
 *   - inicio del mes 12 meses atrás del mes actual.
 *
 * Ej. 2026-07-09 → min(2026-01-01, 2025-07-01) = **2025-07-01**.
 * Ej. 2026-12-15 → min(2026-01-01, 2025-12-01) = **2025-12-01**.
 * Ej. 2026-01-20 → min(2026-01-01, 2025-01-01) = **2025-01-01**.
 */
export function defaultWindowFloor(now: Date = new Date()): string {
  const yearStart = yearStartISO(now.getUTCFullYear());
  // Date.UTC tolera meses negativos (roll-over de año): mes actual − 12.
  const twelveMonthsBack = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1),
  )
    .toISOString()
    .slice(0, 10);
  return twelveMonthsBack < yearStart ? twelveMonthsBack : yearStart;
}

/**
 * Cantidad de meses (inclusive) que abarca la ventana por defecto, para los
 * loaders llaveados por mes (Nómina TRESS itera (año, mes) hacia atrás).
 * Ej. 2026-07-09 (piso 2025-07) → 13 meses.
 */
export function defaultWindowMonths(now: Date = new Date()): number {
  const floor = defaultWindowFloor(now);
  const floorYear = Number(floor.slice(0, 4));
  const floorMonth = Number(floor.slice(5, 7));
  const nowIndex = now.getUTCFullYear() * 12 + (now.getUTCMonth() + 1);
  const floorIndex = floorYear * 12 + floorMonth;
  return nowIndex - floorIndex + 1;
}

/** Día calendario anterior (UTC) a `iso` (`YYYY-MM-DD`). */
export function previousIsoDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * ¿La ventana `[floor, hoy]` ya cubre el año `year`? True si el año es el
 * actual o posterior, o si su inicio no es anterior al piso cargado.
 */
export function isYearWithinFloor(year: number, floor: string): boolean {
  return yearStartISO(year) >= floor;
}
