import type { CXPRecord } from '../../../domain/persistence';
import { projectClientMonth } from '../../../domain/collectionEngine';
import type { Budget } from '../../../domain/budget';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { CobranzaPayment } from '../../../services/jdeTypes';
import type {
  FinancialMovement,
  PayrollCostRecord,
  PurchaseReceiptRecord,
  ForecastRun,
  TaxManualAdjustment,
  TaxObligation,
  TaxPaymentPlanItem,
  TaxSource,
  TaxStatus,
  TaxType,
} from '../../shared-finance/types';
import {
  buildPurchaseReceiptMovements,
  purchaseMatchesCxp,
  purchaseReceiptToMovement,
} from '../../shared-finance/sourceRecords';
import {
  calculateConfidenceBand,
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';

export const TAX_STORE_KEY = 'midas.taxes.v1';
export const TAX_STORE_CHANGED_EVENT = 'midas:taxes:changed';
const LEGACY_IVA_ADJUSTMENTS_KEY = 'midas.financialProjection.taxAdjustments.v1';
const LEGACY_OPERATING_SCENARIOS_KEY = 'midas.operating.scenarios.v1';
const ISN_RATE = 0.03;
const REGIMEN_601_IVA_RATE = 16;

export interface TaxStore {
  adjustments: TaxManualAdjustment[];
  obligations: TaxObligation[];
  taxRateOverrides: TaxRateOverride[];
  /** Saldo vencido acumulado de impuestos (no cubierto por los periodos visibles). */
  overdueBalance: number;
  migratedAt?: string;
}

export type TaxRateOverrideTargetType = 'CLIENT' | 'PROVIDER' | 'CONCEPT';

export interface TaxRateTarget {
  targetType: TaxRateOverrideTargetType;
  targetKey: string;
}

export interface TaxRateOverride extends TaxRateTarget {
  rate: 8 | 16;
  updatedAt: string;
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
  rateTarget?: TaxRateTarget;
  rateSource?: 'OVERRIDE' | 'CATALOG' | 'JDE' | 'DEFAULT';
  estimated?: boolean;
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
  return { adjustments: [], obligations: [], taxRateOverrides: [], overdueBalance: 0 };
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
    if (
      store.adjustments.length === 0
      && store.obligations.length === 0
      && store.taxRateOverrides.length === 0
      && store.overdueBalance <= 0
    ) {
      localStorage.removeItem(TAX_STORE_KEY);
      notifyTaxStoreChanged(store);
      return;
    }
    localStorage.setItem(TAX_STORE_KEY, JSON.stringify(store));
    notifyTaxStoreChanged(store);
  } catch {
    /* localStorage quota errors do not block planning. */
  }
}

function notifyTaxStoreChanged(store: TaxStore): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TAX_STORE_CHANGED_EVENT, { detail: store }));
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

export function upsertTaxRateOverride(store: TaxStore, override: TaxRateOverride): TaxStore {
  const normalized = {
    ...override,
    targetKey: normalizeTargetKey(override),
  };
  const taxRateOverrides = store.taxRateOverrides.some((item) =>
    item.targetType === normalized.targetType && normalizeTargetKey(item) === normalized.targetKey,
  )
    ? store.taxRateOverrides.map((item) => (
      item.targetType === normalized.targetType && normalizeTargetKey(item) === normalized.targetKey
        ? normalized
        : item
    ))
    : [...store.taxRateOverrides, normalized];
  return { ...store, taxRateOverrides };
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

export function removeTaxPaymentPlanItem(
  obligation: TaxObligation,
  paymentId: string,
): TaxObligation {
  return {
    ...obligation,
    paymentPlan: obligation.paymentPlan.filter((payment) => payment.id !== paymentId),
  };
}

export function buildTaxDashboardView(params: {
  clients?: Client[];
  providers?: Provider[];
  assumptions?: CashFlowAssumptions;
  cxpRecords?: CXPRecord[];
  purchaseReceipts?: PurchaseReceiptRecord[];
  payrollCosts?: PayrollCostRecord[];
  cobranzaPayments?: CobranzaPayment[];
  budget?: Budget | null;
  companyCode?: string;
  startDate?: string;
  endDate?: string;
  movements?: FinancialMovement[];
  projection?: ForecastRun;
  store: TaxStore;
  today: string;
}): TaxDashboardView {
  const startDate = params.startDate ?? params.projection?.startDate ?? `${params.today.slice(0, 7)}-01`;
  const endDate = params.endDate ?? params.projection?.endDate ?? `${params.today.slice(0, 4)}-12-31`;
  const movements = params.movements ?? params.projection?.movements ?? [];
  const byPeriod = new Map<string, TaxPeriodAccumulator>();
  const ensure = (period: string) => ensureAccumulator(byPeriod, period);
  const rateContext = buildTaxRateContext(params.store, params.providers ?? []);

  const realIvaPeriods = accumulateCobranzaPaymentIva({
    payments: params.cobranzaPayments ?? [],
    companyCode: params.companyCode,
    startDate,
    endDate,
    ensure,
  });

  accumulateProjectedClientIva({
    clients: params.clients ?? [],
    assumptions: params.assumptions,
    startDate,
    endDate,
    rateContext,
    ensure,
    skipPeriods: realIvaPeriods,
  });

  const handledCxpKeys = accumulateCxpIva({
    cxpRecords: params.cxpRecords ?? [],
    purchaseReceipts: params.purchaseReceipts ?? [],
    companyCode: params.companyCode,
    startDate,
    endDate,
    rateContext,
    ensure,
  });
  const handledPurchaseMovementIds = accumulatePurchaseReceiptIva({
    purchaseReceipts: params.purchaseReceipts ?? [],
    cxpRecords: params.cxpRecords ?? [],
    companyCode: params.companyCode,
    startDate,
    endDate,
    asOfDate: params.today,
    ensure,
  });

  accumulateMovementIvaFallback({
    movements,
    startDate,
    endDate,
    handledCxpKeys,
    handledMovementIds: handledPurchaseMovementIds,
    rateContext,
    ensure,
  });

  accumulateBudgetIvaComplement({
    budget: params.budget ?? null,
    startDate,
    endDate,
    rateContext,
    ensure,
  });

  for (const movement of movements) {
    const date = effectiveMovementDate(movement);
    if (date < startDate || date > endDate) continue;
    const period = date.slice(0, 7);
    const row = ensure(period);
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
    .filter((ob) => ob.period < startDate.slice(0, 7) && ob.pendingAmount > 0)
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

export function buildAutomaticTaxReserveMovements(params: {
  obligations: TaxObligation[];
  scenarioId: string;
  startDate: string;
  endDate: string;
  asOfDate: string;
}): FinancialMovement[] {
  return params.obligations
    .flatMap((obligation) => {
      const committedAmount = obligation.paymentPlan
        .filter((payment) => payment.status === 'APPROVED' || payment.status === 'PAID')
        .reduce((sum, payment) => sum + payment.amount, 0);
      const reserveAmount = Math.max(0, obligation.totalAmount - committedAmount);
      if (reserveAmount <= 0) return [];
      const projectedDate = obligation.dueDate < params.asOfDate ? params.asOfDate : obligation.dueDate;
      if (projectedDate < params.startDate || projectedDate > params.endDate) return [];
      const movement: FinancialMovement = {
        id: `tax-reserve:${params.scenarioId}:${obligation.id}`,
        sourceSystem: 'TAX' as const,
        sourceObjectId: obligation.id,
        type: 'OUTFLOW' as const,
        category: 'TAX' as const,
        counterpartyName: taxAuthorityName(obligation.taxType),
        counterpartyType: 'TAX_AUTHORITY' as const,
        concept: `Reserva ${obligation.taxType} ${obligation.period} · ${obligation.label}`,
        currency: 'MXN',
        originalAmount: reserveAmount,
        baseAmount: reserveAmount,
        projectedAmount: reserveAmount,
        adjustedAmount: reserveAmount,
        issueDate: `${obligation.period}-01`,
        dueDate: obligation.dueDate,
        projectedDate,
        adjustedDate: projectedDate,
        confidenceScore: obligation.source === 'CALCULATED' ? 74 : 84,
        confidenceBand: calculateConfidenceBand(obligation.source === 'CALCULATED' ? 74 : 84),
        forecastMethod: obligation.source === 'CALCULATED' ? 'RULE' as const : 'MANUAL' as const,
        ruleApplied: 'Reserva fiscal automática',
        taxTreatment: 'IVA_EXEMPT' as const,
        status: obligation.status === 'PAID' ? 'EXECUTED' as const : 'PROJECTED_BASE' as const,
        lockState: obligation.taxType === 'IMSS' || obligation.risk === 'LEGAL' ? 'LOCKED' as const : 'RESTRICTED' as const,
        comments: [
          `Saldo fiscal no cubierto por pagos aprobados/pagados: ${obligation.taxType} ${obligation.period}.`,
          obligation.comment,
        ].filter((value): value is string => Boolean(value)),
        createdAt: `${params.asOfDate}T00:00:00.000Z`,
        updatedAt: `${params.asOfDate}T00:00:00.000Z`,
      };
      return [movement];
    });
}

export function taxDueDate(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month, 17)).toISOString().slice(0, 10);
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
  creditableGross: number;
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
    creditableGross: 0,
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

function accumulateCobranzaPaymentIva({
  payments,
  companyCode,
  startDate,
  endDate,
  ensure,
}: {
  payments: CobranzaPayment[];
  companyCode?: string;
  startDate: string;
  endDate: string;
  ensure: (period: string) => TaxPeriodAccumulator;
}): Set<string> {
  const periods = new Set<string>();
  for (const payment of payments) {
    if (companyCode && companyCode !== 'all' && payment.cia !== companyCode) continue;
    for (const app of payment.applications) {
      const date = cleanIsoDate(payment.fechaCobro) ?? cleanIsoDate(app.fechaAplicacion);
      if (!date || date < startDate || date > endDate) continue;
      const amount = positiveNumber(app.importeCobrado);
      if (amount <= 0) continue;
      const original = positiveNumber(app.importeOriginalFactura);
      const originalIva = positiveNumber(app.importeIvaFacturaOriginal);
      const taxAmount = original > 0 && originalIva > 0
        ? originalIva * Math.min(1, amount / original)
        : 0;
      const taxRate = taxRateFromIndicator(app.tasaIva, amount, taxAmount);
      if (taxRate !== 16 && taxRate !== 8) continue;
      const taxBase = Math.max(0, amount - taxAmount);
      const line: TaxSourceLine = {
        movementId: `cxc-payment:${payment.cia}:${payment.idPago}:${app.noFacturaNormalizada}`,
        date,
        concept: `Cobro ${payment.idPago} · Factura ${app.noFactura || 's/n'}`,
        counterpartyName: app.cliente || payment.cliente,
        amount,
        taxBase,
        taxRate,
        taxAmount,
        sourceSystem: 'JDE',
        rateSource: 'JDE',
      };
      addIvaCaused(ensure(date.slice(0, 7)), line, taxRate);
      periods.add(date.slice(0, 7));
    }
  }
  return periods;
}

function accumulateProjectedClientIva({
  clients,
  assumptions,
  startDate,
  endDate,
  rateContext,
  ensure,
  skipPeriods,
}: {
  clients: Client[];
  assumptions?: CashFlowAssumptions;
  startDate: string;
  endDate: string;
  rateContext: TaxRateContext;
  ensure: (period: string) => TaxPeriodAccumulator;
  skipPeriods?: Set<string>;
}): void {
  if (!assumptions || clients.length === 0) return;
  const startYear = Number(startDate.slice(0, 4));
  const endYear = Number(endDate.slice(0, 4));
  let lineIndex = 0;

  for (const client of clients) {
    for (let year = startYear - 1; year <= endYear; year += 1) {
      for (let month = 0; month < 12; month += 1) {
        const events = projectClientMonth(client, year, month, { ...assumptions, year });
        for (const event of events) {
          if (event.realDate < startDate || event.realDate > endDate) continue;
          if (skipPeriods?.has(event.realDate.slice(0, 7))) continue;
          if (event.amount <= 0) continue;
          const target = clientRateTarget(client);
          const resolution = resolveTaxRate(rateContext, target, client.ivaRate);
          const rate = resolution.rate;
          const line: TaxSourceLine = {
            movementId: `cxc:${client.id}:${event.invoiceDate}:${event.realDate}:${lineIndex++}`,
            date: event.realDate,
            concept: `Factura proyectada ${client.name}`,
            counterpartyName: client.name,
            amount: rate ? event.amount * (1 + rate / 100) : event.amount,
            taxBase: event.amount,
            taxRate: rate,
            taxAmount: rate ? event.amount * (rate / 100) : 0,
            sourceSystem: 'FORECAST',
            rateTarget: target,
            rateSource: resolution.source,
          };
          const row = ensure(event.realDate.slice(0, 7));
          if (rate === 16 || rate === 8) addIvaCaused(row, line, rate);
          else {
            row.unclassifiedIncome += event.amount;
            row.unclassifiedLines.push(line);
          }
        }
      }
    }
  }
}

function accumulateCxpIva({
  cxpRecords,
  purchaseReceipts,
  companyCode,
  startDate,
  endDate,
  rateContext,
  ensure,
}: {
  cxpRecords: CXPRecord[];
  purchaseReceipts: PurchaseReceiptRecord[];
  companyCode?: string;
  startDate: string;
  endDate: string;
  rateContext: TaxRateContext;
  ensure: (period: string) => TaxPeriodAccumulator;
}): Set<string> {
  const handledKeys = new Set<string>();
  cxpRecords.forEach((record, index) => {
    if (companyCode && companyCode !== 'all' && record.cia !== companyCode) return;
    const date = cleanIsoDate(record.fechaProgramacionPago)
      ?? cleanIsoDate(record.fechaVence)
      ?? cleanIsoDate(record.fechaFactura);
    if (!date || date < startDate || date > endDate) return;

    const target = providerRateTargetFromCxp(record);
    const providerRate = providerCatalogRate(rateContext, record);
    const overrideRate = overrideRateFor(rateContext, target);
    const matchedPurchase = purchaseReceipts.find((receipt) => purchaseMatchesCxp(receipt, record));
    const breakdown = cxpTaxBreakdown(record, overrideRate ?? undefined, providerRate, matchedPurchase);
    if (breakdown.amount <= 0) return;
    markCxpHandled(handledKeys, record, index);

    const line: TaxSourceLine = {
      movementId: `cxp:${record.cia}:${record.noProveedor}:${record.noFactura}:${index}`,
      date,
      concept: `Factura ${record.noFactura || 'sin folio'} · ${record.nombre}`,
      counterpartyName: record.nombre,
      amount: breakdown.amount,
      taxBase: breakdown.taxBase,
      taxRate: breakdown.taxRate,
      taxAmount: breakdown.taxAmount,
      sourceSystem: 'JDE',
      rateTarget: target,
      rateSource: overrideRate ? 'OVERRIDE' : breakdown.rateSource,
      estimated: breakdown.estimated,
    };
    const row = ensure(date.slice(0, 7));
    if (breakdown.taxRate === 16 || breakdown.taxRate === 8) addIvaCreditable(row, line, breakdown.taxRate);
    else {
      row.unclassifiedExpense += breakdown.amount;
      row.unclassifiedLines.push(line);
    }
  });
  return handledKeys;
}

function accumulatePurchaseReceiptIva({
  purchaseReceipts,
  cxpRecords,
  companyCode,
  startDate,
  endDate,
  asOfDate,
  ensure,
}: {
  purchaseReceipts: PurchaseReceiptRecord[];
  cxpRecords: CXPRecord[];
  companyCode?: string;
  startDate: string;
  endDate: string;
  asOfDate: string;
  ensure: (period: string) => TaxPeriodAccumulator;
}): Set<string> {
  const handledMovementIds = new Set<string>();
  const movements = buildPurchaseReceiptMovements({
    purchaseReceipts,
    cxpRecords,
    companyCode: companyCode ?? 'all',
    asOfDate,
    endDate,
  });
  for (const movement of movements) {
    const date = effectiveMovementDate(movement);
    if (date < startDate || date > endDate) continue;
    handledMovementIds.add(movement.id);
    if (movement.status === 'CANCELLED') continue;
    const amount = positiveNumber(effectiveAmount(movement));
    if (amount <= 0) continue;
    if (movement.taxTreatment !== 'IVA_CREDITABLE' || (movement.taxRate !== 16 && movement.taxRate !== 8)) {
      const row = ensure(date.slice(0, 7));
      row.unclassifiedExpense += amount;
      row.unclassifiedLines.push(lineForMovement(movement));
      continue;
    }
    const line: TaxSourceLine = {
      movementId: movement.id,
      date,
      concept: movement.concept,
      counterpartyName: movement.counterpartyName,
      amount,
      taxBase: positiveNumber(movement.taxBaseAmount ?? 0),
      taxRate: movement.taxRate,
      taxAmount: positiveNumber(movement.taxAmount ?? 0),
      sourceSystem: movement.sourceSystem,
      rateTarget: rateTargetFromMovement(movement),
      rateSource: 'JDE',
      estimated: true,
    };
    addIvaCreditable(ensure(date.slice(0, 7)), line, movement.taxRate);
  }

  for (const receipt of purchaseReceipts) {
    if (!receipt.isCancelled) continue;
    handledMovementIds.add(purchaseReceiptToMovement(receipt, asOfDate).id);
  }
  return handledMovementIds;
}

function accumulateBudgetIvaComplement({
  budget,
  startDate,
  endDate,
  rateContext,
  ensure,
}: {
  budget: Budget | null;
  startDate: string;
  endDate: string;
  rateContext: TaxRateContext;
  ensure: (period: string) => TaxPeriodAccumulator;
}): void {
  if (!budget) return;
  const startPeriod = startDate.slice(0, 7);
  const endPeriod = endDate.slice(0, 7);
  for (const concept of budget.expenseByConcept ?? []) {
    const category = budgetCategoryForTax(concept.concept);
    if (!isRegimen601CreditableCategory(category)) continue;
    for (let month = 0; month < 12; month += 1) {
      const amount = positiveNumber(concept.monthly?.[month] ?? 0);
      if (amount <= 0) continue;
      const period = `${budget.year}-${String(month + 1).padStart(2, '0')}`;
      if (period < startPeriod || period > endPeriod) continue;
      const row = ensure(period);
      const complement = Math.max(0, amount - row.creditableGross);
      if (complement <= 0.01) continue;
      const date = dateForDayOfMonth(period, typicalDayForConcept(concept.concept, month));
      const target = conceptRateTarget(concept.concept);
      const resolution = resolveTaxRate(rateContext, target);
      const breakdown = grossToIvaBreakdown(complement, resolution.rate);
      addIvaCreditable(row, {
        movementId: `budget-iva:${budget.year}:${month + 1}:${normalizeText(concept.concept)}`,
        date,
        concept: `${concept.concept} presupuestado`,
        counterpartyName: 'Presupuesto',
        amount: complement,
        taxBase: breakdown.taxBase,
        taxRate: resolution.rate,
        taxAmount: breakdown.taxAmount,
        sourceSystem: 'FORECAST',
        rateTarget: target,
        rateSource: resolution.source,
        estimated: true,
      }, resolution.rate);
    }
  }
}

function accumulateMovementIvaFallback({
  movements,
  startDate,
  endDate,
  handledCxpKeys,
  handledMovementIds,
  rateContext,
  ensure,
}: {
  movements: FinancialMovement[];
  startDate: string;
  endDate: string;
  handledCxpKeys: Set<string>;
  handledMovementIds: Set<string>;
  rateContext: TaxRateContext;
  ensure: (period: string) => TaxPeriodAccumulator;
}): void {
  for (const movement of movements) {
    if (movement.type !== 'OUTFLOW') continue;
    if (handledMovementIds.has(movement.id)) continue;
    const date = effectiveMovementDate(movement);
    if (date < startDate || date > endDate) continue;
    if (isHandledCxpMovement(movement, handledCxpKeys)) continue;

    const breakdown = movementCreditableIvaBreakdown(movement, rateContext);
    if (!breakdown) continue;

    addIvaCreditable(ensure(date.slice(0, 7)), {
      movementId: movement.id,
      date,
      concept: movement.concept,
      counterpartyName: movement.counterpartyName,
      amount: breakdown.amount,
      taxBase: breakdown.taxBase,
      taxRate: breakdown.taxRate,
      taxAmount: breakdown.taxAmount,
      sourceSystem: movement.sourceSystem,
      rateTarget: breakdown.rateTarget,
      rateSource: breakdown.rateSource,
      estimated: movement.sourceSystem === 'FORECAST' && movement.id.startsWith('budget:'),
    }, breakdown.taxRate);
  }
}

function addIvaCaused(acc: TaxPeriodAccumulator, line: TaxSourceLine, rate: 8 | 16): void {
  if (rate === 16) {
    acc.incomeBase16 += line.taxBase;
    acc.ivaCaused16 += line.taxAmount;
  } else {
    acc.incomeBase8 += line.taxBase;
    acc.ivaCaused8 += line.taxAmount;
  }
  acc.incomeLines.push(line);
}

function addIvaCreditable(acc: TaxPeriodAccumulator, line: TaxSourceLine, rate: 8 | 16): void {
  if (rate === 16) {
    acc.expenseBase16 += line.taxBase;
    acc.ivaCreditable16 += line.taxAmount;
  } else {
    acc.expenseBase8 += line.taxBase;
    acc.ivaCreditable8 += line.taxAmount;
  }
  acc.creditableGross += line.amount;
  acc.expenseLines.push(line);
}

function accumulateIsn(acc: TaxPeriodAccumulator, movement: FinancialMovement): void {
  if (movement.category !== 'PAYROLL' || movement.type !== 'OUTFLOW') return;
  const amount = effectiveAmount(movement);
  acc.payrollBase += amount;
  acc.payrollLines.push(lineForMovement(movement));
}

function accumulateImss(acc: TaxPeriodAccumulator, movement: FinancialMovement): void {
  if (movement.type !== 'OUTFLOW') return;
  if (movement.category === 'TAX') return;
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

interface TaxRateContext {
  overrides: Map<string, 8 | 16>;
  providerRateByKey: Map<string, 8 | 16>;
}

function buildTaxRateContext(store: TaxStore, providers: Provider[]): TaxRateContext {
  const overrides = new Map<string, 8 | 16>();
  for (const override of store.taxRateOverrides) {
    overrides.set(rateOverrideKey(override), override.rate);
  }
  const providerRateByKey = new Map<string, 8 | 16>();
  for (const provider of providers) {
    if (provider.ivaRate !== 8 && provider.ivaRate !== 16) continue;
    if (provider.numProveedorJDE) {
      providerRateByKey.set(rateOverrideKey({
        targetType: 'PROVIDER',
        targetKey: provider.numProveedorJDE,
      }), provider.ivaRate);
    }
    providerRateByKey.set(rateOverrideKey(providerRateTarget(provider.name)), provider.ivaRate);
  }
  return { overrides, providerRateByKey };
}

function resolveTaxRate(
  context: TaxRateContext,
  target: TaxRateTarget,
  catalogRate?: 8 | 16,
): { rate: 8 | 16; source: TaxSourceLine['rateSource'] } {
  const override = overrideRateFor(context, target);
  if (override) return { rate: override, source: 'OVERRIDE' };
  if (catalogRate === 8 || catalogRate === 16) return { rate: catalogRate, source: 'CATALOG' };
  return { rate: REGIMEN_601_IVA_RATE, source: 'DEFAULT' };
}

function overrideRateFor(context: TaxRateContext, target: TaxRateTarget): 8 | 16 | undefined {
  return context.overrides.get(rateOverrideKey(target));
}

function providerCatalogRate(context: TaxRateContext, record: CXPRecord): 8 | 16 | undefined {
  return context.providerRateByKey.get(rateOverrideKey(providerRateTargetFromCxp(record)))
    ?? context.providerRateByKey.get(rateOverrideKey(providerRateTarget(record.nombre)));
}

function providerCatalogRateForTarget(context: TaxRateContext, target: TaxRateTarget): 8 | 16 | undefined {
  return context.providerRateByKey.get(rateOverrideKey(target));
}

function clientRateTarget(client: Client): TaxRateTarget {
  return { targetType: 'CLIENT', targetKey: client.id };
}

function providerRateTarget(value: string): TaxRateTarget {
  return { targetType: 'PROVIDER', targetKey: value };
}

function providerRateTargetFromCxp(record: CXPRecord): TaxRateTarget {
  return providerRateTarget(record.noProveedor?.trim() || record.nombre);
}

function conceptRateTarget(concept: string): TaxRateTarget {
  return { targetType: 'CONCEPT', targetKey: concept };
}

function rateTargetFromMovement(movement: FinancialMovement): TaxRateTarget | undefined {
  if (movement.id.startsWith('budget:')) return conceptRateTarget(movement.concept);
  if (movement.sourceSystem === 'JDE' || movement.category === 'AP_PAYMENT' || movement.counterpartyType === 'SUPPLIER') {
    const key = movement.counterpartyId || movement.counterpartyName;
    return key ? providerRateTarget(key) : undefined;
  }
  if (movement.category === 'OPEX' || movement.category === 'CAPEX') return conceptRateTarget(movement.concept);
  return undefined;
}

function rateOverrideKey(target: TaxRateTarget): string {
  return `${target.targetType}:${normalizeTargetKey(target)}`;
}

function normalizeTargetKey(target: TaxRateTarget): string {
  return target.targetType === 'CLIENT'
    ? target.targetKey.trim()
    : normalizeText(target.targetKey);
}

function cxpTaxBreakdown(record: CXPRecord, overrideRate?: 8 | 16, providerRate?: 8 | 16, matchedPurchase?: PurchaseReceiptRecord): {
  amount: number;
  taxBase: number;
  taxAmount: number;
  taxRate?: 8 | 16;
  rateSource?: TaxSourceLine['rateSource'];
  estimated?: boolean;
} {
  const gross = positiveNumber(record.importeBrutoPesos);
  const pending = positiveNumber(record.importePendientePesos);
  const subtotal = positiveNumber(record.importeSubtotalPesos);
  const tax = positiveNumber(record.importeImpuestosPesos);
  if (pending <= 0) return { amount: 0, taxBase: 0, taxAmount: 0 };

  if (overrideRate) {
    return {
      amount: pending,
      ...grossToIvaBreakdown(pending, overrideRate),
      rateSource: 'OVERRIDE',
      estimated: true,
    };
  }

  if (gross <= 0 || subtotal <= 0 || tax <= 0) {
    if (matchedPurchase?.taxRate === 16 || matchedPurchase?.taxRate === 8) {
      return {
        amount: pending,
        ...grossToIvaBreakdown(pending, matchedPurchase.taxRate),
        rateSource: 'JDE',
        estimated: true,
      };
    }
    const fallbackRate = providerRate ?? REGIMEN_601_IVA_RATE;
    return {
      amount: pending,
      ...grossToIvaBreakdown(pending, fallbackRate),
      rateSource: providerRate ? 'CATALOG' : 'DEFAULT',
      estimated: true,
    };
  }

  const scale = Math.min(1, pending / gross);
  const taxBase = subtotal * scale;
  const taxAmount = tax * scale;
  const taxRate = taxRateFromAmounts(taxBase, taxAmount);
  if (taxRate) return { amount: pending, taxBase, taxAmount, taxRate, rateSource: 'JDE' };
  const fallbackRate = providerRate ?? REGIMEN_601_IVA_RATE;
  return {
    amount: pending,
    ...grossToIvaBreakdown(pending, fallbackRate),
    rateSource: providerRate ? 'CATALOG' : 'DEFAULT',
    estimated: true,
  };
}

function taxRateFromAmounts(base: number, tax: number): 8 | 16 | undefined {
  if (base <= 0 || tax <= 0) return undefined;
  const percent = (tax / base) * 100;
  if (Math.abs(percent - 16) <= 1) return 16;
  if (Math.abs(percent - 8) <= 1) return 8;
  return undefined;
}

function taxRateFromIndicator(value: string, amount: number, taxAmount: number): 8 | 16 | undefined {
  const text = normalizeText(value);
  if (text.includes('IVA16') || text.includes('16')) return 16;
  if (text.includes('IVA8') || text.includes('8')) return 8;
  if (taxAmount > 0) return taxRateFromAmounts(Math.max(0, amount - taxAmount), taxAmount);
  return undefined;
}

function grossToIvaBreakdown(amount: number, rate: 8 | 16): { taxBase: number; taxAmount: number; taxRate: 8 | 16 } {
  const taxBase = amount / (1 + rate / 100);
  return {
    taxBase,
    taxAmount: amount - taxBase,
    taxRate: rate,
  };
}

function movementCreditableIvaBreakdown(movement: FinancialMovement, rateContext: TaxRateContext): {
  amount: number;
  taxBase: number;
  taxAmount: number;
  taxRate: 8 | 16;
  rateTarget?: TaxRateTarget;
  rateSource?: TaxSourceLine['rateSource'];
} | undefined {
  const amount = positiveNumber(effectiveAmount(movement));
  if (amount <= 0) return undefined;
  if (movement.taxTreatment === 'IVA_EXEMPT') return undefined;

  const target = rateTargetFromMovement(movement);
  const overrideRate = target ? overrideRateFor(rateContext, target) : undefined;
  if (overrideRate) {
    return {
      amount,
      ...grossToIvaBreakdown(amount, overrideRate),
      rateTarget: target,
      rateSource: 'OVERRIDE',
    };
  }

  const explicitRate = movement.taxRate === 8 || movement.taxRate === 16 ? movement.taxRate : undefined;
  if (movement.taxTreatment === 'IVA_CREDITABLE' && explicitRate) {
    if (positiveNumber(movement.taxBaseAmount ?? 0) > 0 && positiveNumber(movement.taxAmount ?? 0) > 0) {
      return {
        amount,
        taxBase: movement.taxBaseAmount ?? 0,
        taxAmount: movement.taxAmount ?? 0,
        taxRate: explicitRate,
        rateTarget: target,
        rateSource: 'JDE',
      };
    }
    return { amount, ...grossToIvaBreakdown(amount, explicitRate), rateTarget: target, rateSource: 'JDE' };
  }

  const catalogRate = target?.targetType === 'PROVIDER'
    ? providerCatalogRateForTarget(rateContext, target)
    : undefined;
  if (movement.taxTreatment === 'IVA_CREDITABLE') {
    const rate = catalogRate ?? REGIMEN_601_IVA_RATE;
    return {
      amount,
      ...grossToIvaBreakdown(amount, rate),
      rateTarget: target,
      rateSource: catalogRate ? 'CATALOG' : 'DEFAULT',
    };
  }

  if (!isRegimen601CreditableMovement(movement)) return undefined;
  const rate = catalogRate ?? REGIMEN_601_IVA_RATE;
  return {
    amount,
    ...grossToIvaBreakdown(amount, rate),
    rateTarget: target,
    rateSource: catalogRate ? 'CATALOG' : 'DEFAULT',
  };
}

function isRegimen601CreditableMovement(movement: FinancialMovement): boolean {
  if (!isRegimen601CreditableCategory(movement.category)) return false;
  const text = normalizeText(`${movement.concept} ${movement.counterpartyName ?? ''}`);
  if (
    text.includes('NOMINA')
    || text.includes('SUELDO')
    || text.includes('SALARIO')
    || text.includes('FINIQUITO')
    || text.includes('IMSS')
    || text.includes('INFONAVIT')
    || text.includes('ISR')
    || text.includes('IMPUESTO')
    || text.includes('TESORERIA')
    || text.includes('SAT')
    || text.includes('PRESTAMO')
    || text.includes('CREDITO')
    || text.includes('DEUDA')
    || text.includes('PASIVO')
  ) return false;
  return true;
}

function isRegimen601CreditableCategory(category: FinancialMovement['category']): boolean {
  return category === 'AP_PAYMENT' || category === 'OPEX' || category === 'CAPEX';
}

function budgetCategoryForTax(concept: string): FinancialMovement['category'] {
  const upper = normalizeText(concept);
  if (upper.includes('NOMINA') || upper.includes('SUELDOS') || upper.includes('FINIQUITO')) return 'PAYROLL';
  if (upper.includes('IMPUESTO') || upper.includes('ISR') || upper.includes('IVA') || upper.includes('IMSS')) return 'TAX';
  if (upper.includes('DEUDA') || upper.includes('PRESTAMO') || upper.includes('CREDITO') || upper.includes('PASIVO')) return 'DEBT';
  if (upper.includes('CAPEX') || upper.includes('INVERSION')) return 'CAPEX';
  return 'OPEX';
}

function typicalDayForConcept(concept: string, fallbackIndex: number): number {
  const upper = normalizeText(concept);
  if (upper.includes('NOMINA') || upper.includes('SUELDOS') || upper.includes('FINIQUITO')) return 30;
  if (upper.includes('IMPUESTO') || upper.includes('ISR') || upper.includes('IVA') || upper.includes('IMSS')) return 17;
  if (upper.includes('RENTA') || upper.includes('SEGURO')) return 5;
  const days = [3, 8, 12, 18, 22, 26];
  return days[fallbackIndex % days.length];
}

function dateForDayOfMonth(yearMonth: string, day: number): string {
  const [year, month] = yearMonth.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const safeDay = Math.min(Math.max(1, day), lastDay);
  return `${yearMonth}-${String(safeDay).padStart(2, '0')}`;
}

function markCxpHandled(keys: Set<string>, record: CXPRecord, index: number): void {
  keys.add(`id:cxp:${record.cia}:${record.noProveedor}:${record.noFactura}:${index}`);
  if (record.noFactura) keys.add(`invoice:${normalizeText(record.cia)}:${normalizeText(record.noFactura)}`);
  if (record.noFactura) keys.add(`invoice:any:${normalizeText(record.noFactura)}`);
}

function isHandledCxpMovement(movement: FinancialMovement, keys: Set<string>): boolean {
  if (keys.has(`id:${movement.id}`)) return true;
  if (movement.sourceSystem !== 'JDE') return false;
  const invoice = movement.sourceObjectId ?? parseCxpInvoiceFromMovementId(movement.id);
  if (!invoice) return false;
  const company = movement.companyId ? normalizeText(movement.companyId) : 'any';
  return keys.has(`invoice:${company}:${normalizeText(invoice)}`)
    || keys.has(`invoice:any:${normalizeText(invoice)}`);
}

function parseCxpInvoiceFromMovementId(id: string): string | undefined {
  if (!id.startsWith('cxp:')) return undefined;
  const parts = id.split(':');
  return parts[3] || undefined;
}

function positiveNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function cleanIsoDate(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return isIsoDate(trimmed) ? trimmed : undefined;
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
    taxRateOverrides: Array.isArray(raw.taxRateOverrides)
      ? raw.taxRateOverrides.map(normalizeTaxRateOverride).filter((item): item is TaxRateOverride => item !== null)
      : fallback.taxRateOverrides,
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
    taxRateOverrides: [],
    overdueBalance: 0,
    migratedAt: adjustments.length > 0 || obligations.length > 0 ? new Date().toISOString() : undefined,
  };
}

function normalizeTaxRateOverride(value: unknown): TaxRateOverride | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const targetType = raw.targetType === 'CLIENT' || raw.targetType === 'PROVIDER' || raw.targetType === 'CONCEPT'
    ? raw.targetType
    : null;
  const targetKey = typeof raw.targetKey === 'string' && raw.targetKey.trim() ? raw.targetKey : null;
  const rate = raw.rate === 8 || raw.rate === 16 ? raw.rate : null;
  if (!targetType || !targetKey || !rate) return null;
  return {
    targetType,
    targetKey: normalizeTargetKey({ targetType, targetKey }),
    rate,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
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
