/**
 * ¿El dato más reciente de una fuente SIGUE AVANZANDO?
 *
 * POR QUÉ EXISTE
 * --------------
 * `sourceDataFreshness` mide la ANTIGÜEDAD del dato: "el documento más nuevo
 * es del 31-ago". Eso responde "¿qué tan atrás va la fuente?", no "¿la fuente
 * sigue insertando?". Las dos preguntas se separan en cuanto una fecha se
 * puede post-fechar:
 *
 *   Medido 2026-09-14: `jde.Antiguedad_Saldos` llevaba 13 días sin insertar
 *   una fila, pero su último lote (01-sep) traía 10 facturas fechadas al 10 y
 *   11 de septiembre. Esas fechas eran FUTURAS al cargarse —y el filtro de
 *   `latestUsableDataDate` las descartaba— pero con el paso de los días se
 *   volvieron pasadas. El panel pasó de `aging` (6 días hábiles, avisaba) a
 *   `fresh` (1 día hábil, callaba) **sin que el dato cambiara un byte**. El
 *   aviso se apagó solo.
 *
 * `summarizeSourceDataFreshnessPreferred` cierra ese caso concreto eligiendo
 * una fecha que JDE no post-fecha (la contable). Esta marca cierra la CLASE:
 * no importa qué campo se mida ni si mañana el origen empieza a post-fechar
 * otro, porque no juzga la fecha — juzga si el máximo SUBIÓ desde la última
 * vez que lo vimos. Una fuente muerta se delata sola por quedarse quieta.
 *
 * LÍMITE HONESTO
 * --------------
 * Necesita historia, así que es per-navegador y **no puede acusar en la
 * primera observación**: un navegador que abre hoy por primera vez ve un
 * máximo y no tiene contra qué compararlo. Por eso NO reemplaza a
 * `sourceDataFreshness` — la respalda. Nunca inventa un veredicto: sin marca
 * previa o sin fecha usable devuelve `null`.
 *
 * Puro y con reloj inyectado; la persistencia vive en funciones aparte para
 * poder testear la regla sin tocar `localStorage`.
 */
import { countBusinessDaysBetween } from './bankSourceFreshness';

/** Registrada en `storageRegistry.ts`. */
export const SOURCE_ADVANCE_KEY = 'midas.sources.advance.v1';

/**
 * Días HÁBILES que el máximo puede quedarse quieto antes de llamarlo muerto.
 *
 * 10 y no menos por la nómina: `paymentDate` avanza por SEMANA (~5 días
 * hábiles), así que un umbral más corto acusaría a una fuente sana cada
 * semana — y una alerta que grita en falso entrena al usuario a ignorar el
 * panel, que es justo lo que este panel no se puede permitir. Dos semanas sin
 * avanzar no le pasa a ninguna de las ocho fuentes estando viva.
 */
export const SOURCE_ADVANCE_STALL_BUSINESS_DAYS = 10;

export interface SourceAdvanceMark {
  /** Máximo dato usable observado. */
  maxDataDate: string;
  /** ISO del día en que ese máximo se vio por PRIMERA vez. */
  firstSeenAt: string;
}

export type SourceAdvanceMarks = Record<string, SourceAdvanceMark>;

export interface SourceAdvanceVerdict {
  /** Marca a persistir (puede ser la previa sin cambios). */
  next: SourceAdvanceMark | undefined;
  /**
   * Días hábiles que el máximo lleva sin subir, o `null` cuando no hay
   * veredicto posible (primera observación, sin fecha usable, o máximo que
   * RETROCEDIÓ — ver abajo).
   */
  stalledBusinessDays: number | null;
}

/**
 * Regla de avance para UNA fuente.
 *
 * El caso que obliga a devolver `null` en vez de acusar: durante el boot los
 * datasets se comprometen por olas, así que el máximo puede verse MENOR que
 * el ya conocido por unos segundos (y lo mismo si el usuario acota la ventana
 * de datos). Un retroceso no prueba que la fuente murió, así que se conserva
 * la marca previa y no se emite veredicto. Conservador a propósito.
 */
export function assessSourceAdvance(
  prev: SourceAdvanceMark | undefined,
  maxDataDate: string | null,
  todayISO: string,
): SourceAdvanceVerdict {
  const today = todayISO.slice(0, 10);
  if (!maxDataDate) return { next: prev, stalledBusinessDays: null };
  if (!prev) return { next: { maxDataDate, firstSeenAt: today }, stalledBusinessDays: null };
  if (maxDataDate > prev.maxDataDate) {
    return { next: { maxDataDate, firstSeenAt: today }, stalledBusinessDays: 0 };
  }
  if (maxDataDate < prev.maxDataDate) return { next: prev, stalledBusinessDays: null };
  return { next: prev, stalledBusinessDays: countBusinessDaysBetween(prev.firstSeenAt, today) };
}

/** Aplica `assessSourceAdvance` a todas las fuentes de una pasada. */
export function assessSourceAdvanceAll(
  prev: SourceAdvanceMarks,
  maxByKey: Record<string, string | null>,
  todayISO: string,
): { next: SourceAdvanceMarks; stalledByKey: Record<string, number> } {
  const next: SourceAdvanceMarks = { ...prev };
  const stalledByKey: Record<string, number> = {};
  for (const [key, maxDataDate] of Object.entries(maxByKey)) {
    const verdict = assessSourceAdvance(prev[key], maxDataDate, todayISO);
    if (verdict.next) next[key] = verdict.next; else delete next[key];
    if (verdict.stalledBusinessDays !== null) stalledByKey[key] = verdict.stalledBusinessDays;
  }
  return { next, stalledByKey };
}

/** `true` cuando el máximo lleva quieto más de lo tolerable. */
export function isSourceStalled(stalledBusinessDays: number | undefined): boolean {
  return stalledBusinessDays !== undefined && stalledBusinessDays > SOURCE_ADVANCE_STALL_BUSINESS_DAYS;
}

function isMark(value: unknown): value is SourceAdvanceMark {
  if (!value || typeof value !== 'object') return false;
  const m = value as Partial<SourceAdvanceMark>;
  return /^\d{4}-\d{2}-\d{2}$/.test(m.maxDataDate ?? '') && /^\d{4}-\d{2}-\d{2}$/.test(m.firstSeenAt ?? '');
}

/** Lectura defensiva: cualquier payload corrupto se descarta entrada por entrada. */
export function loadSourceAdvanceMarks(storage?: Storage): SourceAdvanceMarks {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    const raw = store?.getItem(SOURCE_ADVANCE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: SourceAdvanceMarks = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isMark(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveSourceAdvanceMarks(marks: SourceAdvanceMarks, storage?: Storage): void {
  try {
    const store = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    store?.setItem(SOURCE_ADVANCE_KEY, JSON.stringify(marks));
  } catch {
    /* almacenamiento lleno o bloqueado: la marca es diagnóstico, nunca bloquea. */
  }
}
