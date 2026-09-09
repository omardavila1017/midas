/**
 * payrollOperatingFloor — piso operativo mensual de nómina, tomado de TRESS.
 *
 * ── El dato es el mes, no una extrapolación ──────────────────────────────────
 * `tress.Nomina` ya entrega el gasto de nómina fechado por `FechaPago`, así que
 * el gasto mensual es una SUMA de la fuente: Σ `CASH_OUT` del mes. No hay que
 * inferirlo.
 *
 * Las dos versiones previas sí lo inferían, y las dos se equivocaban:
 *
 *   v1  última semana CERRADA × 4.33. La nómina de Senda alterna semana normal
 *       y semana con quincena, así que el piso oscilaba $40.78M–$65.08M según
 *       el día en que se abría la app.
 *   v2  promedio de las últimas 4 semanas cerradas × 4.33. Quitó el sesgo de la
 *       semana, pero heredó tres defectos de la ventana móvil:
 *         · un evento ANUAL dentro de la ventana la distorsiona un mes entero
 *           (la semana del 2026-08-03 valía $20.0M por $10.6M de liquidación de
 *           fondo de ahorro: el piso subió a $59.2M y volvió a $49.9M solo al
 *           salir de la ventana);
 *         · el guard de semana parcial (`dedCount/cashCount`) DESCARTABA semanas
 *           reales cuando el ratio no le gustaba;
 *         · sólo excluía la semana EN CURSO, no las futuras — el 2026-09-09
 *           TRESS cargó 2 filas con `FechaPago` 2026-09-24 por $18,004 y esa
 *           "semana" desplazó a una real del promedio: el piso cayó de $49.92M
 *           a $36.38M sin que cambiara un peso de nómina.
 *
 * Esta versión no descarta ninguna fila ni extrapola: agrupa por el mes que el
 * propio registro trae y devuelve el total del ÚLTIMO MES COMPLETO. El mes en
 * curso no es elegible porque no es un total mensual (al 2026-09-09 septiembre
 * llevaba $18.1M de 9 días contra $57.2M del mes cerrado) — es el único
 * requisito, y `monthUsed` lo deja a la vista para que nada quede implícito.
 *
 * Verificado contra `tress.Nomina` el 2026-09-09, excluyendo la cía 33
 * (MULTICARGA, fuera de `NOMINA_FANOUT_EMPRESAS` y cortada por
 * `dropExcludedByCia`): piso de nómina jun $71.00M · jul $88.29M · ago $86.80M.
 *
 * ── Qué se suma: TODO el efectivo de nómina ─────────────────────────────────
 * `CASH_OUT` (percepciones) **+ `EMPLOYER_TAX`** (aportaciones patronales). Las
 * dos son dinero que sale del banco y que la empresa tiene que cubrir para
 * seguir operando; el piso las necesita completas.
 *
 * Antes el piso era sólo el bruto, documentado como "el costo de nómina
 * contratado". Eso deja fuera IMSS patronal, RCV, cesantía, INFONAVIT y retiro
 * — que NO viven dentro del bruto (el bruto ya contiene las retenciones AL
 * empleado, no las aportaciones DE la empresa). Medido ago-2026 (sin la cía 33,
 * que Midas excluye): bruto $54.21M contra $32.59M de aportaciones, o sea el
 * piso subreportaba 38% del efectivo de nómina.
 *
 * ── Qué NO se suma, y por qué ───────────────────────────────────────────────
 * `DEDUCTION` y `WITHHOLDING_PAYABLE` ya viven DENTRO del bruto (salen de lo
 * que se le paga al empleado); sumarlas sería doble conteo. `NON_CASH` es
 * informativo por definición.
 *
 * Además se descarta `FONDO AHORRO EMPRESA` (ver `isAccruedNotDisbursed`), que
 * es `EMPLOYER_TAX` pero se PAGA por otro lado — detalle abajo.
 */

/** Subset de `NominaRecord` que necesita el cálculo. */
export interface PayrollFloorRecordLike {
  cia?: string;
  conceptName?: string;
  paymentDate?: string;
  periodEndDate?: string;
  sourcePeriod?: string;
  year: number;
  month: number;
  amount: number;
  cashTreatment: string;
}

/**
 * Mes (`YYYY-MM`) al que pertenece el gasto. Misma precedencia que usaba el
 * agrupado por semana: la fecha de pago manda, porque es cuando el dinero sale.
 */
export function payrollMonthKey(r: PayrollFloorRecordLike): string | null {
  const fromDate = r.paymentDate || r.periodEndDate;
  if (fromDate && fromDate.length >= 7) return fromDate.slice(0, 7);
  if (r.year > 0 && r.month > 0) return `${r.year}-${String(r.month).padStart(2, '0')}`;
  if (r.sourcePeriod && r.sourcePeriod.length >= 7) return r.sourcePeriod.slice(0, 7);
  return null;
}

/**
 * Aportación patronal que se DEVENGA cada mes pero se DESEMBOLSA por otra vía,
 * así que contarla aquí sería doble conteo.
 *
 * `FONDO AHORRO EMPRESA` (la aportación de la empresa al fondo de ahorro) se
 * acumula mensual bajo Obligación Empresa —medido sep-2025…ago-2026: ~$1.48–1.68M
 * cada mes, ~$18.2M al año— y su desembolso aparece como `LIQ TOTAL FA EMP` /
 * `LIQ TOTAL FA SOCIO` en PERCEPCIÓN cuando el fondo se liquida ($10.71M en
 * ago-2026, el mismo pago que inflaba la ventana móvil del piso anterior).
 * Sumar las dos cuenta la aportación dos veces.
 *
 * Se descarta la acumulación y se conserva el desembolso, porque el desembolso
 * es el que TRESS fecha en el mes en que el dinero sale. Consecuencia asumida:
 * el piso del mes de liquidación es más alto que el de los demás — eso es lo
 * que de verdad pasó ese mes.
 *
 * NO se corrigió en `refineCashTreatment` a propósito: para el módulo de Nómina
 * la acumulación SÍ es una obligación patronal del mes y pertenece a su KPI de
 * Aportaciones. Es el piso —que mide EFECTIVO— el que no la puede contar.
 */
export function isAccruedNotDisbursed(r: PayrollFloorRecordLike): boolean {
  return r.cashTreatment === 'EMPLOYER_TAX'
    && /fondo\s+(de\s+)?ahorro\s+empresa/i.test(r.conceptName ?? '');
}

export interface PayrollFloorMonth {
  month: string;
  /** Σ efectivo (percepciones + aportaciones) del mes. */
  amount: number;
  /** Σ percepciones. */
  gross: number;
  /** Σ aportaciones patronales. `0` con `gross > 0` = payload truncado. */
  employerTax: number;
  /** Firma de truncamiento del gateway: hay percepciones y CERO aportaciones. */
  truncated: boolean;
}

export interface PayrollFloorResult {
  /** Efectivo del último mes completo y USABLE. `undefined` si no hay ninguno. */
  monthly: number | undefined;
  /** Mes usado (`YYYY-MM`). */
  monthUsed: string | undefined;
  /** Por mes, más reciente primero. Incluye el mes en curso y los truncados. */
  byMonth: PayrollFloorMonth[];
  /** Meses cerrados descartados por truncamiento, más reciente primero. */
  skippedTruncated: string[];
}

/**
 * Piso operativo mensual de nómina. Devuelve `undefined` cuando no hay ningún
 * mes completo — el caller lo trata como "sin dato", nunca como 0 (un piso 0
 * significaría que nunca hay déficit).
 */
export function computePayrollMonthlyFloor(
  records: PayrollFloorRecordLike[],
  options: { todayIso: string; ciaFilter?: string },
): PayrollFloorResult {
  const empty: PayrollFloorResult = {
    monthly: undefined, monthUsed: undefined, byMonth: [], skippedTruncated: [],
  };
  if (records.length === 0) return empty;

  const ciaFilter = options.ciaFilter ?? '';
  const acc = new Map<string, { gross: number; employerTax: number }>();

  for (const r of records) {
    if (ciaFilter && r.cia !== ciaFilter) continue;
    const isGross = r.cashTreatment === 'CASH_OUT';
    const isEmployer = r.cashTreatment === 'EMPLOYER_TAX' && !isAccruedNotDisbursed(r);
    if (!isGross && !isEmployer) continue;
    const key = payrollMonthKey(r);
    if (!key) continue;
    const e = acc.get(key) ?? { gross: 0, employerTax: 0 };
    if (isGross) e.gross += r.amount;
    else e.employerTax += r.amount;
    acc.set(key, e);
  }

  const byMonth: PayrollFloorMonth[] = Array.from(acc.entries())
    .map(([month, e]) => ({
      month,
      amount: e.gross + e.employerTax,
      gross: e.gross,
      employerTax: e.employerTax,
      // El gateway de TRESS corta payloads >1MB y el corte cae justo en el
      // bloque "Obligación Empresa" (`nominaLacksEmployerTax` en `jde.ts` ya
      // trocea el fetch por esta firma, pero devuelve best-effort). Un mes
      // cerrado con percepciones y CERO aportaciones no es un mes sin
      // aportaciones: es un payload incompleto.
      truncated: e.gross > 0 && e.employerTax === 0,
    }))
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));

  // Único requisito de elegibilidad: el mes tiene que estar COMPLETO. Un mes en
  // curso (o uno futuro, que TRESS sí carga por adelantado) no es un total
  // mensual.
  const currentMonth = options.todayIso.slice(0, 7);
  const closed = byMonth.filter((m) => m.month < currentMonth && m.amount > 0);

  // Un mes truncado se SALTA, no se reporta bajo. Desde que el piso incluye las
  // aportaciones (~37% del efectivo de nómina), servir un mes sin ellas daría un
  // piso plausible y 37% corto — el modo de falla caro. Se prefiere el mes
  // anterior completo, y los saltados se confiesan en `skippedTruncated`.
  const usable = closed.find((m) => !m.truncated);
  const skippedTruncated = closed.filter((m) => m.truncated).map((m) => m.month);

  if (!usable) return { ...empty, byMonth, skippedTruncated };
  return { monthly: usable.amount, monthUsed: usable.month, byMonth, skippedTruncated };
}
