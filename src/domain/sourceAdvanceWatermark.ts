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
   * veredicto posible: primera observación (no hay contra qué comparar) o sin
   * fecha usable. Un máximo que RETROCEDE **sí** emite veredicto — ver abajo.
   */
  stalledBusinessDays: number | null;
}

/**
 * Regla de avance para UNA fuente.
 *
 * **El retroceso se trata igual que "no se movió"** (conserva la marca, cuenta
 * desde `firstSeenAt`). Antes devolvía `null` para tolerar el transitorio del
 * boot —los datasets se comprometen por olas y el máximo puede verse menor unos
 * segundos—, pero eso dejaba inmune PARA SIEMPRE a la fuente cuyo máximo baja de
 * forma permanente: cada evaluación posterior seguía por esa rama y esa fuente
 * no podía acusarse jamás.
 *
 * **Trade-off explícito**, y se eligió a conciencia: el precio es un parpadeo
 * durante el boot —una fuente que YA llevaba días sin avanzar puede acusarse
 * unos segundos mientras la ola se completa, hasta que el máximo sube y el
 * reloj se resetea a 0—. Un falso positivo transitorio, visible y que se
 * auto-corrige es estrictamente mejor que un silencio permanente, que es el
 * defecto que esta marca existe para cerrar. La marca NO se corrompe en el
 * transitorio: el retroceso conserva `prev` tal cual.
 *
 * Re-basificar en el retroceso (`firstSeenAt = hoy`) parece la alternativa
 * limpia y NO lo es: el transitorio del boot la dispararía en cada arranque,
 * `firstSeenAt` sería siempre hoy y la fuente nunca acumularía días — la misma
 * inmunidad, por otra puerta.
 */
export function assessSourceAdvance(
  prev: SourceAdvanceMark | undefined,
  maxDataDate: string | null,
  todayISO: string,
): SourceAdvanceVerdict {
  const today = todayISO.slice(0, 10);
  // Se normaliza igual que `today`: si un caller entregara la fecha con hora,
  // `isMark` la descartaría al recargar y la marca se resetearía en cada arranque
  // — la fuente nunca acumularía días y jamás podría acusarse. Passthrough con
  // una fecha ya ISO de 10 chars, que es lo que hoy entrega `latestUsableDataDate`.
  const maxDate = maxDataDate ? maxDataDate.slice(0, 10) : maxDataDate;
  if (!maxDate) return { next: prev, stalledBusinessDays: null };
  if (!prev) return { next: { maxDataDate: maxDate, firstSeenAt: today }, stalledBusinessDays: null };
  if (maxDate > prev.maxDataDate) {
    return { next: { maxDataDate: maxDate, firstSeenAt: today }, stalledBusinessDays: 0 };
  }
  // Un máximo que RETROCEDE se trata igual que uno que no se movió: la marca se
  // conserva y se sigue contando desde `firstSeenAt`.
  //
  // Antes devolvía `null` (sin veredicto) para tolerar el transitorio del boot,
  // donde los datasets se comprometen por olas y el máximo puede verse menor unos
  // segundos. Pero un retroceso PERMANENTE —una ventana que se acorta, una cía
  // que deja de cargarse— dejaba esa fuente inmune al aviso PARA SIEMPRE: cada
  // evaluación posterior seguía por esta rama. Una capa de confesión que deja de
  // confesar sola es justo el defecto que esta marca existe para cerrar.
  //
  // Contar desde `firstSeenAt` no reintroduce el falso positivo del boot: una
  // fuente sana acaba de avanzar, así que su `firstSeenAt` es reciente y el
  // conteo queda muy por debajo del umbral. Sólo acusa a la que ya llevaba
  // tiempo quieta — y un retroceso es, como mínimo, tan malo como no avanzar.
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
