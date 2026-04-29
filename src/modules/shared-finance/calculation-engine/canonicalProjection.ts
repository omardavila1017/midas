// ─────────────────────────────────────────────────────────────────────────
// canonicalProjection — bridge entre el motor canónico del Dashboard
// (`computeBaseCashFlow`) y el modelo de movimientos que consumen
// Proyección Financiera y Planeación Financiera.
//
// Reglas del módulo:
//
//   1. La trayectoria de caja MENSUAL coincide byte-a-byte con la del
//      Dashboard. Para cada mes futuro tomamos el total canónico de
//      ingreso/egreso y lo distribuimos sobre catálogos reales:
//        - Inflows  → `projectClientMonth` por cada cliente con eventos
//          fechados en ese mes (respeta payment-day, créditos, factoraje).
//        - Outflows → CXP con `fechaProgramacionPago` real, líneas de
//          presupuesto fechadas a su día típico, y patrones recurrentes
//          de proveedores cuando faltan CXP/presupuesto.
//
//   2. Cada movimiento informativo guarda su monto crudo en `baseAmount`
//      y el monto escalado al canónico en `projectedAmount`. La suma de
//      `projectedAmount` por mes empata con el Dashboard.
//
//   3. NUNCA caemos a mock data. Si los catálogos no producen líneas
//      para un mes, se emite UN movement sintético "Resto presupuesto"
//      con la fecha del día medio del mes — pero esto es el último
//      recurso, no la regla.
//
// Bug previo arreglado por este archivo:
//   - Antes la cobranza y los egresos futuros caían en una sola línea
//     genérica "Cobranza proyectada YYYY-MM" en el día 15 del mes,
//     porque el código solo emitía catálogo para el mes en curso. Ahora
//     itera todos los meses futuros del horizonte y usa el catálogo
//     real, lo que da granularidad útil para vistas semanales/diarias.
// ─────────────────────────────────────────────────────────────────────────

import { computeBaseCashFlow } from '../../../components/Dashboard';
import type { ComputeInputs } from '../../../components/Dashboard';
import { compareYearMonth, toYearMonth } from '../../../domain/cashFlowEngine';
import { projectClientMonth } from '../../../domain/collectionEngine';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { Client, Provider, CashFlowAssumptions } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { calculateConfidenceBand } from './financialProjectionEngine';
import type {
  FinancialMovement,
  FinancialMovementCategory,
  FinancialTaxRate,
} from '../types';

export interface CanonicalProjectionInputs {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  startingBalance: number;
  asOfDate: string;
}

export interface CanonicalMonthlyPoint {
  yearMonth: string;
  isHistorical: boolean;
  income: number;
  expense: number;
  closingCash: number;
}

export interface CanonicalProjectionResult {
  monthly: CanonicalMonthlyPoint[];
  movements: FinancialMovement[];
  initialCash: number;
  fromYearMonth: string;
  toYearMonth: string;
}

export function buildCanonicalProjection(
  inputs: CanonicalProjectionInputs,
): CanonicalProjectionResult {
  const computeInputs: ComputeInputs = {
    bankStatements: inputs.bankStatements,
    aged: [],
    clients: inputs.clients,
    providers: inputs.providers,
    cxpRecords: inputs.cxpRecords,
    assumptions: inputs.assumptions,
    companyCode: inputs.companyCode,
    today: inputs.asOfDate,
    overrides: loadCanonicalOverrides(),
    budget: inputs.budget,
    startingBalance: inputs.startingBalance,
  };
  const { base } = computeBaseCashFlow(computeInputs);

  const monthly: CanonicalMonthlyPoint[] = base.map((m) => ({
    yearMonth: m.yearMonth,
    isHistorical: m.isHistorical,
    income: m.income,
    expense: m.expense,
    closingCash: m.closingCash,
  }));

  const movements = buildMovements({ monthly, inputs });

  const initialCash = base.length > 0
    ? base[0].closingCash - base[0].income + base[0].expense
    : inputs.startingBalance;

  return {
    monthly,
    movements,
    initialCash,
    fromYearMonth: monthly[0]?.yearMonth ?? toYearMonth(inputs.asOfDate),
    toYearMonth: monthly[monthly.length - 1]?.yearMonth ?? toYearMonth(inputs.asOfDate),
  };
}

function loadCanonicalOverrides() {
  try {
    const raw = localStorage.getItem('midas.dashboard.projectionOverrides.v1');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

interface BuildArgs {
  monthly: CanonicalMonthlyPoint[];
  inputs: CanonicalProjectionInputs;
}

function buildMovements({ monthly, inputs }: BuildArgs): FinancialMovement[] {
  const out: FinancialMovement[] = [];
  const todayYm = toYearMonth(inputs.asOfDate);
  const monthlyByYm = new Map(monthly.map((m) => [m.yearMonth, m]));

  // 1) Histórico bancario — los mismos números que sumó el Dashboard.
  for (const statement of inputs.bankStatements) {
    if (
      inputs.companyCode !== 'all'
      && inputs.companyCode
      && statement.cia !== inputs.companyCode
    ) continue;
    for (const line of statement.movimientos) {
      const ym = (line.fechaOperacion ?? '').slice(0, 7);
      if (ym.length !== 7) continue;
      if (!monthlyByYm.has(ym)) continue;
      out.push({
        id: `bank:${statement.cia}:${statement.cuenta}:${line.referencia ?? ''}:${line.fechaOperacion}:${out.length}`,
        sourceSystem: 'BANK',
        sourceObjectId: line.referencia,
        type: line.tipoMovimiento === 'ABONO' ? 'INFLOW' : 'OUTFLOW',
        category: 'TRANSFER',
        companyId: statement.cia,
        bankAccountId: statement.cuenta,
        counterpartyType: 'BANK',
        concept: line.concepto || 'Movimiento bancario',
        currency: line.moneda || statement.moneda || 'MXN',
        originalAmount: Math.abs(line.importe),
        baseAmount: Math.abs(line.importe),
        projectedAmount: Math.abs(line.importe),
        actualDate: line.fechaOperacion,
        projectedDate: line.fechaOperacion,
        confidenceScore: 100,
        confidenceBand: calculateConfidenceBand(100),
        forecastMethod: 'RULE',
        ruleApplied: 'Estado de cuenta bancario',
        status: 'REAL',
        lockState: 'LOCKED',
        comments: ['Dato real del banco. No editable desde Planeación.'],
        createdAt: `${line.fechaOperacion}T00:00:00.000Z`,
        updatedAt: `${line.fechaOperacion}T00:00:00.000Z`,
      });
    }
  }

  // 2) Para cada mes futuro: distribuimos los totales canónicos sobre
  //    catálogos reales (`projectClientMonth` para inflows, CXP +
  //    presupuesto para outflows). El escalamiento garantiza que la
  //    suma de `projectedAmount` empate con el total canónico.
  const futureMonths = monthly.filter((m) => !m.isHistorical);
  for (const month of futureMonths) {
    const inflowLines = collectInflowLines(month, inputs, todayYm);
    out.push(...balanceMonth({
      lines: inflowLines,
      target: month.income,
      ym: month.yearMonth,
      type: 'INFLOW',
      asOfDate: inputs.asOfDate,
      fallbackCategory: 'AR_COLLECTION',
      fallbackConcept: `Cobranza proyectada ${month.yearMonth}`,
      fallbackRule: 'Total proyectado mensual (Dashboard)',
    }));

    const outflowLines = collectOutflowLines(month, inputs, todayYm);
    out.push(...balanceMonth({
      lines: outflowLines,
      target: month.expense,
      ym: month.yearMonth,
      type: 'OUTFLOW',
      asOfDate: inputs.asOfDate,
      fallbackCategory: 'OPEX',
      fallbackConcept: `Egresos proyectados ${month.yearMonth}`,
      fallbackRule: 'Total proyectado mensual (Dashboard)',
    }));
  }

  // 3) Mes en curso (histórico parcial). El canónico de este mes ya
  //    refleja sólo lo que pasó realmente en el banco, por lo que
  //    `balanceMonth` no aplica (no hay un "target" futuro contra el
  //    cual escalar). Emitimos las líneas de catálogo cuya fecha cae
  //    DESPUÉS de hoy como PROJECTED_BASE sin escalar — son los
  //    movimientos esperados para los días que aún faltan del mes.
  //    Sin esto el usuario sólo ve los confirmados del banco y queda
  //    ciego al resto del mes.
  const currentYm = todayYm;
  const currentHistorical = monthly.find((m) => m.isHistorical && m.yearMonth === currentYm);
  if (currentHistorical) {
    const inflowLines = collectInflowLines(currentHistorical, inputs, todayYm)
      .filter((line) => line.date > inputs.asOfDate);
    out.push(...emitRawLines(inflowLines, 'INFLOW', inputs.asOfDate));

    const outflowLines = collectOutflowLines(currentHistorical, inputs, todayYm)
      .filter((line) => line.date > inputs.asOfDate);
    out.push(...emitRawLines(outflowLines, 'OUTFLOW', inputs.asOfDate));
  }

  return out;
}

/**
 * Convierte `RawLine[]` directamente a `FinancialMovement[]` sin
 * escalar contra un total canónico. Se usa para el mes en curso, donde
 * los días pasados ya están cubiertos por movimientos REAL del banco
 * y los días futuros son proyecciones genuinas que no deben "balancear"
 * a nada — sólo sumarse.
 */
function emitRawLines(
  lines: RawLine[],
  type: FinancialMovement['type'],
  asOfDate: string,
): FinancialMovement[] {
  return lines.map((line) => ({
    id: line.id,
    sourceSystem: line.sourceSystem,
    sourceObjectId: line.sourceObjectId,
    type,
    category: line.category,
    companyId: line.companyId,
    counterpartyId: line.counterpartyId,
    counterpartyName: line.counterpartyName,
    counterpartyType: line.counterpartyType,
    concept: line.concept,
    currency: 'MXN',
    originalAmount: line.amount,
    baseAmount: line.amount,
    projectedAmount: line.amount,
    issueDate: line.issueDate,
    dueDate: line.dueDate,
    projectedDate: line.date,
    confidenceScore: line.confidenceScore,
    confidenceBand: calculateConfidenceBand(line.confidenceScore),
    forecastMethod: line.forecastMethod,
    ruleApplied: line.ruleApplied,
    taxTreatment: line.taxTreatment,
    taxRate: line.taxRate,
    ...taxMetaFromGross(line.amount, line.taxRate),
    status: 'PROJECTED_BASE',
    lockState: line.lockState,
    comments: [line.comment],
    createdAt: `${asOfDate}T00:00:00.000Z`,
    updatedAt: `${asOfDate}T00:00:00.000Z`,
  }));
}

interface RawLine {
  id: string;
  amount: number;
  date: string;
  concept: string;
  category: FinancialMovementCategory;
  counterpartyId?: string;
  counterpartyName?: string;
  counterpartyType?: FinancialMovement['counterpartyType'];
  ruleApplied: string;
  sourceSystem: FinancialMovement['sourceSystem'];
  sourceObjectId?: string;
  companyId?: string;
  issueDate?: string;
  dueDate?: string;
  forecastMethod: FinancialMovement['forecastMethod'];
  confidenceScore: number;
  lockState: FinancialMovement['lockState'];
  comment: string;
  taxTreatment?: FinancialMovement['taxTreatment'];
  taxRate?: FinancialTaxRate;
}

/**
 * Inflows: usa `projectClientMonth` para CADA cliente del catálogo en el
 * mes objetivo. Cada evento tiene `realDate` que respeta:
 *   - frecuencia (semanal, quincenal, mensual, contado)
 *   - días de crédito del cliente
 *   - patrón de pago (DOM, DOW, etc.) o factoraje
 * Esto produce muchos puntos en distintos días → la vista semanal/diaria
 * se ve poblada en lugar de un solo bloque a mediados de mes.
 */
function collectInflowLines(
  month: CanonicalMonthlyPoint,
  inputs: CanonicalProjectionInputs,
  _todayYm: string,
): RawLine[] {
  if (inputs.clients.length === 0) return [];
  const [year, mNum] = month.yearMonth.split('-').map(Number);
  const targetMonthIdx = mNum - 1;
  const lines: RawLine[] = [];

  // Necesitamos buscar un poco hacia atrás: facturas emitidas el mes
  // anterior pueden cobrarse en el mes objetivo (créditos cortos).
  // Iteramos el mes objetivo y los 2 meses previos.
  const monthsToScan: Array<{ year: number; monthIdx: number }> = [
    { year, monthIdx: targetMonthIdx - 2 },
    { year, monthIdx: targetMonthIdx - 1 },
    { year, monthIdx: targetMonthIdx },
  ].map(({ year: y, monthIdx }) => {
    if (monthIdx < 0) return { year: y - 1, monthIdx: monthIdx + 12 };
    if (monthIdx > 11) return { year: y + 1, monthIdx: monthIdx - 12 };
    return { year: y, monthIdx };
  });

  for (const client of inputs.clients) {
    let evIdx = 0;
    for (const scan of monthsToScan) {
      const events = projectClientMonth(client, scan.year, scan.monthIdx, {
        ...inputs.assumptions,
        year: scan.year,
      });
      for (const event of events) {
        const ym = event.realDate.slice(0, 7);
        if (ym !== month.yearMonth) continue;
        if (event.amount <= 0) continue;
        const compliance = client.complianceRate ?? inputs.assumptions.globalCompliance ?? 1;
        const score = Math.round(55 + Math.min(40, compliance * 40));
        lines.push({
          id: `client:${client.id}:${event.realDate}:${evIdx++}`,
          amount: event.amount,
          date: event.realDate,
          concept: `Cobranza ${client.name}`,
          category: 'AR_COLLECTION',
          counterpartyId: client.id,
          counterpartyName: client.name,
          counterpartyType: 'CUSTOMER',
          ruleApplied: paymentPatternLabel(client),
          sourceSystem: 'FORECAST',
          sourceObjectId: client.id,
          forecastMethod: 'RULE',
          confidenceScore: score,
          lockState: 'UNLOCKED',
          taxTreatment: client.ivaRate ? 'IVA_CAUSED' : 'UNCLASSIFIED',
          taxRate: client.ivaRate,
          comment: `Evento proyectado por collectionEngine. Lag teórico ${event.lagDays} días.`,
        });
      }
    }
  }

  return lines;
}

/**
 * Outflows: combina CXP (con fechas reales de programación de pago) con
 * líneas de presupuesto (distribuidas a un día típico del mes). Cuando
 * no hay ninguna fuente, `balanceMonth` cae al sintético.
 */
function collectOutflowLines(
  month: CanonicalMonthlyPoint,
  inputs: CanonicalProjectionInputs,
  todayYm: string,
): RawLine[] {
  const lines: RawLine[] = [];
  const providerByName = new Map(inputs.providers.map((p) => [normalize(p.name), p]));
  const filteredCxp = inputs.companyCode === 'all' || !inputs.companyCode
    ? inputs.cxpRecords
    : inputs.cxpRecords.filter((r) => r.cia === inputs.companyCode);

  // 1) CXP con fecha real de programación que cae en este mes.
  filteredCxp.forEach((record, index) => {
    if (record.importePendientePesos <= 0) return;
    const date = cleanDate(record.fechaProgramacionPago)
      ?? cleanDate(record.fechaVence)
      ?? null;
    if (!date) return;
    if (date.slice(0, 7) !== month.yearMonth) return;
    if (compareYearMonth(date.slice(0, 7), todayYm) < 0) return;
    const provider = providerByName.get(normalize(record.nombre));
    const score = (record.edoPago ?? '').toUpperCase().includes('APROB') ? 90 : 76;
    const taxRate = taxRateFromCxp(record.importeSubtotalPesos, record.importeImpuestosPesos);
    lines.push({
      id: `cxp:${record.cia}:${record.noProveedor}:${record.noFactura}:${index}`,
      amount: record.importePendientePesos,
      date,
      concept: `Factura ${record.noFactura || 'sin folio'} · ${record.nombre}`,
      category: 'AP_PAYMENT',
      counterpartyId: provider?.id ?? record.noProveedor,
      counterpartyName: record.nombre,
      counterpartyType: 'SUPPLIER',
      ruleApplied: provider?.flexibility ? `Proveedor ${provider.flexibility}` : 'Fecha programada JDE',
      sourceSystem: 'JDE',
      sourceObjectId: record.noFactura,
      companyId: record.cia,
      issueDate: cleanDate(record.fechaFactura),
      dueDate: cleanDate(record.fechaVence),
      forecastMethod: 'RULE',
      confidenceScore: score,
      lockState: provider?.flexibility === 'inamovible' ? 'LOCKED' : 'RESTRICTED',
      taxTreatment: taxRate ? 'IVA_CREDITABLE' : 'UNCLASSIFIED',
      taxRate,
      comment: 'Factura abierta en JDE.',
    });
  });

  // 2) Líneas del presupuesto que aplican a este mes. Las distribuimos
  //    a un día específico para que en vista semanal aparezcan.
  if (inputs.budget) {
    const monthIdx = Number(month.yearMonth.slice(5, 7)) - 1;
    if (inputs.budget.year === Number(month.yearMonth.slice(0, 4))) {
      let conceptIdx = 0;
      for (const concept of inputs.budget.expenseByConcept ?? []) {
        const amount = concept.monthly?.[monthIdx];
        if (!amount || amount <= 0) continue;
        // Día típico del concepto: nómina día 15/30, otros día 5 + offset
        // por concepto para esparcir las barras del chart semanal.
        const typicalDay = typicalDayForConcept(concept.concept, conceptIdx);
        conceptIdx++;
        lines.push({
          id: `budget:${inputs.budget.year}:${monthIdx + 1}:${normalize(concept.concept)}`,
          amount,
          date: dateForDayOfMonth(month.yearMonth, typicalDay),
          concept: concept.concept,
          category: budgetCategoryFor(concept.concept),
          ruleApplied: 'Presupuesto anual',
          sourceSystem: 'FORECAST',
          forecastMethod: 'DRIVER',
          confidenceScore: 60,
          lockState: 'RESTRICTED',
          taxTreatment: budgetCategoryFor(concept.concept) === 'PAYROLL' || budgetCategoryFor(concept.concept) === 'TAX'
            ? 'IVA_EXEMPT'
            : 'UNCLASSIFIED',
          comment: 'Línea del presupuesto, fechada al día típico del concepto.',
        });
      }
    }
  }

  return lines;
}

interface BalanceArgs {
  lines: RawLine[];
  target: number;
  ym: string;
  type: FinancialMovement['type'];
  asOfDate: string;
  fallbackCategory: FinancialMovementCategory;
  fallbackConcept: string;
  fallbackRule: string;
}

function balanceMonth({
  lines,
  target,
  ym,
  type,
  asOfDate,
  fallbackCategory,
  fallbackConcept,
  fallbackRule,
}: BalanceArgs): FinancialMovement[] {
  if (target <= 0) return [];
  if (lines.length === 0) {
    return [{
      id: `canonical-${type.toLowerCase()}:${ym}`,
      sourceSystem: 'FORECAST',
      type,
      category: fallbackCategory,
      concept: fallbackConcept,
      currency: 'MXN',
      originalAmount: target,
      baseAmount: target,
      projectedAmount: target,
      projectedDate: midMonthDate(ym),
      confidenceScore: 65,
      confidenceBand: calculateConfidenceBand(65),
      forecastMethod: 'DRIVER',
      ruleApplied: fallbackRule,
      taxTreatment: fallbackCategory === 'AR_COLLECTION' ? 'UNCLASSIFIED' : fallbackCategory === 'PAYROLL' || fallbackCategory === 'TAX' ? 'IVA_EXEMPT' : 'UNCLASSIFIED',
      status: 'PROJECTED_BASE',
      lockState: 'RESTRICTED',
      comments: ['Sin desglose por catálogo en este mes; se usa el total del Dashboard.'],
      createdAt: `${asOfDate}T00:00:00.000Z`,
      updatedAt: `${asOfDate}T00:00:00.000Z`,
    }];
  }

  const sum = lines.reduce((s, l) => s + l.amount, 0);
  if (sum === 0) return [];

  const scale = target / sum;
  let runningTotal = 0;
  const out: FinancialMovement[] = [];
  lines.forEach((line, idx) => {
    const isLast = idx === lines.length - 1;
    const scaled = isLast
      ? Math.max(0, target - runningTotal)
      : Math.round(line.amount * scale);
    runningTotal += scaled;
    out.push({
      id: line.id,
      sourceSystem: line.sourceSystem,
      sourceObjectId: line.sourceObjectId,
      type,
      category: line.category,
      companyId: line.companyId,
      counterpartyId: line.counterpartyId,
      counterpartyName: line.counterpartyName,
      counterpartyType: line.counterpartyType,
      concept: line.concept,
      currency: 'MXN',
      originalAmount: line.amount,
      baseAmount: line.amount,
      projectedAmount: scaled,
      issueDate: line.issueDate,
      dueDate: line.dueDate,
      projectedDate: line.date,
      confidenceScore: line.confidenceScore,
      confidenceBand: calculateConfidenceBand(line.confidenceScore),
      forecastMethod: line.forecastMethod,
      ruleApplied: line.ruleApplied,
      taxTreatment: line.taxTreatment,
      taxRate: line.taxRate,
      ...taxMetaFromGross(scaled, line.taxRate),
      status: 'PROJECTED_BASE',
      lockState: line.lockState,
      comments: [line.comment],
      createdAt: `${asOfDate}T00:00:00.000Z`,
      updatedAt: `${asOfDate}T00:00:00.000Z`,
    });
  });
  return out;
}

export function hasSufficientCanonicalData(inputs: CanonicalProjectionInputs): boolean {
  if (inputs.bankStatements.length === 0) return false;
  if (inputs.budget === null && inputs.clients.length === 0 && inputs.cxpRecords.length === 0) {
    return false;
  }
  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function midMonthDate(yearMonth: string): string {
  return `${yearMonth}-15`;
}

function dateForDayOfMonth(yearMonth: string, day: number): string {
  const [year, month] = yearMonth.split('-').map(Number);
  // Cap day to last day of month to evitar fechas inválidas.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const safeDay = Math.min(Math.max(1, day), lastDay);
  return `${yearMonth}-${String(safeDay).padStart(2, '0')}`;
}

function typicalDayForConcept(concept: string, fallbackIndex: number): number {
  const upper = concept.toUpperCase();
  if (upper.includes('NOMINA') || upper.includes('NÓMINA') || upper.includes('SUELDOS')) {
    return 30; // último día del mes — el helper hace clamp a fin de mes.
  }
  if (upper.includes('IMPUESTO') || upper.includes('ISR') || upper.includes('IVA') || upper.includes('IMSS')) {
    return 17;
  }
  if (upper.includes('RENTA') || upper.includes('SEGURO')) {
    return 5;
  }
  // Otros conceptos: distribuidos por su orden para que la vista semanal
  // muestre actividad en distintas semanas.
  const days = [3, 8, 12, 18, 22, 26];
  return days[fallbackIndex % days.length];
}

function cleanDate(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function taxRateFromCxp(subtotal: number, taxAmount: number): FinancialTaxRate | undefined {
  if (!Number.isFinite(subtotal) || subtotal <= 0 || !Number.isFinite(taxAmount) || taxAmount <= 0) return undefined;
  const pct = Math.round((taxAmount / subtotal) * 100);
  if (Math.abs(pct - 16) <= 1) return 16;
  if (Math.abs(pct - 8) <= 1) return 8;
  return undefined;
}

function taxMetaFromGross(
  grossAmount: number,
  taxRate: FinancialTaxRate | undefined,
): Pick<FinancialMovement, 'taxBaseAmount' | 'taxAmount'> {
  if (!taxRate || taxRate <= 0) return {};
  const divisor = 1 + taxRate / 100;
  const taxBaseAmount = grossAmount / divisor;
  return {
    taxBaseAmount,
    taxAmount: grossAmount - taxBaseAmount,
  };
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

function budgetCategoryFor(concept: string): FinancialMovementCategory {
  const upper = concept.toUpperCase();
  if (upper.includes('NOMINA') || upper.includes('NÓMINA') || upper.includes('SUELDOS')) return 'PAYROLL';
  if (upper.includes('IMPUESTO') || upper.includes('ISR') || upper.includes('IVA') || upper.includes('IMSS')) return 'TAX';
  if (upper.includes('DEUDA') || upper.includes('PRESTAMO') || upper.includes('CREDITO')) return 'DEBT';
  if (upper.includes('CAPEX') || upper.includes('INVERSION')) return 'CAPEX';
  return 'OPEX';
}
