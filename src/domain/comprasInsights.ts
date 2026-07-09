/**
 * Compras (OCs) — agregaciones e higiene de datos para la pestaña de
 * Órdenes de Compra.
 *
 * Dos responsabilidades, ambas read-only sobre `ComprasRecord`:
 *
 *   1. `buildOpenSinEntradaByMonth` — el strip mensual de la pestaña: OCs
 *      ABIERTAS (no canceladas, sin factura, workflow vivo) que nunca
 *      recibieron entrada de mercancía, agrupadas por mes de pedido. Es el
 *      comprometido "fantasma": sin F_Recepcion no hay fecha cierta de pago,
 *      pero la orden tampoco está cerrada en JDE.
 *
 *   2. `buildComprasDepuracionInsights` — detecciones por lógica sobre los
 *      campos del API que señalan registros depurables en JDE (órdenes
 *      muertas, fechas invertidas, tipo de cambio faltante, posibles
 *      duplicados, workflow cerrado sin cancelar, …). Cada hallazgo trae las
 *      claves de registro para enfocar la tabla.
 *
 * Los montos se reportan SIEMPRE en MXN (`comprasImporteMxn`), con la misma
 * conversión que usa el motor (`comprasToPurchaseReceipts.buildRecord`):
 * MXP/MXN tal cual; otra moneda × tipoCambio (fallback 1).
 */

import type { ComprasRecord } from '../services/jdeTypes';
import { isComprasWorkflowClosed } from './comprasToPurchaseReceipts';
import { csvDate } from '../utils/export';

/** Días sin entrada tras los cuales una OC abierta se considera probable orden muerta. */
export const STALE_OPEN_ORDER_DAYS = 90;
/** Gracia tras la fecha de pago proyectada antes de marcar "recibida sin factura" como vencida. */
export const INVOICE_OVERDUE_GRACE_DAYS = 30;

/** Clave estable de línea de OC — misma que el dedup de `fetchComprasRange`. */
export function comprasRecordKey(r: ComprasRecord): string {
  return `${r.cia}::${r.noOrden}::${r.lineaOrden}`;
}

export function isComprasForeignCurrency(r: ComprasRecord): boolean {
  return Boolean(r.moneda) && r.moneda !== 'MXP' && r.moneda !== 'MXN';
}

/** Importe en MXN — espejo de la conversión del motor (`buildRecord`). */
export function comprasImporteMxn(r: ComprasRecord): number {
  const amount = r.importeTotal || 0;
  if (!isComprasForeignCurrency(r)) return amount;
  return amount * (r.tipoCambio || 1);
}

/**
 * OC abierta que nunca recibió entrada de mercancía: no cancelada, sin
 * factura, sin F_Recepcion y con workflow vivo (Edo_Sig ≠ 998/999 — si el
 * workflow ya la cerró no está "abierta", está mal cerrada y la reporta el
 * hallazgo `workflowCerrado`).
 */
export function isOpenSinEntrada(r: ComprasRecord): boolean {
  return (
    !r.cancelada &&
    !r.facturada &&
    !r.fechaRecepcion &&
    !isComprasWorkflowClosed(r.estadoSiguiente)
  );
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Días transcurridos de `iso` a `asOfDate` (negativo si `iso` es futura). */
export function daysSinceIso(iso: string, asOfDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso ?? '')) return null;
  const from = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  const to = Date.parse(`${asOfDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor((to - from) / 86_400_000);
}

/** OC abierta sin entrada cuyo pedido superó la ventana de orden muerta. */
export function isStaleSinEntrada(r: ComprasRecord, asOfDate: string): boolean {
  if (!isOpenSinEntrada(r) || !r.fechaPedido) return false;
  const days = daysSinceIso(r.fechaPedido, asOfDate);
  return days !== null && days > STALE_OPEN_ORDER_DAYS;
}

// ───────────────────────────────────────────────────────────────
// Strip mensual: OCs abiertas sin entrada por mes de pedido
// ───────────────────────────────────────────────────────────────

export interface OpenSinEntradaMonth {
  /** YYYY-MM de la fecha de pedido. */
  ym: string;
  count: number;
  totalMxn: number;
  /** true cuando TODO el mes quedó atrás del corte de STALE_OPEN_ORDER_DAYS. */
  stale: boolean;
  /** Claves de registro para enfocar la tabla en el mes. */
  keys: string[];
}

export function buildOpenSinEntradaByMonth(
  records: ComprasRecord[],
  asOfDate: string,
): OpenSinEntradaMonth[] {
  const staleCutoffYm = addDaysIso(asOfDate, -STALE_OPEN_ORDER_DAYS).slice(0, 7);
  const map = new Map<string, OpenSinEntradaMonth>();
  for (const r of records) {
    if (!isOpenSinEntrada(r)) continue;
    if (!/^\d{4}-\d{2}/.test(r.fechaPedido)) continue;
    const ym = r.fechaPedido.slice(0, 7);
    let bucket = map.get(ym);
    if (!bucket) {
      bucket = { ym, count: 0, totalMxn: 0, stale: Boolean(staleCutoffYm) && ym < staleCutoffYm, keys: [] };
      map.set(ym, bucket);
    }
    bucket.count += 1;
    bucket.totalMxn += comprasImporteMxn(r);
    bucket.keys.push(comprasRecordKey(r));
  }
  return Array.from(map.values()).sort((a, b) => a.ym.localeCompare(b.ym));
}

// ───────────────────────────────────────────────────────────────
// Estado derivado de la OC (chip de la tabla + CSV)
// ───────────────────────────────────────────────────────────────

export type CompraEstado =
  | 'cancelada'
  | 'facturada'
  | 'cerradaWorkflow'
  | 'porPagar'
  | 'sinEntrada';

export function compraEstado(r: ComprasRecord): CompraEstado {
  if (r.cancelada) return 'cancelada';
  if (r.facturada) return 'facturada';
  if (isComprasWorkflowClosed(r.estadoSiguiente)) return 'cerradaWorkflow';
  if (r.fechaRecepcion) return 'porPagar';
  return 'sinEntrada';
}

export const COMPRA_ESTADO_LABEL: Record<CompraEstado, string> = {
  cancelada: 'Cancelada',
  facturada: 'Facturada',
  cerradaWorkflow: 'Cerrada en JDE',
  // "Por pagar" confundía: la mercancía ya entró pero NO hay factura — es el
  // "pasivo por distribuir" de JDE, no una cuenta por pagar (ver Compras.tsx).
  porPagar: 'Pendiente factura',
  sinEntrada: 'Sin entrada',
};

// ───────────────────────────────────────────────────────────────
// Resumen financiero por OC (agregación de líneas → una fila por orden)
// ───────────────────────────────────────────────────────────────

/**
 * Estado de la OC completa (rollup de sus líneas), pensado para el foco
 * FINANCIERO (no de abastecimiento):
 *   • pendienteRecibir — tiene líneas creadas sin entrada → gasto futuro que va
 *     a caer; es el backlog principal de la pestaña.
 *   • pendienteFactura — recibida sin factura = "pasivo por distribuir" (cuenta
 *     puente de JDE); el material entró, falta el documento de cobro.
 *   • facturada — todas sus líneas ya tienen factura → vive en CXP / Antigüedad
 *     de Saldos, NO debe reproyectarse aquí.
 *   • cerrada — cerrada en el workflow de JDE (Edo_Sig 998/999).
 *   • cancelada — todas sus líneas canceladas.
 * Precedencia: pendienteRecibir > pendienteFactura > facturada > cerrada >
 * cancelada (si todavía falta recibir algo, eso manda).
 */
export type ComprasOrderEstado =
  | 'pendienteRecibir'
  | 'pendienteFactura'
  | 'facturada'
  | 'cerrada'
  | 'cancelada';

export const COMPRA_ORDER_ESTADO_LABEL: Record<ComprasOrderEstado, string> = {
  pendienteRecibir: 'Pendiente de recibir',
  pendienteFactura: 'Pendiente factura',
  facturada: 'Facturada',
  cerrada: 'Cerrada en JDE',
  cancelada: 'Cancelada',
};

export interface ComprasOrderSummary {
  cia: string;
  noOrden: string;
  noProveedor: string;
  nombreProveedor: string;
  lineCount: number;
  /** Σ recibido + Σ pendiente por recibir (NO incluye canceladas ni cerradas). */
  importeTotalMxn: number;
  /** Σ líneas recibidas (con o sin factura). */
  importeRecibidoMxn: number;
  /** Σ líneas ya facturadas (subconjunto de recibido — vive en CXP). */
  importeFacturadoMxn: number;
  /** Σ líneas creadas sin entrada — lo que falta por recibir. */
  importePendienteRecibirMxn: number;
  /** Σ líneas recibidas sin factura — "pasivo por distribuir". */
  importePendienteFacturaMxn: number;
  /** Fecha de pedido más antigua entre sus líneas. */
  fechaPedido: string;
  /** Fecha de pago proyectada más reciente entre sus líneas (si hay). */
  fechaPagoProyectada: string;
  /** Días desde la fecha de pedido más antigua. */
  antiguedadDias: number | null;
  estado: ComprasOrderEstado;
  /** Categoría representativa (primera línea con categoría). */
  categoria: string;
  /** Claves de línea — para enfocar/exportar/cruzar. */
  keys: string[];
}

/**
 * Agrega las líneas de OC a UNA fila por orden (cia::noOrden). El split
 * recibido / pendiente por recibir / pendiente factura se deriva del estado de
 * cada línea (`compraEstado`); las líneas canceladas y cerradas-en-workflow se
 * excluyen de los importes (no son ni un gasto futuro ni un pasivo vivo). Es la
 * vista que pidió finanzas: total de la OC + cuánto ya entró + cuánto falta,
 * sin detalle de producto.
 */
export function buildComprasByOrder(
  records: ComprasRecord[],
  asOfDate: string,
): ComprasOrderSummary[] {
  const map = new Map<string, ComprasOrderSummary & {
    _hasPendienteRecibir: boolean;
    _hasPendienteFactura: boolean;
    _hasFacturada: boolean;
    _hasCerrada: boolean;
  }>();

  for (const r of records) {
    const orderKey = `${r.cia}::${r.noOrden}`;
    let o = map.get(orderKey);
    if (!o) {
      o = {
        cia: r.cia,
        noOrden: r.noOrden,
        noProveedor: r.noProveedor,
        nombreProveedor: r.nombreProveedor,
        lineCount: 0,
        importeTotalMxn: 0,
        importeRecibidoMxn: 0,
        importeFacturadoMxn: 0,
        importePendienteRecibirMxn: 0,
        importePendienteFacturaMxn: 0,
        fechaPedido: '',
        fechaPagoProyectada: '',
        antiguedadDias: null,
        estado: 'cancelada',
        categoria: '',
        keys: [],
        _hasPendienteRecibir: false,
        _hasPendienteFactura: false,
        _hasFacturada: false,
        _hasCerrada: false,
      };
      map.set(orderKey, o);
    }
    o.lineCount += 1;
    o.keys.push(comprasRecordKey(r));
    if (!o.categoria) o.categoria = r.descCategoria || r.descFamilia || r.categoria || r.familia || '';
    if (r.fechaPedido && (!o.fechaPedido || r.fechaPedido < o.fechaPedido)) o.fechaPedido = r.fechaPedido;
    if (r.fechaPagoProyectada && r.fechaPagoProyectada > o.fechaPagoProyectada) o.fechaPagoProyectada = r.fechaPagoProyectada;

    const mxn = comprasImporteMxn(r);
    switch (compraEstado(r)) {
      case 'sinEntrada':
        o.importePendienteRecibirMxn += mxn;
        o._hasPendienteRecibir = true;
        break;
      case 'porPagar':
        o.importeRecibidoMxn += mxn;
        o.importePendienteFacturaMxn += mxn;
        o._hasPendienteFactura = true;
        break;
      case 'facturada':
        o.importeRecibidoMxn += mxn;
        o.importeFacturadoMxn += mxn;
        o._hasFacturada = true;
        break;
      case 'cerradaWorkflow':
        o._hasCerrada = true;
        break;
      // 'cancelada' no aporta importe
    }
  }

  const out: ComprasOrderSummary[] = [];
  for (const o of map.values()) {
    o.importeTotalMxn = o.importeRecibidoMxn + o.importePendienteRecibirMxn;
    o.estado = o._hasPendienteRecibir
      ? 'pendienteRecibir'
      : o._hasPendienteFactura
        ? 'pendienteFactura'
        : o._hasFacturada
          ? 'facturada'
          : o._hasCerrada
            ? 'cerrada'
            : 'cancelada';
    o.antiguedadDias = o.fechaPedido ? daysSinceIso(o.fechaPedido, asOfDate) : null;
    const {
      _hasPendienteRecibir, _hasPendienteFactura, _hasFacturada, _hasCerrada, ...summary
    } = o;
    void _hasPendienteRecibir; void _hasPendienteFactura; void _hasFacturada; void _hasCerrada;
    out.push(summary);
  }
  // Backlog primero (pendiente de recibir / factura), luego por importe total.
  const estadoRank: Record<ComprasOrderEstado, number> = {
    pendienteRecibir: 0, pendienteFactura: 1, facturada: 2, cerrada: 3, cancelada: 4,
  };
  return out.sort(
    (a, b) =>
      estadoRank[a.estado] - estadoRank[b.estado] ||
      b.importeTotalMxn - a.importeTotalMxn ||
      a.noOrden.localeCompare(b.noOrden),
  );
}

/** Serializa el resumen por OC a CSV (BOM-friendly, mismo patrón que el detalle). */
export function comprasOrdersToCsv(orders: ComprasOrderSummary[]): string {
  const header = [
    'Compañía', 'No. proveedor', 'Proveedor', 'OC', 'Líneas', 'Estado',
    'Importe total MXN', 'Recibido MXN', 'Facturado MXN',
    'Pendiente por recibir MXN', 'Pendiente factura MXN',
    'Fecha pedido', 'Antigüedad (días)', 'Pago proyectado', 'Categoría',
  ];
  const rows = orders.map((o) =>
    [
      o.cia,
      o.noProveedor,
      o.nombreProveedor,
      o.noOrden,
      o.lineCount,
      COMPRA_ORDER_ESTADO_LABEL[o.estado],
      o.importeTotalMxn.toFixed(2),
      o.importeRecibidoMxn.toFixed(2),
      o.importeFacturadoMxn.toFixed(2),
      o.importePendienteRecibirMxn.toFixed(2),
      o.importePendienteFacturaMxn.toFixed(2),
      csvDate(o.fechaPedido),
      o.antiguedadDias ?? '',
      csvDate(o.fechaPagoProyectada),
      o.categoria,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.map(csvCell).join(','), ...rows].join('\n');
}

// ───────────────────────────────────────────────────────────────
// Depuración JDE: hallazgos detectados con lógica sobre el API
// ───────────────────────────────────────────────────────────────

export type ComprasInsightSeverity = 'danger' | 'warning' | 'info';

export type ComprasInsightId =
  | 'extranjeraSinTc'
  | 'staleSinEntrada'
  | 'recibidaSinFacturaVencida'
  | 'posibleDuplicado'
  | 'recepcionAntesPedido'
  | 'sinFechaPedido'
  | 'creditoCero'
  | 'workflowCerrado'
  | 'canceladaConFactura'
  | 'importeNoPositivo';

export interface ComprasInsight {
  id: ComprasInsightId;
  label: string;
  description: string;
  severity: ComprasInsightSeverity;
  count: number;
  totalMxn: number;
  /** Claves de registro para enfocar la tabla en el hallazgo. */
  keys: string[];
}

const INSIGHT_DEFS: Record<
  ComprasInsightId,
  { label: string; description: string; severity: ComprasInsightSeverity }
> = {
  extranjeraSinTc: {
    label: 'Moneda extranjera sin TC',
    description:
      'OCs en divisa con tipo de cambio en 0/1: el importe se suma a la par y subestima el egreso real. Capturar el TC en JDE.',
    severity: 'danger',
  },
  staleSinEntrada: {
    label: `Sin entrada hace +${STALE_OPEN_ORDER_DAYS} días`,
    description:
      `Pedidas hace más de ${STALE_OPEN_ORDER_DAYS} días y nunca se les dio entrada. Probables órdenes muertas que inflan el comprometido — cerrarlas o cancelarlas en JDE.`,
    severity: 'warning',
  },
  recibidaSinFacturaVencida: {
    label: 'Recibidas sin factura (vencidas)',
    description:
      `Con entrada y pago proyectado vencido hace +${INVOICE_OVERDUE_GRACE_DAYS} días, pero sin factura en JDE: o se pagaron fuera del flujo o el registro de la factura está atorado.`,
    severity: 'warning',
  },
  posibleDuplicado: {
    label: 'Posibles duplicados',
    description:
      'Mismo proveedor, producto, cantidad, importe y fecha de pedido en órdenes distintas — posible doble captura. Revisar y cancelar la sobrante.',
    severity: 'warning',
  },
  recepcionAntesPedido: {
    label: 'Recepción antes del pedido',
    description:
      'La fecha de entrada es anterior a la fecha del pedido — fechas invertidas en la captura.',
    severity: 'warning',
  },
  sinFechaPedido: {
    label: 'Sin fecha de pedido',
    description: 'OCs activas sin fecha de pedido válida: no se pueden fechar ni proyectar.',
    severity: 'warning',
  },
  creditoCero: {
    label: 'Recibidas con crédito 0',
    description:
      'El pago se proyecta el mismo día de la entrada porque D_Credito viene en 0. Completar el plazo en el maestro de proveedores de JDE.',
    severity: 'info',
  },
  workflowCerrado: {
    label: 'Cerradas en workflow sin cancelar',
    description:
      'El Edo_Sig (998/999) las marca cerradas pero no tienen fecha de cancelación: aparecen activas aunque el motor las excluye. Formalizar el cierre en JDE.',
    severity: 'info',
  },
  canceladaConFactura: {
    label: 'Canceladas con factura',
    description:
      'Tienen F_Cancelada y N_Factura a la vez — estado contradictorio; confirmar cuál vale.',
    severity: 'info',
  },
  importeNoPositivo: {
    label: 'Importe en 0 o negativo',
    description:
      'Líneas activas con importe no positivo: la proyección las ignora. Corregir o cerrar en JDE.',
    severity: 'info',
  },
};

const SEVERITY_RANK: Record<ComprasInsightSeverity, number> = {
  danger: 0,
  warning: 1,
  info: 2,
};

export function buildComprasDepuracionInsights(
  records: ComprasRecord[],
  asOfDate: string,
): ComprasInsight[] {
  const acc = new Map<ComprasInsightId, { count: number; totalMxn: number; keys: string[] }>();
  const add = (id: ComprasInsightId, r: ComprasRecord) => {
    let entry = acc.get(id);
    if (!entry) {
      entry = { count: 0, totalMxn: 0, keys: [] };
      acc.set(id, entry);
    }
    entry.count += 1;
    entry.totalMxn += comprasImporteMxn(r);
    entry.keys.push(comprasRecordKey(r));
  };

  const invoiceOverdueCutoff = addDaysIso(asOfDate, -INVOICE_OVERDUE_GRACE_DAYS);
  // sig (cia|prov|fecha|producto|cantidad|importe) → líneas candidatas a duplicado
  const dupGroups = new Map<string, ComprasRecord[]>();

  for (const r of records) {
    if (r.cancelada) {
      if (r.facturada) add('canceladaConFactura', r);
      continue;
    }

    if (isStaleSinEntrada(r, asOfDate)) add('staleSinEntrada', r);

    if (
      !r.facturada &&
      r.fechaRecepcion &&
      r.fechaPagoProyectada &&
      invoiceOverdueCutoff &&
      r.fechaPagoProyectada < invoiceOverdueCutoff
    ) {
      add('recibidaSinFacturaVencida', r);
    }

    if (!r.facturada && r.fechaRecepcion && (Math.floor(Number(r.diasCredito) || 0)) <= 0) {
      add('creditoCero', r);
    }

    if (!r.facturada && isComprasWorkflowClosed(r.estadoSiguiente)) add('workflowCerrado', r);

    if (r.fechaRecepcion && r.fechaPedido && r.fechaRecepcion < r.fechaPedido) {
      add('recepcionAntesPedido', r);
    }

    if (!r.fechaPedido) add('sinFechaPedido', r);

    if (isComprasForeignCurrency(r) && (r.tipoCambio || 0) <= 1) add('extranjeraSinTc', r);

    if ((r.importeTotal || 0) <= 0) add('importeNoPositivo', r);

    if ((r.importeTotal || 0) > 0 && r.fechaPedido) {
      const producto = (r.noProducto || r.descProducto).trim().toUpperCase();
      if (producto) {
        const sig = [r.cia, r.noProveedor, r.fechaPedido, producto, r.cantidad, r.importeTotal].join('|');
        const group = dupGroups.get(sig);
        if (group) group.push(r);
        else dupGroups.set(sig, [r]);
      }
    }
  }

  for (const group of dupGroups.values()) {
    if (group.length < 2) continue;
    const distinctOrders = new Set(group.map((r) => r.noOrden));
    if (distinctOrders.size < 2) continue; // multi-línea de la MISMA orden = legítimo
    for (const r of group) add('posibleDuplicado', r);
  }

  const out: ComprasInsight[] = [];
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

// ───────────────────────────────────────────────────────────────
// Export CSV (todos los campos del API + derivados)
// ───────────────────────────────────────────────────────────────

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serializa OCs a CSV con todos los campos del API + derivados (estado, MXN). */
export function comprasToCsv(records: ComprasRecord[]): string {
  const header = [
    'Compañía', 'No. proveedor', 'Proveedor', 'OC', 'Línea', 'Tipo de orden', 'Estado',
    'Producto', 'Descripción', 'Concepto', 'Cantidad', 'Precio unitario',
    'Importe', 'Moneda', 'Tipo de cambio', 'Importe MXN',
    'Fecha pedido', 'Fecha recepción', 'Días crédito', 'Pago proyectado', 'Factura',
    'Centro de costos', 'Categoría', 'Familia', 'Subfamilia', 'Edo. sig.', 'Tasa fiscal',
  ];
  const rows = records.map((r) =>
    [
      r.cia,
      r.noProveedor,
      r.nombreProveedor,
      r.noOrden,
      r.lineaOrden,
      r.descTipoOrden || r.tipoOrden,
      COMPRA_ESTADO_LABEL[compraEstado(r)],
      r.noProducto,
      r.descProducto,
      r.concepto,
      r.cantidad,
      r.precioUnitario.toFixed(2),
      r.importeTotal.toFixed(2),
      r.moneda,
      r.tipoCambio,
      comprasImporteMxn(r).toFixed(2),
      csvDate(r.fechaPedido),
      csvDate(r.fechaRecepcion),
      r.diasCredito,
      csvDate(r.fechaPagoProyectada),
      r.noFactura,
      r.centroCostos,
      r.descCategoria || r.categoria,
      r.descFamilia || r.familia,
      r.descSubFamilia || r.subFamilia,
      r.estadoSiguiente,
      r.tasaFiscal,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.map(csvCell).join(','), ...rows].join('\n');
}
