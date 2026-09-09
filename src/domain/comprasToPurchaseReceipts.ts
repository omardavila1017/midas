/**
 * Adapter ComprasRecord → PurchaseReceiptRecord.
 *
 * Dos pasadas por la lista de OCs:
 *
 *   1. **OCs CONFIRMED**  → tienen `fechaRecepcion` real. `estimatedDueDate`
 *      ya viene calculado (recepción + díasCrédito). Alta confianza.
 *   2. **OCs PROJECTED**  → emitidas pero NO recibidas (`fechaRecepcion`
 *      vacío). Estimamos recepción usando lead time histórico por familia
 *      (`computeLeadTimeStats`) y derivamos `estimatedDueDate =
 *      fechaPedido + leadTime + díasCrédito`. Menor confianza, alimentan
 *      forecast a largo plazo.
 *
 * Filtros comunes:
 *   - `cancelada === false` (F_Cancelada válida)
 *   - importe > 0
 *   - workflow JDE no cerrado/cancelado (ver `isWorkflowStateClosed`)
 *   - fecha de pago proyectada vencida por más de 1 mes ya no se proyecta
 *
 * El dedup contra CXP se hace downstream en `buildPurchaseReceiptMovements`
 * (`sourceRecords.ts`), no acá — porque el motor canónico tiene contexto
 * de toda la CXP del scope, mientras que este adapter solo ve compras.
 */

import type { CXPRecord } from './persistence';
import type { ComprasRecord, PagoProveedorRecord } from '../services/jdeTypes';
import type {
  PurchaseReceiptRecord,
  FinancialTaxRate,
  FinancialTaxTreatment,
  PurchaseConfidence,
} from '../modules/shared-finance/types';
import {
  computeLeadTimeStats,
  leadTimeFor,
  type LeadTimeStats,
} from './comprasLeadTime';
import { normalizeJdeKey, normalizeProviderName } from './providerIdentity';
import { todayISO } from '../formatters';

/**
 * Estados workflow JDE (Edo_Sig) que indican OC cerrada o sin acción de pago
 * pendiente. Si vemos uno de estos, el OC no debe alimentar el forecast.
 *
 * Documentado por el equipo JDE (parcial — el resto se infiere):
 *   - 380 = recibido facturado (CXP la cubrirá, dedup la quita)
 *   - 999 / 998 = cerrada / cancelada workflow
 *   - 400+ = post-recepción (factura, contabilización)
 *
 * Lista conservadora: solo bloqueamos los códigos que CLARAMENTE son cierre.
 * No queremos perder OCs activas por filtrar demás. Si un estado no está acá,
 * se procesa normal y se sujeta a los otros filtros (cancelada, importe, fecha).
 */
const CLOSED_WORKFLOW_STATES = new Set<string>(['999', '998']);

export function isComprasWorkflowClosed(edoSig: string | undefined): boolean {
  if (!edoSig) return false;
  return CLOSED_WORKFLOW_STATES.has(edoSig.trim());
}

function parseTasaFiscal(raw: string): FinancialTaxRate | undefined {
  const t = raw.trim().toUpperCase();
  if (!t) return undefined;
  if (t.includes('IVA16') || /\b16\b/.test(t)) return 16;
  if (t.includes('IVA8') || /\b8\b/.test(t)) return 8;
  if (t.includes('IVA0') || t.includes('EXTO') || t.includes('EXEN')) return 0;
  return undefined;
}

function taxTreatmentFor(rate: FinancialTaxRate | undefined): FinancialTaxTreatment {
  if (rate === 16 || rate === 8) return 'IVA_CREDITABLE';
  if (rate === 0) return 'IVA_EXEMPT';
  return 'UNCLASSIFIED';
}

function todayIso(): string {
  return todayISO();
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function addMonths(date: string, months: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  return parsed.toISOString().slice(0, 10);
}

function cleanIsoDate(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : undefined;
}

function isPastPaymentGrace(paymentDate: string, asOfDate: string): boolean {
  const cleanPaymentDate = cleanIsoDate(paymentDate);
  if (!cleanPaymentDate) return false;
  return addMonths(cleanPaymentDate, 1) < asOfDate;
}

function buildRecord(
  r: ComprasRecord,
  estimatedDueDate: string,
  confidence: PurchaseConfidence,
  leadTimeMeta?: { days: number; source: string },
): PurchaseReceiptRecord | null {
  const amount = r.importeTotal || 0;
  if (amount <= 0) return null;

  const taxRate = parseTasaFiscal(r.tasaFiscal);
  const treatment = taxTreatmentFor(taxRate);
  const taxBaseAmount = taxRate && taxRate > 0 ? amount / (1 + taxRate / 100) : undefined;
  const taxAmount = taxBaseAmount !== undefined ? amount - taxBaseAmount : undefined;

  const currency = r.moneda === 'MXP' || r.moneda === 'MXN' ? 'MXN' : r.moneda || 'MXN';
  const fx = currency === 'MXN' ? 1 : (r.tipoCambio || 1);
  const amountMxn = currency === 'MXN' ? amount : amount * fx;

  return {
    cia: r.cia,
    noProveedor: r.noProveedor,
    // `.trim()`: JDE manda nombres con relleno de espacios, y un nombre de sólo
    // espacios no caía al placeholder — salía como contraparte en blanco.
    supplierName: r.nombreProveedor?.trim() || 'Proveedor sin nombre',
    invoiceNo: r.noFactura,
    purchaseOrderNo: r.noOrden,
    receiptNo: r.lineaOrden ? String(r.lineaOrden) : '',
    orderDate: r.fechaPedido,
    receiptDate: r.fechaRecepcion,
    creditDays: r.diasCredito,
    estimatedDueDate,
    currency,
    exchangeRate: fx,
    totalAmount: amount,
    amountMxn,
    taxCode: undefined,
    taxRateCode: r.tasaFiscal.trim() || undefined,
    taxRate,
    taxTreatment: treatment,
    taxBaseAmount,
    taxAmount,
    cancelledAt: undefined,
    isCancelled: false,
    status: 'PROJECTED_BASE',
    costCenter: r.centroCostos.trim() || undefined,
    productCode: r.noProducto.trim() || undefined,
    productDescription: r.descProducto.trim() || undefined,
    productType: undefined,
    categoryCode: r.categoria.trim() || undefined,
    categoryName: r.descCategoria.trim() || undefined,
    familyCode: r.familia.trim() || undefined,
    familyName: r.descFamilia.trim() || undefined,
    subfamilyCode: r.subFamilia.trim() || undefined,
    subfamilyName: r.descSubFamilia.trim() || undefined,
    confidence,
    projectedLeadTimeDays: leadTimeMeta?.days,
    projectedLeadTimeSource: leadTimeMeta?.source,
    workflowState: r.estadoSiguiente?.trim() || undefined,
  };
}

/**
 * Días de crédito por proveedor derivados de la propia API de Órdenes de
 * Compra. Es "el catálogo actualizado por el API": cada OC trae su `D_Credito`
 * real; el término representativo de un proveedor es la **moda** de esos
 * valores (el plazo contractual que se repite), con desempate por la OC más
 * reciente. Sirve para fechar el egreso de una OC cuyo `D_Credito` viene en 0
 * y para que otros módulos (CXP / recurrentes sin plazo explícito) lean el
 * mismo dato vivo en vez del JSON estático.
 *
 * Clave = número JDE de proveedor normalizado; fallback = nombre normalizado.
 */
export type ComprasCreditOverlay = Map<string, number>;

function providerKey(noProveedor: string, nombreProveedor: string): string {
  return normalizeJdeKey(noProveedor) || normalizeProviderName(nombreProveedor);
}

export function buildComprasCreditOverlay(records: ComprasRecord[]): ComprasCreditOverlay {
  // key -> (diasCredito -> { count, latestPedido })
  const samples = new Map<string, Map<number, { count: number; latest: string }>>();
  for (const r of records) {
    if (r.cancelada) continue;
    const dias = Math.floor(Number(r.diasCredito) || 0);
    if (dias <= 0) continue;
    const key = providerKey(r.noProveedor, r.nombreProveedor);
    if (!key) continue;
    let byDias = samples.get(key);
    if (!byDias) {
      byDias = new Map();
      samples.set(key, byDias);
    }
    const prev = byDias.get(dias);
    const pedido = cleanIsoDate(r.fechaPedido) ?? '';
    if (prev) {
      prev.count += 1;
      if (pedido > prev.latest) prev.latest = pedido;
    } else {
      byDias.set(dias, { count: 1, latest: pedido });
    }
  }
  const overlay: ComprasCreditOverlay = new Map();
  for (const [key, byDias] of samples) {
    let bestDias = 0;
    let bestCount = -1;
    let bestLatest = '';
    for (const [dias, meta] of byDias) {
      if (
        meta.count > bestCount ||
        (meta.count === bestCount && meta.latest > bestLatest)
      ) {
        bestDias = dias;
        bestCount = meta.count;
        bestLatest = meta.latest;
      }
    }
    if (bestDias > 0) overlay.set(key, bestDias);
  }
  return overlay;
}

/**
 * Plazo de crédito efectivo para una OC: su propio `D_Credito` si viene > 0
 * (verdad contractual de ESE pedido); si viene 0/ausente, el término
 * representativo del proveedor según el API (overlay); si no hay overlay, 0.
 */
function effectiveCreditDays(r: ComprasRecord, overlay: ComprasCreditOverlay | undefined): number {
  const own = Math.floor(Number(r.diasCredito) || 0);
  if (own > 0) return own;
  if (!overlay) return 0;
  return overlay.get(providerKey(r.noProveedor, r.nombreProveedor)) ?? 0;
}

export interface ComprasToPurchaseReceiptsOptions {
  /** Fecha de hoy para filtrar pagos pasados. Default: today UTC. */
  asOfDate?: string;
  /**
   * Stats precomputados de lead time. Si se pasa, evita recomputar (útil
   * en App.tsx donde ya hay un useMemo). Si se omite, se computa aquí
   * usando los mismos `comprasRecords`.
   */
  leadTimeStats?: LeadTimeStats;
  /**
   * Si false, NO se proyectan OCs sin recepción (solo CONFIRMED). Default
   * true. Útil para callers que solo quieren el set comprometido.
   */
  includeProjected?: boolean;
  /**
   * Si true, una OC cuya fecha de pago proyectada ya venció por más de un
   * mes no se emite desde Compras. Si sigue abierta debe venir por CXP; si se
   * ejecutó, PagoProveedor y banco ya la cubren como histórico real.
   */
  excludePastUnexecuted?: boolean;
  /**
   * Si true, conserva OCs CONFIRMED aunque su fecha de pago proyectada esté
   * en el pasado. Útil para Impuestos: AuxiliarContable puede confirmar que
   * la OC ya se pagó y Compras aporta la tasa fiscal para IVA acreditable.
   * Default false para no inflar la proyección de caja futura.
   */
  includePastConfirmed?: boolean;
  /**
   * Contexto disponible para callers que necesitan aplicar la regla anterior
   * con trazabilidad. El adapter no emite OCs pasadas desde compras para evitar
   * doble conteo contra CXP/PagoProveedor.
   */
  cxpRecords?: CXPRecord[];
  pagoProveedorRecords?: PagoProveedorRecord[];
  /**
   * Límite por fecha de pedido para OCs futuras. Ej. `3` conserva sólo OCs con
   * `fechaPedido <= asOfDate + 3 meses`.
   */
  futureOrderLookaheadMonths?: number;
}

export function comprasToPurchaseReceipts(
  comprasRecords: ComprasRecord[],
  optionsOrAsOfDate?: ComprasToPurchaseReceiptsOptions | string,
): PurchaseReceiptRecord[] {
  const options: ComprasToPurchaseReceiptsOptions =
    typeof optionsOrAsOfDate === 'string'
      ? { asOfDate: optionsOrAsOfDate }
      : optionsOrAsOfDate ?? {};
  const asOfDate = options.asOfDate ?? todayIso();
  const includeProjected = options.includeProjected !== false;
  const stats = options.leadTimeStats ?? (includeProjected ? computeLeadTimeStats(comprasRecords) : undefined);
  const futureOrderCutoff = typeof options.futureOrderLookaheadMonths === 'number'
    ? addMonths(asOfDate, Math.max(0, options.futureOrderLookaheadMonths))
    : undefined;
  // El API actualiza el catálogo: plazo de crédito representativo por
  // proveedor derivado de las propias OCs. Rellena el plazo cuando una OC
  // trae D_Credito en 0 para que el egreso no caiga el día de recepción.
  const creditOverlay = buildComprasCreditOverlay(comprasRecords);

  const out: PurchaseReceiptRecord[] = [];

  for (const r of comprasRecords) {
    if (r.cancelada) continue;
    if (isComprasWorkflowClosed(r.estadoSiguiente)) continue;

    const amount = r.importeTotal || 0;
    if (amount <= 0) continue;
    const orderDate = cleanIsoDate(r.fechaPedido);
    if (futureOrderCutoff && orderDate && orderDate > futureOrderCutoff) continue;

    if (r.fechaRecepcion && r.fechaPagoProyectada) {
      // CONFIRMED: ya recibida, fecha de pago cierta.
      //
      // Cuando D_Credito > 0, `fechaPagoProyectada` ya = recepción + crédito
      // (la calculó el mapper JDE) — la respetamos tal cual. Cuando D_Credito
      // viene en 0, JDE dejó `fechaPagoProyectada = fechaRecepcion`, lo que
      // adelanta el egreso al día de recepción. Si el catálogo (vía API)
      // conoce el plazo del proveedor, re-fechamos a recepción + ese plazo.
      let dueDate = r.fechaPagoProyectada;
      if (Math.floor(Number(r.diasCredito) || 0) <= 0) {
        const eff = effectiveCreditDays(r, creditOverlay);
        if (eff > 0) dueDate = addDays(r.fechaRecepcion, eff);
      }
      if (options.excludePastUnexecuted && isPastPaymentGrace(dueDate, asOfDate)) continue;
      if (!options.excludePastUnexecuted && !options.includePastConfirmed && dueDate < asOfDate) continue;
      const record = buildRecord(r, dueDate, 'CONFIRMED');
      if (record) out.push(record);
    } else if (includeProjected && stats && r.fechaPedido) {
      // PROJECTED: OC pedida pero sin recepción. Estimamos recepción y pago.
      const lt = leadTimeFor(stats, {
        cia: r.cia,
        familia: r.familia,
        subFamilia: r.subFamilia,
        categoria: r.categoria,
      });
      const projectedReceipt = addDays(r.fechaPedido, lt.days);
      const projectedDue = addDays(projectedReceipt, Math.max(0, effectiveCreditDays(r, creditOverlay)));
      if (options.excludePastUnexecuted && isPastPaymentGrace(projectedDue, asOfDate)) continue;
      if (!options.excludePastUnexecuted && projectedDue < asOfDate) continue;
      const record = buildRecord(r, projectedDue, 'PROJECTED', lt);
      if (record) out.push(record);
    }
  }
  return out;
}
