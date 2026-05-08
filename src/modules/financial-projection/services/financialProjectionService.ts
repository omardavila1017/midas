// ─────────────────────────────────────────────────────────────────────────
// financialProjectionService — adapta los catálogos de Midas (clientes,
// proveedores, CXP, bancos, presupuesto) al modelo de "movimientos" que
// consume Proyección Financiera y Planeación Financiera.
//
// Reglas duras:
//   1. NUNCA caer a mock data. Si no hay datos suficientes, devolvemos
//      listas vacías y el caller muestra empty state. Antes este
//      servicio inyectaba "Diesel Norte", "Carrier Planta A", etc.
//      cuando había menos de 6 movimientos reales — eso confunde al
//      usuario y rompe la confianza en los números.
//   2. La trayectoria de caja viene del motor canónico del Dashboard
//      (computeBaseCashFlow) vía `buildCanonicalProjection`. No se
//      vuelve a calcular aquí.
//   3. La caja inicial anual coincide con el Dashboard. La caja operativa
//      diaria para decidir pagos se calcula aparte con el saldo bancario
//      más reciente por cuenta.
// ─────────────────────────────────────────────────────────────────────────

import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { RealReconciliationResult } from '../../../domain/realReconciliationEngine';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaRecord } from '../../../services/jdeTypes';
import {
  currentBankStatements,
  latestStatementDate,
  sumBankStatementBalances,
} from '../../../domain/bankStatements';
import {
  buildCanonicalProjection,
  hasSufficientCanonicalData,
  type CanonicalProjectionResult,
} from '../../shared-finance/calculation-engine/canonicalProjection';
import type {
  CustomerCollectionProfile,
  FinancialAdjustment,
  FinancialMovement,
  FinancialScenario,
  PayrollCostRecord,
  PurchaseReceiptRecord,
  SupplierFinancialProfile,
  TaxObligation,
} from '../../shared-finance/types';

export interface FinancialProjectionSourceInput {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  cobranzaRecords?: CobranzaRecord[];
  purchaseReceipts?: PurchaseReceiptRecord[];
  payrollCosts?: PayrollCostRecord[];
  /**
   * Resultado del cruce JDE ↔ banco. Cuando se pasa, las facturas con
   * `match.status === 'cobrada-banco'` no se vuelven a proyectar como
   * cobro pendiente. Forma parte del cache key: cuando el worker emite
   * un nuevo cruce, la proyección se recalcula automáticamente.
   */
  cobranzaReconciliation?: RealReconciliationResult;
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  startingBalance: number;
  asOfDate?: string;
}

export interface FinancialProjectionSourceData {
  /**
   * Movimientos derivados de los catálogos. Vacío cuando no hay datos
   * suficientes. La UI debe leer `hasData` antes de renderizar el módulo.
   */
  movements: FinancialMovement[];
  /** Default scenarios — siempre incluyen Base. */
  scenarios: FinancialScenario[];
  /** Por defecto vacío; los ajustes los crea el usuario. */
  adjustments: FinancialAdjustment[];
  suppliers: SupplierFinancialProfile[];
  customers: CustomerCollectionProfile[];
  /** Por ahora derivamos impuestos del CXP cuando aplica. Vacío si no. */
  taxes: TaxObligation[];
  /** Resultado canónico subyacente (mensual + bridge). */
  canonical: CanonicalProjectionResult;
  /** True cuando hay banco o CXC JDE suficiente para proyectar flujo. */
  hasData: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Module-level memo for `buildFinancialProjectionSourceData`. The canonical
// projection iterates clients × months × CXP × budget through
// `computeBaseCashFlow`, which is by far the heaviest piece of work in the
// module — anywhere from 80–250ms on a real catalog. The dashboard's
// `useMemo` only caches *per mount*, so navigating away from the tab and
// back was paying the full cost again. This cache survives navigation and
// component remounts; it lives for the lifetime of the JS module.
//
// Cache key folds in only the references that actually influence output —
// the inputs are immutable arrays from the Midas storage layer, so identity
// comparison is sufficient and avoids JSON.stringify on hot paths.
// ─────────────────────────────────────────────────────────────────────────

type CacheKey = string;
const SOURCE_CACHE = new Map<CacheKey, FinancialProjectionSourceData>();
const SOURCE_CACHE_LIMIT = 6;

function sourceCacheKey(input: FinancialProjectionSourceInput, asOfDate: string): CacheKey {
  // We mix array references via WeakRef-like identity sentinels: each
  // unique array gets a stable id assigned the first time we see it. This
  // is faster than JSON.stringify and avoids walking the data.
  const ids = [
    refId(input.bankStatements),
    refId(input.clients),
    refId(input.providers),
    refId(input.cxpRecords),
    refId(input.cobranzaRecords),
    refId(input.purchaseReceipts),
    refId(input.payrollCosts),
    refId(input.cobranzaReconciliation),
    refId(input.assumptions),
    refId(input.budget),
  ];
  return [
    input.companyCode,
    asOfDate,
    input.startingBalance,
    ...ids,
  ].join('|');
}

const REF_IDS = new WeakMap<object, number>();
let nextRefId = 1;
function refId(value: unknown): number | string {
  if (value === null || value === undefined) return 'n';
  if (typeof value !== 'object') return String(value);
  const existing = REF_IDS.get(value as object);
  if (existing !== undefined) return existing;
  const id = nextRefId++;
  REF_IDS.set(value as object, id);
  return id;
}

export function buildFinancialProjectionSourceData(
  input: FinancialProjectionSourceInput,
): FinancialProjectionSourceData {
  const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
  const cacheKey = sourceCacheKey(input, asOfDate);
  const cached = SOURCE_CACHE.get(cacheKey);
  if (cached) {
    // Refresh insertion order so frequently-used entries stay hot.
    SOURCE_CACHE.delete(cacheKey);
    SOURCE_CACHE.set(cacheKey, cached);
    return cached;
  }

  const canonicalInputs = {
    companyCode: input.companyCode,
    bankStatements: input.bankStatements,
    clients: input.clients,
    providers: input.providers,
    cxpRecords: input.cxpRecords,
    cobranzaRecords: input.cobranzaRecords ?? [],
    purchaseReceipts: input.purchaseReceipts ?? [],
    payrollCosts: input.payrollCosts ?? [],
    cobranzaReconciliation: input.cobranzaReconciliation,
    assumptions: input.assumptions,
    budget: input.budget,
    startingBalance: input.startingBalance,
    asOfDate,
  };
  const hasData = hasSufficientCanonicalData(canonicalInputs);

  // Motor canónico (mismo que el Dashboard). Si no hay datos seguimos
  // construyéndolo — produce listas vacías sin reventar — para mantener
  // simple el contrato de retorno.
  const canonical = buildCanonicalProjection(canonicalInputs);

  const scenarios = defaultScenarios(asOfDate);
  const customers = customerProfiles(input.clients, input.assumptions, asOfDate);
  const suppliers = supplierProfiles(input.providers, input.cxpRecords);

  const result: FinancialProjectionSourceData = {
    movements: canonical.movements,
    scenarios,
    adjustments: [],
    suppliers,
    customers,
    taxes: [],
    canonical,
    hasData,
  };
  SOURCE_CACHE.set(cacheKey, result);
  if (SOURCE_CACHE.size > SOURCE_CACHE_LIMIT) {
    const oldest = SOURCE_CACHE.keys().next().value as CacheKey | undefined;
    if (oldest !== undefined) SOURCE_CACHE.delete(oldest);
  }
  return result;
}

/**
 * Cheap cache lookup that does NOT trigger the canonical projection build.
 * Lets the dashboard render the chrome on the first commit while it knows
 * whether it has to schedule heavy work or not.
 */
export function tryGetCachedFinancialProjectionSourceData(
  input: FinancialProjectionSourceInput,
): FinancialProjectionSourceData | null {
  const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
  return SOURCE_CACHE.get(sourceCacheKey(input, asOfDate)) ?? null;
}

/**
 * Test/debug hook — clear the source cache. Not used at runtime.
 */
export function __clearProjectionSourceCache(): void {
  SOURCE_CACHE.clear();
}

/**
 * Caja inicial canónica — misma prioridad que `computeBaseCashFlow` del
 * Dashboard:
 *   1. `startingBalance` numérico (override manual del usuario)
 *   2. `budget.openingCash[0]` (caja inicial declarada en el presupuesto)
 *   3. Σ saldoInicial de los estados de cuenta de la compañía activa
 *
 * Antes este helper ignoraba `startingBalance` y `budget.openingCash`, y
 * además sumaba el saldoInicial de TODAS las cuentas sin filtrar por
 * `companyCode`. Eso inflaba la caja proyectada de Trayectoria de caja
 * cuando el usuario tenía una sola compañía seleccionada o un override
 * manual de caja inicial — la línea de caja en Caja proyectada no empataba
 * con el Flujo mensual del Dashboard.
 */
export function calculateInitialCash(
  bankStatements: BankAccountStatement[],
  startingBalance: number | undefined,
  options?: { companyCode?: string; budget?: Budget | null },
): number {
  if (typeof startingBalance === 'number') return startingBalance;
  const budgetOpening = options?.budget?.openingCash?.[0];
  if (typeof budgetOpening === 'number') return budgetOpening;
  const companyCode = options?.companyCode;
  const filtered = !companyCode || companyCode === 'all'
    ? bankStatements
    : bankStatements.filter((s) => s.cia === companyCode);
  if (filtered.length === 0) return startingBalance ?? 0;
  return filtered.reduce(
    (sum, statement) => sum + (statement.saldoInicial ?? 0),
    0,
  );
}

export function calculateCurrentBankCash(
  bankStatements: BankAccountStatement[],
  companyCode = 'all',
  fallback = 0,
): number {
  const scoped = companyCode === 'all' || !companyCode
    ? bankStatements
    : bankStatements.filter((statement) => statement.cia === companyCode);
  const latest = latestStatementDate(scoped);
  const current = currentBankStatements(scoped, latest);
  if (current.length === 0) return fallback;
  const total = sumBankStatementBalances(current);
  return total > 0 ? total : fallback;
}

function defaultScenarios(asOfDate: string): FinancialScenario[] {
  const now = `${asOfDate}T00:00:00.000Z`;
  return [
    {
      id: 'base',
      name: 'Escenario Base',
      kind: 'BASE',
      description: 'Proyección canónica del Dashboard. No editable.',
      adjustmentIds: [],
      status: 'APPROVED',
      isBase: true,
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'approved',
      name: 'Escenario Aprobado',
      kind: 'APPROVED',
      description: 'Plan vivo que se ejecuta en operación. Cambia mediante merge de propuestas.',
      adjustmentIds: [],
      status: 'APPROVED',
      createdBy: 'system',
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function supplierProfiles(providers: Provider[], records: CXPRecord[]): SupplierFinancialProfile[] {
  if (providers.length === 0) return [];
  return providers.slice(0, 24).map((provider) => {
    const related = records.filter(
      (record) => normalize(record.nombre) === normalize(provider.name),
    );
    const pendingAmount = related.reduce(
      (sum, record) => sum + Math.max(0, record.importePendientePesos),
      0,
    );
    const staleDays = provider.lastUpdatedAt
      ? Math.max(
          0,
          Math.floor((Date.now() - new Date(provider.lastUpdatedAt).getTime()) / 86_400_000),
        )
      : 0;
    return {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      category: provider.type,
      risk:
        provider.risk === 'Alto'
          ? 'HIGH_RISK'
          : provider.flexibility === 'inamovible'
          ? 'CRITICAL'
          : provider.flexibility === 'flexible'
          ? 'FLEXIBLE'
          : 'LOW_RISK',
      paymentFlexibility:
        provider.flexibility === 'inamovible'
          ? 'LOCKED'
          : provider.flexibility === 'revisar'
          ? 'REVIEW'
          : provider.flexibility === 'flexible'
          ? 'FLEXIBLE'
          : 'NEGOTIABLE',
      creditLimit: provider.creditLimit ?? 0,
      staleDays,
      pendingAmount,
      upcomingPayments: related.length,
      priority: provider.risk === 'Alto' ? 'P0' : provider.risk === 'Medio' ? 'P1' : 'P2',
      comment: provider.flexibilityComment ?? provider.riskComment,
    };
  });
}

function customerProfiles(
  clients: Client[],
  assumptions: CashFlowAssumptions,
  asOfDate: string,
): CustomerCollectionProfile[] {
  if (clients.length === 0) return [];
  const month = Number(asOfDate.slice(5, 7)) - 1;
  return clients.slice(0, 24).map((client) => {
    const compliance = client.complianceRate ?? assumptions.globalCompliance ?? 0.7;
    const pendingAmount = (client.monthlyBilling[month] ?? 0) * compliance;
    return {
      id: client.id,
      name: client.name,
      groupName: client.commercialGroupName,
      legalNames: [client.legalName ?? client.name],
      pendingInvoices: pendingAmount > 0 ? Math.max(1, Math.round(pendingAmount / 2_500_000)) : 0,
      pendingAmount,
      theoreticalCollectionDate: shift(asOfDate, client.creditDays),
      projectedCollectionDate: shift(asOfDate, client.creditDays + 7),
      creditDays: client.creditDays,
      paymentPattern: paymentPatternLabel(client),
      paymentHistory:
        compliance >= 0.9
          ? 'ON_TIME'
          : compliance >= 0.75
          ? 'USUALLY_LATE'
          : compliance >= 0.55
          ? 'VOLATILE'
          : 'NEW',
      collectionProbability: compliance,
      owner: 'Cobranza',
      comment: client.notes,
    };
  });
}

function paymentPatternLabel(client: Client): string {
  if (client.paymentDayRaw) return client.paymentDayRaw;
  if (client.paymentDay.kind === 'ANY') return 'Sin patrón específico';
  if (client.paymentDay.kind === 'DOW') return `Días ${client.paymentDay.days.join(', ')}`;
  if (client.paymentDay.kind === 'DOM') return `Día ${client.paymentDay.day}`;
  if (client.paymentDay.kind === 'NTH_DOW') return `${client.paymentDay.nth} día ${client.paymentDay.day}`;
  if (client.paymentDay.kind === 'DOM_LIST') return `Días ${client.paymentDay.days.join(', ')}`;
  if (client.paymentDay.kind === 'WOM') return `Semanas ${client.paymentDay.weeks.join(', ')}`;
  return `Día ${client.paymentDay.day}`;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function shift(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
