/**
 * Motor de proyección ROL → ingreso futuro.
 *
 * Modelo (confirmado con el usuario 2026-05-19):
 *
 *   Viaje ejecutado (ROL CITI)  →  Factura emitida (Cobranza JDE)  →  Cobro (Banco)
 *
 *   - ROL aporta el MONTO REAL ejecutado (servicio entregado), más fiel que
 *     el estimado genérico de `projectClientMonth` (`client:`).
 *   - La REGLA de pago (días crédito, día de pago, frecuencia, factoraje) NO
 *     viene de ROL: vive en el catálogo del cliente, sincronizado del API
 *     /cobranza (`recomputeClientCreditDaysFromCobranza`). ROL valida/realiza
 *     ese monto; la regla decide la fecha.
 *   - Solo se proyectan viajes ejecutados AÚN NO FACTURADOS
 *     (`buildRolCobranzaCross().predicted`). Un viaje ya facturado lo maneja
 *     el pipeline `cxc:` (cobranza JDE) y lo cierra el cruce banco. Por
 *     construcción NO hay doble conteo ROL↔cxc: predicted ⊥ invoiced.
 *   - Para clientes con cobertura ROL en un mes de cobro, la proyección
 *     genérica `client:` de ese mes se suprime (ROL es la versión real) →
 *     `coverageByClientMonth`. Sin doble conteo ROL↔client.
 *
 * El ingreso ROL proyectado es FUTURO + PREDICHO: vive sólo en escenarios
 * Aprobado/propuesta. El id `rol:` no pasa `isRealShortTermApiMovement` y la
 * fecha es futura, así que queda fuera de Base por construcción (invariante
 * Base intacto — no editar ese filtro).
 *
 * Salida AGREGADA por (cliente, fecha de cobro): miles de viajes colapsan a
 * ~clientes×fechas líneas. Crítico para no reventar el heap del grid diario.
 */

import type { CashFlowAssumptions, Client } from './types';
import type { CobranzaRecord, RolRecord } from '../services/jdeTypes';
import { buildRolCobranzaCross } from './rolCobranzaMatch';
import {
  buildClientLookup,
  resolveClientCalendarDate,
  type CollectionCalendarClientLookup,
} from './collectionCalendarEngine';

export interface RolProjectedInflow {
  clientId: string;
  clientName: string;
  commercialGroupId?: string;
  /** Fecha de cobro calendarizada por la regla del catálogo. */
  date: string;
  /** Suma de subTotal × (1 + IVA) — lo que entra al banco. */
  grossAmount: number;
  /** Suma de subTotal sin IVA (base gravable). */
  subTotal: number;
  /** Viajes agregados en esta línea. */
  tripCount: number;
  ruleReason: string;
}

export interface RolProjectionResult {
  inflows: RolProjectedInflow[];
  /**
   * clientId → set de `yyyy-mm` de COBRO cubiertos por ROL. El canónico usa
   * esto para suprimir la proyección genérica `client:` de ese cliente/mes.
   */
  coverageByClientMonth: Map<string, Set<string>>;
  /** Viajes ejecutados sin cliente en catálogo (no proyectables — sin regla). */
  unmatchedTrips: number;
  unmatchedAmount: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function onlyDigits(value: string | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

function emptyResult(): RolProjectionResult {
  return {
    inflows: [],
    coverageByClientMonth: new Map(),
    unmatchedTrips: 0,
    unmatchedAmount: 0,
  };
}

export function buildRolProjectedInflows(args: {
  rolRecords: RolRecord[];
  cobranzaRecords: CobranzaRecord[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  asOfDate: string;
  /** Tope superior `yyyy-mm`: cobros más allá del horizonte se descartan. */
  horizonYm?: string;
  /** Lookup precomputado (el canónico ya lo arma — evita reconstruirlo). */
  clientLookup?: CollectionCalendarClientLookup;
}): RolProjectionResult {
  const { rolRecords, cobranzaRecords, clients, assumptions, asOfDate, horizonYm } = args;
  if (!rolRecords || rolRecords.length === 0) return emptyResult();

  const cross = buildRolCobranzaCross(rolRecords, cobranzaRecords ?? []);
  if (cross.predicted.length === 0) return emptyResult();

  const lookup = args.clientLookup ?? buildClientLookup(clients);
  const agg = new Map<string, RolProjectedInflow>();
  const coverage = new Map<string, Set<string>>();
  let unmatchedTrips = 0;
  let unmatchedAmount = 0;

  for (const r of cross.predicted) {
    // Sólo viajes EFECTUADOS generan ingreso; despachado-no-efectuado aún no.
    if (!r.efectuado) continue;
    if (!(r.subTotal > 0)) continue;

    const digits = onlyDigits(r.claveJDE);
    const client = digits ? lookup.byDigits.get(digits)?.[0] : undefined;
    if (!client) {
      // Sin cliente en catálogo no hay regla de pago confiable → no se
      // proyecta (conservador: no inflar caja con fecha adivinada).
      unmatchedTrips += r.viajes;
      unmatchedAmount += r.subTotal;
      continue;
    }

    const base = r.fechaViaje && ISO_DATE.test(r.fechaViaje) ? r.fechaViaje : undefined;
    if (!base) continue;

    const { calendarDate, reason } = resolveClientCalendarDate(client, base, assumptions);
    // ROL proyecta SÓLO futuro. Un cobro calculado en el pasado debería ya
    // estar facturado (cxc:) o cruzado en banco — no es trabajo de ROL.
    if (calendarDate < asOfDate) continue;
    const ym = calendarDate.slice(0, 7);
    if (horizonYm && ym > horizonYm) continue;

    const ivaRate = Number.isFinite(r.iva) && r.iva > 0 ? r.iva : 16;
    const gross = r.subTotal * (1 + ivaRate / 100);

    const key = `${client.id}::${calendarDate}`;
    const existing = agg.get(key);
    if (existing) {
      existing.grossAmount += gross;
      existing.subTotal += r.subTotal;
      existing.tripCount += r.viajes;
    } else {
      agg.set(key, {
        clientId: client.id,
        clientName: client.name,
        commercialGroupId: client.commercialGroupId,
        date: calendarDate,
        grossAmount: gross,
        subTotal: r.subTotal,
        tripCount: r.viajes,
        ruleReason: reason,
      });
    }

    let set = coverage.get(client.id);
    if (!set) {
      set = new Set<string>();
      coverage.set(client.id, set);
    }
    set.add(ym);
  }

  return {
    inflows: Array.from(agg.values()),
    coverageByClientMonth: coverage,
    unmatchedTrips,
    unmatchedAmount,
  };
}
