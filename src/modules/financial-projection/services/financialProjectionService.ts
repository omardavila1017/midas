// ─────────────────────────────────────────────────────────────────────────
// financialProjectionService — adapta los catálogos de Midas (clientes,
// proveedores, CXP, bancos y cobranza real) al modelo de "movimientos" que
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
import type { AuxiliarReconResult } from '../../../domain/auxiliarReconciliationEngine';
import {
  adaptAuxiliarForProjection,
  mergeCargoEnrichments,
  type BankOutflowEnrichment,
} from '../../../domain/auxiliarProjectionAdapter';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaRecord, RolRecord, ViajeEspecialRecord } from '../../../services/jdeTypes';
import { todayISO } from '../../../formatters';
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
} from '../../shared-finance/types';

export interface FinancialProjectionSourceInput {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  cobranzaRecords?: CobranzaRecord[];
  /** ROL CITI: viajes ejecutados. Forma parte del cache key. */
  rolRecords?: RolRecord[];
  /**
   * Viajes Especiales (API srv-desarrollo:95).
   *
   * Forma parte del cache key (memo + persistente): emite ingreso REAL
   * (`cxc:especial:viaje:` fechado con Fecha_Factura + Dias_Credito del API) y
   * re-etiqueta los `cxc:` cruzados, así que mueve el dinero de la proyección.
   * Hasta 2026-08-11 el comentario decía "forma parte del cache key" pero sólo
   * estaba en el del memo: el persistente le servía al tablero una entrada
   * construida antes de que los viajes aterrizaran.
   */
  viajesEspecialesRecords?: ViajeEspecialRecord[];
  purchaseReceipts?: PurchaseReceiptRecord[];
  payrollCosts?: PayrollCostRecord[];
  /**
   * Resultado del motor de conciliación histórica (AuxiliarContable ↔
   * banco). Forma parte del cache key: cuando el worker emite un cruce
   * nuevo, la proyección se recalcula. El servicio lo traduce internamente
   * (`adaptAuxiliarForProjection`) a las señales que consume el canónico:
   * facturas cobradas, CXPs pagadas y enriquecimiento de movimientos.
   */
  auxiliarReconciliation?: AuxiliarReconResult;
  /**
   * `bankMovementKey` → pago a proveedor cruzado por `paymentReconciliationEngine`.
   *
   * Es la ÚNICA fuente que trae la **clasificación JDE** del proveedor
   * (`Clasificacion_Proveedor` + `…_Financiera`) y su `claveProveedor` para un
   * CARGO histórico. El puente auxiliar sólo puede nombrar la contraparte con el
   * texto del libro mayor, así que sin esto el bucket del egreso histórico lo
   * decidía un lookup por nombre contra el catálogo de proveedores (~23% de
   * cobertura). Se une al puente en `mergeCargoEnrichments` — ver el porqué ahí.
   *
   * Forma parte del cache key (memo + persistente): cambia la salida.
   */
  paymentCargoEnrichments?: Map<string, BankOutflowEnrichment>;
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  /**
   * Override manual. `undefined` → calculateInitialCash suma saldoInicial
   * real de los bankStatements provistos.
   */
  startingBalance?: number;
  asOfDate?: string;
  /**
   * Si false, el canonical no entrena el motor predictivo (`canonical.predictive`
   * queda null) y se ahorran varios cientos de ms.
   *
   * OJO: **Proyección Y Planeación SÍ lo consumen** — `source.canonical.predictive`
   * es lo que alimenta `trendAvailable` y, con él, el top-off de tendencia
   * (`forecast:trend:`) que va SIEMPRE en los escenarios no-Base. Apagarlo NO es
   * gratis para esos tableros: cambia las cifras proyectadas. Sólo pásalo `false`
   * desde un consumidor que no lea `predictive` (hoy: KpisObjectivesDashboard).
   * Es parte de la llave del memo y del cache persistente, así que un build sin
   * predictivo ya no se le puede servir a un tablero que sí lo necesita.
   */
  enablePredictive?: boolean;
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
  /** Resultado canónico subyacente (mensual + bridge). */
  canonical: CanonicalProjectionResult;
  /**
   * Set `${cia}::${noOrdenCompra}` de OCs pagadas según AuxiliarContable.
   * Mismo set que el canónico ya consume. Se expone aquí para que el
   * acumulador fiscal (taxModuleService) lo reciba via worker args y evite
   * doble-conteo de IVA acreditable.
   */
  paidPurchaseOrderKeys: Set<string>;
  /** True cuando hay banco o CXC JDE suficiente para proyectar flujo. */
  hasData: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Module-level memo for `buildFinancialProjectionSourceData`. The canonical
// projection iterates clients × months × CXP through
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
// Cada FinancialProjectionSourceData es ENORME (cobranza ~46k + compras
// ~334k + payroll + movimientos canónicos ~100k+ → cientos de MB). El límite
// previo de 20 era un techo de varios GB; bajado a 2 (cold boot) y ahora a
// 1 (2026-05-20) tras heap snapshot que mostró {id, sourceSystem} reteniendo
// 517MB (56% del heap) — cada source pesa ~250MB con la cobranza/compras
// reales, y mantener uno previo "por si acaso" sale a media RAM. La UI solo
// renderiza el source CURRENT; el persistent cache (IDB) rehidrata si el
// usuario navega y vuelve.
const SOURCE_CACHE_LIMIT = 1;

/**
 * Memory pressure escape hatch — runtimeGuardian llama cuando heap > 85% del
 * límite del browser. SOURCE_CACHE pesa ~250MB con datasets reales; liberarlo
 * preempte Error code: 5. El siguiente render lo recomputa (segundos visibles).
 * Expuesto como función para que el dashboard la registre desde main thread —
 * un side-effect en module init rompía el bundling de los workers (no admiten
 * dynamic imports anidados con code-splitting).
 */
export function clearProjectionSourceCache(): void {
  if (SOURCE_CACHE.size === 0) return;
  // eslint-disable-next-line no-console
  console.warn(`[financialProjectionService] clearing SOURCE_CACHE (size=${SOURCE_CACHE.size})`);
  SOURCE_CACHE.clear();
}

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
    refId(input.rolRecords),
    refId(input.viajesEspecialesRecords),
    refId(input.purchaseReceipts),
    refId(input.payrollCosts),
    refId(input.auxiliarReconciliation),
    refId(input.paymentCargoEnrichments),
    refId(input.assumptions),
    refId(input.budget),
  ];
  return [
    input.companyCode,
    asOfDate,
    input.startingBalance,
    // `enablePredictive` CAMBIA la salida (`canonical.predictive` = null cuando
    // esta apagado, via dashboardEngine), asi que es parte de la llave: sin el,
    // los dos variantes comparten entrada y el que llegue primero le sirve su
    // resultado al otro. La direccion que muerde: KpisObjectivesDashboard
    // construye con `enablePredictive:false` en el hilo principal, y con
    // SOURCE_CACHE_LIMIT=1 esa entrada es la que Proyeccion/Planeacion recogen
    // por `tryGetCachedFinancialProjectionSourceData` -> `predictive` ausente
    // -> `trendAvailable=false` -> el top-off de tendencia (`forecast:trend:`,
    // siempre activo fuera de Base) desaparece de los escenarios y los meses
    // futuros salen mas bajos, segun que tab se abrio primero. El cache
    // PERSISTENTE ya llavea por esto (`financialProjectionPersistentCache.ts`);
    // el memo de modulo era el inconsistente. Regla: todo input que mueva la
    // salida va en la llave.
    `predictive=${input.enablePredictive !== false ? '1' : '0'}`,
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
  const asOfDate = input.asOfDate ?? todayISO();
  const cacheKey = sourceCacheKey(input, asOfDate);
  const cached = SOURCE_CACHE.get(cacheKey);
  if (cached) {
    // Refresh insertion order so frequently-used entries stay hot.
    SOURCE_CACHE.delete(cacheKey);
    SOURCE_CACHE.set(cacheKey, cached);
    return cached;
  }

  // Traduce el cruce AuxiliarContable a las señales que consume el canónico.
  const bridge = adaptAuxiliarForProjection(
    input.auxiliarReconciliation,
    input.cxpRecords,
    input.cobranzaRecords ?? [],
  );

  const canonicalInputs = {
    companyCode: input.companyCode,
    bankStatements: input.bankStatements,
    clients: input.clients,
    providers: input.providers,
    cxpRecords: input.cxpRecords,
    cobranzaRecords: input.cobranzaRecords ?? [],
    rolRecords: input.rolRecords ?? [],
    viajesEspecialesRecords: input.viajesEspecialesRecords ?? [],
    purchaseReceipts: input.purchaseReceipts ?? [],
    payrollCosts: input.payrollCosts ?? [],
    cobradaBancoKeys: bridge.cobradaBancoKeys,
    abonoEnrichments: bridge.abonoEnrichments,
    paidCxpKeys: bridge.paidCxpKeys,
    paidPurchaseOrderKeys: bridge.paidPurchaseOrderKeys,
    // El puente del mayor dice QUÉ CARGO es pago a proveedor; el motor de pagos
    // dice QUIÉN es y cómo lo clasifica JDE. Sin la unión, lo segundo no llegaba.
    cargoEnrichments: mergeCargoEnrichments(bridge.cargoEnrichments, input.paymentCargoEnrichments),
    // Líneas GL completas — canonicalProjection las usa en step 1c para
    // emitir `auxiliar-historic:*` cuando un mes no tiene banco cargado
    // (cubre egresos pasados que cobranza-historic no rellena).
    auxiliarReconLines: input.auxiliarReconciliation?.lines,
    // MOTOR 1: totales reconciliados Auxiliar×Bancos por (cía, mes) — re-sourcean
    // los brutos históricos del `monthly[]` a la verdad contable.
    reconciledByCompanyMonth: bridge.reconciledByCompanyMonth,
    assumptions: input.assumptions,
    budget: input.budget,
    startingBalance: input.startingBalance,
    enablePredictive: input.enablePredictive,
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
    canonical,
    paidPurchaseOrderKeys: bridge.paidPurchaseOrderKeys,
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
  const asOfDate = input.asOfDate ?? todayISO();
  return SOURCE_CACHE.get(sourceCacheKey(input, asOfDate)) ?? null;
}

export function rememberFinancialProjectionSourceData(
  input: FinancialProjectionSourceInput,
  result: FinancialProjectionSourceData,
): void {
  const asOfDate = input.asOfDate ?? todayISO();
  const cacheKey = sourceCacheKey(input, asOfDate);
  if (SOURCE_CACHE.has(cacheKey)) SOURCE_CACHE.delete(cacheKey);
  SOURCE_CACHE.set(cacheKey, result);
  if (SOURCE_CACHE.size > SOURCE_CACHE_LIMIT) {
    const oldest = SOURCE_CACHE.keys().next().value as CacheKey | undefined;
    if (oldest !== undefined) SOURCE_CACHE.delete(oldest);
  }
}

/**
 * Test/debug hook — clear the source cache. Not used at runtime.
 */
export function __clearProjectionSourceCache(): void {
  SOURCE_CACHE.clear();
}

/**
 * Caja inicial canónica — misma prioridad operativa que `computeBaseCashFlow`
 * del Dashboard:
 *   1. `startingBalance` numérico (override manual del usuario)
 *   2. Σ saldoInicial de los estados de cuenta de la compañía activa
 *
 * Antes este helper ignoraba `startingBalance` y sumaba el saldoInicial
 * de TODAS las cuentas sin filtrar por
 * `companyCode`. Eso inflaba la caja proyectada de Trayectoria de caja
 * cuando el usuario tenía una sola compañía seleccionada o un override
 * manual de caja inicial — la línea de caja en Caja proyectada no empataba
 * con el Flujo mensual del Dashboard.
 */
export function calculateInitialCash(
  bankStatements: BankAccountStatement[],
  startingBalance: number | undefined,
  options?: { companyCode?: string },
): number {
  if (typeof startingBalance === 'number') return startingBalance;
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
