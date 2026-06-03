import type { CXPRecord } from '../../../domain/persistence';
import type { CxpPaymentCoverage, PaymentMatch } from '../../../domain/paymentReconciliationEngine';
import type { AuxiliarReconLine, AuxiliarReconResult } from '../../../domain/auxiliarReconciliationEngine';
import { projectClientMonth } from '../../../domain/collectionEngine';
import type { Budget } from '../../../domain/budget';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import { classifyBankConcept } from '../../../domain/bankConceptClassifier';
import type { AuxiliarContableRecord, BankAccountStatement, CobranzaPayment } from '../../../services/jdeTypes';
import { buildIvaLedgerByPeriod, type IvaLedgerLine, type IvaLedgerPeriod } from '../../../domain/ivaLedger';
import { todayISO } from '../../../formatters';
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
  buildJdeSupplierIndex,
  buildPurchaseReceiptMovements,
  normalizeJde,
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
const ISR_CORPORATE_RATE = 0.30;
const DEFAULT_ISR_PROVISIONAL_COEFFICIENT = 0;
const REGIMEN_601_IVA_RATE = 16;

export type IvaMode = 'REAL' | 'FORECAST' | 'BOTH';

function foldHash(seed: number, value: string | number | undefined | null): number {
  if (value === undefined || value === null) return seed;
  const s = String(value);
  let hash = seed;
  for (let i = 0; i < s.length; i += 1) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

export function auxiliarTaxCoverageFingerprint(result: AuxiliarReconResult | undefined): string {
  if (!result || result.summary.totalLineas === 0) return 'aux:0';
  let hash = result.summary.totalLineas;
  for (const line of result.lines) {
    hash = foldHash(hash, line.cia);
    hash = foldHash(hash, line.flujo);
    hash = foldHash(hash, line.matchTier);
    hash = foldHash(hash, line.source.kind);
    hash = foldHash(hash, line.source.ref);
    hash = foldHash(hash, line.bankDate);
    hash = foldHash(hash, line.fechaContable);
    hash = foldHash(hash, line.bankAmount ?? line.importe);
  }
  return `aux:${result.summary.totalLineas}:${hash}`;
}

export function cxpPaymentCoverageFingerprint(
  coverage: Map<string, CxpPaymentCoverage> | undefined,
): string {
  if (!coverage || coverage.size === 0) return 'cxpCoverage:0';
  let hash = coverage.size;
  for (const [key, value] of coverage) {
    hash = foldHash(hash, key);
    hash = foldHash(hash, value.status);
    hash = foldHash(hash, value.totalPaidPesos);
    for (const payment of value.payments) {
      hash = foldHash(hash, payment.noPago);
      hash = foldHash(hash, payment.fechaPago);
      hash = foldHash(hash, payment.importe);
    }
  }
  return `cxpCoverage:${coverage.size}:${hash}`;
}

export interface TaxStore {
  adjustments: TaxManualAdjustment[];
  obligations: TaxObligation[];
  taxRateOverrides: TaxRateOverride[];
  settings: TaxSettings;
  /** Saldo vencido acumulado de impuestos (no cubierto por los periodos visibles). */
  overdueBalance: number;
  migratedAt?: string;
}

export interface TaxSettings {
  /**
   * Coeficiente de utilidad del ultimo ejercicio fiscal. El ISR provisional de
   * persona moral no se puede inferir de facturas; sin este dato queda en cero
   * y se captura manualmente.
   */
  isrProvisionalCoefficient: number;
  isrRate: number;
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
  paidLines: TaxSourceLine[];
  unclassifiedLines: TaxSourceLine[];
}

export interface IsrPeriodDetail {
  period: string;
  dueDate: string;
  nominalIncome: number;
  coefficient: number;
  rate: number;
  estimatedTaxableProfit: number;
  calculated: number;
  manual: number;
  paid: number;
  payable: number;
  status: TaxStatus;
  paymentPlan: TaxPaymentPlanItem[];
  incomeLines: TaxSourceLine[];
  paidLines: TaxSourceLine[];
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
  /** Vista activa segun `ivaMode`; se conserva para compatibilidad de UI. */
  iva: IvaPeriodDetail;
  /** IVA fiscal declarable: facturas cobradas/pagadas confirmadas. */
  realIva: IvaPeriodDetail;
  /** IVA proyectado/reserva: CXP abiertas, OCs, presupuesto y movimientos estimados. */
  forecastIva: IvaPeriodDetail;
  ivaMode: IvaMode;
  isr: IsrPeriodDetail;
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
    isr: number;
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
  return {
    adjustments: [],
    obligations: [],
    taxRateOverrides: [],
    settings: defaultTaxSettings(),
    overdueBalance: 0,
  };
}

function defaultTaxSettings(): TaxSettings {
  return {
    isrProvisionalCoefficient: DEFAULT_ISR_PROVISIONAL_COEFFICIENT,
    isrRate: ISR_CORPORATE_RATE,
  };
}

function normalizeTaxSettings(value: unknown): TaxSettings {
  if (!value || typeof value !== 'object') return defaultTaxSettings();
  const raw = value as Record<string, unknown>;
  const coefficient = readAmount(raw.isrProvisionalCoefficient);
  const rate = readAmount(raw.isrRate);
  return {
    isrProvisionalCoefficient: Number.isFinite(coefficient)
      ? Math.max(0, Math.min(1, coefficient))
      : DEFAULT_ISR_PROVISIONAL_COEFFICIENT,
    isrRate: Number.isFinite(rate)
      ? Math.max(0, Math.min(1, rate))
      : ISR_CORPORATE_RATE,
  };
}

function isDefaultTaxSettings(settings: TaxSettings | undefined): boolean {
  const normalized = normalizeTaxSettings(settings);
  return normalized.isrProvisionalCoefficient === DEFAULT_ISR_PROVISIONAL_COEFFICIENT
    && normalized.isrRate === ISR_CORPORATE_RATE;
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
      && isDefaultTaxSettings(store.settings)
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
    risk: taxRisk(input.taxType),
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
  cxpPaymentCoverage?: Map<string, CxpPaymentCoverage>;
  paymentMatches?: PaymentMatch[];
  purchaseReceipts?: PurchaseReceiptRecord[];
  /**
   * OCs cuya salida ya cruzó banco vía AuxiliarContable. Evita doble-conteo
   * de IVA acreditable: si la OC pagó en marzo, el IVA se realizó en marzo
   * (real); proyectarlo de nuevo sobreestima la reserva fiscal.
   */
  paidPurchaseOrderKeys?: Set<string>;
  payrollCosts?: PayrollCostRecord[];
  cobranzaPayments?: CobranzaPayment[];
  bankStatements?: BankAccountStatement[];
  /**
   * Nueva conciliacion contable (AuxiliarContable ↔ bancos). No contiene IVA,
   * pero si trae factura, importe y fecha real/contable para fechar el IVA de
   * la factura CXP sin depender del motor viejo PagoProveedor.
   */
  auxiliarReconciliation?: AuxiliarReconResult;
  /**
   * Líneas del libro mayor JDE de las cuentas de IVA (acreditable + causado).
   * Cuando hay cobertura, el IVA REAL se lee DIRECTO del ledger (autoritativo,
   * sin estimar) y los estimadores REAL de causado/acreditable se omiten para
   * no doble-contar. Ver `domain/ivaLedger.ts`.
   */
  auxiliarIvaRecords?: AuxiliarContableRecord[];
  /** REAL = IVA declarable, FORECAST = reserva/proyeccion, BOTH = ambas vistas. */
  ivaMode?: IvaMode;
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
  const realByPeriod = new Map<string, TaxPeriodAccumulator>();
  const forecastByPeriod = new Map<string, TaxPeriodAccumulator>();
  const sharedByPeriod = new Map<string, TaxPeriodAccumulator>();
  const ensureReal = (period: string) => ensureAccumulator(realByPeriod, period);
  const ensureForecast = (period: string) => ensureAccumulator(forecastByPeriod, period);
  const ensureShared = (period: string) => ensureAccumulator(sharedByPeriod, period);
  const rateContext = buildTaxRateContext(params.store, params.providers ?? []);
  const ivaMode = params.ivaMode ?? 'REAL';
  const includeRealIva = ivaMode === 'REAL' || ivaMode === 'BOTH';
  const includeForecastIva = ivaMode === 'FORECAST' || ivaMode === 'BOTH';

  // IVA REAL desde el libro mayor (autoritativo). Cuando hay cobertura, el
  // causado y el acreditable se leen DIRECTO del Auxiliar y los estimadores
  // REAL (cobranza/CXP/OC/Auxiliar direccional) se omiten para no doble-contar.
  const ivaLedgerByPeriod = buildIvaLedgerByPeriod(params.auxiliarIvaRecords ?? [], {
    companyCode: params.companyCode,
    startDate,
    endDate,
  });
  const hasIvaLedger = ivaLedgerByPeriod.size > 0;

  if (includeRealIva) {
    if (hasIvaLedger) {
      accumulateIvaFromLedger({ ledgerByPeriod: ivaLedgerByPeriod, ensure: ensureReal });
    } else {
      accumulateCobranzaPaymentIva({
        payments: params.cobranzaPayments ?? [],
        companyCode: params.companyCode,
        startDate,
        endDate,
        ensure: ensureReal,
      });
    }
    accumulateHistoricIvaPaidFromBankStatements({
      bankStatements: params.bankStatements ?? [],
      companyCode: params.companyCode,
      startDate,
      endDate,
      ensure: ensureReal,
    });
    accumulateHistoricIvaPaidFromMovements({
      movements,
      hasDirectBankStatements: (params.bankStatements ?? []).length > 0,
      startDate,
      endDate,
      ensure: ensureReal,
    });
    accumulateHistoricIsrPaidFromBankStatements({
      bankStatements: params.bankStatements ?? [],
      companyCode: params.companyCode,
      startDate,
      endDate,
      ensure: ensureShared,
    });
    accumulateHistoricIsrPaidFromMovements({
      movements,
      hasDirectBankStatements: (params.bankStatements ?? []).length > 0,
      startDate,
      endDate,
      ensure: ensureShared,
    });
  }

  if (includeForecastIva) {
    accumulateProjectedClientIva({
      clients: params.clients ?? [],
      assumptions: params.assumptions,
      startDate,
      endDate,
      rateContext,
      ensure: ensureForecast,
    });
  }

  const auxiliarCoverage = buildAuxiliarCxpPaymentCoverage(
    params.auxiliarReconciliation,
    params.cxpRecords ?? [],
  );
  const auxiliarPagoCoverage = buildAuxiliarPagoCxpPaymentCoverage(
    params.auxiliarReconciliation,
    params.paymentMatches ?? [],
  );
  const cxpPaymentCoverage = mergeCxpPaymentCoverage(
    params.cxpPaymentCoverage,
    mergeCxpPaymentCoverage(auxiliarCoverage, auxiliarPagoCoverage),
  );

  // Estimadores REAL de IVA acreditable — SOLO cuando NO hay libro mayor de IVA.
  // Con ledger, el acreditable es autoritativo y estos doble-contarían.
  if (includeRealIva && !hasIvaLedger) {
    accumulateCxpIva({
      cxpRecords: params.cxpRecords ?? [],
      cxpPaymentCoverage,
      purchaseReceipts: params.purchaseReceipts ?? [],
      companyCode: params.companyCode,
      startDate,
      endDate,
      rateContext,
      ensure: ensureReal,
      includePaidCoverage: true,
      includeOpenCxp: false,
      includeProjectedRemainder: false,
      allowEstimatedBreakdown: false,
    });
    accumulatePaidPurchaseReceiptIvaFromAuxiliar({
      purchaseReceipts: params.purchaseReceipts ?? [],
      auxiliarReconciliation: params.auxiliarReconciliation,
      cxpRecords: params.cxpRecords ?? [],
      cxpPaymentCoverage,
      paymentMatches: params.paymentMatches ?? [],
      companyCode: params.companyCode,
      startDate,
      endDate,
      ensure: ensureReal,
    });
    accumulateDirectionalAuxiliarIvaEstimate({
      auxiliarReconciliation: params.auxiliarReconciliation,
      cxpRecords: params.cxpRecords ?? [],
      purchaseReceipts: params.purchaseReceipts ?? [],
      cobranzaPayments: params.cobranzaPayments ?? [],
      companyCode: params.companyCode,
      startDate,
      endDate,
      rateContext,
      ensure: ensureReal,
    });
  }

  const handledForecastCxpKeys = includeForecastIva
    ? accumulateCxpIva({
      cxpRecords: params.cxpRecords ?? [],
      cxpPaymentCoverage,
      purchaseReceipts: params.purchaseReceipts ?? [],
      companyCode: params.companyCode,
      startDate,
      endDate,
      rateContext,
      ensure: ensureForecast,
      includePaidCoverage: false,
      includeOpenCxp: true,
      includeProjectedRemainder: true,
      allowEstimatedBreakdown: false,
    })
    : new Set<string>();

  const handledPurchaseMovementIds = includeForecastIva
    ? accumulatePurchaseReceiptIva({
      purchaseReceipts: params.purchaseReceipts ?? [],
      cxpRecords: params.cxpRecords ?? [],
      paidPurchaseOrderKeys: params.paidPurchaseOrderKeys,
      companyCode: params.companyCode,
      startDate,
      endDate,
      asOfDate: params.today,
      ensure: ensureForecast,
    })
    : new Set<string>();

  if (includeForecastIva) {
    accumulateMovementIvaFallback({
      movements,
      startDate,
      endDate,
      handledCxpKeys: handledForecastCxpKeys,
      handledMovementIds: handledPurchaseMovementIds,
      rateContext,
      ensure: ensureForecast,
    });

    accumulateBudgetIvaComplement({
      budget: params.budget ?? null,
      startDate,
      endDate,
      rateContext,
      ensure: ensureForecast,
    });
  }

  for (const movement of movements) {
    const date = effectiveMovementDate(movement);
    if (date < startDate || date > endDate) continue;
    const period = date.slice(0, 7);
    const row = ensureShared(period);
    accumulateIsn(row, movement);
    accumulateImss(row, movement);
  }

  const activeIvaEnsure = ivaMode === 'FORECAST' ? ensureForecast : ensureReal;

  for (const adjustment of params.store.adjustments) {
    const row = adjustment.taxType === 'IVA'
      ? activeIvaEnsure(adjustment.period)
      : ensureShared(adjustment.period);
    if (adjustment.kind === 'IVA_CAUSED') row.manualIvaCaused += adjustment.amount;
    if (adjustment.kind === 'IVA_CREDITABLE') row.manualIvaCreditable += adjustment.amount;
    if (adjustment.kind === 'IVA_PAID') row.ivaPaid += adjustment.amount;
    if (adjustment.kind === 'IVA_PAYABLE') row.manualIvaPayable += adjustment.amount;
    if (adjustment.kind === 'ISR_MANUAL') row.manualIsr += adjustment.amount;
    if (adjustment.kind === 'ISR_PAID') row.isrPaid += adjustment.amount;
    if (adjustment.kind === 'ISN_OVERRIDE') row.isnOverride = adjustment.amount;
    if (adjustment.kind === 'IMSS_MANUAL') row.imssManual += adjustment.amount;
  }

  for (const obligation of params.store.obligations) {
    const row = ensureShared(obligation.period);
    row.manualObligations.push(obligation);
  }

  const periodKeys = new Set<string>();
  const collectKeys = (map: Map<string, TaxPeriodAccumulator>) => {
    for (const key of map.keys()) periodKeys.add(key);
  };
  if (ivaMode !== 'FORECAST') collectKeys(realByPeriod);
  if (ivaMode !== 'REAL') collectKeys(forecastByPeriod);
  collectKeys(sharedByPeriod);

  const periods = Array.from(periodKeys)
    .sort((a, b) => a.localeCompare(b))
    .map((period) => finalizeTaxPeriod({
      period,
      activeIva: ivaMode === 'FORECAST'
        ? accumulatorFor(forecastByPeriod, period)
        : accumulatorFor(realByPeriod, period),
      realIva: accumulatorFor(realByPeriod, period),
      forecastIva: accumulatorFor(forecastByPeriod, period),
      shared: accumulatorFor(sharedByPeriod, period),
      ivaMode,
      store: params.store,
      today: params.today,
    }));

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
    isr: sum.isr + period.isr.payable,
    imss: sum.imss + period.imss,
    total: sum.total + period.total,
    totalWithOverdue: sum.totalWithOverdue + period.total,
    cashImpact: sum.cashImpact + period.cashImpact,
    unclassified: sum.unclassified + period.iva.unclassifiedIncome + period.iva.unclassifiedExpense,
    grossIncome: sum.grossIncome + period.iva.incomeBase16 + period.iva.incomeBase8,
  }), {
    ivaNet: 0,
    isn: 0,
    isr: 0,
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
  paidLines: TaxSourceLine[];
  unclassifiedLines: TaxSourceLine[];
  payrollBase: number;
  payrollLines: TaxSourceLine[];
  isnOverride?: number;
  imssDetected: number;
  imssManual: number;
  imssLines: TaxSourceLine[];
  manualIsr: number;
  isrPaid: number;
  manualObligations: TaxObligation[];
}

function ensureAccumulator(map: Map<string, TaxPeriodAccumulator>, period: string): TaxPeriodAccumulator {
  const current = map.get(period);
  if (current) return current;
  const next = createEmptyAccumulator(period);
  map.set(period, next);
  return next;
}

function accumulatorFor(map: Map<string, TaxPeriodAccumulator>, period: string): TaxPeriodAccumulator {
  return map.get(period) ?? createEmptyAccumulator(period);
}

function createEmptyAccumulator(period: string): TaxPeriodAccumulator {
  return {
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
    paidLines: [],
    unclassifiedLines: [],
    payrollBase: 0,
    payrollLines: [],
    imssDetected: 0,
    imssManual: 0,
    imssLines: [],
    manualIsr: 0,
    isrPaid: 0,
    manualObligations: [],
  };
}

function buildAuxiliarCxpPaymentCoverage(
  result: AuxiliarReconResult | undefined,
  cxpRecords: CXPRecord[],
): Map<string, CxpPaymentCoverage> {
  const out = new Map<string, CxpPaymentCoverage>();
  if (!result || result.summary.totalLineas === 0 || cxpRecords.length === 0) return out;

  const cxpByFactura = new Map<string, CXPRecord[]>();
  for (const cxp of cxpRecords) {
    if (!cxp.noFactura) continue;
    const key = `${cxp.cia}::${normalizeText(cxp.noFactura)}`;
    const bucket = cxpByFactura.get(key);
    if (bucket) bucket.push(cxp);
    else cxpByFactura.set(key, [cxp]);
  }

  const addPayment = (
    cxp: CXPRecord,
    amount: number,
    date: string,
    noPago: string,
    tier: CxpPaymentCoverage['payments'][number]['tier'],
  ) => {
    if (amount <= 0 || !date) return;
    const key = cxpCoverageKey(cxp);
    const existing = out.get(key);
    const payment = { noPago, fechaPago: date, importe: amount, tier };
    if (existing) {
      if (existing.payments.some((item) => paymentCoverageDedupeKey(item) === paymentCoverageDedupeKey(payment))) return;
      existing.totalPaidPesos += amount;
      existing.payments.push(payment);
      existing.status = cxpCoverageStatus(existing.totalPaidPesos, cxp.importeBrutoPesos);
    } else {
      out.set(key, {
        cxpKey: key,
        status: cxpCoverageStatus(amount, cxp.importeBrutoPesos),
        totalPaidPesos: amount,
        payments: [payment],
      });
    }
  };

  for (const line of result.lines) {
    if (!isConfirmedAuxiliarLine(line)) continue;
    if (line.flujo !== 'egreso' || line.source.kind !== 'factura') continue;
    const candidates = cxpByFactura.get(`${line.cia}::${normalizeText(line.source.ref)}`) ?? [];
    const cxp = pickCxpForAuxiliarLine(candidates, line);
    if (!cxp) continue;

    const amount = positiveNumber(Math.abs(line.bankAmount ?? line.importe));
    const date = cleanIsoDate(line.bankDate) ?? cleanIsoDate(line.fechaContable);
    if (amount <= 0 || !date) continue;

    addPayment(cxp, amount, date, `Auxiliar ${line.tipoDocto || 'GL'} ${line.fechaContable || date}`, 'folio-exact');
  }

  for (const [sourceKey, confirmation] of result.sourceConfirmation) {
    if (!confirmation.confirmed || confirmation.flujo !== 'egreso') continue;
    if (!sourceKey.startsWith('factura:')) continue;
    const [, payload] = sourceKey.split('factura:');
    const [cia, ref] = payload.split('::');
    if (!cia || !ref) continue;
    const candidates = cxpByFactura.get(`${cia}::${normalizeText(ref)}`) ?? [];
    if (candidates.length !== 1) continue;
    const date = cleanIsoDate(confirmation.bankDate) ?? cleanIsoDate(confirmation.fechaContable);
    const amount = positiveNumber(Math.abs(confirmation.importe));
    if (!date || amount <= 0) continue;
    addPayment(candidates[0], amount, date, `Auxiliar factura ${ref}`, 'folio-exact');
    }

  return out;
}

function buildAuxiliarPagoCxpPaymentCoverage(
  result: AuxiliarReconResult | undefined,
  paymentMatches: PaymentMatch[],
): Map<string, CxpPaymentCoverage> {
  const out = new Map<string, CxpPaymentCoverage>();
  if (!result || result.summary.totalLineas === 0 || paymentMatches.length === 0) return out;

  const matchesByPaymentKey = buildPaymentMatchIndex(paymentMatches);
  for (const line of result.lines) {
    if (!isConfirmedAuxiliarLine(line)) continue;
    if (line.flujo !== 'egreso' || line.source.kind !== 'pago') continue;
    const match = findPaymentMatchForAuxiliarLine(line, matchesByPaymentKey);
    if (!match || match.cxpMatches.length === 0) continue;

    const amount = positiveNumber(Math.abs(line.bankAmount ?? line.importe));
    const date = cleanIsoDate(line.bankDate) ?? cleanIsoDate(line.fechaContable) ?? cleanIsoDate(match.payment.fechaPago);
    if (amount <= 0 || !date) continue;

    const totalMatchedGross = match.cxpMatches.reduce((sum, hit) => (
      sum + positiveNumber(hit.cxp.importeBrutoPesos || hit.cxp.importePendientePesos)
    ), 0);
    const paymentGross = positiveNumber(match.payment.importePesos) || amount || totalMatchedGross;

    for (const hit of match.cxpMatches) {
      const cxpGross = positiveNumber(hit.cxp.importeBrutoPesos || hit.cxp.importePendientePesos);
      const allocated = allocatePaymentAmount({
        lineAmount: amount,
        paymentAmount: paymentGross,
        cxpAmount: cxpGross,
        totalMatchedAmount: totalMatchedGross,
      });
      if (allocated <= 0) continue;

      const key = cxpCoverageKey(hit.cxp);
      const payment = {
        noPago: paymentLabel(match.payment, line),
        fechaPago: date,
        importe: allocated,
        tier: hit.tier,
      };
      const existing = out.get(key);
      if (existing) {
        existing.totalPaidPesos += allocated;
        existing.payments.push(payment);
        existing.status = cxpCoverageStatus(existing.totalPaidPesos, hit.cxp.importeBrutoPesos);
      } else {
        out.set(key, {
          cxpKey: key,
          status: cxpCoverageStatus(allocated, hit.cxp.importeBrutoPesos),
          totalPaidPesos: allocated,
          payments: [payment],
        });
      }
    }
  }

  return out;
}

function mergeCxpPaymentCoverage(
  primary: Map<string, CxpPaymentCoverage> | undefined,
  secondary: Map<string, CxpPaymentCoverage> | undefined,
): Map<string, CxpPaymentCoverage> | undefined {
  if ((!primary || primary.size === 0) && (!secondary || secondary.size === 0)) return undefined;
  const out = new Map<string, CxpPaymentCoverage>();

  const add = (coverage: CxpPaymentCoverage) => {
    const current = out.get(coverage.cxpKey);
    if (!current) {
      out.set(coverage.cxpKey, {
        ...coverage,
        payments: [...coverage.payments],
      });
      return;
    }

    const seen = new Set(current.payments.map(paymentCoverageDedupeKey));
    for (const payment of coverage.payments) {
      const key = paymentCoverageDedupeKey(payment);
      if (seen.has(key)) continue;
      current.payments.push(payment);
      seen.add(key);
    }
    current.totalPaidPesos = current.payments.reduce((sum, payment) => sum + positiveNumber(payment.importe), 0);
    current.status = strongestCoverageStatus(current.status, coverage.status);
  };

  for (const coverage of primary?.values() ?? []) add(coverage);
  for (const coverage of secondary?.values() ?? []) add(coverage);
  return out;
}

function paymentCoverageDedupeKey(payment: CxpPaymentCoverage['payments'][number]): string {
  return `${payment.noPago}::${payment.fechaPago}::${Math.round(payment.importe * 100)}::${payment.tier}`;
}

function strongestCoverageStatus(
  left: CxpPaymentCoverage['status'],
  right: CxpPaymentCoverage['status'],
): CxpPaymentCoverage['status'] {
  if (left === 'PAID' || right === 'PAID') return 'PAID';
  if (left === 'PARTIAL' || right === 'PARTIAL') return 'PARTIAL';
  return 'OPEN';
}

function buildPaymentMatchIndex(paymentMatches: PaymentMatch[]): Map<string, PaymentMatch> {
  const out = new Map<string, PaymentMatch>();
  for (const match of paymentMatches) {
    for (const key of paymentLookupKeys(match.payment.cia, match.payment.tipoPago, match.payment.noPago)) {
      if (!out.has(key)) out.set(key, match);
    }
  }
  return out;
}

function findPaymentMatchForAuxiliarLine(
  line: AuxiliarReconLine,
  matchesByPaymentKey: Map<string, PaymentMatch>,
): PaymentMatch | undefined {
  const ref = normalizePaymentRef(line.source.ref);
  if (!ref) return undefined;
  const candidates = [
    paymentLookupKey(line.cia, ref),
    paymentLookupKey(line.source.cia, ref),
  ];
  for (const key of candidates) {
    const match = matchesByPaymentKey.get(key);
    if (match) return match;
  }
  return undefined;
}

function paymentLookupKeys(cia: string, tipoPago: string, noPago: string): string[] {
  const keys = new Set<string>();
  const normalizedTipo = normalizePaymentRef(tipoPago);
  const normalizedNoPago = normalizePaymentRef(noPago);
  if (normalizedNoPago) keys.add(paymentLookupKey(cia, normalizedNoPago));
  if (normalizedTipo && normalizedNoPago) keys.add(paymentLookupKey(cia, `${normalizedTipo}${normalizedNoPago}`));
  return [...keys];
}

function paymentLookupKey(cia: string, ref: string): string {
  return `${cia}::${normalizePaymentRef(ref)}`;
}

function normalizePaymentRef(value: string | undefined): string {
  return normalizeText(value ?? '').replace(/[^A-Z0-9]/g, '');
}

function paymentLabel(payment: PaymentMatch['payment'], line: AuxiliarReconLine): string {
  const ref = payment.tipoPago || payment.noPago
    ? `${payment.tipoPago}${payment.noPago}`.trim()
    : line.source.ref;
  return ref || `Auxiliar ${line.tipoDocto || 'pago'}`;
}

function allocatePaymentAmount({
  lineAmount,
  paymentAmount,
  cxpAmount,
  totalMatchedAmount,
}: {
  lineAmount: number;
  paymentAmount: number;
  cxpAmount: number;
  totalMatchedAmount: number;
}): number {
  if (lineAmount <= 0) return 0;
  if (totalMatchedAmount > 0 && cxpAmount > 0) {
    return Math.min(cxpAmount, lineAmount * (cxpAmount / totalMatchedAmount));
  }
  if (paymentAmount > 0 && cxpAmount > 0) {
    return Math.min(cxpAmount, lineAmount * Math.min(1, cxpAmount / paymentAmount));
  }
  return lineAmount;
}

function findPurchaseReceiptForPayment(
  payment: PaymentMatch['payment'],
  purchaseReceipts: PurchaseReceiptRecord[],
  companyCode?: string,
): PurchaseReceiptRecord | undefined {
  const amount = positiveNumber(payment.importePesos);
  const comment = normalizePaymentSearchText(payment.comentarioPago);
  const candidates = purchaseReceipts.filter((receipt) => {
    if (companyCode && companyCode !== 'all' && receipt.cia !== companyCode) return false;
    if (payment.cia && receipt.cia !== payment.cia) return false;
    if (receipt.isCancelled || receipt.amountMxn <= 0) return false;
    if (normalizeJde(receipt.noProveedor) !== normalizeJde(payment.claveProveedor)) return false;
    return true;
  });
  if (candidates.length === 0) return undefined;

  const commentMatches = candidates.filter((receipt) => {
    if (!comment) return false;
    return receiptRefsForSearch(receipt).some((ref) => ref && comment.includes(ref));
  });
  if (commentMatches.length === 1) return commentMatches[0];
  const exactCommentAmountMatches = commentMatches.filter((receipt) => amountsClose(receipt.amountMxn, amount));
  if (exactCommentAmountMatches.length === 1) return exactCommentAmountMatches[0];

  const exactAmountMatches = candidates.filter((receipt) => amountsClose(receipt.amountMxn, amount));
  if (exactAmountMatches.length === 1) return exactAmountMatches[0];
  return undefined;
}

function receiptRefsForSearch(receipt: PurchaseReceiptRecord): string[] {
  return [
    receipt.invoiceNo,
    receipt.purchaseOrderNo,
    receipt.receiptNo,
  ].map(normalizePaymentSearchText).filter(Boolean);
}

function normalizePaymentSearchText(value: string | undefined): string {
  return normalizeText(value ?? '').replace(/[^A-Z0-9]/g, '');
}

function amountsClose(left: number, right: number): boolean {
  if (left <= 0 || right <= 0) return false;
  return Math.abs(left - right) <= Math.max(1, Math.min(left, right) * 0.005);
}

function purchaseReceiptTaxDedupeKey(receipt: PurchaseReceiptRecord): string {
  return `${receipt.cia}::${receipt.purchaseOrderNo || 'no-oc'}::${receipt.invoiceNo || receipt.receiptNo || 'no-doc'}::${receipt.noProveedor}`;
}

function isConfirmedAuxiliarLine(line: AuxiliarReconLine): boolean {
  return line.matchTier === 'jde-reconciled'
    || line.matchTier === 'exact'
    || line.matchTier === 'tolerance';
}

function pickCxpForAuxiliarLine(candidates: CXPRecord[], line: AuxiliarReconLine): CXPRecord | undefined {
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return undefined;
  const counterpart = normalizeText(line.source.contraparte ?? '');
  if (!counterpart) return undefined;
  return candidates.find((cxp) => {
    const name = normalizeText(cxp.nombre);
    return name.includes(counterpart) || counterpart.includes(name);
  });
}

function cxpCoverageStatus(totalPaid: number, grossAmount: number): CxpPaymentCoverage['status'] {
  const gross = positiveNumber(grossAmount);
  if (gross > 0 && totalPaid >= gross - 1) return 'PAID';
  if (totalPaid > 0) return 'PARTIAL';
  return 'OPEN';
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
      const resolved = taxRate === 16 || taxRate === 8 ? taxRate : undefined;
      const taxBase = Math.max(0, amount - taxAmount);
      const line: TaxSourceLine = {
        movementId: `cxc-payment:${payment.cia}:${payment.idPago}:${app.noFacturaNormalizada}`,
        date,
        concept: `Cobro ${payment.idPago} · Factura ${app.noFactura || 's/n'}`,
        counterpartyName: app.cliente || payment.cliente,
        amount,
        taxBase,
        taxRate: resolved,
        taxAmount,
        sourceSystem: 'JDE',
        rateSource: 'JDE',
      };
      const row = ensure(date.slice(0, 7));
      if (resolved) {
        addIvaCaused(row, line, resolved);
      } else if (taxAmount > 0) {
        // Cobro CON IVA pero tasa no resoluble (indicador raro o ratio fuera de 8|16):
        // no se descarta — va a no clasificado para auditoría, no se pierde del neto.
        row.unclassifiedIncome += amount;
        row.unclassifiedLines.push(line);
      } else {
        // Sin IVA (exento / tasa 0) → se ignora, como antes.
        continue;
      }
      periods.add(date.slice(0, 7));
    }
  }
  return periods;
}

function accumulateHistoricIvaPaidFromBankStatements({
  bankStatements,
  companyCode,
  startDate,
  endDate,
  ensure,
}: {
  bankStatements: BankAccountStatement[];
  companyCode?: string;
  startDate: string;
  endDate: string;
  ensure: (period: string) => TaxPeriodAccumulator;
}): void {
  for (const statement of bankStatements) {
    if (companyCode && companyCode !== 'all' && statement.cia !== companyCode) continue;
    for (const movement of statement.movimientos) {
      if (movement.tipoMovimiento !== 'CARGO') continue;
      const date = cleanIsoDate(movement.fechaOperacion);
      if (!date || date < startDate || date > endDate) continue;
      const classification = classifyBankConcept({
        concepto: movement.concepto,
        infAdi1: movement.infAdi1,
        infAdi2: movement.infAdi2,
        infAdi3: movement.infAdi3,
      });
      if (classification.category !== 'TAX' || classification.subcategory !== 'IVA') continue;
      const amount = positiveNumber(movement.importe);
      if (amount <= 0) continue;
      const acc = ensure(date.slice(0, 7));
      const concept = movement.concepto || movement.referencia || 'Movimiento bancario';
      acc.ivaPaid += amount;
      acc.paidLines.push({
        movementId: `bank-iva-paid:${movement.cia}:${movement.banco}:${movement.cuenta}:${movement.fechaOperacion}:${movement.referencia}:${movement.gsaid ?? ''}`,
        date,
        concept: `Pago IVA · ${concept}`,
        counterpartyName: classification.counterpartyName,
        amount,
        taxBase: 0,
        taxAmount: amount,
        sourceSystem: 'BANK',
        estimated: false,
      });
    }
  }
}

function accumulateHistoricIvaPaidFromMovements({
  movements,
  hasDirectBankStatements,
  startDate,
  endDate,
  ensure,
}: {
  movements: FinancialMovement[];
  hasDirectBankStatements: boolean;
  startDate: string;
  endDate: string;
  ensure: (period: string) => TaxPeriodAccumulator;
}): void {
  for (const movement of movements) {
    if (movement.type !== 'OUTFLOW') continue;
    if (movement.category !== 'TAX' || movement.subcategory !== 'IVA') continue;
    if (hasDirectBankStatements && movement.sourceSystem === 'BANK') continue;
    if (movement.status !== 'REAL' && movement.status !== 'EXECUTED') continue;
    const date = cleanIsoDate(effectiveMovementDate(movement));
    if (!date || date < startDate || date > endDate) continue;
    const amount = positiveNumber(effectiveAmount(movement));
    if (amount <= 0) continue;
    const acc = ensure(date.slice(0, 7));
    acc.ivaPaid += amount;
    acc.paidLines.push({
      movementId: `movement-iva-paid:${movement.id}`,
      date,
      concept: `Pago IVA · ${movement.concept || movement.counterpartyName || 'Movimiento fiscal'}`,
      counterpartyName: movement.counterpartyName ?? 'SAT — IVA',
      amount,
      taxBase: 0,
      taxAmount: amount,
      sourceSystem: movement.sourceSystem,
      estimated: false,
    });
  }
}

function accumulateHistoricIsrPaidFromBankStatements({
  bankStatements,
  companyCode,
  startDate,
  endDate,
  ensure,
}: {
  bankStatements: BankAccountStatement[];
  companyCode?: string;
  startDate: string;
  endDate: string;
  ensure: (period: string) => TaxPeriodAccumulator;
}): void {
  for (const statement of bankStatements) {
    if (companyCode && companyCode !== 'all' && statement.cia !== companyCode) continue;
    for (const movement of statement.movimientos) {
      if (movement.tipoMovimiento !== 'CARGO') continue;
      const date = cleanIsoDate(movement.fechaOperacion);
      if (!date || date < startDate || date > endDate) continue;
      const classification = classifyBankConcept({
        concepto: movement.concepto,
        infAdi1: movement.infAdi1,
        infAdi2: movement.infAdi2,
        infAdi3: movement.infAdi3,
      });
      if (classification.category !== 'TAX' || classification.subcategory !== 'ISR') continue;
      const amount = positiveNumber(movement.importe);
      if (amount <= 0) continue;
      const acc = ensure(date.slice(0, 7));
      const concept = movement.concepto || movement.referencia || 'Movimiento bancario';
      acc.isrPaid += amount;
      acc.paidLines.push({
        movementId: `bank-isr-paid:${movement.cia}:${movement.banco}:${movement.cuenta}:${movement.fechaOperacion}:${movement.referencia}:${movement.gsaid ?? ''}`,
        date,
        concept: `Pago ISR · ${concept}`,
        counterpartyName: classification.counterpartyName,
        amount,
        taxBase: 0,
        taxAmount: amount,
        sourceSystem: 'BANK',
        estimated: false,
      });
    }
  }
}

function accumulateHistoricIsrPaidFromMovements({
  movements,
  hasDirectBankStatements,
  startDate,
  endDate,
  ensure,
}: {
  movements: FinancialMovement[];
  hasDirectBankStatements: boolean;
  startDate: string;
  endDate: string;
  ensure: (period: string) => TaxPeriodAccumulator;
}): void {
  for (const movement of movements) {
    if (movement.type !== 'OUTFLOW') continue;
    if (movement.category !== 'TAX' || movement.subcategory !== 'ISR') continue;
    if (hasDirectBankStatements && movement.sourceSystem === 'BANK') continue;
    if (movement.status !== 'REAL' && movement.status !== 'EXECUTED') continue;
    const date = cleanIsoDate(effectiveMovementDate(movement));
    if (!date || date < startDate || date > endDate) continue;
    const amount = positiveNumber(effectiveAmount(movement));
    if (amount <= 0) continue;
    const acc = ensure(date.slice(0, 7));
    acc.isrPaid += amount;
    acc.paidLines.push({
      movementId: `movement-isr-paid:${movement.id}`,
      date,
      concept: `Pago ISR · ${movement.concept || movement.counterpartyName || 'Movimiento fiscal'}`,
      counterpartyName: movement.counterpartyName ?? 'SAT — ISR',
      amount,
      taxBase: 0,
      taxAmount: amount,
      sourceSystem: movement.sourceSystem,
      estimated: false,
    });
  }
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
  cxpPaymentCoverage,
  purchaseReceipts,
  companyCode,
  startDate,
  endDate,
  rateContext,
  ensure,
  includePaidCoverage,
  includeOpenCxp,
  includeProjectedRemainder,
  allowEstimatedBreakdown,
}: {
  cxpRecords: CXPRecord[];
  cxpPaymentCoverage?: Map<string, CxpPaymentCoverage>;
  purchaseReceipts: PurchaseReceiptRecord[];
  companyCode?: string;
  startDate: string;
  endDate: string;
  rateContext: TaxRateContext;
  ensure: (period: string) => TaxPeriodAccumulator;
  includePaidCoverage: boolean;
  includeOpenCxp: boolean;
  includeProjectedRemainder: boolean;
  allowEstimatedBreakdown: boolean;
}): Set<string> {
  const handledKeys = new Set<string>();
  const purchaseBySupplier = buildJdeSupplierIndex(purchaseReceipts);
  cxpRecords.forEach((record, index) => {
    if (companyCode && companyCode !== 'all' && record.cia !== companyCode) return;
    const date = cleanIsoDate(record.fechaProgramacionPago)
      ?? cleanIsoDate(record.fechaVence)
      ?? cleanIsoDate(record.fechaFactura);
    if (!date) return;

    const target = providerRateTargetFromCxp(record);
    const providerRate = providerCatalogRate(rateContext, record);
    const overrideRate = overrideRateFor(rateContext, target);
    const matchedPurchase = purchaseBySupplier
      .get(normalizeJde(record.noProveedor))
      ?.find((receipt) => purchaseMatchesCxp(receipt, record));
    const coverage = cxpPaymentCoverage?.get(cxpCoverageKey(record));

    if (coverage && coverage.payments.length > 0) {
      const grossAmount = positiveNumber(record.importeBrutoPesos)
        || positiveNumber(record.importePendientePesos)
        || positiveNumber(coverage.totalPaidPesos);
      let allocatedPaid = 0;
      let emitted = false;

      for (const [paymentIndex, payment] of coverage.payments.entries()) {
        const remainingCapacity = Math.max(0, grossAmount - allocatedPaid);
        const paymentAmount = positiveNumber(payment.importe);
        const paidAmount = grossAmount > 0
          ? Math.min(paymentAmount, remainingCapacity)
          : paymentAmount;
        if (paidAmount <= 0) continue;
        allocatedPaid += paidAmount;
        if (!includePaidCoverage) continue;
        const paymentDate = cleanIsoDate(payment.fechaPago) ?? date;
        emitted = addCxpIvaLine({
          record,
          index,
          date: paymentDate,
          amount: paidAmount,
          conceptPrefix: `Pago ${payment.noPago || paymentIndex + 1}`,
          target,
          overrideRate: overrideRate ?? undefined,
          providerRate,
          matchedPurchase,
          startDate,
          endDate,
          ensure,
          allowEstimatedBreakdown,
        }) || emitted;
      }

      const remaining = Math.max(0, grossAmount - allocatedPaid);
      if (includeProjectedRemainder && coverage.status === 'PARTIAL' && remaining > 0) {
        emitted = addCxpIvaLine({
          record,
          index,
          date,
          amount: remaining,
          conceptPrefix: 'Remanente proyectado',
          target,
          overrideRate: overrideRate ?? undefined,
          providerRate,
          matchedPurchase,
          startDate,
          endDate,
          ensure,
          allowEstimatedBreakdown,
        }) || emitted;
      }

      if (emitted || coverage.status === 'PAID' || coverage.status === 'PARTIAL') {
        markCxpHandled(handledKeys, record, index);
      }
      return;
    }

    if (!includeOpenCxp) return;
    if (date < startDate || date > endDate) return;
    const breakdown = cxpTaxBreakdown(record, overrideRate ?? undefined, providerRate, matchedPurchase, undefined, {
      allowEstimated: allowEstimatedBreakdown,
    });
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
      rateSource: breakdown.rateSource,
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

function addCxpIvaLine({
  record,
  index,
  date,
  amount,
  conceptPrefix,
  target,
  overrideRate,
  providerRate,
  matchedPurchase,
  startDate,
  endDate,
  ensure,
  allowEstimatedBreakdown,
}: {
  record: CXPRecord;
  index: number;
  date: string;
  amount: number;
  conceptPrefix: string;
  target: TaxRateTarget;
  overrideRate?: 8 | 16;
  providerRate?: 8 | 16;
  matchedPurchase?: PurchaseReceiptRecord;
  startDate: string;
  endDate: string;
  ensure: (period: string) => TaxPeriodAccumulator;
  allowEstimatedBreakdown: boolean;
}): boolean {
  const breakdown = cxpTaxBreakdown(record, overrideRate, providerRate, matchedPurchase, amount, {
    allowEstimated: allowEstimatedBreakdown,
  });
  if (breakdown.amount <= 0) return false;
  if (date < startDate || date > endDate) return true;

  const line: TaxSourceLine = {
    movementId: `cxp:${record.cia}:${record.noProveedor}:${record.noFactura}:${index}:${conceptPrefix}`,
    date,
    concept: `${conceptPrefix} · Factura ${record.noFactura || 'sin folio'} · ${record.nombre}`,
    counterpartyName: record.nombre,
    amount: breakdown.amount,
    taxBase: breakdown.taxBase,
    taxRate: breakdown.taxRate,
    taxAmount: breakdown.taxAmount,
    sourceSystem: 'JDE',
    rateTarget: target,
    rateSource: breakdown.rateSource,
    estimated: breakdown.estimated,
  };
  const row = ensure(date.slice(0, 7));
  if (breakdown.taxRate === 16 || breakdown.taxRate === 8) addIvaCreditable(row, line, breakdown.taxRate);
  else {
    row.unclassifiedExpense += breakdown.amount;
    row.unclassifiedLines.push(line);
  }
  return true;
}

function accumulatePurchaseReceiptIva({
  purchaseReceipts,
  cxpRecords,
  paidPurchaseOrderKeys,
  companyCode,
  startDate,
  endDate,
  asOfDate,
  ensure,
}: {
  purchaseReceipts: PurchaseReceiptRecord[];
  cxpRecords: CXPRecord[];
  paidPurchaseOrderKeys?: Set<string>;
  companyCode?: string;
  startDate: string;
  endDate: string;
  asOfDate: string;
  ensure: (period: string) => TaxPeriodAccumulator;
}): Set<string> {
  const handledMovementIds = new Set<string>();
  // OCs ya pagadas (per AuxiliarContable) realizaron su IVA acreditable en el
  // período del cargo real. Excluirlas evita sobre-estimar la reserva fiscal
  // futura. Mismo set que canonicalProjection consume — wiring viene desde
  // BuildScenarioForecastRunArgs → buildTaxDashboardView.
  const movements = buildPurchaseReceiptMovements({
    purchaseReceipts,
    cxpRecords,
    paidPurchaseOrderKeys,
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

function accumulatePaidPurchaseReceiptIvaFromAuxiliar({
  purchaseReceipts,
  auxiliarReconciliation,
  cxpRecords,
  cxpPaymentCoverage,
  paymentMatches,
  companyCode,
  startDate,
  endDate,
  ensure,
}: {
  purchaseReceipts: PurchaseReceiptRecord[];
  auxiliarReconciliation?: AuxiliarReconResult;
  cxpRecords: CXPRecord[];
  cxpPaymentCoverage?: Map<string, CxpPaymentCoverage>;
  paymentMatches: PaymentMatch[];
  companyCode?: string;
  startDate: string;
  endDate: string;
  ensure: (period: string) => TaxPeriodAccumulator;
}): void {
  if (!auxiliarReconciliation) return;

  const paidOcDateByKey = new Map<string, string>();
  const paidReceiptDateByKey = new Map<string, string>();
  const paymentMatchesByKey = buildPaymentMatchIndex(paymentMatches);
  const unclassifiedPaymentKeys = new Set<string>();
  for (const line of auxiliarReconciliation.lines) {
    if (!isConfirmedAuxiliarLine(line)) continue;
    if (line.flujo !== 'egreso') continue;
    if (companyCode && companyCode !== 'all' && line.cia !== companyCode) continue;
    const date = cleanIsoDate(line.bankDate) ?? cleanIsoDate(line.fechaContable);
    if (!date) continue;
    if (line.source.kind === 'oc') {
      const key = purchaseOrderKey(line.cia, line.source.ref);
      const current = paidOcDateByKey.get(key);
      if (!current || date < current) paidOcDateByKey.set(key, date);
      continue;
    }
    if (line.source.kind !== 'pago') continue;

    const match = findPaymentMatchForAuxiliarLine(line, paymentMatchesByKey);
    if (!match && paymentMatches.length === 0) continue;
    if (match?.cxpMatches.length) continue;
    const matchedReceipt = match
      ? findPurchaseReceiptForPayment(match.payment, purchaseReceipts, companyCode)
      : undefined;
    if (matchedReceipt) {
      const key = purchaseReceiptTaxDedupeKey(matchedReceipt);
      const current = paidReceiptDateByKey.get(key);
      if (!current || date < current) paidReceiptDateByKey.set(key, date);
      continue;
    }

    const amount = positiveNumber(Math.abs(line.bankAmount ?? line.importe));
    const unclassifiedKey = `${line.glKey}::${date}::${Math.round(amount * 100)}`;
    if (date < startDate || date > endDate) continue;
    if (amount <= 0 || unclassifiedPaymentKeys.has(unclassifiedKey)) continue;
    unclassifiedPaymentKeys.add(unclassifiedKey);
    const row = ensure(date.slice(0, 7));
    row.unclassifiedExpense += amount;
    row.unclassifiedLines.push({
      movementId: `paid-supplier-unclassified:${unclassifiedKey}`,
      date,
      concept: `Pago proveedor sin desglose fiscal ${line.source.ref || line.tipoDocto || ''}`.trim(),
      counterpartyName: line.source.contraparte,
      amount,
      taxBase: amount,
      taxAmount: 0,
      sourceSystem: 'JDE',
      estimated: false,
    });
  }
  if (paidOcDateByKey.size === 0 && paidReceiptDateByKey.size === 0) return;

  const cxpBySupplier = buildJdeSupplierIndex(cxpRecords);
  const emitted = new Set<string>();
  for (const receipt of purchaseReceipts) {
    if (companyCode && companyCode !== 'all' && receipt.cia !== companyCode) continue;
    if (receipt.isCancelled || receipt.amountMxn <= 0) continue;
    const dedupeKey = purchaseReceiptTaxDedupeKey(receipt);
    const ocDate = receipt.purchaseOrderNo
      ? paidOcDateByKey.get(purchaseOrderKey(receipt.cia, receipt.purchaseOrderNo))
      : undefined;
    const date = ocDate ?? paidReceiptDateByKey.get(dedupeKey);
    if (!date || date < startDate || date > endDate) continue;

    // Si esta misma factura CXP ya se acreditó con cobertura PagoProveedor o
    // Auxiliar por folio, no la dupliques desde Compras.
    const matchedCxp = cxpBySupplier
      .get(normalizeJde(receipt.noProveedor))
      ?.find((cxp) => purchaseMatchesCxp(receipt, cxp));
    if (matchedCxp && cxpPaymentCoverage?.has(cxpCoverageKey(matchedCxp))) continue;

    if (emitted.has(dedupeKey)) continue;
    emitted.add(dedupeKey);

    const row = ensure(date.slice(0, 7));
    const taxRate = receipt.taxRate === 16 || receipt.taxRate === 8 ? receipt.taxRate : undefined;
    if (!taxRate || receipt.taxTreatment !== 'IVA_CREDITABLE') {
      if (receipt.taxTreatment === 'UNCLASSIFIED') {
        row.unclassifiedExpense += receipt.amountMxn;
        row.unclassifiedLines.push({
          movementId: `paid-purchase-unclassified:${dedupeKey}`,
          date,
          concept: `OC pagada ${receipt.invoiceNo || receipt.purchaseOrderNo} · ${receipt.supplierName}`,
          counterpartyName: receipt.supplierName,
          amount: receipt.amountMxn,
          taxBase: receipt.amountMxn,
          taxAmount: 0,
          sourceSystem: 'JDE',
          estimated: false,
        });
      }
      continue;
    }

    const breakdown = receipt.taxBaseAmount != null && receipt.taxAmount != null
      ? {
        taxBase: positiveNumber(receipt.taxBaseAmount),
        taxAmount: positiveNumber(receipt.taxAmount),
      }
      : grossToIvaBreakdown(receipt.amountMxn, taxRate);
    addIvaCreditable(row, {
      movementId: `paid-purchase:${dedupeKey}`,
      date,
      concept: `OC pagada ${receipt.invoiceNo || receipt.purchaseOrderNo} · ${receipt.supplierName}`,
      counterpartyName: receipt.supplierName,
      amount: receipt.amountMxn,
      taxBase: breakdown.taxBase,
      taxRate,
      taxAmount: breakdown.taxAmount,
      sourceSystem: 'JDE',
      rateTarget: providerRateTarget(receipt.noProveedor || receipt.supplierName),
      rateSource: 'JDE',
      estimated: false,
    }, taxRate);
  }
}

function accumulateDirectionalAuxiliarIvaEstimate({
  auxiliarReconciliation,
  cxpRecords,
  purchaseReceipts,
  cobranzaPayments,
  companyCode,
  startDate,
  endDate,
  rateContext,
  ensure,
}: {
  auxiliarReconciliation?: AuxiliarReconResult;
  cxpRecords: CXPRecord[];
  purchaseReceipts: PurchaseReceiptRecord[];
  cobranzaPayments: CobranzaPayment[];
  companyCode?: string;
  startDate: string;
  endDate: string;
  rateContext: TaxRateContext;
  ensure: (period: string) => TaxPeriodAccumulator;
}): void {
  if (!auxiliarReconciliation) return;

  const knownCxpInvoices = new Set<string>();
  for (const cxp of cxpRecords) {
    if (cxp.noFactura) knownCxpInvoices.add(auxiliarDocKey(cxp.cia, cxp.noFactura));
  }

  const knownCobranzaInvoices = new Set<string>();
  for (const payment of cobranzaPayments) {
    for (const app of payment.applications) {
      if (app.noFactura) knownCobranzaInvoices.add(auxiliarDocKey(app.cia || payment.cia, app.noFactura));
      if (app.noFacturaNormalizada) knownCobranzaInvoices.add(auxiliarDocKey(app.cia || payment.cia, app.noFacturaNormalizada));
    }
  }

  const knownPurchaseOrders = new Set<string>();
  const knownPurchaseDocs = new Set<string>();
  for (const receipt of purchaseReceipts) {
    if (receipt.purchaseOrderNo) knownPurchaseOrders.add(purchaseOrderKey(receipt.cia, receipt.purchaseOrderNo));
    if (receipt.invoiceNo) knownPurchaseDocs.add(auxiliarDocKey(receipt.cia, receipt.invoiceNo));
    if (receipt.receiptNo) knownPurchaseDocs.add(auxiliarDocKey(receipt.cia, receipt.receiptNo));
  }

  const emitted = new Set<string>();
  for (const line of auxiliarReconciliation.lines) {
    if (!isConfirmedAuxiliarLine(line)) continue;
    if (line.flujo !== 'ingreso' && line.flujo !== 'egreso') continue;
    if (companyCode && companyCode !== 'all' && line.cia !== companyCode) continue;

    const date = cleanIsoDate(line.bankDate) ?? cleanIsoDate(line.fechaContable);
    if (!date || date < startDate || date > endDate) continue;

    const amount = positiveNumber(Math.abs(line.bankAmount ?? line.importe));
    if (amount <= 0) continue;

    if (line.source.kind === 'pago') continue;
    if (line.source.kind === 'factura') {
      const key = auxiliarDocKey(line.cia, line.source.ref);
      if (line.flujo === 'egreso' && (knownCxpInvoices.has(key) || knownPurchaseDocs.has(key))) continue;
      if (line.flujo === 'ingreso' && knownCobranzaInvoices.has(key)) continue;
    }
    if (line.source.kind === 'oc' && knownPurchaseOrders.has(purchaseOrderKey(line.cia, line.source.ref))) continue;
    if (!isDirectionalAuxiliarIvaCandidate(line)) continue;

    const target = auxiliarRateTarget(line);
    const resolution = resolveTaxRate(rateContext, target);
    const breakdown = grossToIvaBreakdown(amount, resolution.rate);
    const dedupeKey = `${line.glKey}::${date}::${line.flujo}::${Math.round(amount * 100)}`;
    if (emitted.has(dedupeKey)) continue;
    emitted.add(dedupeKey);

    const taxLine: TaxSourceLine = {
      movementId: `aux-iva-estimate:${dedupeKey}`,
      date,
      concept: `IVA estimado Auxiliar · ${auxiliarLineLabel(line)}`,
      counterpartyName: line.source.contraparte || line.nombreCuenta,
      amount,
      taxBase: breakdown.taxBase,
      taxRate: breakdown.taxRate,
      taxAmount: breakdown.taxAmount,
      sourceSystem: 'JDE',
      rateTarget: target,
      rateSource: resolution.source,
      estimated: true,
    };
    const row = ensure(date.slice(0, 7));
    if (line.flujo === 'ingreso') addIvaCaused(row, taxLine, breakdown.taxRate);
    else addIvaCreditable(row, taxLine, breakdown.taxRate);
  }
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

/**
 * IVA REAL autoritativo desde el libro mayor (`domain/ivaLedger.ts`).
 *
 * El `importe` del ledger ES el impuesto (no la base). Por periodo y lado se
 * agrupan las líneas por tasa detectada en el nombre de cuenta (default 16% si
 * no hay señal), se suma el neto firmado, se toma su magnitud y se deriva la
 * base. Reusa `addIvaCaused`/`addIvaCreditable` para que el desglose por tasa,
 * el neto y las líneas de drilldown queden iguales que en el pipeline estimado.
 */
function accumulateIvaFromLedger({
  ledgerByPeriod,
  ensure,
}: {
  ledgerByPeriod: Map<string, IvaLedgerPeriod>;
  ensure: (period: string) => TaxPeriodAccumulator;
}): void {
  const emitSide = (
    row: TaxPeriodAccumulator,
    period: string,
    lines: IvaLedgerLine[],
    side: 'creditable' | 'caused',
  ) => {
    if (lines.length === 0) return;
    const byRate = new Map<8 | 16, IvaLedgerLine[]>();
    for (const line of lines) {
      const rate: 8 | 16 = line.rate === 8 ? 8 : 16;
      const bucket = byRate.get(rate) ?? [];
      bucket.push(line);
      byRate.set(rate, bucket);
    }
    for (const [rate, group] of byRate) {
      const net = group.reduce((sum, line) => sum + line.signedAmount, 0);
      const taxAmount = Math.abs(net);
      if (taxAmount <= 0) continue;
      const taxBase = taxAmount / (rate / 100);
      const accounts = Array.from(new Set(group.map((line) => line.cuentaObjeto))).join(', ');
      const taxLine: TaxSourceLine = {
        movementId: `iva-ledger:${side}:${period}:${rate}`,
        date: `${period}-15`,
        concept: side === 'creditable'
          ? `IVA acreditable (libro mayor) · ${rate}% · cuenta ${accounts}`
          : `IVA causado (libro mayor) · ${rate}% · cuenta ${accounts}`,
        amount: taxBase + taxAmount,
        taxBase,
        taxRate: rate,
        taxAmount,
        sourceSystem: 'JDE',
        rateSource: 'JDE',
        estimated: false,
      };
      if (side === 'creditable') addIvaCreditable(row, taxLine, rate);
      else addIvaCaused(row, taxLine, rate);
    }
  };

  for (const [period, detail] of ledgerByPeriod) {
    const row = ensure(period);
    emitSide(row, period, detail.causedLines, 'caused');
    emitSide(row, period, detail.creditableLines, 'creditable');
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
  if (movement.category === 'TAX') return;
  const text = `${movement.concept} ${movement.counterpartyName ?? ''}`.toUpperCase();
  if (!text.includes('IMSS') && !text.includes('INSTITUTO MEXICANO DEL SEGURO SOCIAL')) return;
  const amount = effectiveAmount(movement);
  acc.imssDetected += amount;
  acc.imssLines.push(lineForMovement(movement));
}

function buildIvaDetail(
  acc: TaxPeriodAccumulator,
  store: TaxStore,
  today: string,
): IvaPeriodDetail {
  const ivaCaused = acc.ivaCaused16 + acc.ivaCaused8 + acc.manualIvaCaused;
  const ivaCreditable = acc.ivaCreditable16 + acc.ivaCreditable8 + acc.manualIvaCreditable;
  const netIva = ivaCaused - ivaCreditable;
  const ivaRawPayable = netIva + acc.manualIvaPayable - acc.ivaPaid;
  const ivaPayable = Math.max(0, ivaRawPayable);
  const ivaBalanceInFavor = Math.max(0, -ivaRawPayable);

  return {
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
    paidLines: acc.paidLines,
    unclassifiedLines: acc.unclassifiedLines,
  };
}

function finalizeTaxPeriod({
  period,
  activeIva,
  realIva,
  forecastIva,
  shared,
  ivaMode,
  store,
  today,
}: {
  period: string;
  activeIva: TaxPeriodAccumulator;
  realIva: TaxPeriodAccumulator;
  forecastIva: TaxPeriodAccumulator;
  shared: TaxPeriodAccumulator;
  ivaMode: IvaMode;
  store: TaxStore;
  today: string;
}): TaxPeriodSummary {
  const activeIvaDetail = buildIvaDetail(activeIva, store, today);
  const realIvaDetail = buildIvaDetail(realIva, store, today);
  const forecastIvaDetail = buildIvaDetail(forecastIva, store, today);
  const isrDetail = buildIsrDetail(activeIvaDetail, shared, store, today);

  const isn = shared.isnOverride ?? shared.payrollBase * ISN_RATE;
  const imss = shared.imssDetected + shared.imssManual;

  const calculated: TaxObligation[] = [
    calculatedObligation('IVA', period, activeIvaDetail.payable, taxDueDate(period), statusFromPaymentPlan(activeIvaDetail.payable, paymentPlanFor(store, 'IVA', period), today, taxDueDate(period)), paymentPlanFor(store, 'IVA', period), 'CALCULATED'),
    calculatedObligation('ISR', period, isrDetail.payable, taxDueDate(period), isrDetail.status, isrDetail.paymentPlan, isrDetail.calculated > 0 ? 'CALCULATED' : isrDetail.manual > 0 ? 'MANUAL' : 'CALCULATED'),
    calculatedObligation('ISN', period, isn, taxDueDate(period), statusFromPaymentPlan(isn, paymentPlanFor(store, 'ISN', period), today, taxDueDate(period)), paymentPlanFor(store, 'ISN', period), shared.isnOverride != null ? 'MANUAL' : 'CALCULATED'),
    calculatedObligation('IMSS', period, imss, taxDueDate(period), statusFromPaymentPlan(imss, paymentPlanFor(store, 'IMSS', period), today, taxDueDate(period)), paymentPlanFor(store, 'IMSS', period), shared.imssDetected > 0 ? 'JDE' : shared.imssManual > 0 ? 'MANUAL' : 'CALCULATED'),
  ].filter((obligation) => obligation.totalAmount > 0 || obligation.paymentPlan.length > 0);

  const manualOnly = shared.manualObligations.filter((manual) =>
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
  const total = activeIvaDetail.payable + isrDetail.payable + isn + imss;

  return {
    period,
    dueDate: taxDueDate(period),
    ivaNet: activeIvaDetail.payable,
    isn,
    imss,
    total,
    cashImpact,
    status: rollupStatus(obligations, total),
    obligations,
    iva: activeIvaDetail,
    realIva: realIvaDetail,
    forecastIva: forecastIvaDetail,
    ivaMode,
    isr: isrDetail,
    payrollBase: shared.payrollBase,
    payrollLines: shared.payrollLines,
    imssLines: shared.imssLines,
  };
}

function buildIsrDetail(
  iva: IvaPeriodDetail,
  shared: TaxPeriodAccumulator,
  store: TaxStore,
  today: string,
): IsrPeriodDetail {
  const settings = store.settings ?? defaultTaxSettings();
  const coefficient = clampTaxRate(settings.isrProvisionalCoefficient);
  const rate = clampTaxRate(settings.isrRate || ISR_CORPORATE_RATE);
  const nominalIncome = iva.incomeBase16 + iva.incomeBase8;
  const estimatedTaxableProfit = nominalIncome * coefficient;
  const calculated = estimatedTaxableProfit * rate;
  const grossPayable = calculated + shared.manualIsr - shared.isrPaid;
  const payable = Math.max(0, grossPayable);
  const plan = paymentPlanFor(store, 'ISR', shared.period);
  return {
    period: shared.period,
    dueDate: shared.dueDate,
    nominalIncome,
    coefficient,
    rate,
    estimatedTaxableProfit,
    calculated,
    manual: shared.manualIsr,
    paid: shared.isrPaid,
    payable,
    status: statusFromPaymentPlan(payable, plan, today, shared.dueDate),
    paymentPlan: plan,
    incomeLines: iva.incomeLines,
    paidLines: shared.paidLines.filter((line) => normalizeText(line.concept).includes('ISR')),
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
    risk: taxRisk(taxType),
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

function taxRisk(taxType: TaxType): TaxObligation['risk'] {
  if (taxType === 'IMSS') return 'LEGAL';
  if (taxType === 'IVA' || taxType === 'ISR') return 'HIGH';
  return 'MEDIUM';
}

function clampTaxRate(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(value, 1) : 0;
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

function cxpTaxBreakdown(
  record: CXPRecord,
  overrideRate?: 8 | 16,
  providerRate?: 8 | 16,
  matchedPurchase?: PurchaseReceiptRecord,
  amountOverride?: number,
  options: { allowEstimated?: boolean } = {},
): {
  amount: number;
  taxBase: number;
  taxAmount: number;
  taxRate?: 0 | 8 | 16;
  rateSource?: TaxSourceLine['rateSource'];
  estimated?: boolean;
} {
  const gross = positiveNumber(record.importeBrutoPesos);
  const pending = positiveNumber(amountOverride ?? record.importePendientePesos);
  const subtotal = positiveNumber(record.importeSubtotalPesos);
  const tax = positiveNumber(record.importeImpuestosPesos);
  const allowEstimated = options.allowEstimated !== false;
  if (pending <= 0) return { amount: 0, taxBase: 0, taxAmount: 0 };

  if (overrideRate && allowEstimated) {
    return {
      amount: pending,
      ...grossToIvaBreakdown(pending, overrideRate),
      rateSource: 'OVERRIDE',
      estimated: true,
    };
  }

  // JDE mandó subtotal+bruto válidos pero impuesto explícitamente 0 → proveedor
  // exento / tasa 0. NO fabricar 16% DEFAULT (inflaría el IVA acreditable). El
  // monto completo va a no clasificado (taxRate 0 → caller suma a unclassified).
  const rawTax = record.importeImpuestosPesos;
  if (subtotal > 0 && gross > 0 && Number.isFinite(rawTax) && rawTax <= 0) {
    return {
      amount: pending,
      taxBase: pending,
      taxAmount: 0,
      taxRate: 0,
      rateSource: 'JDE',
    };
  }

  if (gross <= 0 || subtotal <= 0 || tax <= 0) {
    if (!allowEstimated) {
      return {
        amount: pending,
        taxBase: pending,
        taxAmount: 0,
        rateSource: 'JDE',
      };
    }
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
  if (!allowEstimated) return { amount: pending, taxBase, taxAmount, rateSource: 'JDE' };
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

function cxpCoverageKey(record: CXPRecord): string {
  return `${record.cia}::${record.noFactura}::${record.noProveedor}`;
}

function purchaseOrderKey(cia: string, purchaseOrderNo: string): string {
  return `${normalizeText(cia)}::${purchaseOrderNo.trim()}`;
}

function auxiliarDocKey(cia: string, ref: string): string {
  return `${normalizeText(cia)}::${normalizeText(ref)}`;
}

function auxiliarLineLabel(line: AuxiliarReconLine): string {
  return [
    line.tipoDoctoDesc || line.tipoDocto || 'GL',
    line.source.ref,
    line.source.contraparte || line.nombreCuenta,
  ].filter(Boolean).join(' · ');
}

function auxiliarRateTarget(line: AuxiliarReconLine): TaxRateTarget {
  if (line.flujo === 'egreso' && line.source.contraparte) {
    return providerRateTarget(line.source.contraparte);
  }
  return conceptRateTarget(auxiliarLineLabel(line));
}

function isDirectionalAuxiliarIvaCandidate(line: AuxiliarReconLine): boolean {
  const text = normalizeText([
    line.tipoDoctoDesc,
    line.tipoDocto,
    line.source.kind,
    line.source.ref,
    line.source.contraparte,
    line.nombreCuenta,
  ].filter(Boolean).join(' '));
  if (!text) return false;

  const classification = classifyBankConcept({ concepto: text });
  if (classification.category === 'TAX' || classification.category === 'PAYROLL' || classification.category === 'DEBT') {
    return false;
  }

  if (isNonTaxableAuxiliarText(text)) return false;
  if (line.flujo === 'ingreso') {
    return line.source.kind === 'factura';
  }
  if (line.source.kind === 'factura' || line.source.kind === 'oc') return true;
  return isOperationalAuxiliarExpenseText(text);
}

function isNonTaxableAuxiliarText(text: string): boolean {
  return [
    'NOMINA',
    'SUELDO',
    'SALARIO',
    'FINIQUITO',
    'IMSS',
    'INFONAVIT',
    'ISR',
    'IMPUESTO',
    'TESORERIA',
    'SAT',
    'IVA',
    'PRESTAMO',
    'CREDITO',
    'DEUDA',
    'PASIVO',
    'TRASPASO',
    'TRANSFERENCIA',
    'INTERCOMPANIA',
    'INTERCOMPAN',
    'COMISION',
    'INTERES',
  ].some((token) => text.includes(token));
}

function isOperationalAuxiliarExpenseText(text: string): boolean {
  return [
    'PROVEEDOR',
    'FLETE',
    'DIESEL',
    'COMBUSTIBLE',
    'MANTENIMIENTO',
    'REFACCION',
    'RENTA',
    'SERVICIO',
    'COMPRA',
    'GASTO',
  ].some((token) => text.includes(token));
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
    settings: normalizeTaxSettings(raw.settings ?? fallback.settings),
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
    settings: defaultTaxSettings(),
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
    risk: taxRisk(taxType),
    comment: typeof raw.comments === 'string' && raw.comments.trim() ? raw.comments.trim() : undefined,
    status: statusFromPaymentPlan(amount, plan, todayISO(), dueDate),
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
      : taxRisk(taxType),
    comment: typeof raw.comment === 'string' && raw.comment.trim() ? raw.comment.trim() : undefined,
    status: normalizeStatus(raw.status) ?? statusFromPaymentPlan(totalAmount, paymentPlan, todayISO(), dueDate),
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
  return value === 'IVA' || value === 'ISR' || value === 'ISN' || value === 'IMSS' ? value : null;
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
    || value === 'ISR_MANUAL'
    || value === 'ISR_PAID'
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
