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

  // Tier 1: factura exacta (mismo proveedor + N_Factura idéntico). Match más
  // fuerte posible — si tenemos ambos, no necesitamos verificar más.
  const recordInvoice = normalizeInvoice(record.invoiceNo);
  const cxpInvoice = normalizeInvoice(cxp.noFactura);
  if (sameSupplier && recordInvoice && recordInvoice === cxpInvoice) return true;

  // OCs PROJECTED no tienen factura todavía. NO pueden estar en CXP por
  // definición (CXP requiere factura). Saltar dedup heurístico para ellas
  // — evita falsos positivos donde una OC futura se "matchee" con una CXP
  // vieja por similitud de monto+fecha.
  if (record.confidence === 'PROJECTED') return false;

  // Tier 2: el folio de OC/recepción aparece embebido en el texto de CXP
  // (típico cuando JDE concatena referencias en la descripción).
  const cxpText = normalize(`${cxp.noFactura} ${cxp.nombre}`);
  const purchaseOrder = normalize(record.purchaseOrderNo);
  const receipt = normalize(record.receiptNo);
  if (sameSupplier && purchaseOrder && receipt && cxpText.includes(purchaseOrder) && cxpText.includes(receipt)) return true;

  // Tier 3: heurístico monto + fecha. Solo para OCs CONFIRMED (recibidas)
  // cuya factura aún no llegó a CXP de forma identificable. Tolerancia
  // ±0.5% monto, ±7 días fecha.
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
  /**
   * Set de `noProveedor` (trim + upper) a omitir — usado para excluir
   * proveedores en Concurso Mercantil del modelo predictivo. Una compra cuyo
   * proveedor está en concurso no genera egreso proyectado: el pago de su
   * deuda se maneja en el módulo Concurso.
   */
  excludeProviderIds?: Set<string>;
}): FinancialMovement[] {
  const scopedCxp = filterCxpByCompany(input.cxpRecords, input.companyCode);
  const excludeSet = input.excludeProviderIds;
  return input.purchaseReceipts
    .filter((record) => input.companyCode === 'all' || !input.companyCode || normalizeCia(record.cia) === normalizeCia(input.companyCode))
    .filter((record) => !record.isCancelled && record.amountMxn > 0)
    .filter((record) => !excludeSet || !excludeSet.has((record.noProveedor || '').trim().toUpperCase()))
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

  // Confidence-aware scoring:
  //   - CONFIRMED (OC ya recibida): 76 — alta certeza, monto y fecha cuasi-firmes.
  //   - PROJECTED (OC sin recepción): 48 — estimación con lead time histórico,
  //     fecha de pago puede deslizarse según ritmo real de recepción.
  // Default 76 cuando el campo no está poblado (records pre-migración).
  const isProjected = record.confidence === 'PROJECTED';
  const confidenceScore = isProjected ? 48 : 76;
  const ruleApplied = isProjected
    ? `OC pendiente de recepción · lead time estimado ${record.projectedLeadTimeDays ?? '?'}d (${record.projectedLeadTimeSource ?? 'default'})`
    : 'Recibo de compras activo sin CXP matcheada';
  const idTag = isProjected ? 'po' : 'purchase';

  const comments: string[] = isProjected
    ? [
        'Compromiso proyectado: OC emitida sin recepción confirmada.',
        `Pago estimado = pedido + ${record.projectedLeadTimeDays ?? '?'}d lead + ${record.creditDays}d crédito.`,
      ]
    : ['Compromiso temprano desde Recibo de Compras.'];
  if (record.taxRateCode) {
    comments.push(`Tasa fiscal ${record.taxRateCode}.`);
  } else {
    comments.push('Sin tasa fiscal clasificada.');
  }

  return {
    id: `${idTag}:${record.cia}:${record.noProveedor || 'sin-proveedor'}:${record.invoiceNo || record.purchaseOrderNo || record.receiptNo || index}`,
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
    concept: `${isProjected ? 'OC' : 'Compra'} ${record.invoiceNo || record.purchaseOrderNo || 'sin folio'} · ${record.supplierName || 'Proveedor sin nombre'}`,
    currency: 'MXN',
    originalAmount: record.amountMxn,
    baseAmount: record.amountMxn,
    projectedAmount: record.amountMxn,
    issueDate: cleanIsoDate(record.orderDate),
    dueDate: originalDate,
    projectedDate,
    confidenceScore,
    confidenceBand: calculateConfidenceBand(confidenceScore),
    forecastMethod: 'RULE',
    ruleApplied,
    taxTreatment: meta.taxTreatment,
    taxRate,
    taxBaseAmount: meta.taxBaseAmount,
    taxAmount: meta.taxAmount,
    status: record.status === 'CANCELLED' || record.isCancelled ? 'CANCELLED' : 'PROJECTED_BASE',
    lockState: isProjected ? 'UNLOCKED' : 'RESTRICTED',
    comments,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildPayrollCostMovements(input: {
  payrollCosts: PayrollCostRecord[];
  companyCode: string;
  asOfDate: string;
  endDate?: string;
  /**
   * Si se proporciona, replica la pauta del último mes completo de TRESS hacia
   * adelante hasta `projectThroughYearMonth` (YYYY-MM), generando movimientos
   * sintéticos para meses futuros sin data TRESS. Permite que Dashboard /
   * Proyección / Planeación vean nómina proyectada cuando el backend solo
   * tiene el mes en curso.
   */
  projectThroughYearMonth?: string;
  /**
   * Filtro opcional: si se setea, solo se generan movimientos sintéticos para
   * este mes (formato YYYY-MM). Crítico para evitar O(meses²) cuando el
   * caller invoca buildPayrollCostMovements una vez por mes.
   */
  targetYearMonth?: string;
}): FinancialMovement[] {
  const filteredRecords = input.payrollCosts
    .filter((record) => input.companyCode === 'all' || !input.companyCode || normalizeCia(record.cia) === normalizeCia(input.companyCode))
    .filter((record) => record.amount > 0 && shouldEmitPayrollMovement(record));

  const realMovements = filteredRecords
    .map((record, index) => payrollCostToMovement(record, input.asOfDate, index))
    .filter((movement) => !input.endDate || movement.projectedDate <= input.endDate)
    .filter((movement) => !input.targetYearMonth || movement.projectedDate.slice(0, 7) === input.targetYearMonth);

  if (!input.projectThroughYearMonth) return realMovements;

  const monthsWithReal = new Set(
    filteredRecords
      .map((r) => `${r.year}-${String(r.month).padStart(2, '0')}`)
      .filter((ym) => /^\d{4}-\d{2}$/.test(ym)),
  );
  const baselineMonth = findBaselineMonth(filteredRecords, monthsWithReal);
  if (!baselineMonth) return realMovements;
  if (input.targetYearMonth && input.targetYearMonth <= baselineMonth) return realMovements;
  if (input.targetYearMonth && monthsWithReal.has(input.targetYearMonth)) return realMovements;

  const baselineRecords = filteredRecords.filter((r) => `${r.year}-${String(r.month).padStart(2, '0')}` === baselineMonth);

  const horizon = input.projectThroughYearMonth;
  const synthetic: FinancialMovement[] = [];
  const monthsToFill: string[] = [];
  if (input.targetYearMonth) {
    monthsToFill.push(input.targetYearMonth);
  } else {
    let cursor = nextYearMonth(baselineMonth);
    let guard = 0;
    while (cursor <= horizon && guard < 60) {
      if (!monthsWithReal.has(cursor)) monthsToFill.push(cursor);
      cursor = nextYearMonth(cursor);
      guard += 1;
    }
  }

  for (const ym of monthsToFill) {
    baselineRecords.forEach((record, idx) => {
      const shifted = shiftPayrollRecordToMonth(record, ym);
      if (!shifted) return;
      const movement = payrollCostToMovement(shifted, input.asOfDate, idx);
      if (input.endDate && movement.projectedDate > input.endDate) return;
      synthetic.push({
        ...movement,
        id: `${movement.id}:forecast:${ym}`,
        forecastMethod: 'RULE',
        ruleApplied: `${movement.ruleApplied ?? 'TRESS'} · proyectado desde ${baselineMonth}`,
        confidenceScore: 65,
        confidenceBand: calculateConfidenceBand(65),
        comments: [`Nómina proyectada replicando ${baselineMonth} (último mes TRESS).`],
      });
    });
  }
  return [...realMovements, ...synthetic];
}

function findBaselineMonth(records: PayrollCostRecord[], monthsWithMovements: Set<string>): string | undefined {
  if (records.length === 0) return undefined;
  const monthlyCounts = new Map<string, number>();
  for (const r of records) {
    if (!r.year || !r.month) continue;
    const ym = `${r.year}-${String(r.month).padStart(2, '0')}`;
    if (!monthsWithMovements.has(ym)) continue;
    monthlyCounts.set(ym, (monthlyCounts.get(ym) ?? 0) + 1);
  }
  if (monthlyCounts.size === 0) return undefined;
  let best = '';
  let bestCount = 0;
  for (const [ym, count] of monthlyCounts) {
    if (count >= bestCount * 0.5 && ym > best) {
      best = ym;
      bestCount = Math.max(bestCount, count);
    }
  }
  return best || undefined;
}

function shiftPayrollRecordToMonth(record: PayrollCostRecord, targetYm: string): PayrollCostRecord | undefined {
  const baseDate = cleanIsoDate(record.paymentDate);
  if (!baseDate) return undefined;
  const targetYear = Number(targetYm.slice(0, 4));
  const targetMonth = Number(targetYm.slice(5, 7));
  if (!targetYear || !targetMonth) return undefined;
  const baseParts = baseDate.split('-');
  const baseDay = Number(baseParts[2]);
  const daysInTarget = new Date(targetYear, targetMonth, 0).getDate();
  const clampedDay = Math.min(baseDay, daysInTarget);
  const shiftedPay = `${targetYm}-${String(clampedDay).padStart(2, '0')}`;
  const shiftDays = (new Date(`${shiftedPay}T00:00:00.000Z`).getTime() - new Date(`${baseDate}T00:00:00.000Z`).getTime()) / DAY_MS;
  const shiftedStart = record.periodStartDate ? addDays(record.periodStartDate, shiftDays) : undefined;
  const shiftedEnd = record.periodEndDate ? addDays(record.periodEndDate, shiftDays) : undefined;
  return {
    ...record,
    year: targetYear,
    month: targetMonth,
    paymentDate: shiftedPay,
    periodStartDate: shiftedStart,
    periodEndDate: shiftedEnd,
  };
}

function nextYearMonth(ym: string): string {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7));
  const next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`;
  return next;
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
