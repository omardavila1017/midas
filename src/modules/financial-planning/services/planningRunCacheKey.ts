import type { AuxiliarReconResult } from '../../../domain/auxiliarReconciliationEngine';
import type { CxpPaymentCoverage } from '../../../domain/paymentReconciliationEngine';
import type { Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaPayment } from '../../../services/jdeTypes';
import { fingerprintArray } from '../../financial-projection/services/projectionCache';
import { auxiliarTaxCoverageFingerprint, cxpPaymentCoverageFingerprint, type TaxStore } from '../../taxes/services/taxModuleService';
import type {
  FinancialAdjustment,
  FinancialMovement,
  ManualPlanningEntry,
  ProjectionGranularity,
} from '../../shared-finance/types';

/**
 * Única fuente de la llave de corrida persistida de Planeación.
 *
 * Módulo hoja a propósito (mismo patrón que `planningStorageKeys.ts`): la
 * llave se arma en DOS lugares —el precalentado (`preloadPlanningScenarioRuns`)
 * y el dashboard interno— y basta con que uno omita, reordene o desincronice un
 * tramo para que el precalentado quede INERTE: guarda bajo una llave que nadie
 * pide después, así que Planeación recomputa Base/Aprobada en cada entrada sin
 * error, sin warning y sin test rojo. Eso ya pasó una vez (PR #173 agregó
 * `trend:` y `g=` sólo del lado interno; el warm-start desde IndexedDB quedó
 * muerto hasta PR #244).
 *
 * NO vuelvas a armar estas llaves por concatenación en el call site.
 */

/**
 * Granularidad con la que ABRE Planeación. Load-bearing en dos lados: es el
 * estado inicial del dashboard y la granularidad con la que el precalentado
 * arma la llave. Si divergen, el precalentado vuelve a quedar inerte.
 */
export const PLANNING_DEFAULT_GRANULARITY: ProjectionGranularity = 'monthly';

export interface PlanningSharedRunInputs {
  movements: readonly FinancialMovement[];
  adjustments: readonly FinancialAdjustment[];
  manualEntries: readonly ManualPlanningEntry[];
  taxStore: TaxStore;
  providers: readonly Provider[];
  cobranzaPayments: readonly CobranzaPayment[] | undefined;
  bajioStatements: readonly BankAccountStatement[] | undefined;
  auxiliarReconciliation: AuxiliarReconResult | undefined;
  cxpPaymentCoverage: Map<string, CxpPaymentCoverage> | undefined;
  yearStart: string;
  yearEnd: string;
  today: string;
  initialCash: number;
  supplierInitialCash: number;
  minimumCash: number;
  granularity: ProjectionGranularity;
}

/**
 * Huella estable de los inputs que TODA corrida de escenario comparte. Se
 * dobla dentro de la llave de cache para que las visitas repetidas al tab y las
 * consultas del tab-strip se salten el pipeline completo.
 */
export function planningSharedRunInputsKey(input: PlanningSharedRunInputs): string {
  const taxKey = [
    fingerprintArray(input.taxStore.obligations, (o) => o.id + ':' + o.pendingAmount + ':' + o.status + ':' + o.paymentPlan.length),
    fingerprintArray(input.taxStore.adjustments, (a) => a.id + ':' + a.kind + ':' + a.amount + ':' + a.createdAt),
    fingerprintArray(input.taxStore.taxRateOverrides, (r) => r.targetType + ':' + r.targetKey + ':' + r.rate + ':' + r.updatedAt),
    input.taxStore.overdueBalance,
  ].join(':');
  return [
    fingerprintArray(input.movements, (m) => m.id + ':' + (m.adjustedAmount ?? m.projectedAmount)),
    fingerprintArray(input.adjustments, (a) => a.id + ':' + a.status + ':' + a.createdAt),
    fingerprintArray(input.manualEntries, (m) => m.id + ':' + (m.updatedAt ?? m.createdAt ?? '')),
    taxKey,
    fingerprintArray(input.providers, (provider) => provider.id + ':' + (provider.score ?? '') + ':' + (provider.lastUpdatedAt ?? '')),
    fingerprintArray(
      input.cobranzaPayments ?? [],
      (payment) => payment.idPago + ':' + payment.importeRecibo + ':' + payment.pendienteAplicar,
    ),
    fingerprintArray(
      input.bajioStatements ?? [],
      (s) => s.cia + ':' + s.cuenta + ':' + s.fechaEstadoCuenta + ':' + s.movimientos.length,
    ),
    auxiliarTaxCoverageFingerprint(input.auxiliarReconciliation),
    cxpPaymentCoverageFingerprint(input.cxpPaymentCoverage),
    input.yearStart,
    input.yearEnd,
    input.today,
    input.initialCash,
    input.supplierInitialCash,
    input.minimumCash,
    input.granularity,
  ].join('|');
}

export interface PlanningRunCacheKeyArgs {
  scenarioId: string;
  includeManualEntries: boolean;
  sharedRunInputsKey: string;
  customKey: string;
  overrideKey: string;
  trendTag: string;
  granularity: ProjectionGranularity;
}

/** Llave de la corrida persistida (IndexedDB + LRU en memoria) de un escenario. */
export function planningRunCacheKey(args: PlanningRunCacheKeyArgs): string {
  const manual = args.includeManualEntries ? 'm1' : 'm0';
  return `planning-run:${args.scenarioId}:${manual}|${args.sharedRunInputsKey}|${args.customKey}|${args.overrideKey}|${args.trendTag}|g=${args.granularity}`;
}
