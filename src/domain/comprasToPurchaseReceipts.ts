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

function isWorkflowStateClosed(edoSig: string | undefined): boolean {
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
  return new Date().toISOString().slice(0, 10);
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
    supplierName: r.nombreProveedor || 'Proveedor sin nombre',
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

  const out: PurchaseReceiptRecord[] = [];

  for (const r of comprasRecords) {
    if (r.cancelada) continue;
    if (isWorkflowStateClosed(r.estadoSiguiente)) continue;

    const amount = r.importeTotal || 0;
    if (amount <= 0) continue;
    const orderDate = cleanIsoDate(r.fechaPedido);
    if (futureOrderCutoff && orderDate && orderDate > futureOrderCutoff) continue;

    if (r.fechaRecepcion && r.fechaPagoProyectada) {
      // CONFIRMED: ya recibida, fecha de pago cierta.
      if (options.excludePastUnexecuted && isPastPaymentGrace(r.fechaPagoProyectada, asOfDate)) continue;
      if (!options.excludePastUnexecuted && r.fechaPagoProyectada < asOfDate) continue;
      const record = buildRecord(r, r.fechaPagoProyectada, 'CONFIRMED');
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
      const projectedDue = addDays(projectedReceipt, Math.max(0, r.diasCredito || 0));
      if (options.excludePastUnexecuted && isPastPaymentGrace(projectedDue, asOfDate)) continue;
      if (!options.excludePastUnexecuted && projectedDue < asOfDate) continue;
      const record = buildRecord(r, projectedDue, 'PROJECTED', lt);
      if (record) out.push(record);
    }
  }
  return out;
}
