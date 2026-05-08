import type { CXPRecord } from '../../domain/persistence';
import type {
  FinancialMovement,
  FinancialTaxRate,
  PayrollCostRecord,
  PurchaseReceiptRecord,
} from './types';
import { calculateConfidenceBand } from './calculation-engine/financialProjectionEngine';

const DAY_MS = 86_400_000;

export function parsePurchaseTaxRate(value: string | undefined | null): FinancialTaxRate | undefined {
  const text = normalize(value);
  if (!text) return undefined;
  if (text.includes('IVA16') || /\b16\b/.test(text)) return 16;
  if (text.includes('IVA8') || /\b8\b/.test(text)) return 8;
  return undefined;
}

export function purchaseTaxMeta(
  amountMxn: number,
  taxRate: FinancialTaxRate | undefined,
): Pick<PurchaseReceiptRecord, 'taxTreatment' | 'taxBaseAmount' | 'taxAmount'> {
  if ((taxRate !== 16 && taxRate !== 8) || amountMxn <= 0) {
    return { taxTreatment: 'UNCLASSIFIED' };
  }
  const taxBaseAmount = amountMxn / (1 + taxRate / 100);
  return {
    taxTreatment: 'IVA_CREDITABLE',
    taxBaseAmount,
    taxAmount: amountMxn - taxBaseAmount,
  };
}

export function normalizeCancelledAt(value: string | undefined | null): string | undefined {
  const raw = (value ?? '').trim();
  if (!raw || raw === '0' || raw === '00:00:00') return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return undefined;
}

export function estimatedPurchaseDueDate(record: Pick<PurchaseReceiptRecord, 'receiptDate' | 'orderDate' | 'creditDays'>): string {
  const base = cleanIsoDate(record.receiptDate) ?? cleanIsoDate(record.orderDate);
  if (!base) return '';
  return addDays(base, Math.max(0, Number(record.creditDays) || 0));
}

export function isPurchaseMatchedToCxp(record: PurchaseReceiptRecord, cxpRecords: CXPRecord[]): boolean {
  return cxpRecords.some((cxp) => purchaseMatchesCxp(record, cxp));
}

export function purchaseMatchesCxp(record: PurchaseReceiptRecord, cxp: CXPRecord): boolean {
  if (record.cia && cxp.cia && normalizeCia(record.cia) !== normalizeCia(cxp.cia)) return false;
  const purchaseSupplier = normalizeJde(record.noProveedor);
  const cxpSupplier = normalizeJde(cxp.noProveedor);
  const sameSupplier = purchaseSupplier && cxpSupplier && purchaseSupplier === cxpSupplier;
  const sameInvoice = normalizeInvoice(record.invoiceNo) && normalizeInvoice(record.invoiceNo) === normalizeInvoice(cxp.noFactura);
  if (sameSupplier && sameInvoice) return true;

  const cxpText = normalize(`${cxp.noFactura} ${cxp.nombre}`);
  const purchaseOrder = normalize(record.purchaseOrderNo);
  const receipt = normalize(record.receiptNo);
  if (sameSupplier && purchaseOrder && receipt && cxpText.includes(purchaseOrder) && cxpText.includes(receipt)) return true;

  const amountDelta = Math.abs(record.amountMxn - cxp.importePendientePesos);
  const closeAmount = amountDelta <= 1 || amountDelta <= Math.max(1, record.amountMxn * 0.005);
  const purchaseDate = cleanIsoDate(record.estimatedDueDate) ?? cleanIsoDate(record.receiptDate) ?? cleanIsoDate(record.orderDate);
  const cxpDate = cleanIsoDate(cxp.fechaProgramacionPago) ?? cleanIsoDate(cxp.fechaVence) ?? cleanIsoDate(cxp.fechaFactura);
  const closeDate = Boolean(purchaseDate && cxpDate && Math.abs(daysBetween(purchaseDate!, cxpDate!)) <= 7);
  return Boolean(sameSupplier && closeAmount && closeDate);
}

export function buildPurchaseReceiptMovements(input: {
  purchaseReceipts: PurchaseReceiptRecord[];
  cxpRecords: CXPRecord[];
  companyCode: string;
  asOfDate: string;
  endDate?: string;
}): FinancialMovement[] {
  const scopedCxp = filterCxpByCompany(input.cxpRecords, input.companyCode);
  return input.purchaseReceipts
    .filter((record) => input.companyCode === 'all' || !input.companyCode || normalizeCia(record.cia) === normalizeCia(input.companyCode))
    .filter((record) => !record.isCancelled && record.amountMxn > 0)
    .filter((record) => !isPurchaseMatchedToCxp(record, scopedCxp))
    .map((record, index) => purchaseReceiptToMovement(record, input.asOfDate, index))
    .filter((movement) => !input.endDate || movement.projectedDate <= input.endDate);
}

export function purchaseReceiptToMovement(
  record: PurchaseReceiptRecord,
  asOfDate: string,
  index = 0,
): FinancialMovement {
  const originalDate = cleanIsoDate(record.estimatedDueDate)
    ?? cleanIsoDate(record.receiptDate)
    ?? cleanIsoDate(record.orderDate)
    ?? asOfDate;
  const projectedDate = originalDate < asOfDate ? asOfDate : originalDate;
  const taxRate = record.taxRate === 8 || record.taxRate === 16 ? record.taxRate : undefined;
  const meta = taxRate
    ? purchaseTaxMeta(record.amountMxn, taxRate)
    : { taxTreatment: record.taxTreatment };
  const now = `${asOfDate}T00:00:00.000Z`;
  return {
    id: `purchase:${record.cia}:${record.noProveedor || 'sin-proveedor'}:${record.invoiceNo || record.purchaseOrderNo || record.receiptNo || index}`,
    sourceSystem: 'JDE',
    sourceObjectId: record.invoiceNo || record.purchaseOrderNo || record.receiptNo || undefined,
    type: 'OUTFLOW',
    category: 'AP_PAYMENT',
    subcategory: record.familyName || record.categoryName || record.categoryCode || 'Compras',
    companyId: normalizeCia(record.cia),
    businessUnitId: record.costCenter,
    counterpartyId: record.noProveedor,
    counterpartyName: record.supplierName || 'Proveedor sin nombre',
    counterpartyType: 'SUPPLIER',
    providerCategory: record.categoryName || record.familyName || record.subfamilyName,
    concept: `Compra ${record.invoiceNo || record.purchaseOrderNo || 'sin folio'} · ${record.supplierName || 'Proveedor sin nombre'}`,
    currency: 'MXN',
    originalAmount: record.amountMxn,
    baseAmount: record.amountMxn,
    projectedAmount: record.amountMxn,
    issueDate: cleanIsoDate(record.orderDate),
    dueDate: originalDate,
    projectedDate,
    confidenceScore: 76,
    confidenceBand: calculateConfidenceBand(76),
    forecastMethod: 'RULE',
    ruleApplied: 'Recibo de compras activo sin CXP matcheada',
    taxTreatment: meta.taxTreatment,
    taxRate,
    taxBaseAmount: meta.taxBaseAmount,
    taxAmount: meta.taxAmount,
    status: record.status === 'CANCELLED' || record.isCancelled ? 'CANCELLED' : 'PROJECTED_BASE',
    lockState: 'RESTRICTED',
    comments: [
      'Compromiso temprano desde Recibo de Compras.',
      record.taxRateCode ? `Tasa fiscal ${record.taxRateCode}.` : 'Sin tasa fiscal clasificada.',
    ],
    createdAt: now,
    updatedAt: now,
  };
}

export function buildPayrollCostMovements(input: {
  payrollCosts: PayrollCostRecord[];
  companyCode: string;
  asOfDate: string;
  endDate?: string;
}): FinancialMovement[] {
  return input.payrollCosts
    .filter((record) => input.companyCode === 'all' || !input.companyCode || normalizeCia(record.cia) === normalizeCia(input.companyCode))
    .filter((record) => record.amount > 0 && shouldEmitPayrollMovement(record))
    .map((record, index) => payrollCostToMovement(record, input.asOfDate, index))
    .filter((movement) => !input.endDate || movement.projectedDate <= input.endDate);
}

function payrollCostToMovement(record: PayrollCostRecord, asOfDate: string, index: number): FinancialMovement {
  const projectedDate = (cleanIsoDate(record.paymentDate) ?? asOfDate) < asOfDate
    ? asOfDate
    : cleanIsoDate(record.paymentDate) ?? asOfDate;
  const isImss = isImssConcept(record.conceptName);
  const now = `${asOfDate}T00:00:00.000Z`;
  return {
    id: `payroll:${record.cia}:${record.payrollType}:${record.payrollPeriod}:${record.conceptId}:${index}`,
    sourceSystem: 'PAYROLL',
    sourceObjectId: String(record.conceptId),
    type: 'OUTFLOW',
    category: isImss ? 'AP_PAYMENT' : 'PAYROLL',
    subcategory: record.payrollType,
    companyId: normalizeCia(record.cia),
    businessUnitId: record.costCenter,
    counterpartyName: isImss ? 'INSTITUTO MEXICANO DEL SEGURO SOCIAL' : record.empresaNomina,
    counterpartyType: isImss ? 'TAX_AUTHORITY' : 'EMPLOYEE',
    concept: `${record.conceptName} · ${record.payrollType}`,
    currency: 'MXN',
    originalAmount: record.amount,
    baseAmount: record.amount,
    projectedAmount: record.amount,
    issueDate: record.periodStartDate,
    dueDate: projectedDate,
    projectedDate,
    confidenceScore: 82,
    confidenceBand: calculateConfidenceBand(82),
    forecastMethod: 'RULE',
    ruleApplied: `TRESS ${record.conceptType} · ${record.cashTreatment}`,
    taxTreatment: 'IVA_EXEMPT',
    status: 'PROJECTED_BASE',
    lockState: isImss || record.cashTreatment === 'EMPLOYER_TAX' ? 'LOCKED' : 'RESTRICTED',
    comments: ['Costo de nómina desde TRESS. No genera IVA.'],
    createdAt: now,
    updatedAt: now,
  };
}

function shouldEmitPayrollMovement(record: PayrollCostRecord): boolean {
  if (record.cashTreatment === 'NON_CASH') return false;
  if (record.cashTreatment === 'DEDUCTION') return false;
  if (normalize(record.conceptType).includes('DEDUCCION') && record.cashTreatment !== 'WITHHOLDING_PAYABLE') return false;
  return true;
}

function filterCxpByCompany(cxpRecords: CXPRecord[], companyCode: string): CXPRecord[] {
  if (companyCode === 'all' || !companyCode) return cxpRecords;
  return cxpRecords.filter((record) => normalizeCia(record.cia) === normalizeCia(companyCode));
}

function isImssConcept(value: string): boolean {
  const text = normalize(value);
  return text.includes('IMSS') || text.includes('INFONAVIT') || text.includes('RETIRO') || text.includes('CESANTIA') || text.includes('INSTITUTO MEXICANO');
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return (new Date(`${a}T00:00:00.000Z`).getTime() - new Date(`${b}T00:00:00.000Z`).getTime()) / DAY_MS;
}

function cleanIsoDate(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

function normalize(value: string | undefined | null): string {
  return (value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function normalizeCia(value: string | undefined | null): string {
  const digits = (value ?? '').match(/\d+/)?.[0];
  return digits ? digits.padStart(5, '0') : (value ?? '').trim();
}

function normalizeJde(value: string | undefined | null): string {
  const digits = (value ?? '').replace(/\D+/g, '');
  return digits ? String(Number(digits)) : '';
}

function normalizeInvoice(value: string | undefined | null): string {
  return normalize(value).replace(/\s*-\s*/g, '-').replace(/\s+/g, '');
}
