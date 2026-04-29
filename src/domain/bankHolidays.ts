/**
 * Días inhábiles bancarios en México.
 *
 * Fuente única de verdad para feriados que NO operan en banca mexicana.
 * Consumido por:
 *   - operatingProjectionModule.isBusinessDay (proyección operativa diaria)
 *   - calendar.dateMatchesPattern (cobranza por patrón de cliente)
 *
 * Extender este set al cerrar el año o cuando se publique calendario nuevo.
 */

/**
 * Días inhábiles bancarios MX 2026 según calendario operativo del usuario.
 * Sábados y domingos NO se listan aquí — se rechazan por separado en `isWeekend`.
 */
export const MX_BANK_HOLIDAYS: ReadonlySet<string> = new Set<string>([
  '2026-05-01', // Día del Trabajo
  '2026-09-16', // Independencia
  '2026-11-02', // Día de Muertos
  '2026-11-16', // Conmemoración de la Revolución (20-nov)
  '2026-12-12', // Día del Empleado Bancario
  '2026-12-25', // Navidad
]);

export function isWeekend(date: Date): boolean {
  const d = date.getUTCDay();
  return d === 0 || d === 6;
}

export function isNonOperatingDay(date: Date): boolean {
  return isWeekend(date) || isBankHoliday(date);
}

function toIsoUTC(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isBankHoliday(date: Date): boolean {
  return MX_BANK_HOLIDAYS.has(toIsoUTC(date));
}
