/**
 * Adapter ComprasRecord → PurchaseReceiptRecord.
 *
 * El motor canónico de proyección (`canonicalProjection.ts`) ya consume
 * `PurchaseReceiptRecord[]` vía `buildPurchaseReceiptMovements()`. Ese
 * builder:
 *   - filtra cancelados (`isCancelled`),
 *   - hace dedup contra CXP (`isPurchaseMatchedToCxp`) para no doblar
 *     egreso cuando una OC ya tiene factura abierta en JDE,
 *   - emite el movimiento como `category: 'AP_PAYMENT'`, matcheando
 *     proveedor por `noProveedor`/`supplierName` — exactamente lo que
 *     necesitamos para que las OCs alimenten la fila del proveedor en el
 *     mapa de Planeación Financiera.
 *
 * Esta función traduce el shape de Compras al shape que el motor espera,
 * aplicando además dos filtros del lado del adapter:
 *
 *   1. **Solo OCs con `fechaPagoProyectada >= hoy`** — descartamos OCs cuya
 *      fecha proyectada de pago ya pasó. Asumimos que el pago ya ocurrió
 *      aunque JDE no lo refleje; mantenerlas en la proyección inflaría
 *      egreso del pasado.
 *   2. **Solo OCs con recepción confirmada** — sin `fechaRecepcion` no hay
 *      fecha cierta de pago. El usuario las ve en el tab Compras en el
 *      bucket "Pendiente recepción" pero NO entran al cash flow proyectado.
 *
 * El filtro de "ya facturada" no se aplica acá — `extractComprasPaymentEvents`
 * sí lo hace, pero el motor canónico usa `isPurchaseMatchedToCxp` que es más
 * preciso (considera importe + fechas, no solo presencia de noFactura).
 * Dejamos el dedup al motor canónico para no perder OCs cuya factura aún
 * no llegó a CXP.
 */

import type { ComprasRecord } from '../services/jdeTypes';
import type {
  PurchaseReceiptRecord,
  FinancialTaxRate,
  FinancialTaxTreatment,
} from '../modules/shared-finance/types';

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

export function comprasToPurchaseReceipts(
  comprasRecords: ComprasRecord[],
  asOfDate: string = todayIso(),
): PurchaseReceiptRecord[] {
  const out: PurchaseReceiptRecord[] = [];
  for (const r of comprasRecords) {
    if (r.cancelada) continue;
    if (!r.fechaRecepcion) continue;
    if (!r.fechaPagoProyectada) continue;
    if (r.fechaPagoProyectada < asOfDate) continue;
    const amount = r.importeTotal || 0;
    if (amount <= 0) continue;

    const taxRate = parseTasaFiscal(r.tasaFiscal);
    const treatment = taxTreatmentFor(taxRate);
    const taxBaseAmount = taxRate && taxRate > 0 ? amount / (1 + taxRate / 100) : undefined;
    const taxAmount = taxBaseAmount !== undefined ? amount - taxBaseAmount : undefined;

    const currency = r.moneda === 'MXP' || r.moneda === 'MXN' ? 'MXN' : r.moneda || 'MXN';
    const fx = currency === 'MXN' ? 1 : (r.tipoCambio || 1);
    const amountMxn = currency === 'MXN' ? amount : amount * fx;

    out.push({
      cia: r.cia,
      noProveedor: r.noProveedor,
      supplierName: r.nombreProveedor || 'Proveedor sin nombre',
      invoiceNo: r.noFactura,
      purchaseOrderNo: r.noOrden,
      receiptNo: r.lineaOrden ? String(r.lineaOrden) : '',
      orderDate: r.fechaPedido,
      receiptDate: r.fechaRecepcion,
      creditDays: r.diasCredito,
      estimatedDueDate: r.fechaPagoProyectada,
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
    });
  }
  return out;
}
