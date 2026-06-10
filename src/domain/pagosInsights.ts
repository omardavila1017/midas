/**
 * Pagos a Proveedores — agregaciones e higiene de datos para la pestaña de
 * Pagos (espejo del patrón `comprasInsights.ts` para OCs).
 *
 * Tres responsabilidades, todas read-only sobre `PagoProveedorRecord` /
 * `PaymentMatch`:
 *
 *   1. Estado visible del cruce (`pagoDisplayStatus` / `isRealOrphan`) —
 *      ÚNICA fuente de verdad de la definición "huérfano real" (UNMATCHED con
 *      cobertura bancaria, no-empleado). La consumen el KPI, el rollup, los
 *      filtros de `Pagos.tsx` y el CSV; antes vivía duplicada en el componente.
 *
 *   2. `buildPagosDepuracionInsights` — detecciones por lógica sobre los
 *      campos del API que señalan registros depurables en JDE (posibles
 *      dobles pagos, huérfanos viejos que sugieren voids no reflejados,
 *      maestro de proveedores incompleto, fechas inválidas, …). Cada hallazgo
 *      trae las claves `cia::noPago` para enfocar la tabla.
 *
 *   3. `buildPagadoPorMes` (strip mensual) + `pagosToCsv` (export con todos
 *      los campos del API + derivados del cruce).
 *
 * Los importes de pago YA llegan en pesos (`importePesos`) — no hay
 * conversión que hacer; `moneda` ≠ MXP solo señala que el CARGO bancario
 * correspondiente sale en divisa (causa documentada de huérfanos).
 */

import type { PagoProveedorRecord } from '../services/jdeTypes';
import type { PaymentMatch, PaymentStatus } from './paymentReconciliationEngine';
import { isEmployeeSearchType } from './providerDerivation';

/** Días sin cargo bancario tras los cuales un huérfano sugiere void/captura errónea en JDE. */
export const ORPHAN_STALE_DAYS = 30;

/** Clave estable de pago — misma que el dedup de `fetchPagoProveedorRange`. */
export function pagoRecordKey(r: PagoProveedorRecord): string {
  return `${r.cia}::${r.noPago}`;
}

export function isEmployeePago(r: PagoProveedorRecord): boolean {
  return isEmployeeSearchType(r.tipoBusqueda);
}

export function isPagoForeignCurrency(r: PagoProveedorRecord): boolean {
  return Boolean(r.moneda) && r.moneda !== 'MXP' && r.moneda !== 'MXN';
}

/* ───────── Estado visible del cruce ───────── */

/**
 * `UNMATCHED` se desdobla según `bankCoverage`: sin banco cargado contra qué
 * cruzar no hay discrepancia que alarme — "Huérfano" queda reservado para
 * cuentas con cobertura donde el cargo realmente no apareció.
 */
export type PagoDisplayStatus = PaymentStatus | 'NO_BANK_DATA';

export function pagoDisplayStatus(m: PaymentMatch): PagoDisplayStatus {
  return m.status === 'UNMATCHED' && m.bankCoverage !== 'covered' ? 'NO_BANK_DATA' : m.status;
}

/** Huérfano real: hubo banco contra qué cruzar, no-empleado, y no cruzó. */
export function isRealOrphan(m: PaymentMatch): boolean {
  return m.status === 'UNMATCHED' && m.bankCoverage === 'covered' && !isEmployeePago(m.payment);
}

export const PAGO_STATUS_LABEL: Record<PagoDisplayStatus, string> = {
  MATCHED_FULL: 'Conciliado',
  MATCHED_CXP_ONLY: 'CXP ✓ · Banco pendiente',
  MATCHED_BANK_ONLY: 'Pagado · CXP cerrada',
  UNMATCHED: 'Huérfano',
  NO_BANK_DATA: 'Sin estado de cuenta',
};

/* ───────── Strip mensual: pagado por mes ───────── */

export interface PagadoMonth {
  /** YYYY-MM de la fecha de pago. */
  ym: string;
  count: number;
  totalMxn: number;
  proveedoresMxn: number;
  empleadosMxn: number;
  /** Claves `cia::noPago` para enfocar la tabla en el mes. */
  keys: string[];
}

export function buildPagadoPorMes(records: PagoProveedorRecord[]): PagadoMonth[] {
  const map = new Map<string, PagadoMonth>();
  for (const r of records) {
    if (!/^\d{4}-\d{2}/.test(r.fechaPago)) continue;
    const ym = r.fechaPago.slice(0, 7);
    let bucket = map.get(ym);
    if (!bucket) {
      bucket = { ym, count: 0, totalMxn: 0, proveedoresMxn: 0, empleadosMxn: 0, keys: [] };
      map.set(ym, bucket);
    }
    bucket.count += 1;
    bucket.totalMxn += r.importePesos;
    if (isEmployeePago(r)) bucket.empleadosMxn += r.importePesos;
    else bucket.proveedoresMxn += r.importePesos;
    bucket.keys.push(pagoRecordKey(r));
  }
  return Array.from(map.values()).sort((a, b) => a.ym.localeCompare(b.ym));
}

/* ───────── Depuración JDE: hallazgos detectados con lógica ───────── */

export type PagosInsightSeverity = 'danger' | 'warning' | 'info';

export type PagosInsightId =
  | 'posibleDoblePago'
  | 'huerfanoAntiguo'
  | 'sinFechaPago'
  | 'fechaFutura'
  | 'sinCuentaBanco'
  | 'importeNoPositivo'
  | 'monedaExtranjera'
  | 'sinRfc'
  | 'rfcGenerico'
  | 'porClasificar'
  | 'sinReferenciaCxp';

export interface PagosInsight {
  id: PagosInsightId;
  label: string;
  description: string;
  severity: PagosInsightSeverity;
  count: number;
  totalMxn: number;
  /** Claves `cia::noPago` para enfocar la tabla en el hallazgo. */
  keys: string[];
}

const INSIGHT_DEFS: Record<
  PagosInsightId,
  { label: string; description: string; severity: PagosInsightSeverity }
> = {
  posibleDoblePago: {
    label: 'Posibles dobles pagos',
    description:
      'Mismo proveedor, misma fecha y mismo importe en pagos distintos — posible pago duplicado. Verificar contra la factura y solicitar reverso si procede.',
    severity: 'danger',
  },
  huerfanoAntiguo: {
    label: `Huérfanos de +${ORPHAN_STALE_DAYS} días`,
    description:
      `Pagos con banco cargado que llevan más de ${ORPHAN_STALE_DAYS} días sin cargo bancario: probable pago cancelado/void en JDE que el API sigue reportando, o cuenta bancaria mal capturada.`,
    severity: 'warning',
  },
  sinFechaPago: {
    label: 'Sin fecha de pago',
    description:
      'Pagos sin fecha válida: no se pueden fechar ni cruzar contra el banco. Corregir la fecha en JDE.',
    severity: 'warning',
  },
  fechaFutura: {
    label: 'Fecha de pago futura',
    description:
      'La fecha de pago es posterior a hoy — cheque posfechado o fecha mal capturada; el cruce bancario quedará pendiente hasta esa fecha.',
    severity: 'warning',
  },
  sinCuentaBanco: {
    label: 'Sin cuenta bancaria',
    description:
      'Pagos sin número de cuenta emisora: el cruce contra estados de cuenta es imposible. Completar la cuenta en JDE.',
    severity: 'warning',
  },
  importeNoPositivo: {
    label: 'Importe en 0 o negativo',
    description:
      'Pagos con importe no positivo — usualmente reversos/voids que el API sigue listando. Confirmar el void en JDE.',
    severity: 'info',
  },
  monedaExtranjera: {
    label: 'Pagos en divisa',
    description:
      'El importe llega en pesos pero el cargo bancario sale en la divisa original — causa conocida de huérfanos; conciliar manualmente contra el estado de cuenta.',
    severity: 'info',
  },
  sinRfc: {
    label: 'Proveedor sin RFC',
    description:
      'Pagos a proveedores (no empleados) sin RFC en el maestro: impide validar CFDI y cruzar identidad. Completar el RFC en JDE.',
    severity: 'info',
  },
  rfcGenerico: {
    label: 'RFC genérico',
    description:
      'Proveedores con RFC genérico (XAXX/XEXX 010101000) — público en general o extranjero; confirmar si el proveedor debe tener RFC real en el maestro.',
    severity: 'info',
  },
  porClasificar: {
    label: 'Sin clasificación financiera',
    description:
      'Proveedores con clasificación financiera "Por Clasificar" o vacía: ensucian el análisis de egreso por categoría. Clasificarlos en el maestro de JDE.',
    severity: 'info',
  },
  sinReferenciaCxp: {
    label: 'Sin referencia de factura',
    description:
      'Pagos a proveedores sin comentario/folio CXP: el cruce pago→factura depende solo del monto. Capturar la referencia al generar el pago.',
    severity: 'info',
  },
};

const SEVERITY_RANK: Record<PagosInsightSeverity, number> = {
  danger: 0,
  warning: 1,
  info: 2,
};

const GENERIC_RFC_RE = /^X[AE]XX010101000$/i;
const POR_CLASIFICAR_RE = /por\s+clasificar/i;

/** Días transcurridos de `iso` a `asOfDate` (negativo si `iso` es futura). */
function daysSinceIso(iso: string, asOfDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso ?? '')) return null;
  const from = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${asOfDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor((to - from) / 86_400_000);
}

/**
 * Detecciones de higiene de datos sobre los pagos (post-filtro de internos).
 *
 * `matches` es opcional: sin él se omiten los hallazgos que dependen del
 * cruce bancario (`huerfanoAntiguo`); el resto sale solo de los campos del
 * API. El reporte se computa sobre el scope de la cía, no sobre los filtros
 * de la tabla.
 */
export function buildPagosDepuracionInsights(
  records: PagoProveedorRecord[],
  asOfDate: string,
  matches?: PaymentMatch[],
): PagosInsight[] {
  const acc = new Map<PagosInsightId, { count: number; totalMxn: number; keys: string[] }>();
  const add = (id: PagosInsightId, r: PagoProveedorRecord) => {
    let entry = acc.get(id);
    if (!entry) {
      entry = { count: 0, totalMxn: 0, keys: [] };
      acc.set(id, entry);
    }
    entry.count += 1;
    entry.totalMxn += r.importePesos;
    entry.keys.push(pagoRecordKey(r));
  };

  // sig (cia|prov|fecha|importe) → pagos no-empleado candidatos a doble pago
  const dupGroups = new Map<string, PagoProveedorRecord[]>();

  for (const r of records) {
    const employee = isEmployeePago(r);
    const hasFecha = /^\d{4}-\d{2}-\d{2}/.test(r.fechaPago);

    if (!hasFecha) add('sinFechaPago', r);
    else if (r.fechaPago.slice(0, 10) > asOfDate) add('fechaFutura', r);

    if (!r.cuentaBanco.trim()) add('sinCuentaBanco', r);
    if (r.importePesos <= 0) add('importeNoPositivo', r);
    if (isPagoForeignCurrency(r)) add('monedaExtranjera', r);

    if (!employee) {
      const rfc = r.rfcProveedor.trim();
      if (!rfc) add('sinRfc', r);
      else if (GENERIC_RFC_RE.test(rfc)) add('rfcGenerico', r);

      const clasif = r.clasificacionProveedorFinanciera.trim();
      if (!clasif ? !r.clasificacionProveedor.trim() : POR_CLASIFICAR_RE.test(clasif)) {
        add('porClasificar', r);
      }

      if (!r.comentarioPago.trim()) add('sinReferenciaCxp', r);

      if (r.importePesos > 0 && hasFecha) {
        const sig = [r.cia, r.claveProveedor, r.fechaPago, r.importePesos].join('|');
        const group = dupGroups.get(sig);
        if (group) group.push(r);
        else dupGroups.set(sig, [r]);
      }
    }
  }

  for (const group of dupGroups.values()) {
    if (group.length < 2) continue;
    const distinctPagos = new Set(group.map((r) => r.noPago));
    if (distinctPagos.size < 2) continue; // mismo noPago repetido = artefacto de carga, no doble pago
    for (const r of group) add('posibleDoblePago', r);
  }

  if (matches) {
    for (const m of matches) {
      if (!isRealOrphan(m)) continue;
      const days = daysSinceIso(m.payment.fechaPago, asOfDate);
      if (days !== null && days > ORPHAN_STALE_DAYS) add('huerfanoAntiguo', m.payment);
    }
  }

  const out: PagosInsight[] = [];
  for (const [id, entry] of acc) {
    const def = INSIGHT_DEFS[id];
    out.push({ id, ...def, ...entry });
  }
  return out.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.totalMxn - a.totalMxn ||
      a.label.localeCompare(b.label),
  );
}

/* ───────── Export CSV (todos los campos del API + derivados del cruce) ───────── */

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serializa pagos (con su cruce) a CSV — para entregar la lista de depuración al equipo JDE. */
export function pagosToCsv(matches: PaymentMatch[]): string {
  const header = [
    'Compañía', 'Nombre cía', 'Tipo pago', 'No. pago', 'Batch', 'Fecha pago',
    'Importe (pesos)', 'Moneda', 'Clave proveedor', 'Proveedor', 'RFC',
    'Tipo búsqueda', 'Clasificación', 'Clasificación financiera',
    'Cuenta bancaria', 'Cuenta banco', 'Comentario',
    'Estado cruce', 'CXPs cubiertas', 'Cargo banco fecha', 'Cargo banco cuenta', 'Cruce banco',
  ];
  const rows = matches.map((m) => {
    const r = m.payment;
    return [
      r.cia,
      r.nombreCia,
      r.tipoPago,
      r.noPago,
      r.batchPago,
      r.fechaPago,
      r.importePesos.toFixed(2),
      r.moneda,
      r.claveProveedor,
      r.nombreProveedor,
      r.rfcProveedor,
      r.tipoBusqueda,
      r.clasificacionProveedor,
      r.clasificacionProveedorFinanciera,
      r.cuentaBancaria,
      r.cuentaBanco,
      r.comentarioPago,
      PAGO_STATUS_LABEL[pagoDisplayStatus(m)],
      m.cxpMatches.length,
      m.cargoMatch?.movement.fechaOperacion ?? '',
      m.cargoMatch?.cuenta ?? '',
      m.cargoMatch?.tier ?? '',
    ]
      .map(csvCell)
      .join(',');
  });
  return [header.map(csvCell).join(','), ...rows].join('\n');
}
