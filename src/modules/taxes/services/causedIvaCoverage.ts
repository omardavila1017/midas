/**
 * Confesión de cobertura del IVA CAUSADO (base-cobro).
 *
 * El causado se reconoce desde la cobranza realmente APLICADA
 * (`jde.Cobranza_Indicadores` → `CobranzaPayment.applications`), que es la
 * fuente fiscalmente correcta: el IVA se causa al cobrar, no al facturar. El
 * problema es que esa tabla puede venir INCOMPLETA sin que nada falle — Midas
 * suma fielmente lo que hay y publica un causado cercano a cero como si fuera
 * un hecho, así que el neto del periodo sale falsamente a favor.
 *
 * Medido en `db_Artefactos` el 2026-08-10: de enero a junio de 2026 la tabla de
 * aplicaciones trae 139–250 registros por mes contra 1 800–2 500 facturas
 * realmente pagadas (cobertura del 6% en marzo), mientras julio y agosto ya
 * están completos. El causado de ese primer semestre está subreportado 90–98%.
 *
 * Este módulo NO corrige el número ni cambia de fuente — eso mueve el impuesto
 * declarado y es decisión de negocio. Lo que hace es DETECTARLO y dejar que la
 * UI lo confiese, comparando contra una referencia independiente que ya está en
 * memoria: las facturas de cobranza (`CobranzaRecord`), que traen su propia
 * `fechaCobro` e `importeIVA` y no dependen de que se haya capturado la
 * aplicación.
 */
import type { CobranzaPayment, CobranzaRecord } from '../../../services/jdeTypes';

/**
 * Cuánto IVA causado reconoce el MOTOR de una aplicación de cobro.
 *
 * Se inyecta a propósito y NO tiene default: este módulo mide cobertura, no
 * decide qué se reconoce. Si tuviera su propia regla, un periodo perfectamente
 * capturado podría salir marcado (o uno vacío pasar) por diferir del motor —
 * que es exactamente el modo de falla que esta capa existe para impedir.
 * `taxModuleService` es el dueño de la regla y la pasa desde ahí.
 */
export type CausedIvaRecognizer = (
  app: CobranzaPayment['applications'][number],
  payment: CobranzaPayment,
) => number;

/** Umbral por debajo del cual la cobertura de un periodo CERRADO es implausible. */
export const DEFAULT_MIN_COVERAGE_RATIO = 0.6;

/**
 * Piso de IVA esperado para siquiera evaluar un periodo. Sin él, un mes con
 * $500 esperados y $100 reconocidos marca 20% y no significa nada.
 */
export const DEFAULT_MIN_EXPECTED_IVA = 1_000_000;

export interface CausedIvaCoverage {
  period: string;
  /** IVA causado que la fuente de aplicaciones permite reconocer. */
  reportedIva: number;
  /** IVA de las facturas cuyo cobro cayó en el periodo (referencia independiente). */
  expectedIva: number;
  /** Aplicaciones capturadas en el periodo. */
  applicationCount: number;
  /** Facturas con cobro fechado en el periodo. */
  paidInvoiceCount: number;
  /** `reportedIva / expectedIva`; `null` cuando no hay referencia con qué comparar. */
  coverageRatio: number | null;
  /**
   * True sólo para periodos CERRADOS cuya cobertura queda por debajo del
   * umbral. El periodo en curso nunca se marca: sus dos lados están
   * legítimamente parciales, y marcarlo cada mes entrenaría al usuario a
   * ignorar el aviso.
   */
  implausible: boolean;
}

const isoPeriod = (date: string | undefined): string | undefined => {
  if (!date || date.length < 7) return undefined;
  const period = date.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(period) ? period : undefined;
};

const positive = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

function inScope(cia: string | undefined, companyCode: string | undefined): boolean {
  if (!companyCode || companyCode === 'all') return true;
  return cia === companyCode;
}

function inRange(date: string, startDate?: string, endDate?: string): boolean {
  if (startDate && date < startDate) return false;
  if (endDate && date > endDate) return false;
  return true;
}

/**
 * Compara, por periodo, el IVA causado que se puede reconocer desde las
 * aplicaciones contra el IVA de las facturas efectivamente cobradas.
 *
 * El lado REPORTADO lo decide el motor vía `recognizeIva`, para que la
 * comparación sea contra lo que realmente se suma y no contra una
 * aproximación. Ojo: el motor reconoce por DOS caminos (IVA de la factura
 * prorrateado por la porción cobrada, y el método por depósito cuando el cobro
 * es gravable pero no trae desglose), y descarta el primero cuando no puede
 * resolver la tasa. Replicar sólo uno sesga el veredicto en ambas direcciones.
 */
export function assessCausedIvaCoverage({
  payments,
  invoices,
  recognizeIva,
  companyCode,
  startDate,
  endDate,
  currentPeriod,
  minCoverageRatio = DEFAULT_MIN_COVERAGE_RATIO,
  minExpectedIva = DEFAULT_MIN_EXPECTED_IVA,
}: {
  payments: readonly CobranzaPayment[];
  invoices: readonly CobranzaRecord[];
  /** Regla del motor. Sin default a propósito — ver `CausedIvaRecognizer`. */
  recognizeIva: CausedIvaRecognizer;
  companyCode?: string;
  startDate?: string;
  endDate?: string;
  /** Periodo `YYYY-MM` en curso; no se marca como implausible. */
  currentPeriod: string;
  minCoverageRatio?: number;
  minExpectedIva?: number;
}): Map<string, CausedIvaCoverage> {
  const reported = new Map<string, number>();
  const applications = new Map<string, number>();
  const expected = new Map<string, number>();
  const paidInvoices = new Map<string, number>();

  for (const payment of payments) {
    if (!inScope(payment.cia, companyCode)) continue;
    for (const app of payment.applications) {
      const date = payment.fechaCobro || app.fechaAplicacion;
      if (!date || !inRange(date, startDate, endDate)) continue;
      const period = isoPeriod(date);
      if (!period) continue;
      if (positive(app.importeCobrado) <= 0) continue;
      reported.set(period, (reported.get(period) ?? 0) + positive(recognizeIva(app, payment)));
      applications.set(period, (applications.get(period) ?? 0) + 1);
    }
  }

  for (const invoice of invoices) {
    if (!inScope(invoice.cia, companyCode)) continue;
    const date = invoice.fechaCobro;
    if (!date || !inRange(date, startDate, endDate)) continue;
    const period = isoPeriod(date);
    if (!period) continue;
    const iva = positive(invoice.importeIVA);
    if (iva <= 0) continue;
    expected.set(period, (expected.get(period) ?? 0) + iva);
    paidInvoices.set(period, (paidInvoices.get(period) ?? 0) + 1);
  }

  const out = new Map<string, CausedIvaCoverage>();
  for (const period of new Set([...reported.keys(), ...expected.keys()])) {
    const reportedIva = reported.get(period) ?? 0;
    const expectedIva = expected.get(period) ?? 0;
    const comparable = expectedIva >= minExpectedIva;
    const coverageRatio = expectedIva > 0 ? reportedIva / expectedIva : null;
    out.set(period, {
      period,
      reportedIva,
      expectedIva,
      applicationCount: applications.get(period) ?? 0,
      paidInvoiceCount: paidInvoices.get(period) ?? 0,
      coverageRatio,
      implausible: comparable
        && period < currentPeriod
        && coverageRatio !== null
        && coverageRatio < minCoverageRatio,
    });
  }
  return out;
}

/** Periodos con cobertura implausible, en orden cronológico. */
export function implausibleCausedIvaPeriods(
  coverage: Map<string, CausedIvaCoverage>,
): CausedIvaCoverage[] {
  return Array.from(coverage.values())
    .filter((entry) => entry.implausible)
    .sort((a, b) => a.period.localeCompare(b.period));
}
