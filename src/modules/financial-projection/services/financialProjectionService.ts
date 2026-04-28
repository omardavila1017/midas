import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { CashFlowAssumptions, Client, Provider } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { calculateConfidenceBand } from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  CustomerCollectionProfile,
  FinancialMovement,
  SupplierFinancialProfile,
} from '../../shared-finance/types';
import { buildFinanceMockData, type FinanceMockData } from '../mock-data/financeMockData';

export interface FinancialProjectionSourceInput {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  asOfDate?: string;
}

export function buildFinancialProjectionSourceData(input: FinancialProjectionSourceInput): FinanceMockData {
  const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
  const mock = buildFinanceMockData(asOfDate);
  const realMovements = [
    ...bankMovements(input.bankStatements, input.companyCode),
    ...cxpMovements(input.cxpRecords, input.providers, input.companyCode, asOfDate),
    ...clientProjectionMovements(input.clients, input.assumptions, asOfDate),
    ...budgetMovements(input.budget, asOfDate),
  ];

  return {
    movements: realMovements.length >= 6 ? realMovements : mock.movements,
    scenarios: mock.scenarios,
    adjustments: mock.adjustments,
    suppliers: input.providers.length > 0 ? supplierProfiles(input.providers, input.cxpRecords) : mock.suppliers,
    customers: input.clients.length > 0 ? customerProfiles(input.clients, input.assumptions, asOfDate) : mock.customers,
    taxes: mock.taxes,
  };
}

export function calculateInitialCash(bankStatements: BankAccountStatement[], fallback = 76_300_000): number {
  const balances = bankStatements
    .map((statement) => statement.saldoFinal)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (balances.length === 0) return fallback;
  return balances.reduce((sum, value) => sum + value, 0);
}

function bankMovements(bankStatements: BankAccountStatement[], companyCode: string): FinancialMovement[] {
  const statements = companyCode === 'all'
    ? bankStatements
    : bankStatements.filter((statement) => statement.cia === companyCode);
  return statements.flatMap((statement) =>
    statement.movimientos.slice(-120).map((line, index) => {
      const type = line.tipoMovimiento === 'ABONO' ? 'INFLOW' : 'OUTFLOW';
      const score = 98;
      return {
        id: `bank:${statement.cia}:${statement.cuenta}:${line.referencia}:${line.fechaOperacion}:${index}`,
        sourceSystem: 'BANK',
        sourceObjectId: line.referencia,
        type,
        category: 'TRANSFER',
        companyId: statement.cia,
        bankAccountId: statement.cuenta,
        counterpartyType: 'BANK',
        concept: line.concepto || 'Movimiento bancario',
        currency: line.moneda || statement.moneda || 'MXN',
        originalAmount: line.importe,
        baseAmount: line.importe,
        projectedAmount: line.importe,
        actualDate: line.fechaOperacion,
        projectedDate: line.fechaOperacion,
        confidenceScore: score,
        confidenceBand: calculateConfidenceBand(score),
        forecastMethod: 'RULE',
        ruleApplied: 'Estado de cuenta bancario',
        status: 'REAL',
        lockState: 'LOCKED',
        comments: ['Dato real de banco; no editable desde planeación.'],
        createdAt: `${line.fechaOperacion}T00:00:00.000Z`,
        updatedAt: `${line.fechaOperacion}T00:00:00.000Z`,
      } satisfies FinancialMovement;
    }),
  );
}

function cxpMovements(
  records: CXPRecord[],
  providers: Provider[],
  companyCode: string,
  asOfDate: string,
): FinancialMovement[] {
  const providerByName = new Map(providers.map((provider) => [normalize(provider.name), provider]));
  return records
    .filter((record) => companyCode === 'all' || record.cia === companyCode)
    .filter((record) => record.importePendientePesos > 0)
    .slice(0, 160)
    .map((record, index) => {
      const provider = providerByName.get(normalize(record.nombre));
      const date = cleanDate(record.fechaProgramacionPago) || cleanDate(record.fechaVence) || shift(asOfDate, 7);
      const score = record.edoPago?.toUpperCase().includes('APROB') ? 90 : 76;
      return {
        id: `cxp:${record.cia}:${record.noProveedor}:${record.noFactura}:${index}`,
        sourceSystem: 'JDE',
        sourceObjectId: record.noFactura,
        type: 'OUTFLOW',
        category: 'AP_PAYMENT',
        companyId: record.cia,
        counterpartyId: provider?.id ?? record.noProveedor,
        counterpartyName: record.nombre,
        counterpartyType: 'SUPPLIER',
        concept: `Factura proveedor ${record.noFactura || 'sin folio'}`,
        currency: record.moneda || 'MXN',
        originalAmount: record.importePendientePesos,
        baseAmount: record.importePendientePesos,
        projectedAmount: record.importePendientePesos,
        issueDate: cleanDate(record.fechaFactura),
        dueDate: cleanDate(record.fechaVence),
        projectedDate: date,
        confidenceScore: score,
        confidenceBand: calculateConfidenceBand(score),
        forecastMethod: 'RULE',
        ruleApplied: provider?.flexibility ? `Proveedor ${provider.flexibility}` : 'Fecha programada JDE',
        status: 'PROJECTED_BASE',
        lockState: provider?.flexibility === 'inamovible' ? 'LOCKED' : 'RESTRICTED',
        comments: ['Dato JDE convertido a movimiento financiero.'],
        createdAt: `${asOfDate}T00:00:00.000Z`,
        updatedAt: `${asOfDate}T00:00:00.000Z`,
      } satisfies FinancialMovement;
    });
}

function clientProjectionMovements(
  clients: Client[],
  assumptions: CashFlowAssumptions,
  asOfDate: string,
): FinancialMovement[] {
  const month = Number(asOfDate.slice(5, 7)) - 1;
  return clients
    .filter((client) => (client.monthlyBilling[month] ?? 0) > 0)
    .slice(0, 40)
    .map((client, index) => {
      const amount = (client.monthlyBilling[month] ?? 0) * (client.complianceRate ?? assumptions.globalCompliance ?? 1);
      const date = shift(asOfDate, 10 + (index % 4) * 5 + client.creditDays);
      const score = Math.round(55 + Math.min(40, (client.complianceRate ?? assumptions.globalCompliance ?? 0.7) * 40));
      return {
        id: `client:${client.id}:${asOfDate}:${index}`,
        sourceSystem: 'FORECAST',
        sourceObjectId: client.id,
        type: 'INFLOW',
        category: 'AR_COLLECTION',
        counterpartyId: client.id,
        counterpartyName: client.name,
        counterpartyType: 'CUSTOMER',
        concept: `Factura proyectada ${client.name}`,
        currency: 'MXN',
        originalAmount: amount,
        baseAmount: amount,
        projectedAmount: amount,
        issueDate: asOfDate,
        dueDate: shift(asOfDate, client.creditDays),
        projectedDate: date,
        confidenceScore: score,
        confidenceBand: calculateConfidenceBand(score),
        forecastMethod: 'RULE',
        ruleApplied: paymentPatternLabel(client),
        status: 'PROJECTED_BASE',
        lockState: 'UNLOCKED',
        comments: ['Proyección desde catálogo de clientes; reemplazar por CxC real cuando exista API.'],
        createdAt: `${asOfDate}T00:00:00.000Z`,
        updatedAt: `${asOfDate}T00:00:00.000Z`,
      } satisfies FinancialMovement;
    });
}

function budgetMovements(budget: Budget | null, asOfDate: string): FinancialMovement[] {
  if (!budget) return [];
  const month = Number(asOfDate.slice(5, 7)) - 1;
  const total = budget.expenseTotal[month] ?? 0;
  if (total <= 0) return [];
  return [{
    id: `budget:opex:${budget.year}:${month + 1}`,
    sourceSystem: 'FORECAST',
    type: 'OUTFLOW',
    category: 'OPEX',
    concept: 'Presupuesto de gasto operativo',
    currency: 'MXN',
    originalAmount: total,
    baseAmount: total,
    projectedAmount: total,
    projectedDate: shift(asOfDate, 20),
    confidenceScore: 62,
    confidenceBand: 'MEDIUM',
    forecastMethod: 'DRIVER',
    ruleApplied: 'Presupuesto mensual cargado',
    status: 'PROJECTED_BASE',
    lockState: 'RESTRICTED',
    comments: ['Dato de presupuesto, editable sólo como ajuste de escenario.'],
    createdAt: `${asOfDate}T00:00:00.000Z`,
    updatedAt: `${asOfDate}T00:00:00.000Z`,
  }];
}

function supplierProfiles(providers: Provider[], records: CXPRecord[]): SupplierFinancialProfile[] {
  return providers.slice(0, 24).map((provider) => {
    const related = records.filter((record) => normalize(record.nombre) === normalize(provider.name));
    const pendingAmount = related.reduce((sum, record) => sum + Math.max(0, record.importePendientePesos), 0);
    const staleDays = provider.lastUpdatedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(provider.lastUpdatedAt).getTime()) / 86_400_000))
      : 0;
    return {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      category: provider.type,
      risk: provider.risk === 'Alto' ? 'HIGH_RISK' : provider.flexibility === 'inamovible' ? 'CRITICAL' : provider.flexibility === 'flexible' ? 'FLEXIBLE' : 'LOW_RISK',
      paymentFlexibility: provider.flexibility === 'inamovible' ? 'LOCKED' : provider.flexibility === 'revisar' ? 'REVIEW' : provider.flexibility === 'flexible' ? 'FLEXIBLE' : 'NEGOTIABLE',
      creditLimit: provider.creditLimit ?? 0,
      staleDays,
      pendingAmount,
      upcomingPayments: related.length,
      priority: provider.risk === 'Alto' ? 'P0' : provider.risk === 'Medio' ? 'P1' : 'P2',
      comment: provider.flexibilityComment ?? provider.riskComment,
    };
  });
}

function customerProfiles(clients: Client[], assumptions: CashFlowAssumptions, asOfDate: string): CustomerCollectionProfile[] {
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
      paymentHistory: compliance >= 0.9 ? 'ON_TIME' : compliance >= 0.75 ? 'USUALLY_LATE' : compliance >= 0.55 ? 'VOLATILE' : 'NEW',
      collectionProbability: compliance,
      owner: 'Cobranza',
      comment: client.notes,
    };
  });
}

function paymentPatternLabel(client: Client): string {
  if (client.paymentDayRaw) return client.paymentDayRaw;
  if (client.paymentDay.kind === 'ANY') return 'Sin patrón específico';
  if (client.paymentDay.kind === 'DOW') return `Días de semana ${client.paymentDay.days.join(', ')}`;
  if (client.paymentDay.kind === 'DOM') return `Día ${client.paymentDay.day} del mes`;
  if (client.paymentDay.kind === 'NTH_DOW') return `${client.paymentDay.nth} día ${client.paymentDay.day} del mes`;
  if (client.paymentDay.kind === 'DOM_LIST') return `Días ${client.paymentDay.days.join(', ')} del mes`;
  if (client.paymentDay.kind === 'WOM') return `Semanas ${client.paymentDay.weeks.join(', ')} del mes`;
  return `Día ${client.paymentDay.day} · semanas ${client.paymentDay.nths.join(', ')}`;
}

function cleanDate(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return undefined;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function shift(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
