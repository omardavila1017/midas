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
//   3. La caja inicial coincide con la del Dashboard (FIXED_STARTING_BALANCE
//      o budget.openingCash[0] o saldoInicial bancario, en ese orden).
// ─────────────────────────────────────────────────────────────────────────

import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
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
  SupplierFinancialProfile,
  TaxObligation,
} from '../../shared-finance/types';

export interface FinancialProjectionSourceInput {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
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
  /** True cuando hay banco + (clientes/CXP/budget). */
  hasData: boolean;
}

export function buildFinancialProjectionSourceData(
  input: FinancialProjectionSourceInput,
): FinancialProjectionSourceData {
  const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
  const canonicalInputs = {
    companyCode: input.companyCode,
    bankStatements: input.bankStatements,
    clients: input.clients,
    providers: input.providers,
    cxpRecords: input.cxpRecords,
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

  return {
    movements: canonical.movements,
    scenarios,
    adjustments: [],
    suppliers,
    customers,
    taxes: [],
    canonical,
    hasData,
  };
}

/**
 * Caja inicial canónica — mismo dato que usa el Dashboard. Antes este
 * helper sumaba `saldoFinal` de las cuentas (que no es la caja inicial:
 * es la caja al cierre de cada cuenta), y se desviaba completamente del
 * Dashboard. Ahora simplemente expone la caja inicial congruente con el
 * resto del producto.
 */
export function calculateInitialCash(
  bankStatements: BankAccountStatement[],
  fallback: number,
): number {
  if (bankStatements.length === 0) return fallback;
  const sumSaldoInicial = bankStatements.reduce(
    (sum, statement) => sum + (statement.saldoInicial ?? 0),
    0,
  );
  return sumSaldoInicial > 0 ? sumSaldoInicial : fallback;
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
