import {
  calculateConfidenceBand,
  calculateMovementConfidence,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type {
  CustomerCollectionProfile,
  FinancialAdjustment,
  FinancialMovement,
  FinancialMovementCategory,
  FinancialMovementType,
  FinancialScenario,
  SupplierFinancialProfile,
  TaxObligation,
} from '../../shared-finance/types';

export interface FinanceMockData {
  movements: FinancialMovement[];
  scenarios: FinancialScenario[];
  adjustments: FinancialAdjustment[];
  suppliers: SupplierFinancialProfile[];
  customers: CustomerCollectionProfile[];
  taxes: TaxObligation[];
}

const NOW = '2026-05-01T12:00:00.000Z';

export function buildFinanceMockData(asOfDate = '2026-05-01'): FinanceMockData {
  const suppliers: SupplierFinancialProfile[] = [
    { id: 'sup-diesel-norte', name: 'Diesel Norte', type: 'Combustible', category: 'OPEX', risk: 'CRITICAL', paymentFlexibility: 'REVIEW', creditLimit: 18_000_000, staleDays: 3, pendingAmount: 11_800_000, upcomingPayments: 4, priority: 'P0', comment: 'Proveedor operativo sensible; renegociar antes de patear.' },
    { id: 'sup-llantas-roma', name: 'Llantas Roma', type: 'Refacciones', category: 'OPEX', risk: 'STRATEGIC', paymentFlexibility: 'NEGOTIABLE', creditLimit: 7_500_000, staleDays: 9, pendingAmount: 3_450_000, upcomingPayments: 2, priority: 'P1' },
    { id: 'sup-seguros-fleet', name: 'Seguros Fleet', type: 'Seguros', category: 'OPEX', risk: 'HIGH_RISK', paymentFlexibility: 'LOCKED', creditLimit: 0, staleDays: 1, pendingAmount: 8_100_000, upcomingPayments: 1, priority: 'P0', comment: 'No mover sin aprobación.' },
    { id: 'sup-talleres-mty', name: 'Talleres MTY', type: 'Mantenimiento', category: 'OPEX', risk: 'FLEXIBLE', paymentFlexibility: 'FLEXIBLE', creditLimit: 4_000_000, staleDays: 17, pendingAmount: 1_950_000, upcomingPayments: 3, priority: 'P2' },
    { id: 'sup-ti-critical', name: 'Infra TI Crítica', type: 'Tecnología', category: 'CAPEX', risk: 'BLOCKED', paymentFlexibility: 'LOCKED', creditLimit: 2_000_000, staleDays: 6, pendingAmount: 2_600_000, upcomingPayments: 1, priority: 'P1' },
  ];

  const customers: CustomerCollectionProfile[] = [
    { id: 'cus-carrier-a', name: 'Carrier Planta A', groupName: 'Grupo Carrier', legalNames: ['Carrier México S.A. de C.V.'], pendingInvoices: 4, pendingAmount: 13_800_000, theoreticalCollectionDate: shift(asOfDate, 4), projectedCollectionDate: nextWeekday(shift(asOfDate, 4), 5), creditDays: 30, paymentPattern: 'Primer viernes de cada mes', paymentHistory: 'ON_TIME', collectionProbability: 0.92, owner: 'Cobranza Norte' },
    { id: 'cus-carrier-b', name: 'Carrier Planta B', groupName: 'Grupo Carrier', legalNames: ['Carrier Servicios S. de R.L.'], pendingInvoices: 3, pendingAmount: 9_600_000, theoreticalCollectionDate: shift(asOfDate, 9), projectedCollectionDate: nextWeekday(shift(asOfDate, 9), 5), creditDays: 30, paymentPattern: 'Viernes semanal', paymentHistory: 'USUALLY_LATE', collectionProbability: 0.78, owner: 'Cobranza Norte' },
    { id: 'cus-cemex', name: 'Cemex Logística', groupName: 'Grupo Cemex', legalNames: ['Cemex Operaciones México S.A. de C.V.'], pendingInvoices: 5, pendingAmount: 15_400_000, theoreticalCollectionDate: shift(asOfDate, 14), projectedCollectionDate: lastBusinessDayOfMonth(asOfDate), creditDays: 45, paymentPattern: 'Último día hábil del mes', paymentHistory: 'ON_TIME', collectionProbability: 0.88, owner: 'Cobranza Centro' },
    { id: 'cus-aero', name: 'AeroPartes Bajío', legalNames: ['AeroPartes Bajío S.A.P.I.'], pendingInvoices: 2, pendingAmount: 4_200_000, theoreticalCollectionDate: shift(asOfDate, 21), projectedCollectionDate: nextWeekday(shift(asOfDate, 21), 4), creditDays: 30, paymentPattern: 'Jueves posterior a vencimiento', paymentHistory: 'VOLATILE', collectionProbability: 0.61, owner: 'Cobranza Bajío' },
    { id: 'cus-retail', name: 'Retail Express', legalNames: ['Retail Express Nacional S.A.'], pendingInvoices: 6, pendingAmount: 6_750_000, theoreticalCollectionDate: shift(asOfDate, 28), projectedCollectionDate: nextWeekday(shift(asOfDate, 28), 1), creditDays: 60, paymentPattern: 'Lunes posterior a corte', paymentHistory: 'NEW', collectionProbability: 0.54, owner: 'Cobranza Corporativa' },
  ];

  const taxes: TaxObligation[] = [
    { id: 'tax-iva-may', taxType: 'IVA', sourceSystem: 'MANUAL', totalAmount: 7_250_000, paidAmount: 0, pendingAmount: 7_250_000, dueDate: shift(asOfDate, 16), paymentPlan: [{ id: 'tax-iva-may-1', date: shift(asOfDate, 16), amount: 7_250_000, status: 'DRAFT' }], risk: 'HIGH', comment: 'Captura manual de tesorería; pendiente validar contabilidad.', status: 'OPEN' },
    { id: 'tax-isr-may', taxType: 'ISR', sourceSystem: 'MANUAL', totalAmount: 5_800_000, paidAmount: 1_000_000, pendingAmount: 4_800_000, dueDate: shift(asOfDate, 18), paymentPlan: [{ id: 'tax-isr-may-1', date: shift(asOfDate, 18), amount: 4_800_000, status: 'DRAFT' }], risk: 'MEDIUM', status: 'PARTIAL' },
    { id: 'tax-imss-may', taxType: 'IMSS', sourceSystem: 'JDE', totalAmount: 3_350_000, paidAmount: 0, pendingAmount: 3_350_000, dueDate: shift(asOfDate, 20), paymentPlan: [{ id: 'tax-imss-may-1', date: shift(asOfDate, 20), amount: 3_350_000, status: 'DRAFT' }], risk: 'LEGAL', comment: 'No patear sin aprobación CFO.', status: 'OPEN' },
  ];

  const movements: FinancialMovement[] = [
    movement('real-bank-open-1', 'BANK', 'INFLOW', 'TRANSFER', asOfDate, 2_800_000, 'Saldo real bancos', 'BANK', 'REAL', 'CONFIRMED'),
    collection('ar-carrier-a-1', customers[0], shift(asOfDate, 3), 4_200_000, 93, 'Factura proyectada 900142'),
    collection('ar-carrier-a-2', customers[0], shift(asOfDate, 7), 3_750_000, 88, 'Factura proyectada 900188'),
    collection('ar-carrier-b-1', customers[1], shift(asOfDate, 8), 4_100_000, 78, 'Factura proyectada 811920'),
    collection('ar-cemex-1', customers[2], shift(asOfDate, 12), 6_900_000, 86, 'Factura proyectada 772001'),
    collection('ar-cemex-2', customers[2], shift(asOfDate, 25), 8_500_000, 82, 'Factura proyectada 772145'),
    collection('ar-aero-1', customers[3], shift(asOfDate, 20), 4_200_000, 61, 'Factura proyectada 600311'),
    collection('ar-retail-1', customers[4], shift(asOfDate, 29), 3_250_000, 54, 'Factura proyectada 188010'),
    collection('ar-retail-2', customers[4], shift(asOfDate, 46), 3_500_000, 52, 'Factura proyectada 188144'),
    outflow('ap-diesel-1', suppliers[0], shift(asOfDate, 2), 4_800_000, 'Factura proveedor D-11012', 'AP_PAYMENT', 84),
    outflow('ap-diesel-2', suppliers[0], shift(asOfDate, 9), 3_600_000, 'Factura proveedor D-11205', 'AP_PAYMENT', 80),
    outflow('ap-llantas-1', suppliers[1], shift(asOfDate, 5), 1_850_000, 'Factura proveedor LL-7780', 'AP_PAYMENT', 76),
    outflow('ap-llantas-2', suppliers[1], shift(asOfDate, 19), 1_600_000, 'Factura proveedor LL-7812', 'AP_PAYMENT', 72),
    outflow('ap-seguros-1', suppliers[2], shift(asOfDate, 11), 8_100_000, 'Póliza flotilla mayo', 'AP_PAYMENT', 90, 'LOCKED'),
    outflow('ap-talleres-1', suppliers[3], shift(asOfDate, 13), 850_000, 'Mantenimiento unidades patio norte', 'AP_PAYMENT', 67),
    outflow('ap-talleres-2', suppliers[3], shift(asOfDate, 27), 1_100_000, 'Mantenimiento preventivo', 'AP_PAYMENT', 64),
    outflow('capex-ti-1', suppliers[4], shift(asOfDate, 34), 2_600_000, 'Renovación firewalls', 'CAPEX', 70, 'LOCKED'),
    taxMovement(taxes[0], 78),
    taxMovement(taxes[1], 74),
    taxMovement(taxes[2], 96),
    movement('payroll-may-1', 'PAYROLL', 'OUTFLOW', 'PAYROLL', shift(asOfDate, 14), 13_600_000, 'Nómina primera quincena', 'EMPLOYEE', 'PROJECTED_BASE', 'HIGH', 'LOCKED'),
    movement('payroll-may-2', 'PAYROLL', 'OUTFLOW', 'PAYROLL', shift(asOfDate, 29), 13_800_000, 'Nómina segunda quincena', 'EMPLOYEE', 'PROJECTED_BASE', 'HIGH', 'LOCKED'),
    movement('debt-bbva-1', 'JDE', 'OUTFLOW', 'DEBT', shift(asOfDate, 23), 5_400_000, 'Servicio deuda BBVA', 'BANK', 'PROJECTED_BASE', 'HIGH', 'RESTRICTED'),
    movement('opex-rent-1', 'FORECAST', 'OUTFLOW', 'OPEX', shift(asOfDate, 31), 2_150_000, 'Rentas terminales', 'INTERNAL', 'PROJECTED_BASE', 'MEDIUM'),
    movement('manual-opex-1', 'MANUAL', 'OUTFLOW', 'MANUAL', shift(asOfDate, 17), 750_000, 'Contingencia operativa', 'INTERNAL', 'PROJECTED_BASE', 'LOW'),
  ];

  const scenarios: FinancialScenario[] = [
    scenario('base', 'Escenario Base', 'BASE', [], 'APPROVED', true),
    scenario('conservative', 'Escenario Conservador', 'CONSERVATIVE', ['adj-cobranza-baja', 'adj-patear-flexibles'], 'DRAFT'),
    scenario('optimistic', 'Escenario Optimista', 'OPTIMISTIC', ['adj-adelantar-carrier', 'adj-ventas-upside'], 'DRAFT'),
    scenario('crisis', 'Escenario Crisis', 'CRISIS', ['adj-cobranza-baja', 'adj-cancelar-capex', 'adj-linea-credito'], 'IN_REVIEW'),
    scenario('liquidity', 'Escenario Liquidez', 'LIQUIDITY', ['adj-patear-flexibles', 'adj-split-iva', 'adj-linea-credito'], 'DRAFT'),
    scenario('custom', 'Escenario Personalizado', 'CUSTOM', [], 'DRAFT'),
  ];

  const adjustments: FinancialAdjustment[] = [
    adjustment('adj-adelantar-carrier', 'Adelantar cobranza Carrier', ['optimistic'], 'DATE_SHIFT', 'MOVEMENT', 'ar-carrier-b-1', 'UPSIDE', 'Cliente confirma corrida de pagos semanal.', { adjustedValue: shift(asOfDate, 4), deltaDays: -4 }),
    adjustment('adj-cobranza-baja', 'Reducir cobranza volátil 20%', ['conservative', 'crisis'], 'PERCENTAGE_CHANGE', 'COUNTERPARTY', 'cus-retail', 'FORECAST_CORRECTION', 'Historial nuevo; usar supuesto conservador.', { percentageChange: -0.2 }),
    adjustment('adj-patear-flexibles', 'Mover proveedores flexibles 15 días', ['conservative', 'liquidity'], 'DATE_SHIFT', 'FILTER_SET', 'category=AP_PAYMENT;counterpartyType=SUPPLIER', 'NEGOTIATION', 'Negociación viable con proveedores no críticos.', { deltaDays: 15 }),
    adjustment('adj-split-iva', 'Dividir IVA en 4 pagos', ['liquidity'], 'SPLIT_PAYMENT', 'MOVEMENT', 'tax-iva-may-movement', 'LIQUIDITY', 'Tesorería solicita parcialidades sujetas a validación fiscal.', { splitConfig: { numberOfPayments: 4, frequency: 'WEEKLY' } }),
    adjustment('adj-cancelar-capex', 'Cancelar CAPEX no operativo', ['crisis'], 'CANCEL_MOVEMENT', 'MOVEMENT', 'capex-ti-1', 'CRISIS', 'Suspender inversión no esencial hasta estabilizar caja.'),
    adjustment('adj-linea-credito', 'Agregar línea de crédito revolvente', ['crisis', 'liquidity'], 'FINANCING_DRAW', 'DATE_RANGE', `${asOfDate}..${shift(asOfDate, 90)}`, 'LIQUIDITY', 'Uso temporal de crédito para cubrir déficit máximo.', {
      adjustedValue: {
        type: 'INFLOW',
        category: 'DEBT',
        projectedDate: shift(asOfDate, 10),
        projectedAmount: 15_000_000,
        concept: 'Disposición línea de crédito',
        counterpartyName: 'Banco revolvente',
        counterpartyType: 'BANK',
      },
    }),
    adjustment('adj-ventas-upside', 'Incrementar ventas nuevas 5%', ['optimistic'], 'PERCENTAGE_CHANGE', 'CATEGORY', 'AR_COLLECTION', 'UPSIDE', 'Pipeline comercial con alta probabilidad.', { percentageChange: 0.05 }),
  ];

  return { movements, scenarios, adjustments, suppliers, customers, taxes };
}

function movement(
  id: string,
  sourceSystem: FinancialMovement['sourceSystem'],
  type: FinancialMovementType,
  category: FinancialMovementCategory,
  projectedDate: string,
  amount: number,
  concept: string,
  counterpartyType: FinancialMovement['counterpartyType'],
  status: FinancialMovement['status'],
  confidenceBand: FinancialMovement['confidenceBand'],
  lockState: FinancialMovement['lockState'] = 'UNLOCKED',
): FinancialMovement {
  const score = confidenceBand === 'CONFIRMED' ? 96 : confidenceBand === 'HIGH' ? 82 : confidenceBand === 'MEDIUM' ? 66 : confidenceBand === 'LOW' ? 48 : 30;
  return {
    id,
    sourceSystem,
    type,
    category,
    counterpartyType,
    concept,
    currency: 'MXN',
    originalAmount: amount,
    baseAmount: amount,
    projectedAmount: amount,
    projectedDate,
    confidenceScore: score,
    confidenceBand: calculateConfidenceBand(score),
    forecastMethod: sourceSystem === 'MANUAL' ? 'MANUAL' : 'RULE',
    ruleApplied: 'Mock data temporal para reemplazar por API/JDE/Bancos',
    status,
    lockState,
    comments: ['Dato mock: conectar a fuente oficial en integración backend.'],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function collection(
  id: string,
  customer: CustomerCollectionProfile,
  date: string,
  amount: number,
  confidenceScore: number,
  concept: string,
): FinancialMovement {
  return {
    ...movement(id, 'FORECAST', 'INFLOW', 'AR_COLLECTION', date, amount, concept, 'CUSTOMER', 'PROJECTED_BASE', calculateConfidenceBand(confidenceScore)),
    counterpartyId: customer.id,
    counterpartyName: customer.name,
    issueDate: shift(date, -customer.creditDays),
    dueDate: customer.theoreticalCollectionDate,
    confidenceScore,
    confidenceBand: calculateConfidenceBand(confidenceScore),
    forecastMethod: 'RULE',
    ruleApplied: customer.paymentPattern,
  };
}

function outflow(
  id: string,
  supplier: SupplierFinancialProfile,
  date: string,
  amount: number,
  concept: string,
  category: FinancialMovementCategory,
  confidenceScore: number,
  lockState: FinancialMovement['lockState'] = 'RESTRICTED',
): FinancialMovement {
  const confidence = calculateMovementConfidence({
    sourceSystem: 'JDE',
    forecastMethod: 'RULE',
    hasManualValidation: lockState === 'LOCKED',
    historyScore: confidenceScore >= 80 ? 18 : 12,
    freshnessScore: Math.max(8, 20 - supplier.staleDays),
  });
  return {
    ...movement(id, 'JDE', 'OUTFLOW', category, date, amount, concept, 'SUPPLIER', 'PROJECTED_BASE', confidence.band, lockState),
    counterpartyId: supplier.id,
    counterpartyName: supplier.name,
    dueDate: date,
    confidenceScore: confidence.score,
    confidenceBand: confidence.band,
    ruleApplied: `${supplier.paymentFlexibility} · ${supplier.priority}`,
  };
}

function taxMovement(tax: TaxObligation, confidenceScore: number): FinancialMovement {
  return {
    ...movement(`${tax.id}-movement`, tax.sourceSystem === 'TAX' ? 'TAX' : tax.sourceSystem, 'OUTFLOW', 'TAX', tax.dueDate, tax.pendingAmount, `${tax.taxType} pendiente`, 'TAX_AUTHORITY', 'PROJECTED_BASE', calculateConfidenceBand(confidenceScore), tax.risk === 'LEGAL' ? 'LOCKED' : 'RESTRICTED'),
    sourceObjectId: tax.id,
    counterpartyId: 'sat',
    counterpartyName: 'Autoridad fiscal',
    dueDate: tax.dueDate,
    confidenceScore,
    confidenceBand: calculateConfidenceBand(confidenceScore),
    forecastMethod: tax.sourceSystem === 'MANUAL' ? 'MANUAL' : 'RULE',
    ruleApplied: `Impuesto ${tax.taxType} capturado por separado`,
  };
}

function scenario(
  id: string,
  name: string,
  kind: FinancialScenario['kind'],
  adjustmentIds: string[],
  status: FinancialScenario['status'],
  isBase = false,
): FinancialScenario {
  return {
    id,
    name,
    kind,
    adjustmentIds,
    status,
    isBase,
    createdBy: 'system',
    createdAt: NOW,
    updatedAt: NOW,
    approvedBy: isBase ? 'system' : undefined,
    approvedAt: isBase ? NOW : undefined,
  };
}

function adjustment(
  id: string,
  name: string,
  scenarioIds: string[],
  type: FinancialAdjustment['type'],
  targetType: FinancialAdjustment['targetType'],
  targetExpression: string,
  reasonCode: FinancialAdjustment['reasonCode'],
  justification: string,
  overrides: Partial<FinancialAdjustment> = {},
): FinancialAdjustment {
  return {
    id,
    name,
    scenarioIds,
    type,
    targetType,
    targetExpression,
    reasonCode,
    justification,
    status: 'DRAFT',
    createdBy: 'analyst@senda.local',
    createdAt: NOW,
    ...overrides,
  };
}

function shift(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function nextWeekday(date: string, dayOfWeek: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  while (parsed.getUTCDay() !== dayOfWeek) parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function lastBusinessDayOfMonth(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  const last = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0));
  while (last.getUTCDay() === 0 || last.getUTCDay() === 6) last.setUTCDate(last.getUTCDate() - 1);
  return last.toISOString().slice(0, 10);
}
