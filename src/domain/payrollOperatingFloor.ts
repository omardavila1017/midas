/**
 * payrollOperatingFloor — piso operativo mensual de nómina derivado de TRESS.
 *
 * Vivía inline en `AppCore.tsx` (`payrollMonthlyActualJDE`), donde no había
 * forma de testearlo. Se extrajo tal cual (mismo agrupado por semana ISO, mismo
 * guard de semana parcial) con UN cambio de método, documentado abajo.
 *
 * ── Por qué NO se usa una sola semana ────────────────────────────────────────
 * La versión previa tomaba la ÚLTIMA semana cerrada × 4.33. La nómina de Senda
 * alterna semana "normal" y semana con quincena, así que una sola semana no
 * representa un mes: medido contra la BD real (2026, meses cerrados ene–jul,
 * nómina real promedio $49.69M/mes) el piso oscilaba según el día en que se
 * abría la app —
 *
 *   semana 2026-07-27 (con quincena) → $15.03M × 4.33 = $65.08M  (+31%)
 *   semana 2026-07-06 (normal)       →  $9.42M × 4.33 = $40.78M  (−18%)
 *
 * Promediar las últimas `PAYROLL_FLOOR_WEEKS` (4 = un ciclo completo de nómina)
 * cubre exactamente una vez cada tipo de semana y cae a 0.8% del real:
 *
 *   (15.03 + 10.26 + 11.54 + 9.42)/4 × 4.33 = $50.07M  vs real $49.69M
 *
 * Se conserva el run-rate reciente (la intención del cambio anterior: no volver
 * al promedio de 3 meses, que quedaba obsoleto) sin heredar el sesgo de la
 * semana en la que uno se para. Con menos de 4 semanas cerradas se promedian
 * las que haya — nunca se inventa una.
 *
 * El monto es BRUTO (Σ percepciones = `CASH_OUT`), igual que el KPI "Nómina
 * Bruta" del módulo de Nómina: es el costo de nómina contratado, que es lo que
 * significa "piso operativo".
 */

/** Semanas por mes. Constante de negocio; no la cambies sin recalcular el piso. */
export const PAYROLL_WEEKS_PER_MONTH = 4.33;

/**
 * Semanas cerradas que se promedian. 4 = un ciclo completo de la nómina de
 * Senda (cubre las semanas con quincena y las normales exactamente una vez).
 */
export const PAYROLL_FLOOR_WEEKS = 4;

/**
 * Una nómina real tiene ~1 deducción por percepción (ISR + IMSS empleado +
 * préstamos). Un ratio por debajo de esto delata un response truncado o una
 * sola quincena cargada: esa semana no se promedia.
 */
const PARTIAL_RATIO_THRESHOLD = 0.3;

/** Subset de `NominaRecord` que necesita el cálculo. */
export interface PayrollFloorRecordLike {
  cia?: string;
  paymentDate?: string;
  periodEndDate?: string;
  year: number;
  month: number;
  amount: number;
  cashTreatment: string;
}

/**
 * Lunes (UTC) de la semana de una fecha ISO. UTC en los dos lados para que el
 * agrupado no se corra un día en CST.
 */
export function payrollWeekKey(iso: string): string | null {
  if (!iso || iso.length < 10) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // getUTCDay: 0=domingo … 6=sábado → 0=lunes … 6=domingo.
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export interface PayrollFloorResult {
  /** Piso mensual (promedio semanal × 4.33). `undefined` si no hay semana cerrada. */
  monthly: number | undefined;
  /** Semanas efectivamente promediadas (lunes ISO, más reciente primero). */
  weeksUsed: string[];
  /** Promedio semanal bruto usado. */
  weeklyAverage: number;
}

/**
 * Piso operativo mensual de nómina. Devuelve `undefined` cuando no hay ninguna
 * semana cerrada usable — el caller lo trata como "sin dato", nunca como 0
 * (un piso 0 significaría que nunca hay déficit).
 */
export function computePayrollMonthlyFloor(
  records: PayrollFloorRecordLike[],
  options: { todayIso: string; ciaFilter?: string; weeks?: number },
): PayrollFloorResult {
  const empty: PayrollFloorResult = { monthly: undefined, weeksUsed: [], weeklyAverage: 0 };
  if (records.length === 0) return empty;

  const ciaFilter = options.ciaFilter ?? '';
  const grossByWeek = new Map<string, number>();
  const cashCountByWeek = new Map<string, number>();
  const reducCountByWeek = new Map<string, number>();

  for (const r of records) {
    if (ciaFilter && r.cia !== ciaFilter) continue;
    const dateIso = r.paymentDate
      || r.periodEndDate
      || `${r.year}-${String(r.month).padStart(2, '0')}-01`;
    const wk = payrollWeekKey(dateIso);
    if (!wk) continue;
    if (r.cashTreatment === 'CASH_OUT') {
      grossByWeek.set(wk, (grossByWeek.get(wk) ?? 0) + r.amount);
      cashCountByWeek.set(wk, (cashCountByWeek.get(wk) ?? 0) + 1);
    } else if (r.cashTreatment === 'DEDUCTION' || r.cashTreatment === 'WITHHOLDING_PAYABLE') {
      reducCountByWeek.set(wk, (reducCountByWeek.get(wk) ?? 0) + 1);
    }
  }

  // La semana en curso puede traer nómina parcial → fuera. El guard sólo puede
  // llevarnos a semanas MÁS antiguas (seguras), nunca a una parcial.
  const currentWeek = payrollWeekKey(options.todayIso);
  const closedWeeks = Array.from(grossByWeek.keys())
    .filter((wk) => {
      if (wk === currentWeek) return false;
      if ((grossByWeek.get(wk) ?? 0) <= 0) return false;
      const cashCnt = cashCountByWeek.get(wk) ?? 0;
      if (cashCnt === 0) return false;
      const reducCnt = reducCountByWeek.get(wk) ?? 0;
      return reducCnt / cashCnt >= PARTIAL_RATIO_THRESHOLD;
    })
    .sort()
    .reverse();

  if (closedWeeks.length === 0) return empty;

  const wanted = Math.max(1, options.weeks ?? PAYROLL_FLOOR_WEEKS);
  const weeksUsed = closedWeeks.slice(0, wanted);
  const sum = weeksUsed.reduce((acc, wk) => acc + (grossByWeek.get(wk) ?? 0), 0);
  const weeklyAverage = sum / weeksUsed.length;
  const monthly = weeklyAverage * PAYROLL_WEEKS_PER_MONTH;

  return {
    monthly: monthly > 0 ? monthly : undefined,
    weeksUsed,
    weeklyAverage,
  };
}
