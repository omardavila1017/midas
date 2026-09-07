/**
 * Antigüedad del DATO de una fuente JDE, no de la última consulta.
 *
 * POR QUÉ EXISTE
 * --------------
 * El panel "Salud de datos" mide `lastSync` = cuándo Midas pidió el dataset.
 * Eso responde "¿ya cargué?", no "¿la fuente sigue viva?". Medido contra la BD
 * el 2026-09-07: **`jde.Antiguedad_Saldos` llevaba 6 días sin insertar una
 * fila** (3,008 el 01-sep, cero desde entonces), así que el CXP de Midas
 * terminaba el 31-ago — y el panel decía "hace unos minutos", porque la
 * consulta sí corrió. La misma corrida cerró este hueco para el feed bancario
 * (`summarizeBankFreshnessByCompany`) y dejó los demás datasets fuera.
 *
 * Es dato de ORIGEN: Midas no puede arreglarlo, pero callarlo es lo que lo
 * vuelve caro — el usuario lee "al día" y toma decisiones sobre un CXP que se
 * quedó una semana atrás.
 *
 * Puro, con reloj inyectado. Reusa el calendario hábil y los umbrales de
 * `bankSourceFreshness` para que las dos filas del panel hablen el mismo
 * idioma (verde ≤3 días hábiles, amarillo 4-10, rojo >10).
 */
import {
  countBusinessDaysBetween,
  freshnessStatusFor,
  MANUAL_BANK_FRESHNESS_THRESHOLDS,
  type BankFreshnessThresholds,
  type BankSourceFreshnessStatus,
} from './bankSourceFreshness';

export interface SourceDataFreshness {
  /** Fecha del dato MÁS RECIENTE no futuro, o `null` si no hay ninguna usable. */
  lastDataDate: string | null;
  businessDaysElapsed: number | null;
  status: BankSourceFreshnessStatus;
}

/**
 * Fecha máxima usable de una lista de fechas crudas.
 *
 * Descarta lo que no sea `YYYY-MM-DD` (el centinela 1899/0001 de JDE ya lo
 * cortan los mappers) y, sobre todo, **lo posterior a hoy**: una factura
 * post-fechada no prueba que la fuente siga cargando, y tomarla como máximo
 * pintaría de verde justo un feed muerto. Misma convención que el resto del
 * repo ("fecha futura nunca verde").
 */
export function latestUsableDataDate(
  values: Iterable<string | null | undefined>,
  todayISO: string,
): string | null {
  const today = todayISO.slice(0, 10);
  let latest: string | null = null;
  for (const raw of values) {
    const day = (raw ?? '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (day > today) continue;
    if (!latest || day > latest) latest = day;
  }
  return latest;
}

export function summarizeSourceDataFreshness(
  values: Iterable<string | null | undefined>,
  todayISO: string,
  thresholds: BankFreshnessThresholds = MANUAL_BANK_FRESHNESS_THRESHOLDS,
): SourceDataFreshness {
  const lastDataDate = latestUsableDataDate(values, todayISO);
  if (!lastDataDate) return { lastDataDate: null, businessDaysElapsed: null, status: 'no-data' };
  const businessDaysElapsed = countBusinessDaysBetween(lastDataDate, todayISO);
  return { lastDataDate, businessDaysElapsed, status: freshnessStatusFor(businessDaysElapsed, thresholds) };
}
