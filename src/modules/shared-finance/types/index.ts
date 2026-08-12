export type FinancialSourceSystem = 'JDE' | 'BANK' | 'EXCEL' | 'MANUAL' | 'FORECAST' | 'PAYROLL' | 'TAX';
export type FinancialMovementType = 'INFLOW' | 'OUTFLOW';

export type FinancialMovementCategory =
  | 'AR_COLLECTION'
  | 'AP_PAYMENT'
  | 'PAYROLL'
  | 'TAX'
  | 'DEBT'
  | 'CAPEX'
  | 'OPEX'
  | 'TRANSFER'
  // Neto de traspasos entre cuentas propias que la detección de internos no
  // pudo aparear individualmente. Ancla la caja al saldo bancario real sin
  // re-inflar los brutos. Ver canonicalProjection (emisión) + netCashFlowEngine
  // (detección). NO es un ingreso/egreso económico — es reconciliación.
  | 'INTERNAL_RECON'
  | 'MANUAL';

export type FinancialCounterpartyType =
  | 'CUSTOMER'
  | 'SUPPLIER'
  | 'EMPLOYEE'
  | 'TAX_AUTHORITY'
  | 'BANK'
  | 'INTERNAL';

export type ConfidenceBand = 'CONFIRMED' | 'HIGH' | 'MEDIUM' | 'LOW' | 'EXPLORATORY';
export type ForecastMethod = 'RULE' | 'STATISTICAL' | 'ML' | 'DRIVER' | 'MANUAL';
export type FinancialDataStatus = 'REAL' | 'PROJECTED_BASE' | 'ADJUSTED' | 'APPROVED' | 'EXECUTED' | 'CANCELLED';
export type LockState = 'UNLOCKED' | 'RESTRICTED' | 'LOCKED';
export type FinancialTaxRate = 0 | 8 | 16;
export type FinancialTaxTreatment = 'IVA_CAUSED' | 'IVA_CREDITABLE' | 'IVA_EXEMPT' | 'UNCLASSIFIED';
// ISR se retiró del módulo de impuestos (Grupo Senda paga sobre flujo, no es
// pagador de ISR) — Taller 8-jul-2026. Quedan IVA + los impuestos de nómina.
export type TaxType = 'IVA' | 'ISN' | 'IMSS';
export type TaxStatus = 'PROJECTED' | 'CONFIRMED' | 'PAID' | 'PENDING';
export type TaxSource = 'CALCULATED' | 'JDE' | 'MANUAL' | 'SCENARIO';
export type TaxPaymentPlanStatus = 'DRAFT' | 'APPROVED' | 'PAID';

/**
 * Factura de cobranza que respalda el importe atribuido a un cliente Citi.
 *
 * Vive aquí (y no en `calculation-engine/citiClientCollection.ts`, que la
 * re-exporta) porque `FinancialMovement` la referencia: el motor adjunta estas
 * facturas a la línea que emite, y el módulo de cálculo importa de `../types`,
 * así que definirla allá cerraría el ciclo.
 */
export interface CitiCollectionInvoice {
  noFactura: string;
  fechaFactura: string;
  fechaCobro: string;
  noRecibo?: string;
  importeBrutoPesos: number;
}

export interface FinancialMovement {
  id: string;
  sourceSystem: FinancialSourceSystem;
  sourceObjectId?: string;
  type: FinancialMovementType;
  category: FinancialMovementCategory;
  subcategory?: string;
  companyId?: string;
  businessUnitId?: string;
  bankAccountId?: string;
  counterpartyId?: string;
  counterpartyName?: string;
  counterpartyType?: FinancialCounterpartyType;
  providerCategory?: string;
  /**
   * Clasificación de pago CRUDA de JDE, tal cual la manda el API — con prefijo
   * numérico y con los centinelas (`" "`, `-  .`, `220 - Por Clasificar`)
   * intactos. Es lo que agrupa los egresos en Planeación.
   *
   * NO es lo mismo que `providerCategory`: ese pasa por
   * `usableJdeProviderCategory`, que recorta el prefijo y descarta los
   * centinelas para poder bucketizar. Ambos conviven a propósito — el
   * normalizado clasifica, el crudo confiesa. Ver `providerPayClassOverlay.ts`.
   */
  payClass?: string;
  /** `Clasificacion_Proveedor_Financiera` cruda (la taxonomía numerada). */
  payClassFinanciera?: string;
  concept: string;
  currency: string;
  originalAmount: number;
  baseAmount: number;
  projectedAmount: number;
  adjustedAmount?: number;
  issueDate?: string;
  dueDate?: string;
  projectedDate: string;
  adjustedDate?: string;
  actualDate?: string;
  confidenceScore: number;
  confidenceBand: ConfidenceBand;
  forecastMethod: ForecastMethod;
  ruleApplied?: string;
  taxTreatment?: FinancialTaxTreatment;
  taxRate?: FinancialTaxRate;
  taxBaseAmount?: number;
  taxAmount?: number;
  status: FinancialDataStatus;
  lockState: LockState;
  comments?: string[];
  /**
   * Facturas que respaldan el importe de una línea `citi-prorrateo:`, guardadas
   * POR EL MOTOR al emitirla.
   *
   * Existe porque la UI no puede volver a derivarlas: la llave de cliente sale
   * de `clientDisplayCounterparty`, que depende del estado de `clients`, y
   * `AppCore` MUTA ese catálogo después del boot (cuelga `jdeAccounts`, aplica
   * el grupo comercial del padre JDE). Comprobado con datos reales de CARRIER
   * MEXICO: el mismo registro de cobranza resuelve a `46055218` sin catálogo, a
   * `catalog-12-carrier-…` con el catálogo bundleado y a `jde-padre-5240062`
   * una vez agrupado. Con el run servido del caché, el `counterpartyId` de la
   * línea es de un estado y la búsqueda de la UI de otro → no empataba y NINGÚN
   * cliente mostraba desglose.
   *
   * Guardarlo aquí elimina la clase completa: la UI lee lo que el motor
   * decidió en vez de recalcular una llave que se mueve.
   */
  citiInvoices?: CitiCollectionInvoice[];
  createdAt: string;
  updatedAt: string;
}

export type PurchaseConfidence = 'CONFIRMED' | 'PROJECTED';

export interface PurchaseReceiptRecord {
  cia: string;
  noProveedor: string;
  supplierName: string;
  invoiceNo: string;
  purchaseOrderNo: string;
  receiptNo: string;
  orderDate: string;
  /**
   * Fecha de recepción real. Vacía si la OC aún no se recibió (en ese caso
   * `confidence === 'PROJECTED'` y `estimatedDueDate` se derivó de
   * `orderDate + leadTime + creditDays`).
   */
  receiptDate: string;
  creditDays: number;
  estimatedDueDate: string;
  currency: string;
  exchangeRate: number;
  totalAmount: number;
  amountMxn: number;
  taxCode?: string;
  taxRateCode?: string;
  taxRate?: FinancialTaxRate;
  taxTreatment: FinancialTaxTreatment;
  taxBaseAmount?: number;
  taxAmount?: number;
  cancelledAt?: string;
  isCancelled: boolean;
  status: FinancialDataStatus;
  costCenter?: string;
  productCode?: string;
  productDescription?: string;
  productType?: string;
  categoryCode?: string;
  categoryName?: string;
  familyCode?: string;
  familyName?: string;
  subfamilyCode?: string;
  subfamilyName?: string;
  /**
   * CONFIRMED = OC ya recibida, `receiptDate` real, fecha de pago cierta.
   * PROJECTED = OC pedida sin recepción, `estimatedDueDate` derivado de
   * lead time histórico. Menor confianza, alimenta forecast a largo plazo.
   */
  confidence?: PurchaseConfidence;
  /** Lead time en días usado cuando confidence = PROJECTED. */
  projectedLeadTimeDays?: number;
  /** Fuente del lead time (cia-familia, familia, global, default, etc.). */
  projectedLeadTimeSource?: string;
  /** Estado workflow JDE (Edo_Sig). Para diagnóstico/filtros downstream. */
  workflowState?: string;
}

export type PayrollCashTreatment =
  | 'CASH_OUT'
  | 'EMPLOYER_TAX'
  | 'WITHHOLDING_PAYABLE'
  | 'DEDUCTION'
  | 'NON_CASH';

export interface PayrollCostRecord {
  cia: string;
  empresaNomina: string;
  year: number;
  month: number;
  paymentDate: string;
  periodStartDate?: string;
  periodEndDate?: string;
  payrollPeriod: string | number;
  payrollType: string;
  conceptId: string | number;
  conceptName: string;
  conceptType: string;
  cashTreatment: PayrollCashTreatment;
  amount: number;
  costCenter?: string;
  /** Turno del grupo de empleados (columna nueva TRESS 2026-07). Informativo. */
  turno?: string;
  /**
   * Periodo de TRESS bajo el que se pidió esta fila (`YYYY-MM`), NO el mes de
   * `paymentDate`. Son distintos: un request de 2026-02 devuelve periodos de
   * febrero cuya `FechaPago` cae en marzo (aguinaldos/finiquitos, periodos 312/
   * 852/872). `year`/`month` siguen saliendo de `paymentDate` porque el efectivo
   * sale ese día; `sourcePeriod` existe para que `mergeNominaBatch` sepa qué
   * cubre realmente el lote y no borre el mes siguiente. Ausente en registros
   * persistidos antes de este campo (el merge los trata como legacy).
   */
  sourcePeriod?: string;
}

export type FinancialScenarioKind = 'BASE' | 'APPROVED' | 'DRAFT';
export type ApprovalStatus = 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'PUBLISHED' | 'EXECUTED';

export const LEGACY_SCENARIO_KINDS = ['CONSERVATIVE', 'OPTIMISTIC', 'CRISIS', 'LIQUIDITY', 'CUSTOM'] as const;

export interface FinancialScenario {
  id: string;
  name: string;
  kind: FinancialScenarioKind;
  description?: string;
  adjustmentIds: string[];
  status: ApprovalStatus;
  isBase?: boolean;
  parentScenarioId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  publishedAt?: string;
  archivedAt?: string;
  promotedFromScenarioId?: string;
  promotedAt?: string;
}

export type ManualPlanningCategory =
  | 'MANUAL_INFLOW'
  | 'MANUAL_OUTFLOW'
  | 'SUPPLIER_PAYMENT'
  | 'TAX_PAYMENT'
  | 'PAYROLL'
  | 'CAPEX'
  | 'OPEX'
  | 'OTHER';

export type ManualPlanningRecurrence = 'ONE_TIME' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'QUARTERLY';

export interface ManualPlanningEntry {
  id: string;
  scenarioIds: string[];
  type: FinancialMovementType;
  category: ManualPlanningCategory;
  name: string;
  amount: number;
  startDate: string;
  endDate?: string;
  recurrence: ManualPlanningRecurrence;
  companyId?: string;
  businessUnitId?: string;
  counterpartyName?: string;
  description?: string;
  taxTreatment: FinancialTaxTreatment;
  taxRate?: FinancialTaxRate;
  taxBaseAmount?: number;
  taxAmount?: number;
  status: 'DRAFT' | 'APPROVED';
  replacedBySourceSystem?: FinancialSourceSystem;
  replacedBySourceObjectId?: string;
  replacedAt?: string;
  replacementNote?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type FinancialAdjustmentType =
  | 'DATE_SHIFT'
  | 'AMOUNT_OVERRIDE'
  | 'AMOUNT_DELTA'
  | 'PERCENTAGE_CHANGE'
  | 'SPLIT_PAYMENT'
  | 'CANCEL_MOVEMENT'
  | 'ADD_MOVEMENT'
  | 'FINANCING_DRAW'
  | 'RULE_OVERRIDE';

export type AdjustmentTargetType = 'MOVEMENT' | 'FILTER_SET' | 'COUNTERPARTY' | 'CATEGORY' | 'DATE_RANGE';

export type AdjustmentReasonCode =
  | 'LIQUIDITY'
  | 'NEGOTIATION'
  | 'CRISIS'
  | 'UPSIDE'
  | 'FORECAST_CORRECTION'
  | 'MANAGEMENT_DECISION';

export interface FinancialAdjustment {
  id: string;
  name: string;
  scenarioIds: string[];
  type: FinancialAdjustmentType;
  targetType: AdjustmentTargetType;
  targetExpression: string;
  originalValue?: unknown;
  adjustedValue?: unknown;
  deltaAmount?: number;
  deltaDays?: number;
  percentageChange?: number;
  splitConfig?: {
    numberOfPayments: number;
    frequency: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM';
    dates?: string[];
  };
  reasonCode: AdjustmentReasonCode;
  justification: string;
  impactSummary?: {
    cashImpact: number;
    deficitDaysReduced: number;
    riskChange: number;
  };
  status: Exclude<ApprovalStatus, 'PUBLISHED'>;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface ProjectionBucket {
  date: string;
  label: string;
  openingCash: number;
  inflows: number;
  outflows: number;
  net: number;
  closingCash: number;
  minimumCash: number;
  deficit: number;
  confidenceScore: number;
  movementIds: string[];
  alertIds: string[];
}

export interface ProjectionAlert {
  id: string;
  date: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  description: string;
  movementId?: string;
}

export interface ProjectionSummary {
  currentCash: number;
  projectedCash7: number;
  projectedCash30: number;
  projectedCash90: number;
  minimumCashRequired: number;
  deficitDays: number;
  largestUpcomingInflow?: FinancialMovement;
  largestUpcomingOutflow?: FinancialMovement;
  averageConfidence: number;
  totalInflows: number;
  totalOutflows: number;
  finalCash: number;
  minCash: number;
  maxRiskDate?: string;
  creditRequired: number;
}

export interface ForecastRun {
  id: string;
  name: string;
  scenarioId: string;
  status: 'BASE' | 'SIMULATED' | 'APPROVED_PLAN';
  granularity: ProjectionGranularity;
  startDate: string;
  endDate: string;
  generatedAt: string;
  movements: FinancialMovement[];
  buckets: ProjectionBucket[];
  summary: ProjectionSummary;
  alerts: ProjectionAlert[];
}

export type ProjectionGranularity = 'daily' | 'weekly' | 'monthly';

export type ProbabilisticModelKind = 'ARIMA' | 'ETS' | 'EMPIRICAL_FALLBACK';
export type ProbabilisticConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface PercentileBand {
  p10: number;
  p50: number;
  p90: number;
}

export interface ModelDiagnostics {
  modelKind: ProbabilisticModelKind;
  confidence: ProbabilisticConfidence;
  sampleSize: number;
  inflowVolatility: number;
  outflowVolatility: number;
  netResidualStd: number;
  autocorrelation: number;
  fallbackReason?: string;
}

export interface ProbabilisticBucket {
  date: string;
  label: string;
  cash: PercentileBand;
  probabilityBelowZero: number;
  probabilityBelowMinimumCash: number;
  expectedCreditRequired: number;
  p90CreditRequired: number;
}

export interface ProbabilisticSummary {
  probabilityOfDeficit: number;
  probabilityBelowMinimumCash: number;
  expectedCreditRequired: number;
  p90CreditRequired: number;
  maxRiskDate?: string;
  confidence: ProbabilisticConfidence;
}

export interface ProbabilisticForecastRun {
  id: string;
  baseForecastId: string;
  scenarioId: string;
  granularity: ProjectionGranularity;
  startDate: string;
  endDate: string;
  generatedAt: string;
  simulations: number;
  buckets: ProbabilisticBucket[];
  summary: ProbabilisticSummary;
  diagnostics: ModelDiagnostics;
}

export interface ProbabilisticForecastRequest {
  jobId?: number;
  baseProjection: ForecastRun;
  minimumCash: number;
  simulations?: number;
  seed?: number;
  horizonDays?: number;
}

export interface ProbabilisticForecastResponse {
  jobId?: number;
  result?: ProbabilisticForecastRun;
  error?: string;
}

export type CellOverrideMode = 'REPLACE' | 'DELTA';

export interface CellOverride {
  id: string;
  scenarioId: string;
  conceptKey: string;
  granularity: ProjectionGranularity;
  bucketKey: string;
  type: FinancialMovementType;
  mode: CellOverrideMode;
  value: number;
  previousAggregatedValue?: number;
  note?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningRow {
  conceptKey: string;
  label: string;
  group: string;
  bucketLabel: string;
  type: FinancialMovementType;
  category: FinancialMovementCategory;
  subgroupLabel?: string;
  providerCategoryLabel?: string;
  /**
   * Etiqueta de criticidad del proveedor según SCORE_LABELS
   * (Operativo / Prioritario / Negociable / Flexible). Solo se llena para
   * filas de proveedor (OUTFLOW + AP_PAYMENT) cuando hay un Provider en el
   * catálogo. La UI la muestra como chip junto al nombre.
   */
  providerScoreLabel?: string;
  /** Bucket de criticidad subyacente — para colorear el chip. */
  providerScoreBucket?: 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAJO';
  isCustom?: boolean;
}

export interface PlanningCustomRow {
  id: string;
  scenarioId: string;
  conceptKey: string;
  label: string;
  type: FinancialMovementType;
  category: FinancialMovementCategory;
  note?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type ScenarioChangeKind =
  | 'ADD_ROW'
  | 'REMOVE_ROW'
  | 'RENAME_ROW'
  | 'EDIT_CELL'
  | 'CLEAR_CELL'
  | 'CREATE_DRAFT'
  | 'DUPLICATE_DRAFT'
  | 'MERGE_TO_APPROVED';

export interface ScenarioChangeLogEntry {
  id: string;
  scenarioId: string;
  kind: ScenarioChangeKind;
  payload: Record<string, unknown>;
  autoDescription: string;
  userNote?: string;
  createdBy: string;
  createdAt: string;
}

export interface ScenarioComparison {
  scenarioId: string;
  scenarioName: string;
  finalCash: number;
  minCash: number;
  deficitDays: number;
  totalInflows: number;
  totalOutflows: number;
  maxRiskDate?: string;
  creditRequired: number;
  averageConfidence: number;
  finalCashDelta: number;
  deficitDaysDelta: number;
  totalInflowsDelta: number;
  totalOutflowsDelta: number;
  riskScoreDelta: number;
}

export interface SupplierFinancialProfile {
  id: string;
  name: string;
  type: string;
  category: string;
  risk: 'CRITICAL' | 'STRATEGIC' | 'FLEXIBLE' | 'BLOCKED' | 'LOW_RISK' | 'HIGH_RISK';
  paymentFlexibility: 'LOCKED' | 'REVIEW' | 'NEGOTIABLE' | 'FLEXIBLE';
  creditLimit: number;
  staleDays: number;
  pendingAmount: number;
  upcomingPayments: number;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  comment?: string;
}

export interface CustomerCollectionProfile {
  id: string;
  name: string;
  groupName?: string;
  legalNames: string[];
  pendingInvoices: number;
  pendingAmount: number;
  theoreticalCollectionDate: string;
  projectedCollectionDate: string;
  creditDays: number;
  paymentPattern: string;
  paymentHistory: 'ON_TIME' | 'USUALLY_LATE' | 'VOLATILE' | 'NEW';
  collectionProbability: number;
  owner: string;
  comment?: string;
}

export interface TaxPaymentPlanItem {
  id: string;
  date: string;
  amount: number;
  status: TaxPaymentPlanStatus;
  scenarioId?: string;
  note?: string;
}

export interface TaxManualAdjustment {
  id: string;
  taxType: TaxType;
  period: string;
  kind:
    | 'IVA_CAUSED'
    | 'IVA_CREDITABLE'
    | 'IVA_PAID'
    | 'IVA_PAYABLE'
    | 'ISN_OVERRIDE'
    | 'IMSS_MANUAL';
  amount: number;
  note?: string;
  source: TaxSource;
  createdAt: string;
}

export interface TaxObligation {
  id: string;
  taxType: TaxType;
  period: string;
  label: string;
  source: TaxSource;
  sourceSystem?: 'MANUAL' | 'TAX' | 'JDE' | 'EXCEL' | 'CALCULATED' | 'SCENARIO';
  totalAmount: number;
  paidAmount: number;
  pendingAmount: number;
  dueDate: string;
  paymentPlan: TaxPaymentPlanItem[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'LEGAL';
  comment?: string;
  status: TaxStatus;
}

export type FinanceRole = 'VIEWER' | 'ANALYST' | 'MANAGER' | 'ADMIN' | 'CFO';
