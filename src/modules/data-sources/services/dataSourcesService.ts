/**
 * ⚠️ TEMPORAL (2026-07-10) — módulo "Fuentes y Datos".
 *
 * Diagnóstico de frescura por fuente de datos (Bancos / JDE / TRESS / ROL),
 * pedido para detectar descuadres tipo Bajío 8-jul-2026 (Midas mostraba un
 * saldo viejo porque la carga manual de estados de cuenta venía atrasada).
 * Read-only: agrega sobre los records que ya están en memoria — NO hace
 * fetches nuevos ni toca motores de proyección/conciliación.
 *
 * Para retirar el módulo: borrar `src/modules/data-sources/` y los puntos
 * marcados "TEMPORAL fuentes-datos" en `AppCore.tsx`, `types.ts`,
 * `NavigationContext.tsx` y `appTabs.ts`.
 */

import type {
  AuxiliarContableRecord,
  BankAccountStatement,
  CobranzaRecord,
  Company,
  ComprasRecord,
  PagoProveedorRecord,
  RolRecord,
  ViajeEspecialRecord,
} from '../../../services/jde';
import type { CXPRecord } from '../../../domain/persistence';
import type { PayrollCostRecord } from '../../shared-finance/types';

// ── Helpers de fecha (tolerantes a basura del API) ─────────────────────────

const ISO_DAY_RE = /^(\d{4}-\d{2}-\d{2})/;

/** Normaliza a "YYYY-MM-DD" o null si el valor no parece fecha ISO. */
export function normalizeIsoDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = ISO_DAY_RE.exec(String(value).trim());
  if (!m) return null;
  // Descarta centinelas tipo "0000-00-00" que algunos endpoints regresan.
  return m[1].startsWith('0000') ? null : m[1];
}

/** Máximo de un iterable de fechas (ya sean crudas o normalizadas). */
export function maxIsoDay(dates: Iterable<string | null | undefined>): string | null {
  let max: string | null = null;
  for (const raw of dates) {
    const d = normalizeIsoDay(raw);
    if (d && (!max || d > max)) max = d;
  }
  return max;
}

/**
 * Días transcurridos entre `iso` y `todayIso` (negativo = fecha futura,
 * frecuente en pagos mal capturados). null si no hay fecha.
 */
export function daysSince(iso: string | null, todayIso: string): number | null {
  if (!iso) return null;
  const a = Date.parse(`${iso}T00:00:00Z`);
  const b = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** Tono semafórico para pintar la frescura en UI. */
export type FreshnessTone = 'fresh' | 'stale' | 'old' | 'none';

export function freshnessTone(days: number | null): FreshnessTone {
  if (days === null) return 'none';
  if (days <= 1) return 'fresh';
  if (days <= 7) return 'stale';
  return 'old';
}

export function companyNameFor(companies: readonly Company[] | undefined, cia: string): string {
  const hit = (companies ?? []).find((c) => c.cia === cia);
  return hit?.nombre ?? cia;
}

// ── Bancos: una fila por cuenta bancaria ────────────────────────────────────

export interface BankAccountFreshnessRow {
  key: string;
  cia: string;
  banco: string;
  nombreBanco?: string;
  cuenta: string;
  moneda: string;
  /** Fecha del MOVIMIENTO más reciente registrado en Midas (no la de carga). */
  latestMovementDate: string | null;
  /** Fecha del estado de cuenta más reciente (fallback informativo). */
  latestStatementDate: string | null;
  movimientos: number;
  /** Saldo final del estado de cuenta más reciente que lo reporta. */
  saldoFinal: number | null;
}

/**
 * Agrega los estados de cuenta a una fila por cuenta (banco::cuenta::cia) con
 * la fecha del movimiento más reciente (`fechaOperacion`, fallback
 * `fechaValor`). Ordena de más reciente a más antigua; cuentas sin fecha van
 * al final. El modelo NO guarda "fecha de carga del archivo" por movimiento —
 * la frescura real se mide con la fecha del movimiento, que es exactamente lo
 * que este reporte expone.
 */
export function buildBankFreshnessRows(
  statements: readonly BankAccountStatement[] | undefined,
): BankAccountFreshnessRow[] {
  const byAccount = new Map<string, BankAccountFreshnessRow & { saldoDate: string | null }>();
  for (const st of statements ?? []) {
    const key = `${st.banco}::${st.cuenta}::${st.cia}`;
    let row = byAccount.get(key);
    if (!row) {
      row = {
        key,
        cia: st.cia,
        banco: st.banco,
        nombreBanco: st.nombreBanco,
        cuenta: st.cuenta,
        moneda: st.moneda,
        latestMovementDate: null,
        latestStatementDate: null,
        movimientos: 0,
        saldoFinal: null,
        saldoDate: null,
      };
      byAccount.set(key, row);
    }
    if (!row.nombreBanco && st.nombreBanco) row.nombreBanco = st.nombreBanco;
    const stDate = normalizeIsoDay(st.fechaEstadoCuenta);
    if (stDate && (!row.latestStatementDate || stDate > row.latestStatementDate)) {
      row.latestStatementDate = stDate;
    }
    if (typeof st.saldoFinal === 'number' && stDate && (!row.saldoDate || stDate > row.saldoDate)) {
      row.saldoFinal = st.saldoFinal;
      row.saldoDate = stDate;
    }
    for (const mov of st.movimientos ?? []) {
      row.movimientos += 1;
      const d = normalizeIsoDay(mov.fechaOperacion) ?? normalizeIsoDay(mov.fechaValor);
      if (d && (!row.latestMovementDate || d > row.latestMovementDate)) {
        row.latestMovementDate = d;
      }
    }
  }
  return [...byAccount.values()]
    .map(({ saldoDate: _saldoDate, ...row }) => row)
    .sort((a, b) => {
      const da = a.latestMovementDate ?? '';
      const db = b.latestMovementDate ?? '';
      if (da !== db) return da > db ? -1 : 1;
      return `${a.banco}${a.cuenta}`.localeCompare(`${b.banco}${b.cuenta}`);
    });
}

// ── JDE: una fila por entidad consultada ────────────────────────────────────

export interface JdeEntityFreshnessRow {
  id: 'empresas' | 'cxp' | 'cobranza' | 'compras' | 'pagos' | 'bancos' | 'auxiliar';
  entidad: string;
  /** Para qué usa Midas esta entidad (copy visible a usuarios no técnicos). */
  uso: string;
  /** Qué fecha se está midiendo (transparencia del cálculo). */
  fechaMedida: string;
  latestDate: string | null;
  registros: number;
}

export interface JdeFreshnessInput {
  companies?: readonly Company[];
  cxpRecords?: readonly CXPRecord[];
  cobranzaRecords?: readonly CobranzaRecord[];
  comprasRecords?: readonly ComprasRecord[];
  pagoProveedorRecords?: readonly PagoProveedorRecord[];
  bankJdeStatements?: readonly BankAccountStatement[];
  auxiliarRecords?: readonly AuxiliarContableRecord[];
}

export function buildJdeEntityRows(input: JdeFreshnessInput): JdeEntityFreshnessRow[] {
  const companies = input.companies ?? [];
  const cxp = input.cxpRecords ?? [];
  const cobranza = input.cobranzaRecords ?? [];
  const compras = input.comprasRecords ?? [];
  const pagos = input.pagoProveedorRecords ?? [];
  const bancos = input.bankJdeStatements ?? [];
  const auxiliar = input.auxiliarRecords ?? [];

  const bancosMovs: string[] = [];
  let bancosCount = 0;
  for (const st of bancos) {
    for (const mov of st.movimientos ?? []) {
      bancosCount += 1;
      bancosMovs.push(mov.fechaOperacion);
    }
  }

  return [
    {
      id: 'empresas',
      entidad: 'Empresas (catálogo)',
      uso: 'Lista de compañías del grupo; define por qué empresas se consulta todo lo demás.',
      fechaMedida: 'Catálogo sin fecha — se muestra el conteo.',
      latestDate: null,
      registros: companies.length,
    },
    {
      id: 'cobranza',
      entidad: 'Cobranza (CXC)',
      uso: 'Facturas por cobrar y cobradas; alimenta Ingresos, Venta y la proyección de cobro.',
      fechaMedida: 'Fecha de factura o de cobro más reciente.',
      latestDate: maxIsoDay(cobranza.flatMap((r) => [r.fechaFactura, r.fechaCobro])),
      registros: cobranza.length,
    },
    {
      id: 'cxp',
      entidad: 'Antigüedad de saldos (CXP)',
      uso: 'Facturas por pagar a proveedores; alimenta Egresos y la proyección de pagos.',
      fechaMedida: 'Fecha de factura más reciente.',
      latestDate: maxIsoDay(cxp.map((r) => r.fechaFactura)),
      registros: cxp.length,
    },
    {
      id: 'compras',
      entidad: 'Órdenes de compra',
      uso: 'OCs pedidas/recibidas; alimenta Órdenes de Compras, Pasivo por Distribuir y el egreso proyectado.',
      fechaMedida: 'Fecha de pedido o de recepción más reciente.',
      latestDate: maxIsoDay(compras.flatMap((r) => [r.fechaPedido, r.fechaRecepcion])),
      registros: compras.length,
    },
    {
      id: 'pagos',
      entidad: 'Pagos a proveedores',
      uso: 'Pagos ya ejecutados en JDE; valida contra el cargo bancario qué CXP quedó pagada.',
      fechaMedida: 'Fecha de pago más reciente.',
      latestDate: maxIsoDay(pagos.map((r) => r.fechaPago)),
      registros: pagos.length,
    },
    {
      id: 'bancos',
      entidad: 'Estados de cuenta (vía JDE)',
      uso: 'Movimientos bancarios que tesorería sube a JDE; son la verdad del efectivo histórico.',
      fechaMedida: 'Fecha de operación del movimiento más reciente.',
      latestDate: maxIsoDay(bancosMovs),
      registros: bancosCount,
    },
    {
      id: 'auxiliar',
      entidad: 'Auxiliar contable (libro mayor)',
      uso: 'Pólizas del mayor (caja/bancos e IVA); alimenta la Conciliación y el IVA real de Impuestos.',
      fechaMedida: 'Fecha contable más reciente.',
      latestDate: maxIsoDay(auxiliar.map((r) => r.fechaContable)),
      registros: auxiliar.length,
    },
  ];
}

// ── TRESS: una fila por empresa de nómina ───────────────────────────────────

export interface TressFreshnessRow {
  key: string;
  cia: string;
  empresaNomina: string;
  /** Fecha de pago de nómina más reciente. */
  latestPaymentDate: string | null;
  /** Periodo (YYYY-MM) más reciente con datos. */
  latestPeriod: string | null;
  registros: number;
}

export function buildTressFreshnessRows(
  records: readonly PayrollCostRecord[] | undefined,
): TressFreshnessRow[] {
  const byEmpresa = new Map<string, TressFreshnessRow>();
  for (const r of records ?? []) {
    const key = `${r.cia}::${r.empresaNomina}`;
    let row = byEmpresa.get(key);
    if (!row) {
      row = {
        key,
        cia: r.cia,
        empresaNomina: r.empresaNomina,
        latestPaymentDate: null,
        latestPeriod: null,
        registros: 0,
      };
      byEmpresa.set(key, row);
    }
    row.registros += 1;
    const pay = normalizeIsoDay(r.paymentDate);
    if (pay && (!row.latestPaymentDate || pay > row.latestPaymentDate)) row.latestPaymentDate = pay;
    if (Number.isFinite(r.year) && Number.isFinite(r.month)) {
      const period = `${r.year}-${String(r.month).padStart(2, '0')}`;
      if (!row.latestPeriod || period > row.latestPeriod) row.latestPeriod = period;
    }
  }
  return [...byEmpresa.values()].sort((a, b) => {
    const da = a.latestPaymentDate ?? '';
    const db = b.latestPaymentDate ?? '';
    if (da !== db) return da > db ? -1 : 1;
    return a.empresaNomina.localeCompare(b.empresaNomina);
  });
}

// ── ROL (CITI): una fila por empresa operativa ──────────────────────────────

export interface RolFreshnessRow {
  empresa: string;
  /** Fecha del viaje más reciente registrado. */
  latestFechaViaje: string | null;
  registros: number;
}

export function buildRolFreshnessRows(records: readonly RolRecord[] | undefined): RolFreshnessRow[] {
  const byEmpresa = new Map<string, RolFreshnessRow>();
  for (const r of records ?? []) {
    const empresa = r.empresa || r.cia || 'Sin empresa';
    let row = byEmpresa.get(empresa);
    if (!row) {
      row = { empresa, latestFechaViaje: null, registros: 0 };
      byEmpresa.set(empresa, row);
    }
    row.registros += 1;
    const d = normalizeIsoDay(r.fechaViaje);
    if (d && (!row.latestFechaViaje || d > row.latestFechaViaje)) row.latestFechaViaje = d;
  }
  return [...byEmpresa.values()].sort((a, b) => {
    const da = a.latestFechaViaje ?? '';
    const db = b.latestFechaViaje ?? '';
    if (da !== db) return da > db ? -1 : 1;
    return a.empresa.localeCompare(b.empresa);
  });
}

export interface ViajesEspecialesSummary {
  latestDate: string | null;
  registros: number;
}

/** Resumen de Viajes Especiales (fecha de viaje, fallback fecha de factura). */
export function summarizeViajesEspeciales(
  records: readonly ViajeEspecialRecord[] | undefined,
): ViajesEspecialesSummary {
  const all = records ?? [];
  return {
    latestDate: maxIsoDay(
      all.flatMap((r) => [r.fRegresoUltima, r.fSalidaPrimera, r.fechaFactura]),
    ),
    registros: all.length,
  };
}
