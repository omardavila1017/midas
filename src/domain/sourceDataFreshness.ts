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
    // Cortes baratos ANTES del regex: esta función barre datasets de cientos
    // de miles de filas (compras y auxiliar rondan las 334k cada uno), y el
    // grueso de los valores son vacíos o repetidos. Descartar por `day <=
    // latest` no puede cambiar el máximo — `latest` ya es válido y no menor —,
    // así que el resultado es idéntico con o sin este atajo.
    if (day.length !== 10) continue;
    if (latest !== null && day <= latest) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (day > today) continue;
    latest = day;
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

/**
 * Frescura sobre la PRIMERA lista de fechas que produzca una fecha usable.
 *
 * POR QUÉ NO BASTA UNIR LAS LISTAS
 * --------------------------------
 * `latestUsableDataDate` toma el MÁXIMO, así que agregar un campo más
 * conservador a la misma bolsa no sirve de nada: el campo post-fechable gana
 * igual. La elección tiene que ser por PRECEDENCIA, no por unión.
 *
 * El defecto que cierra (medido 2026-09-14): `jde.Antiguedad_Saldos` llevaba
 * 13 días sin insertar una fila, pero el lote del 01-sep traía 10 facturas
 * post-fechadas al 10 y 11-sep. Eran futuras cuando se cargaron —y el filtro
 * de `latestUsableDataDate` las descartaba— pero con el paso de los días se
 * volvieron pasadas, y el panel pasó de `aging` (6 días hábiles, avisaba) a
 * `fresh` (1 día hábil, callaba) **sin que el dato cambiara**. El aviso se
 * apagó solo. Con `fecha_contable`, que JDE no post-fecha, la misma fuente
 * reporta 31-ago → rojo.
 *
 * Degrada sola: si el candidato preferido no produce ninguna fecha usable
 * (p.ej. el SP no expone la columna), cae al siguiente y el resultado es
 * byte-idéntico al comportamiento previo.
 */
export function summarizeSourceDataFreshnessPreferred(
  candidates: Array<() => Iterable<string | null | undefined>>,
  todayISO: string,
  thresholds: BankFreshnessThresholds = MANUAL_BANK_FRESHNESS_THRESHOLDS,
): SourceDataFreshness {
  for (const candidate of candidates) {
    const result = summarizeSourceDataFreshness(candidate(), todayISO, thresholds);
    if (result.lastDataDate) return result;
  }
  return { lastDataDate: null, businessDaysElapsed: null, status: 'no-data' };
}
