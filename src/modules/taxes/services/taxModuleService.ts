import type { CXPRecord } from '../../../domain/persistence';
import type { Provider } from '../../../domain/types';
import type {
  FinancialMovement,
  ForecastRun,
  TaxManualAdjustment,
  TaxObligation,
  TaxPaymentPlanItem,
  TaxSource,
  TaxStatus,
  TaxType,
} from '../../shared-finance/types';
import {
  calculateConfidenceBand,
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';

export const TAX_STORE_KEY = 'midas.taxes.v1';
const LEGACY_IVA_ADJUSTMENTS_KEY = 'midas.financialProjection.taxAdjustments.v1';
const LEGACY_OPERATING_SCENARIOS_KEY = 'midas.operating.scenarios.v1';
const ISN_RATE = 0.03;

export interface TaxStore {
  adjustments: TaxManualAdjustment[];
  obligations: TaxObligation[];
  /** Saldo vencido acumulado de impuestos (no cubierto por los periodos visibles). */
  overdueBalance: number;
  migratedAt?: string;
}

export interface TaxSourceLine {
  movementId: string;
  date: string;
  concept: string;
  counterpartyName?: string;
  amount: number;
  taxBase: number;
  taxRate?: 0 | 8 | 16;
  taxAmount: number;
  sourceSystem: FinancialMovement['sourceSystem'];
}

export interface IvaPeriodDetail {
  period: string;
  dueDate: string;
  incomeBase16: number;
  incomeBase8: number;
  ivaCaused16: number;
  ivaCaused8: number;
  ivaCaused: number;
  expenseBase16: number;
  expenseBase8: number;
  ivaCreditable16: number;
  ivaCreditable8: number;
  ivaCreditable: number;
  manualCaused: number;
  manualCreditable: number;
  ivaPaid: number;
  manualPayable: number;
  unclassifiedIncome: number;
  unclassifiedExpense: number;
  netIva: number;
  payable: number;
  balanceInFavor: number;
  status: TaxStatus;
  source: TaxSource;
  paymentPlan: TaxPaymentPlanItem[];
  incomeLines: TaxSourceLine[];
  expenseLines: TaxSourceLine[];
  unclassifiedLines: TaxSourceLine[];
}

export interface TaxPeriodSummary {
  period: string;
  dueDate: string;
  ivaNet: number;
  isn: number;
  imss: number;
  total: number;
  cashImpact: number;
  status: TaxStatus;
  obligations: TaxObligation[];
  iva: IvaPeriodDetail;
  payrollBase: number;
  payrollLines: TaxSourceLine[];
  imssLines: TaxSourceLine[];
}

export interface TaxDashboardView {
  periods: TaxPeriodSummary[];
  obligations: TaxObligation[];
  /** Saldo vencido acumulado que se arrastra de periodos anteriores. */
  overdueBalance: number;
  totals: {
    ivaNet: number;
    isn: number;
    imss: number;
    total: number;
    /** Total incluyendo el saldo vencido arrastrado. */
    totalWithOverdue: number;
    cashImpact: number;
    unclassified: number;
    /** Ingresos gravables totales del periodo (Base 16% + Base 8%). */
    grossIncome: number;
  };
}

export function defaultTaxStore(): TaxStore {
  return { adjustments: [], obligations: [], overdueBalance: 0 };
}

export function loadTaxStore(fallback: TaxStore = defaultTaxStore()): TaxStore {
  try {
    const raw = localStorage.getItem(TAX_STORE_KEY);
    if (raw) return normalizeTaxStore(JSON.parse(raw), fallback);
    const migrated = migrateLegacyTaxStore();
    if (migrated.adjustments.length > 0 || migrated.obligations.length > 0) {
      saveTaxStore(migrated);
      return migrated;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function saveTaxStore(store: TaxStore): void {
  try {
    if (store.adjustments.length === 0 && store.obligations.length === 0) {
      localStorage.removeItem(TAX_STORE_KEY);
      return;
    }
    localStorage.setItem(TAX_STORE_KEY, JSON.stringify(store));
  } catch {
    /* localStorage quota errors do not block planning. */
  }
}

export function createTaxManualAdjustment(input: {
  taxType: TaxType;
  period: string;
  kind: TaxManualAdjustment['kind'];
  amount: number;
  note?: string;
  source?: TaxSource;
}): TaxManualAdjustment {
  if (!/^\d{4}-\d{2}$/.test(input.period)) throw new Error('Periodo fiscal inválido.');
  if (!Number.isFinite(input.amount) || input.amount < 0) throw new Error('Monto fiscal inválido.');
  return {
    id: `tax-adjustment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taxType: input.taxType,
    period: input.period,
    kind: input.kind,
    amount: input.amount,
    note: input.note?.trim() || undefined,
    source: input.source ?? 'MANUAL',
    createdAt: new Date().toISOString(),
  };
}

export function createManualTaxObligation(input: {
  taxType: TaxType;
  period: string;
  label?: string;
  amount: number;
  dueDate?: string;
  source?: TaxSource;
  status?: TaxStatus;
  comment?: string;
}): TaxObligation {
  if (!/^\d{4}-\d{2}$/.test(input.period)) throw new Error('Periodo fiscal inválido.');
  if (!Number.isFinite(input.amount) || input.amount < 0) throw new Error('Monto fiscal inválido.');
  const paidAmount = input.status === 'PAID' ? input.amount : 0;
  return {
    id: `tax-obligation-${input.taxType}-${input.period}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taxType: input.taxType,
    period: input.period,
    label: input.label?.trim() || `${input.taxType} ${input.period}`,
    source: input.source ?? 'MANUAL',
    sourceSystem: input.source ?? 'MANUAL',
    totalAmount: input.amount,
    paidAmount,
    pendingAmount: Math.max(0, input.amount - paidAmount),
    dueDate: input.dueDate && isIsoDate(input.dueDate) ? input.dueDate : taxDueDate(input.period),
    paymentPlan: [],
    risk: input.taxType === 'IMSS' ? 'LEGAL' : input.taxType === 'IVA' ? 'HIGH' : 'MEDIUM',
    comment: input.comment?.trim() || undefined,
    status: input.status ?? (input.amount > 0 ? 'PENDING' : 'PROJECTED'),
  };
}

export function upsertTaxObligation(store: TaxStore, obligation: TaxObligation): TaxStore {
  const obligations = store.obligations.some((item) => item.id === obligation.id)
    ? store.obligations.map((item) => (item.id === obligation.id ? obligation : item))
    : [...store.obligations, obligation];
  return { ...store, obligations };
}

export function addTaxPaymentPlanItem(input: {
  obligation: TaxObligation;
  date: string;
  amount: number;
  status?: TaxPaymentPlanItem['status'];
  scenarioId?: string;
  note?: string;
}): TaxObligation {
  if (!isIsoDate(input.date)) throw new Error('Fecha de pago fiscal inválida.');
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('Monto de pago fiscal inválido.');
  return {
    ...input.obligation,
    paymentPlan: [
      ...input.obligation.paymentPlan,
      {
        id: `tax-payment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: input.date,
        amount: input.amount,
        status: input.status ?? 'DRAFT',
        scenarioId: input.scenarioId,
        note: input.note?.trim() || undefined,
      },
    ],
  };
}

export function updateTaxPaymentPlanItem(
  obligation: TaxObligation,
  paymentId: string,
  patch: Partial<TaxPaymentPlanItem>,
): TaxObligation {
  return {
    ...obligation,
    paymentPlan: obligation.paymentPlan.map((payment) => (
      payment.id === paymentId
        ? {
          ...payment,
          ...patch,
          amount: patch.amount != null && Number.isFinite(patch.amount) ? Math.max(0, patch.amount) : payment.amount,
          date: patch.date && isIsoDate(patch.date) ? patch.date : payment.date,
        }
        : payment
    )),
  };
}

export function buildTaxDashboardView(params: {
  projection: ForecastRun;
  store: TaxStore;
  providers?: Provider[];
  cxpRecords?: CXPRecord[];
  scenarioId?: string;
  today: string;
}): TaxDashboardView {
  const byPeriod = new Map<string, TaxPeriodAccumulator>();
  const ensure = (period: string) => ensureAccumulator(byPeriod, period);

  for (const movement of params.projection.movements) {
    const date = effectiveMovementDate(movement);
    if (date < params.projection.startDate || date > params.projection.endDate) continue;
    const period = date.slice(0, 7);
    const row = ensure(period);
    accumulateIva(row, movement);
    accumulateIsn(row, movement);
    accumulateImss(row, movement);
  }

  for (const adjustment of params.store.adjustments) {
    const row = ensure(adjustment.period);
    if (adjustment.kind === 'IVA_CAUSED') row.manualIvaCaused += adjustment.amount;
    if (adjustment.kind === 'IVA_CREDITABLE') row.manualIvaCreditable += adjustment.amount;
    if (adjustment.kind === 'IVA_PAID') row.ivaPaid += adjustment.amount;
    if (adjustment.kind === 'IVA_PAYABLE') row.manualIvaPayable += adjustment.amount;
    if (adjustment.kind === 'ISN_OVERRIDE') row.isnOverride = adjustment.amount;
    if (adjustment.kind === 'IMSS_MANUAL') row.imssManual += adjustment.amount;
  }

  for (const obligation of params.store.obligations) {
    const row = ensure(obligation.period);
    row.manualObligations.push(obligation);
  }

  const periods = Array.from(byPeriod.values())
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((acc) => finalizeTaxPeriod(acc, params.store, params.today));

  const obligations = periods.flatMap((period) => period.obligations);
  const overdueBalance = params.store.overdueBalance;
  // Sumar también obligaciones vencidas de periodos ANTERIORES al rango visible.
  const pastPendingObligations = params.store.obligations
    .filter((ob) => ob.period < params.projection.startDate.slice(0, 7) && ob.pendingAmount > 0)
    .reduce((sum, ob) => sum + ob.pendingAmount, 0);

  const totalOverdue = overdueBalance + pastPendingObligations;

  const totals = periods.reduce<TaxDashboardView['totals']>((sum, period) => ({
    ivaNet: sum.ivaNet + period.ivaNet,
    isn: sum.isn + period.isn,
    imss: sum.imss + period.imss,
    total: sum.total + period.total,
    totalWithOverdue: sum.totalWithOverdue + period.total,
    cashImpact: sum.cashImpact + period.cashImpact,
    unclassified: sum.unclassified + period.iva.unclassifiedIncome + period.iva.unclassifiedExpense,
    grossIncome: sum.grossIncome + period.iva.incomeBase16 + period.iva.incomeBase8,
  }), {
    ivaNet: 0,
    isn: 0,
    imss: 0,
    total: 0,
    totalWithOverdue: totalOverdue,
    cashImpact: 0,
    unclassified: 0,
    grossIncome: 0,
  });

  return { periods, obligations, overdueBalance: totalOverdue, totals };
}

export function buildApprovedTaxPaymentMovements(params: {
  obligations: TaxObligation[];
  scenarioId: string;
  startDate: string;
  endDate: string;
  asOfDate: string;
}): FinancialMovement[] {
  return params.obligations.flatMap((obligation) => obligation.paymentPlan
    .filter((payment) =>
      (payment.status === 'APPROVED' || payment.status === 'PAID')
      && payment.date >= params.startDate
      && payment.date <= params.endDate
      && (!payment.scenarioId || payment.scenarioId === params.scenarioId),
    )
    .map((payment, index) => ({
      id: `tax-payment:${obligation.id}:${payment.id}:${index}`,
      sourceSystem: 'TAX' as const,
      sourceObjectId: obligation.id,
      type: 'OUTFLOW' as const,
      category: 'TAX' as const,
      counterpartyName: taxAuthorityName(obligation.taxType),
      counterpartyType: 'TAX_AUTHORITY' as const,
      concept: `${obligation.taxType} ${obligation.period} · ${obligation.label}`,
      currency: 'MXN',
      originalAmount: payment.amount,
      baseAmount: payment.amount,
      projectedAmount: payment.amount,
      adjustedAmount: payment.amount,
      issueDate: `${obligation.period}-01`,
      dueDate: obligation.dueDate,
      projectedDate: payment.date,
      adjustedDate: payment.date,
      confidenceScore: payment.status === 'PAID' ? 96 : 82,
      confidenceBand: calculateConfidenceBand(payment.status === 'PAID' ? 96 : 82),
      forecastMethod: 'MANUAL' as const,
      ruleApplied: `Plan fiscal ${payment.status === 'PAID' ? 'pagado' : 'aprobado'}`,
      taxTreatment: 'IVA_EXEMPT' as const,
      status: payment.status === 'PAID' ? 'EXECUTED' as const : 'APPROVED' as const,
      lockState: obligation.taxType === 'IMSS' ? 'LOCKED' as const : 'RESTRICTED' as const,
      comments: [payment.note, obligation.comment].filter((value): value is string => Boolean(value)),
      createdAt: `${params.asOfDate}T00:00:00.000Z`,
      updatedAt: `${params.asOfDate}T00:00:00.000Z`,
    })));
}

export function taxDueDate(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month, 17)).toISOString().slice(0, 10);
}

export function suggestTaxPaymentDate(
  projection: ForecastRun,
  dueDate: string,
  amount: number,
): { date: string; reason: string } | undefined {
  const dueBucket = projection.buckets.find((bucket) => bucket.date >= dueDate);
  if (dueBucket && dueBucket.closingCash - dueBucket.minimumCash >= amount) {
    return { date: dueDate, reason: 'La caja proyectada cubre el pago fiscal en la fecha objetivo.' };
  }
  const candidate = projection.buckets.find((bucket) =>
    bucket.date >= dueDate && bucket.closingCash - bucket.minimumCash >= amount,
  );
  if (candidate) return { date: candidate.date, reason: 'Primera fecha futura con caja libre suficiente.' };
  const last = projection.buckets[projection.buckets.length - 1];
  if (!last) return undefined;
  return { date: last.date, reason: 'No hay caja suficiente en el horizonte visible; revisar al cierre.' };
}

interface TaxPeriodAccumulator {
  period: string;
  dueDate: string;
  incomeBase16: number;
  incomeBase8: number;
  ivaCaused16: number;
  ivaCaused8: number;
  expenseBase16: number;
  expenseBase8: number;
  ivaCreditable16: number;
  ivaCreditable8: number;
  manualIvaCaused: number;
  manualIvaCreditable: number;
  ivaPaid: number;
  manualIvaPayable: number;
  unclassifiedIncome: number;
  unclassifiedExpense: number;
  incomeLines: TaxSourceLine[];
  expenseLines: TaxSourceLine[];
  unclassifiedLines: TaxSourceLine[];
  payrollBase: number;
  payrollLines: TaxSourceLine[];
  isnOverride?: number;
  imssDetected: number;
  imssManual: number;
  imssLines: TaxSourceLine[];
  manualObligations: TaxObligation[];
}

function ensureAccumulator(map: Map<string, TaxPeriodAccumulator>, period: string): TaxPeriodAccumulator {
  const current = map.get(period);
  if (current) return current;
  const next: TaxPeriodAccumulator = {
    period,
    dueDate: taxDueDate(period),
    incomeBase16: 0,
    incomeBase8: 0,
    ivaCaused16: 0,
    ivaCaused8: 0,
    expenseBase16: 0,
    expenseBase8: 0,
    ivaCreditable16: 0,
    ivaCreditable8: 0,
    manualIvaCaused: 0,
    manualIvaCreditable: 0,
    ivaPaid: 0,
    manualIvaPayable: 0,
    unclassifiedIncome: 0,
    unclassifiedExpense: 0,
    incomeLines: [],
    expenseLines: [],
    unclassifiedLines: [],
    payrollBase: 0,
    payrollLines: [],
    imssDetected: 0,
    imssManual: 0,
    imssLines: [],
    manualObligations: [],
  };
  map.set(period, next);
  return next;
}

function accumulateIva(acc: TaxPeriodAccumulator, movement: FinancialMovement): void {
  if (movement.category === 'TAX') return;
  const treatment = normalizeTaxTreatment(movement.taxTreatment, movement);
  const amount = effectiveAmount(movement);
  const sourceLine = lineForMovement(movement);

  if (movement.type === 'INFLOW' && treatment === 'IVA_CAUSED') {
    // Default a 16% cuando el movimiento no trae tasa explícita (Régimen 601).
    const rate: 8 | 16 = movement.taxRate === 8 ? 8 : 16;
    const { base, tax } = taxAmounts({ ...movement, taxRate: rate }, amount);
    if (rate === 16) {
      acc.incomeBase16 += base;
      acc.ivaCaused16 += tax;
    } else {
      acc.incomeBase8 += base;
      acc.ivaCaused8 += tax;
    }
    acc.incomeLines.push({ ...sourceLine, taxBase: base, taxRate: rate, taxAmount: tax });
    return;
  }

  if (movement.type === 'OUTFLOW' && treatment === 'IVA_CREDITABLE') {
    // Default a 16% cuando el movimiento no trae tasa explícita (Régimen 601).
    const rate: 8 | 16 = movement.taxRate === 8 ? 8 : 16;
    const { base, tax } = taxAmounts({ ...movement, taxRate: rate }, amount);
    if (rate === 16) {
      acc.expenseBase16 += base;
      acc.ivaCreditable16 += tax;
    } else {
      acc.expenseBase8 += base;
      acc.ivaCreditable8 += tax;
    }
    acc.expenseLines.push({ ...sourceLine, taxBase: base, taxRate: rate, taxAmount: tax });
    return;
  }

  if (treatment === 'UNCLASSIFIED' && movement.type === 'INFLOW') {
    acc.unclassifiedIncome += amount;
    acc.unclassifiedLines.push(sourceLine);
  } else if (treatment === 'UNCLASSIFIED' && movement.type === 'OUTFLOW') {
    acc.unclassifiedExpense += amount;
    acc.unclassifiedLines.push(sourceLine);
  }
}

function accumulateIsn(acc: TaxPeriodAccumulator, movement: FinancialMovement): void {
  if (movement.category !== 'PAYROLL' || movement.type !== 'OUTFLOW') return;
  const amount = effectiveAmount(movement);
  acc.payrollBase += amount;
  acc.payrollLines.push(lineForMovement(movement));
}

function accumulateImss(acc: TaxPeriodAccumulator, movement: FinancialMovement): void {
  if (movement.type !== 'OUTFLOW') return;
  const text = `${movement.concept} ${movement.counterpartyName ?? ''}`.toUpperCase();
  if (!text.includes('IMSS') && !text.includes('INSTITUTO MEXICANO DEL SEGURO SOCIAL')) return;
  const amount = effectiveAmount(movement);
  acc.imssDetected += amount;
  acc.imssLines.push(lineForMovement(movement));
}

function finalizeTaxPeriod(
  acc: TaxPeriodAccumulator,
  store: TaxStore,
  today: string,
): TaxPeriodSummary {
  const ivaCaused = acc.ivaCaused16 + acc.ivaCaused8 + acc.manualIvaCaused;
  const ivaCreditable = acc.ivaCreditable16 + acc.ivaCreditable8 + acc.manualIvaCreditable;
  const netIva = ivaCaused - ivaCreditable;
  const ivaRawPayable = netIva + acc.manualIvaPayable - acc.ivaPaid;
  const ivaPayable = Math.max(0, ivaRawPayable);
  const ivaBalanceInFavor = Math.max(0, -ivaRawPayable);

  const isn = acc.isnOverride ?? acc.payrollBase * ISN_RATE;
  const imss = acc.imssDetected + acc.imssManual;

  const calculated: TaxObligation[] = [
    calculatedObligation('IVA', acc.period, ivaPayable, acc.dueDate, statusFromPaymentPlan(ivaPayable, paymentPlanFor(store, 'IVA', acc.period), today, acc.dueDate), paymentPlanFor(store, 'IVA', acc.period), ivaPayable > 0 ? 'CALCULATED' : 'CALCULATED'),
    calculatedObligation('ISN', acc.period, isn, acc.dueDate, statusFromPaymentPlan(isn, paymentPlanFor(store, 'ISN', acc.period), today, acc.dueDate), paymentPlanFor(store, 'ISN', acc.period), acc.isnOverride != null ? 'MANUAL' : 'CALCULATED'),
    calculatedObligation('IMSS', acc.period, imss, acc.dueDate, statusFromPaymentPlan(imss, paymentPlanFor(store, 'IMSS', acc.period), today, acc.dueDate), paymentPlanFor(store, 'IMSS', acc.period), acc.imssDetected > 0 ? 'JDE' : acc.imssManual > 0 ? 'MANUAL' : 'CALCULATED'),
  ].filter((obligation) => obligation.totalAmount > 0 || obligation.paymentPlan.length > 0);

  const manualOnly = acc.manualObligations.filter((manual) =>
    !calculated.some((item) => item.taxType === manual.taxType && item.period === manual.period),
  );
  const obligations = [...calculated, ...manualOnly].map((obligation) => ({
    ...obligation,
    paidAmount: paidAmount(obligation.paymentPlan),
    pendingAmount: Math.max(0, obligation.totalAmount - paidAmount(obligation.paymentPlan)),
  }));
  const cashImpact = obligations.reduce((sum, obligation) =>
    sum + obligation.paymentPlan
      .filter((payment) => payment.status === 'APPROVED' || payment.status === 'PAID')
      .reduce((paymentSum, payment) => paymentSum + payment.amount, 0),
  0);
  const total = ivaPayable + isn + imss;

  const iva: IvaPeriodDetail = {
    period: acc.period,
    dueDate: acc.dueDate,
    incomeBase16: acc.incomeBase16,
    incomeBase8: acc.incomeBase8,
    ivaCaused16: acc.ivaCaused16,
    ivaCaused8: acc.ivaCaused8,
    ivaCaused,
    expenseBase16: acc.expenseBase16,
    expenseBase8: acc.expenseBase8,
    ivaCreditable16: acc.ivaCreditable16,
    ivaCreditable8: acc.ivaCreditable8,
    ivaCreditable,
    manualCaused: acc.manualIvaCaused,
    manualCreditable: acc.manualIvaCreditable,
    ivaPaid: acc.ivaPaid,
    manualPayable: acc.manualIvaPayable,
    unclassifiedIncome: acc.unclassifiedIncome,
    unclassifiedExpense: acc.unclassifiedExpense,
    netIva,
    payable: ivaPayable,
    balanceInFavor: ivaBalanceInFavor,
    status: statusFromPaymentPlan(ivaPayable, paymentPlanFor(store, 'IVA', acc.period), today, acc.dueDate),
    source: 'CALCULATED',
    paymentPlan: paymentPlanFor(store, 'IVA', acc.period),
    incomeLines: acc.incomeLines,
    expenseLines: acc.expenseLines,
    unclassifiedLines: acc.unclassifiedLines,
  };

  return {
    period: acc.period,
    dueDate: acc.dueDate,
    ivaNet: ivaPayable,
    isn,
    imss,
    total,
    cashImpact,
    status: rollupStatus(obligations, total),
    obligations,
    iva,
    payrollBase: acc.payrollBase,
    payrollLines: acc.payrollLines,
    imssLines: acc.imssLines,
  };
}

function calculatedObligation(
  taxType: TaxType,
  period: string,
  amount: number,
  dueDate: string,
  status: TaxStatus,
  paymentPlan: TaxPaymentPlanItem[],
  source: TaxSource,
): TaxObligation {
  const paid = paidAmount(paymentPlan);
  return {
    id: calculatedObligationId(taxType, period),
    taxType,
    period,
    label: `${taxType} ${period}`,
    source,
    sourceSystem: source,
    totalAmount: Math.max(0, amount),
    paidAmount: paid,
    pendingAmount: Math.max(0, amount - paid),
    dueDate,
    paymentPlan,
    risk: taxType === 'IMSS' ? 'LEGAL' : taxType === 'IVA' ? 'HIGH' : 'MEDIUM',
    status,
  };
}

function calculatedObligationId(taxType: TaxType, period: string): string {
  return `tax-calculated:${taxType}:${period}`;
}

function paymentPlanFor(store: TaxStore, taxType: TaxType, period: string): TaxPaymentPlanItem[] {
  const direct = store.obligations.find((obligation) =>
    obligation.taxType === taxType
    && obligation.period === period
    && obligation.id === calculatedObligationId(taxType, period),
  );
  if (direct) return direct.paymentPlan;
  const samePeriod = store.obligations.filter((obligation) => obligation.taxType === taxType && obligation.period === period);
  return samePeriod.flatMap((obligation) => obligation.paymentPlan);
}

function statusFromPaymentPlan(amount: number, plan: TaxPaymentPlanItem[], today: string, dueDate: string): TaxStatus {
  if (amount <= 0) return 'PROJECTED';
  const paid = paidAmount(plan);
  const approved = plan
    .filter((payment) => payment.status === 'APPROVED' || payment.status === 'PAID')
    .reduce((sum, payment) => sum + payment.amount, 0);
  if (paid >= amount) return 'PAID';
  if (approved >= amount) return 'CONFIRMED';
  if (dueDate < today) return 'PENDING';
  return 'PROJECTED';
}

function rollupStatus(obligations: TaxObligation[], total: number): TaxStatus {
  if (total <= 0) return 'PROJECTED';
  if (obligations.some((obligation) => obligation.status === 'PENDING')) return 'PENDING';
  if (obligations.length > 0 && obligations.every((obligation) => obligation.status === 'PAID')) return 'PAID';
  if (obligations.some((obligation) => obligation.status === 'CONFIRMED')) return 'CONFIRMED';
  return 'PROJECTED';
}

function paidAmount(plan: TaxPaymentPlanItem[]): number {
  return plan
    .filter((payment) => payment.status === 'PAID')
    .reduce((sum, payment) => sum + payment.amount, 0);
}

function taxAmounts(movement: FinancialMovement, amount: number): { base: number; tax: number } {
  if (movement.taxBaseAmount != null && movement.taxAmount != null) {
    const scale = movement.projectedAmount > 0 ? amount / movement.projectedAmount : 1;
    return {
      base: Math.max(0, movement.taxBaseAmount * scale),
      tax: Math.max(0, movement.taxAmount * scale),
    };
  }
  const rate = movement.taxRate ?? 0;
  if (rate <= 0) return { base: amount, tax: 0 };
  const base = amount / (1 + rate / 100);
  return { base, tax: amount - base };
}

function lineForMovement(movement: FinancialMovement): TaxSourceLine {
  const amount = effectiveAmount(movement);
  return {
    movementId: movement.id,
    date: effectiveMovementDate(movement),
    concept: movement.concept,
    counterpartyName: movement.counterpartyName,
    amount,
    taxBase: movement.taxBaseAmount ?? amount,
    taxRate: movement.taxRate,
    taxAmount: movement.taxAmount ?? 0,
    sourceSystem: movement.sourceSystem,
  };
}

function normalizeTaxTreatment(
  treatment: FinancialMovement['taxTreatment'] | 'TAXABLE_IVA' | undefined,
  movement: FinancialMovement,
): FinancialMovement['taxTreatment'] {
  if (treatment === 'TAXABLE_IVA') return 'IVA_CAUSED';
  if (treatment) return treatment;

  // Excepciones explícitas (no generan IVA o se manejan por separado)
  if (
    movement.category === 'PAYROLL' ||
    movement.category === 'TAX' ||
    movement.category === 'DEBT' ||
    movement.category === 'TRANSFER'
  ) {
    return 'IVA_EXEMPT';
  }

  // Regla general para Régimen 601:
  // Cualquier ingreso (Inflow) que no sea deuda/transferencia se presume causado.
  // Cualquier egreso (Outflow) que no sea nómina/impuesto se presume acreditable.
  if (movement.type === 'INFLOW') return 'IVA_CAUSED';
  if (movement.type === 'OUTFLOW') return 'IVA_CREDITABLE';

  return 'UNCLASSIFIED';
}

function taxAuthorityName(taxType: TaxType): string {
  if (taxType === 'IMSS') return 'IMSS';
  if (taxType === 'ISN') return 'Tesorería estatal';
  return 'SAT';
}

function normalizeTaxStore(value: unknown, fallback: TaxStore): TaxStore {
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Record<string, unknown>;
  return {
    adjustments: Array.isArray(raw.adjustments)
      ? raw.adjustments.map(normalizeAdjustment).filter((item): item is TaxManualAdjustment => item !== null)
      : fallback.adjustments,
    obligations: Array.isArray(raw.obligations)
      ? raw.obligations.map(normalizeObligation).filter((item): item is TaxObligation => item !== null)
      : fallback.obligations,
    overdueBalance: typeof raw.overdueBalance === 'number' && Number.isFinite(raw.overdueBalance)
      ? Math.max(0, raw.overdueBalance)
      : fallback.overdueBalance,
    migratedAt: typeof raw.migratedAt === 'string' ? raw.migratedAt : fallback.migratedAt,
  };
}

function migrateLegacyTaxStore(): TaxStore {
  const adjustments: TaxManualAdjustment[] = [];
  const obligations: TaxObligation[] = [];
  try {
    const rawIva = localStorage.getItem(LEGACY_IVA_ADJUSTMENTS_KEY);
    const parsedIva = rawIva ? JSON.parse(rawIva) : [];
    if (Array.isArray(parsedIva)) {
      for (const item of parsedIva) {
        const normalized = normalizeLegacyIvaAdjustment(item);
        if (normalized) adjustments.push(normalized);
      }
    }
  } catch {
    /* ignore malformed legacy IVA data */
  }

  try {
    const rawScenarios = localStorage.getItem(LEGACY_OPERATING_SCENARIOS_KEY);
    const parsedScenarios = rawScenarios ? JSON.parse(rawScenarios) : [];
    if (Array.isArray(parsedScenarios)) {
      for (const scenario of parsedScenarios) {
        if (!scenario || typeof scenario !== 'object') continue;
        const taxDebts = (scenario as { taxDebts?: unknown }).taxDebts;
        if (!Array.isArray(taxDebts)) continue;
        for (const debt of taxDebts) {
          const obligation = normalizeLegacyOperatingDebt(debt);
          if (obligation) obligations.push(obligation);
        }
      }
    }
  } catch {
    /* ignore malformed legacy operating data */
  }

  return {
    adjustments,
    obligations: dedupeObligations(obligations),
    overdueBalance: 0,
    migratedAt: adjustments.length > 0 || obligations.length > 0 ? new Date().toISOString() : undefined,
  };
}

function normalizeLegacyIvaAdjustment(value: unknown): TaxManualAdjustment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const period = typeof raw.period === 'string' && /^\d{4}-\d{2}$/.test(raw.period) ? raw.period : null;
  const amount = readAmount(raw.amount);
  const kind = raw.kind === 'IVA_CAUSED'
    || raw.kind === 'IVA_CREDITABLE'
    || raw.kind === 'IVA_PAID'
    || raw.kind === 'IVA_PAYABLE'
    ? raw.kind
    : null;
  if (!period || !kind || !Number.isFinite(amount) || amount < 0) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? `legacy:${raw.id}` : `legacy-tax-adjustment-${period}-${kind}`,
    taxType: 'IVA',
    period,
    kind,
    amount,
    note: typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined,
    source: 'MANUAL',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

function normalizeLegacyOperatingDebt(value: unknown): TaxObligation | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const taxType = normalizeTaxType(raw.taxType);
  const dueDate = typeof raw.dueDate === 'string' && isIsoDate(raw.dueDate) ? raw.dueDate : null;
  const amount = readAmount(raw.outstandingAmount) || readAmount(raw.originalAmount);
  if (!taxType || !dueDate || !Number.isFinite(amount) || amount <= 0) return null;
  const fiscalPeriod = typeof raw.fiscalPeriod === 'string' && raw.fiscalPeriod.trim()
    ? raw.fiscalPeriod.trim()
    : dueDate.slice(0, 7);
  const period = /^\d{4}-\d{2}$/.test(fiscalPeriod) ? fiscalPeriod : dueDate.slice(0, 7);
  const plan = Array.isArray(raw.plannedPayments)
    ? raw.plannedPayments.map(normalizeLegacyPayment).filter((item): item is TaxPaymentPlanItem => item !== null)
    : [];
  const paid = readAmount(raw.paidAmount);
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? `legacy:${raw.id}` : `legacy-tax-obligation-${taxType}-${period}`,
    taxType,
    period,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : `${taxType} ${period}`,
    source: 'MANUAL',
    sourceSystem: 'MANUAL',
    totalAmount: amount + Math.max(0, paid),
    paidAmount: Math.max(0, paid),
    pendingAmount: Math.max(0, amount),
    dueDate,
    paymentPlan: plan,
    risk: taxType === 'IMSS' ? 'LEGAL' : taxType === 'IVA' ? 'HIGH' : 'MEDIUM',
    comment: typeof raw.comments === 'string' && raw.comments.trim() ? raw.comments.trim() : undefined,
    status: statusFromPaymentPlan(amount, plan, new Date().toISOString().slice(0, 10), dueDate),
  };
}

function normalizeLegacyPayment(value: unknown): TaxPaymentPlanItem | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const date = typeof raw.date === 'string' && isIsoDate(raw.date) ? raw.date : null;
  const amount = readAmount(raw.amount);
  if (!date || !Number.isFinite(amount) || amount <= 0) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? `legacy:${raw.id}` : `legacy-payment-${date}`,
    date,
    amount,
    status: 'DRAFT',
    note: typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined,
  };
}

function dedupeObligations(obligations: TaxObligation[]): TaxObligation[] {
  const seen = new Set<string>();
  const out: TaxObligation[] = [];
  for (const obligation of obligations) {
    const key = `${obligation.id}:${obligation.taxType}:${obligation.period}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(obligation);
  }
  return out;
}

function normalizeAdjustment(value: unknown): TaxManualAdjustment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const taxType = normalizeTaxType(raw.taxType);
  const period = typeof raw.period === 'string' && /^\d{4}-\d{2}$/.test(raw.period) ? raw.period : null;
  const kind = normalizeAdjustmentKind(raw.kind);
  const amount = readAmount(raw.amount);
  if (!taxType || !period || !kind || !Number.isFinite(amount) || amount < 0) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `tax-adjustment-${period}-${kind}`,
    taxType,
    period,
    kind,
    amount,
    note: typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined,
    source: normalizeSource(raw.source) ?? 'MANUAL',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

function normalizeObligation(value: unknown): TaxObligation | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const taxType = normalizeTaxType(raw.taxType);
  const period = typeof raw.period === 'string' && /^\d{4}-\d{2}$/.test(raw.period) ? raw.period : null;
  const dueDate = typeof raw.dueDate === 'string' && isIsoDate(raw.dueDate) ? raw.dueDate : null;
  const totalAmount = readAmount(raw.totalAmount);
  if (!taxType || !period || !dueDate || !Number.isFinite(totalAmount) || totalAmount < 0) return null;
  const paymentPlan = Array.isArray(raw.paymentPlan)
    ? raw.paymentPlan.map(normalizePayment).filter((item): item is TaxPaymentPlanItem => item !== null)
    : [];
  const paid = Number.isFinite(readAmount(raw.paidAmount)) ? readAmount(raw.paidAmount) : paidAmount(paymentPlan);
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `tax-obligation-${taxType}-${period}`,
    taxType,
    period,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : `${taxType} ${period}`,
    source: normalizeSource(raw.source) ?? normalizeSource(raw.sourceSystem) ?? 'MANUAL',
    sourceSystem: normalizeLegacySource(raw.sourceSystem),
    totalAmount,
    paidAmount: Math.max(0, paid),
    pendingAmount: Math.max(0, totalAmount - paid),
    dueDate,
    paymentPlan,
    risk: raw.risk === 'LOW' || raw.risk === 'MEDIUM' || raw.risk === 'HIGH' || raw.risk === 'LEGAL'
      ? raw.risk
      : taxType === 'IMSS' ? 'LEGAL' : taxType === 'IVA' ? 'HIGH' : 'MEDIUM',
    comment: typeof raw.comment === 'string' && raw.comment.trim() ? raw.comment.trim() : undefined,
    status: normalizeStatus(raw.status) ?? statusFromPaymentPlan(totalAmount, paymentPlan, new Date().toISOString().slice(0, 10), dueDate),
  };
}

function normalizePayment(value: unknown): TaxPaymentPlanItem | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const date = typeof raw.date === 'string' && isIsoDate(raw.date) ? raw.date : null;
  const amount = readAmount(raw.amount);
  const status = raw.status === 'DRAFT' || raw.status === 'APPROVED' || raw.status === 'PAID' ? raw.status : null;
  if (!date || !Number.isFinite(amount) || amount < 0 || !status) return null;
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `tax-payment-${date}`,
    date,
    amount,
    status,
    scenarioId: typeof raw.scenarioId === 'string' && raw.scenarioId.trim() ? raw.scenarioId.trim() : undefined,
    note: typeof raw.note === 'string' && raw.note.trim() ? raw.note.trim() : undefined,
  };
}

function normalizeTaxType(value: unknown): TaxType | null {
  return value === 'IVA' || value === 'ISN' || value === 'IMSS' ? value : null;
}

function normalizeSource(value: unknown): TaxSource | null {
  return value === 'CALCULATED' || value === 'JDE' || value === 'MANUAL' || value === 'SCENARIO' ? value : null;
}

function normalizeLegacySource(value: unknown): TaxObligation['sourceSystem'] {
  if (value === 'MANUAL' || value === 'TAX' || value === 'JDE' || value === 'EXCEL' || value === 'CALCULATED' || value === 'SCENARIO') return value;
  return undefined;
}

function normalizeStatus(value: unknown): TaxStatus | null {
  if (value === 'PROJECTED' || value === 'CONFIRMED' || value === 'PAID' || value === 'PENDING') return value;
  if (value === 'OPEN' || value === 'OVERDUE') return 'PENDING';
  if (value === 'PARTIAL') return 'CONFIRMED';
  return null;
}

function normalizeAdjustmentKind(value: unknown): TaxManualAdjustment['kind'] | null {
  return value === 'IVA_CAUSED'
    || value === 'IVA_CREDITABLE'
    || value === 'IVA_PAID'
    || value === 'IVA_PAYABLE'
    || value === 'ISN_OVERRIDE'
    || value === 'IMSS_MANUAL'
    ? value
    : null;
}

function readAmount(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
