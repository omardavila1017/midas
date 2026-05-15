// ─────────────────────────────────────────────────────────────────────────
// Convenio Concursal — motor de calendario.
//
// Convierte el dataset crudo (`convenioSchedule.ts`, en miles de MXN) en un
// calendario de pagos en MXN reales con fecha resuelta y partición
// histórico / futuro respecto a una fecha de corte (`asOfDate`).
//
// Regla de fecha de pago (definida con el cliente):
//   - El pago de cada trimestre cae el ÚLTIMO DÍA NATURAL del mes del
//     trimestre (Ene→31, Abr→30, Jul→31, Oct→31).
//   - Si ese día es inhábil (fin de semana o feriado bancario MX) se recorre
//     al SIGUIENTE día hábil. El recorrido puede caer en el mes siguiente.
//   - Los días recorridos siguen devengando interés, por lo que el monto
//     realmente pagado puede diferir del programado. Esa variabilidad la
//     absorbe el motor de conciliación (tolerancia de monto), no este módulo.
//
// Limitación conocida: `MX_BANK_HOLIDAYS` solo lista feriados del año en
// curso. Para trimestres históricos solo se detectan fines de semana. El
// motor de conciliación usa una ventana de fechas que tolera este desfase.
// ─────────────────────────────────────────────────────────────────────────
import { isNonOperatingDay } from './bankHolidays';
import {
  CONVENIO_QUARTERS,
  CONVENIO_TOTALS,
  toConvenioMxn,
  type ConvenioQuarter,
} from '../modules/concurso-mercantil/data/convenioSchedule';

export interface ConvenioScheduledPayment {
  /** Clave estable del trimestre: `YYYY-MM` del mes del convenio. */
  key: string;
  year: number;
  month: string;
  monthIndex: number;
  /** Último día natural del mes del trimestre (ISO), antes de recorrer. */
  naturalDateIso: string;
  /** Fecha de pago resuelta (ISO) tras recorrer inhábiles hacia adelante. */
  scheduledDateIso: string;
  /** Días recorridos por inhábil (0 si el día natural ya era hábil). */
  rolledDays: number;
  /** Interés del trimestre en MXN reales. */
  interesMxn: number;
  /** Capital del trimestre en MXN reales. */
  capitalMxn: number;
  /** Pago total del trimestre (interés + capital) en MXN reales. */
  totalMxn: number;
  /** Saldo vivo del tramo sostenible tras el pago, en MXN reales. */
  nuevoSaldoMxn: number;
  /** true si la fecha de pago resuelta es ≤ `asOfDate`. */
  isElapsed: boolean;
}

export interface ConvenioSchedule {
  all: ConvenioScheduledPayment[];
  elapsed: ConvenioScheduledPayment[];
  future: ConvenioScheduledPayment[];
  totals: {
    /** Suma de interés MXN de todos los trimestres. */
    interesMxn: number;
    /** Suma de capital MXN de todos los trimestres. */
    capitalMxn: number;
    /** Suma total programada MXN. */
    totalMxn: number;
    /** Total ya transcurrido (histórico) MXN. */
    elapsedTotalMxn: number;
    /** Total por pagar (futuro) MXN. */
    futureTotalMxn: number;
    /** Saldo convenio inicial (contingente + sostenible) MXN. */
    saldoConvenioMxn: number;
    /** Tramo sostenible inicial MXN. */
    tramoSostenibleMxn: number;
    /** Tramo contingente MXN. */
    tramoContingenteMxn: number;
  };
}

const DAY_MS = 86_400_000;

function lastDayOfMonth(year: number, monthIndex1: number): Date {
  // Día 0 del mes siguiente = último día del mes actual.
  return new Date(Date.UTC(year, monthIndex1, 0));
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Resuelve la fecha de pago de un trimestre: último día natural del mes y,
 * si es inhábil, recorre hacia adelante hasta el siguiente día hábil.
 */
export function resolveConvenioPaymentDate(
  year: number,
  monthIndex1: number,
): { naturalDateIso: string; scheduledDateIso: string; rolledDays: number } {
  const natural = lastDayOfMonth(year, monthIndex1);
  const naturalDateIso = toIso(natural);
  const cursor = new Date(natural.getTime());
  let rolledDays = 0;
  // Cota de seguridad: ningún puente bancario MX excede ~5 días.
  while (isNonOperatingDay(cursor) && rolledDays < 14) {
    cursor.setTime(cursor.getTime() + DAY_MS);
    rolledDays += 1;
  }
  return { naturalDateIso, scheduledDateIso: toIso(cursor), rolledDays };
}

function buildPayment(q: ConvenioQuarter, asOfDate: string): ConvenioScheduledPayment {
  const { naturalDateIso, scheduledDateIso, rolledDays } = resolveConvenioPaymentDate(
    q.year,
    q.monthIndex,
  );
  const interesMxn = toConvenioMxn(q.interes);
  const capitalMxn = toConvenioMxn(q.capital);
  return {
    key: `${q.year}-${String(q.monthIndex).padStart(2, '0')}`,
    year: q.year,
    month: q.month,
    monthIndex: q.monthIndex,
    naturalDateIso,
    scheduledDateIso,
    rolledDays,
    interesMxn,
    capitalMxn,
    totalMxn: interesMxn + capitalMxn,
    nuevoSaldoMxn: toConvenioMxn(q.nuevoSaldo),
    isElapsed: scheduledDateIso <= asOfDate,
  };
}

/**
 * Construye el calendario completo del convenio en MXN reales, partido en
 * histórico (≤ asOfDate) y futuro (> asOfDate).
 *
 * @param asOfDate ISO `YYYY-MM-DD`. Default: hoy (UTC).
 */
export function buildConvenioSchedule(asOfDate?: string): ConvenioSchedule {
  const cutoff = asOfDate ?? toIso(new Date());
  const all = CONVENIO_QUARTERS.map((q) => buildPayment(q, cutoff));
  const elapsed = all.filter((p) => p.isElapsed);
  const future = all.filter((p) => !p.isElapsed);
  const sum = (xs: ConvenioScheduledPayment[], k: 'totalMxn') =>
    xs.reduce((s, p) => s + p[k], 0);
  return {
    all,
    elapsed,
    future,
    totals: {
      interesMxn: toConvenioMxn(CONVENIO_TOTALS.sumInteres),
      capitalMxn: toConvenioMxn(CONVENIO_TOTALS.sumCapital),
      totalMxn: sum(all, 'totalMxn'),
      elapsedTotalMxn: sum(elapsed, 'totalMxn'),
      futureTotalMxn: sum(future, 'totalMxn'),
      saldoConvenioMxn: toConvenioMxn(CONVENIO_TOTALS.saldoConvenio),
      tramoSostenibleMxn: toConvenioMxn(CONVENIO_TOTALS.tramoSostenible),
      tramoContingenteMxn: toConvenioMxn(CONVENIO_TOTALS.tramoContingente),
    },
  };
}
