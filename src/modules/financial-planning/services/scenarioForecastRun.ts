import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CxpPaymentCoverage } from '../../../domain/paymentReconciliationEngine';
import type { AuxiliarReconResult } from '../../../domain/auxiliarReconciliationEngine';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaPayment } from '../../../services/jdeTypes';
import {
  applyAdjustmentsToMovements,
  applyCellOverridesToBuckets,
  calculateBaseProjection,
  effectiveMovementDate,
  summarizeBucketsForScenario,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  CellOverride,
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
  ForecastRun,
  ManualPlanningEntry,
  PayrollCostRecord,
  PlanningCustomRow,
  PlanningRow,
  ProjectionGranularity,
  PurchaseReceiptRecord,
} from '../../shared-finance/types';
import {
  buildAutomaticTaxReserveMovements,
  buildApprovedTaxPaymentMovements,
  buildTaxDashboardView,
  type TaxStore,
} from '../../taxes/services/taxModuleService';
import { buildConvenioPaymentMovements } from '../../concurso-mercantil/services/convenioMovements';
import { buildFideicomisoMovements } from '../../fideicomiso/services/fideicomisoMovements';
import { buildTrendTopOffMovements } from '../../../domain/predictive';
import type { PredictionPoint } from '../../../domain/predictive';
import { expandManualPlanningEntriesToMovements } from './manualPlanningEntries';
import { buildPlanningRows, conceptKeyForMovement } from './planningRowTaxonomy';
import { scheduleSupplierPaymentsByScore, type SupplierPaymentPlan } from './supplierPaymentSchedule';

export type ScenarioForecastRun = ForecastRun & {
  rows: PlanningRow[];
  overrides: CellOverride[];
  supplierPlan: SupplierPaymentPlan;
};

/**
 * Gran-independent pipeline output. Caching this and reusing across grain
 * flips avoids re-running adjust + tax + supplier-schedule (the heavy part)
 * when the user just toggles mes→sem→día.
 */
export interface ScenarioPipelineResult {
  movements: FinancialMovement[];
  supplierPlan: SupplierPaymentPlan;
  isBase: boolean;
  projectionEndDate: string;
}

export interface BuildScenarioForecastRunArgs {
  scenarioId: string;
  scenarioName: string;
  scenarioKind: FinancialScenario['kind'];
  sourceMovements: FinancialMovement[];
  adjustments: FinancialAdjustment[];
  manualEntries: ManualPlanningEntry[];
  customRows: PlanningCustomRow[];
  overrides: CellOverride[];
  clients: Client[];
  providers: Provider[];
  assumptions: CashFlowAssumptions;
  cxpRecords: CXPRecord[];
  cxpPaymentCoverage?: Map<string, CxpPaymentCoverage>;
  auxiliarReconciliation?: AuxiliarReconResult;
  purchaseReceipts?: PurchaseReceiptRecord[];
  payrollCosts?: PayrollCostRecord[];
  cobranzaPayments?: CobranzaPayment[];
  budget: Budget | null;
  companyCode: string;
  taxStore: TaxStore;
  /** Bajío bank statements — used by fideicomiso (Dina) ingress reconciliation. */
  bajioStatements?: BankAccountStatement[];
  startDate: string;
  endDate: string;
  today: string;
  initialCash: number;
  supplierInitialCash: number;
  minimumCash: number;
  granularity: ProjectionGranularity;
  includeManualEntries?: boolean;
  /**
   * Set `${cia}::${noOrdenCompra}` de OCs ya cruzadas a banco vía
   * AuxiliarContable. Se propaga a `buildTaxDashboardView` →
   * `accumulatePurchaseReceiptIva` para evitar que el acumulador fiscal
   * cuente IVA acreditable proyectado de OCs ya pagadas (IVA ya realizado
   * en período pasado). Mismo set que el motor canónico usa para skipear
   * compras paid en la proyección de caja.
   */
  paidPurchaseOrderKeys?: Set<string>;
  /**
   * Activa la inyección de top-off de tendencia histórica (Holt-Winters) en
   * escenarios NO base. Opt-in desde Proyección. Default off.
   */
  includeTrendTopOff?: boolean;
  /**
   * Series MENSUALES del motor predictivo (`canonical.predictive`) usadas para
   * el top-off de tendencia. Payload ligero (~12 puntos c/u). Sólo se consume
   * si `includeTrendTopOff` está activo.
   */
  trendForecast?: { income: PredictionPoint[]; expense: PredictionPoint[] };
}

/**
 * Gran-independent pipeline: scenario adjustments + tax + convenio +
 * fideicomiso + supplier schedule. Returns post-pipeline movements plus the
 * supplier plan. Caching this and re-running just the aggregator on grain
 * flip cuts a typical flip from ~1500ms to ~50-200ms.
 */
export function buildScenarioPipeline(args: BuildScenarioForecastRunArgs): ScenarioPipelineResult {
  const isBase = args.scenarioKind === 'BASE';
  const manualMovements = !isBase && args.includeManualEntries !== false
    ? expandManualPlanningEntriesToMovements(args.manualEntries, {
      scenarioId: args.scenarioId,
      startDate: args.startDate,
      endDate: args.endDate,
      asOfDate: args.today,
    })
    : [];

  const movementsBeforeAdjust = isBase
    ? args.sourceMovements.filter(
      (movement) =>
        isRealShortTermApiMovement(movement) &&
        effectiveMovementDate(movement) <= args.today,
    )
    : [...args.sourceMovements, ...manualMovements];

  const adjustedMovements = isBase
    ? movementsBeforeAdjust
    : applyAdjustmentsToMovements(
      movementsBeforeAdjust,
      args.adjustments,
      args.scenarioId,
    );

  const taxSeedView = isBase ? null : buildTaxDashboardView({
    clients: args.clients,
    providers: args.providers,
    assumptions: args.assumptions,
    cxpRecords: args.cxpRecords,
    cxpPaymentCoverage: args.cxpPaymentCoverage,
    auxiliarReconciliation: args.auxiliarReconciliation,
    purchaseReceipts: args.purchaseReceipts,
    paidPurchaseOrderKeys: args.paidPurchaseOrderKeys,
    payrollCosts: args.payrollCosts,
    cobranzaPayments: args.cobranzaPayments,
    budget: args.budget,
    companyCode: args.companyCode,
    startDate: args.startDate,
    endDate: args.endDate,
    movements: adjustedMovements,
    store: args.taxStore,
    today: args.today,
    ivaMode: 'FORECAST',
  });

  const taxMovements = taxSeedView
    ? [
      ...buildApprovedTaxPaymentMovements({
        obligations: taxSeedView.obligations,
        scenarioId: args.scenarioId,
        startDate: args.startDate,
        endDate: args.endDate,
        asOfDate: args.today,
      }),
      ...buildAutomaticTaxReserveMovements({
        obligations: taxSeedView.obligations,
        scenarioId: args.scenarioId,
        startDate: args.startDate,
        endDate: args.endDate,
        asOfDate: args.today,
      }),
    ]
    : [];

  const convenioMovements = isBase
    ? []
    : buildConvenioPaymentMovements({
      scenarioId: args.scenarioId,
      startDate: args.startDate,
      endDate: args.endDate,
      asOfDate: args.today,
    });

  // Fideicomiso Dina: ingreso Corning real (Bajío) + egreso DINA mensual.
  // Mismo invariante/patrón que convenio (solo no-base, ventana recortada).
  const fideicomisoMovements = isBase
    ? []
    : buildFideicomisoMovements({
      scenarioId: args.scenarioId,
      startDate: args.startDate,
      endDate: args.endDate,
      asOfDate: args.today,
      bajioStatements: args.bajioStatements ?? [],
    });

  const movementsWithTreasuryRules = [
    ...adjustedMovements,
    ...taxMovements,
    ...convenioMovements,
    ...fideicomisoMovements,
  ];
  const supplierSchedule = scheduleSupplierPaymentsByScore({
    movements: movementsWithTreasuryRules,
    providers: args.providers,
    startDate: args.today,
    endDate: args.endDate,
    initialCash: args.supplierInitialCash,
    minimumCash: args.minimumCash,
    scenarioId: args.scenarioId,
  });

  // Top-off de tendencia histórica (opt-in, sólo no-base). Se calcula DESPUÉS
  // del supplier schedule para que el baseline "ya comprometido" incluya todo
  // (CXC/CXP/nómina/impuestos/convenio/fideicomiso reprogramados) y para que el
  // scheduler no intente reordenar egresos sintéticos sin proveedor.
  const trendMovements = !isBase && args.includeTrendTopOff && args.trendForecast
    ? buildTrendTopOffMovements({
      incomeMonthly: args.trendForecast.income,
      expenseMonthly: args.trendForecast.expense,
      existingMovements: supplierSchedule.movements,
      scenarioId: args.scenarioId,
      startDate: args.startDate,
      endDate: args.endDate,
      asOfDate: args.today,
    })
    : [];

  // Base = past/today only. Truncate bucket window at today so empty future
  // buckets don't render (the movement filter already drops > today, but
  // buildBucketDates spans the full window regardless).
  const projectionEndDate = isBase ? args.today : args.endDate;

  return {
    movements: [...supplierSchedule.movements, ...trendMovements],
    supplierPlan: supplierSchedule.plan,
    isBase,
    projectionEndDate,
  };
}

/**
 * Gran-dependent aggregator. Takes pipeline output + the gran-specific args
 * and produces the final ScenarioForecastRun. Fast (~50-200ms even at daily
 * granularity) so calling it on the main thread for grain flips beats a
 * worker round-trip.
 */
export function aggregateScenarioForecastRun(
  pipeline: ScenarioPipelineResult,
  args: BuildScenarioForecastRunArgs,
): ScenarioForecastRun {
  const rawProjection = calculateBaseProjection(pipeline.movements, {
    startDate: args.startDate,
    endDate: pipeline.projectionEndDate,
    initialCash: args.initialCash,
    minimumCash: args.minimumCash,
    granularity: args.granularity,
    scenarioId: args.scenarioId,
    name: args.scenarioName,
  });

  const rows = buildPlanningRows({
    movements: rawProjection.movements,
    customRows: args.customRows,
    overrides: args.overrides,
    providers: args.providers,
  });
  const buckets = applyCellOverridesToBuckets({
    buckets: rawProjection.buckets,
    overrides: args.overrides,
    movements: rawProjection.movements,
    rows,
    granularity: args.granularity,
    conceptKeyForMovement,
    asOfDate: args.today,
    initialCash: args.initialCash,
  });

  return {
    ...rawProjection,
    buckets,
    summary: summarizeBucketsForScenario(buckets, rawProjection.movements, args.minimumCash, args.granularity),
    rows,
    overrides: args.overrides,
    supplierPlan: pipeline.supplierPlan,
  };
}

/**
 * Shared official forecast pipeline for Dashboard, Proyección and Planeación.
 * Convenience wrapper: pipeline + aggregator. Use the split functions when
 * caching the pipeline output across grain flips.
 */
export function buildScenarioForecastRun(args: BuildScenarioForecastRunArgs): ScenarioForecastRun {
  const pipeline = buildScenarioPipeline(args);
  return aggregateScenarioForecastRun(pipeline, args);
}

/**
 * Base remains a narrow operational baseline: real short-term API records only.
 * The Base run additionally cuts any movement whose effective date is in the
 * future (see buildScenarioForecastRun) — Base shows past/today only; future
 * dates belong to Approved/proposals, which use the full predictive canonical
 * source plus treasury rules.
 */
export const isRealShortTermApiMovement = (movement: FinancialMovement): boolean => {
  if (movement.status === 'REAL') return true;
  if (movement.id.startsWith('cxc:')) return true;
  if (movement.id.startsWith('purchase:') || movement.id.startsWith('po:')) return true;
  if (movement.id.startsWith('payroll:')) return !movement.id.includes(':forecast:');
  return false;
};
