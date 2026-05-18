import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { CobranzaPayment } from '../../../services/jdeTypes';
import {
  applyAdjustmentsToMovements,
  applyCellOverridesToBuckets,
  calculateBaseProjection,
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
import { expandManualPlanningEntriesToMovements } from './manualPlanningEntries';
import { buildPlanningRows, conceptKeyForMovement } from './planningRowTaxonomy';
import { scheduleSupplierPaymentsByScore, type SupplierPaymentPlan } from './supplierPaymentSchedule';

export type ScenarioForecastRun = ForecastRun & {
  rows: PlanningRow[];
  overrides: CellOverride[];
  supplierPlan: SupplierPaymentPlan;
};

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
  purchaseReceipts?: PurchaseReceiptRecord[];
  payrollCosts?: PayrollCostRecord[];
  cobranzaPayments?: CobranzaPayment[];
  budget: Budget | null;
  companyCode: string;
  taxStore: TaxStore;
  startDate: string;
  endDate: string;
  today: string;
  initialCash: number;
  supplierInitialCash: number;
  minimumCash: number;
  granularity: ProjectionGranularity;
  includeManualEntries?: boolean;
}

/**
 * Shared official forecast pipeline for Dashboard, Proyección and Planeación.
 * Forecast inputs may come from the predictive canonical source, but treasury
 * rules always run after that: scenario adjustments, tax, convenio, supplier
 * scheduling by score, and scenario-scoped cell overrides.
 */
export function buildScenarioForecastRun(args: BuildScenarioForecastRunArgs): ScenarioForecastRun {
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
    ? args.sourceMovements.filter(isRealShortTermApiMovement)
    : [...args.sourceMovements, ...manualMovements];

  const adjustedMovements = applyAdjustmentsToMovements(
    movementsBeforeAdjust,
    args.adjustments,
    args.scenarioId,
  );

  const taxSeedView = isBase ? null : buildTaxDashboardView({
    clients: args.clients,
    providers: args.providers,
    assumptions: args.assumptions,
    cxpRecords: args.cxpRecords,
    purchaseReceipts: args.purchaseReceipts,
    payrollCosts: args.payrollCosts,
    cobranzaPayments: args.cobranzaPayments,
    budget: args.budget,
    companyCode: args.companyCode,
    startDate: args.startDate,
    endDate: args.endDate,
    movements: adjustedMovements,
    store: args.taxStore,
    today: args.today,
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

  const movementsWithTreasuryRules = [...adjustedMovements, ...taxMovements, ...convenioMovements];
  const supplierSchedule = scheduleSupplierPaymentsByScore({
    movements: movementsWithTreasuryRules,
    providers: args.providers,
    startDate: args.today,
    endDate: args.endDate,
    initialCash: args.supplierInitialCash,
    minimumCash: args.minimumCash,
    scenarioId: args.scenarioId,
  });

  const rawProjection = calculateBaseProjection(supplierSchedule.movements, {
    startDate: args.startDate,
    endDate: args.endDate,
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
    supplierPlan: supplierSchedule.plan,
  };
}

/**
 * Base remains a narrow operational baseline: real short-term API records only.
 * Approved/proposals use the full predictive canonical source plus treasury rules.
 */
export const isRealShortTermApiMovement = (movement: FinancialMovement): boolean => {
  if (movement.id.startsWith('cxc:')) return true;
  if (movement.id.startsWith('purchase:') || movement.id.startsWith('po:')) return true;
  if (movement.id.startsWith('payroll:')) return !movement.id.includes(':forecast:');
  return false;
};
