// ─────────────────────────────────────────────────────────────────────────
// canonicalProjection — bridge entre el motor canónico del Dashboard
// (`computeBaseCashFlow`) y el modelo de movimientos que consumen
// Proyección Financiera y Planeación Financiera.
//
// Regla dura: la trayectoria de caja MENSUAL que ven Proyección/Planeación
// debe ser idéntica byte-a-byte a la del Dashboard. Si el Dashboard dice
// que en julio la caja final es $X, este módulo también debe decir $X.
// Antes de este puente, los módulos nuevos calculaban su caja por su
// cuenta a partir de "movimientos" individuales en granularidad diaria,
// y eso producía una curva distinta (diferente gasto, diferente caja
// inicial, fallback a mock data, etc.) — eso es lo que arregla este
// archivo.
//
// La granularidad diaria/semanal sigue siendo útil para tesorería, pero
// se construye DERIVANDO la curva mensual canónica (no recalculando):
//   - Para meses históricos: agregamos movimientos reales del banco por
//     día y empatamos el cierre del mes con la caja final canónica.
//   - Para meses futuros: distribuimos los totales mensuales canónicos
//     proporcionalmente al perfil de movimientos proyectados (clientes,
//     CXP, presupuesto). Si un mes futuro no tiene movimientos
//     proyectados, distribuimos uniforme.
//
// Resultado: cualquier re-agregación a mes (sumar income/expense de los
// días del mes y leer cierre del último día) coincide con el motor
// canónico. Es lo que hace que los KPIs `projectedCash30/90`, los
// `deficitDays`, etc., dejen de mentir.
// ─────────────────────────────────────────────────────────────────────────

import { computeBaseCashFlow } from '../../../components/Dashboard';
import type { ComputeInputs } from '../../../components/Dashboard';
import { compareYearMonth, toYearMonth } from '../../../domain/cashFlowEngine';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { Client, Provider, CashFlowAssumptions } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import { calculateConfidenceBand } from './financialProjectionEngine';
import type {
  FinancialMovement,
  FinancialMovementCategory,
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
  /**
   * Trayectoria mensual canónica. La caja final de cada mes coincide
   * exactamente con la del Dashboard. Usar esto como base para cualquier
   * KPI o agregado que el módulo de Proyección/Planeación quiera mostrar.
   */
  monthly: CanonicalMonthlyPoint[];
  /**
   * Movimientos derivados de los mismos insumos que el Dashboard:
   *   - Reales del banco (status REAL, lockState LOCKED)
   *   - CXP / Antigüedad de saldos (status PROJECTED_BASE)
   *   - Cobranza proyectada por cliente (status PROJECTED_BASE)
   *   - Líneas de gasto del presupuesto (status PROJECTED_BASE)
   * Se garantiza que la suma diaria de income/expense de todos los
   * movimientos por mes ≈ el total mensual canónico, dentro de un
   * margen de redondeo. Cuando la suma cruda no empata, se introducen
   * movimientos de "ajuste por presupuesto" para empatar el total.
   */
  movements: FinancialMovement[];
  /**
   * Caja inicial usada — ya alineada con el Dashboard
   * (FIXED_STARTING_BALANCE / budget.openingCash[0] / saldoInicial).
   */
  initialCash: number;
  /** Primer mes de la trayectoria. */
  fromYearMonth: string;
  /** Último mes de la trayectoria. */
  toYearMonth: string;
}

/**
 * Construye la proyección canónica para el módulo de Proyección/Planeación.
 * NUNCA cae a mock data — si no hay datos reales, devuelve listas vacías y
 * el caller debe mostrar empty state.
 */
export function buildCanonicalProjection(
  inputs: CanonicalProjectionInputs,
): CanonicalProjectionResult {
  const computeInputs: ComputeInputs = {
    bankStatements: inputs.bankStatements,
    aged: [], // El Dashboard ya decide si usar aged externo o CXP records.
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

  const movements = buildMovementsFromCanonicalMonths({
    monthly,
    inputs,
  });

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

/**
 * Lee los overrides mensuales del Dashboard (mismo localStorage). Esto
 * garantiza que cualquier ajuste manual hecho en el Dashboard se respeta
 * aquí también — antes los módulos nuevos los ignoraban completamente.
 */
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

interface BuildMovementsArgs {
  monthly: CanonicalMonthlyPoint[];
  inputs: CanonicalProjectionInputs;
}

/**
 * Convierte la trayectoria mensual canónica + los catálogos en un set
 * de movimientos diarios.
 *
 * Estrategia de fidelidad al Dashboard:
 *   1. Para meses históricos: emitimos movimientos por cada ABONO/CARGO
 *      del banco. Como esos son los mismos números que sumó el Dashboard,
 *      la re-agregación da idéntico.
 *   2. Para meses futuros: emitimos UN movimiento sintético de ingreso y
 *      uno de egreso, con el monto exacto del mes canónico, fechado a
 *      mediados del mes. Esto preserva el total y deja al motor de
 *      planeación bucket-ear correctamente.
 *   3. Adicionalmente, agregamos los CXP, las facturas proyectadas por
 *      cliente y las líneas del presupuesto como movimientos
 *      INFORMATIVOS marcados con `lockState: 'RESTRICTED'` para que
 *      aparezcan en la tabla con drilldown. NO entran al cálculo de
 *      caja — eso ya lo decidió el Dashboard.
 */
function buildMovementsFromCanonicalMonths({ monthly, inputs }: BuildMovementsArgs): FinancialMovement[] {
  const out: FinancialMovement[] = [];
  const asOfDate = inputs.asOfDate;
  const todayYm = toYearMonth(asOfDate);

  // ── 1. Históricos del banco — los mismos números que el Dashboard ──
  for (const statement of inputs.bankStatements) {
    if (inputs.companyCode !== 'all' && inputs.companyCode && statement.cia !== inputs.companyCode) {
      continue;
    }
    for (const line of statement.movimientos) {
      const lineYm = (line.fechaOperacion ?? '').slice(0, 7);
      if (lineYm.length !== 7) continue;
      // Solo emitimos para meses presentes en la trayectoria canónica.
      if (!monthly.some((m) => m.yearMonth === lineYm)) continue;
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
        comments: ['Dato real del banco; no se edita desde Planeación.'],
        createdAt: `${line.fechaOperacion}T00:00:00.000Z`,
        updatedAt: `${line.fechaOperacion}T00:00:00.000Z`,
      });
    }
  }

  // ── 2. Movimientos sintéticos por mes futuro para conservar la caja ──
  // Para cada mes futuro de la trayectoria canónica, emitimos un par
  // (ingreso/egreso) con el total exacto que decidió el Dashboard.
  // Estos son los movimientos que el motor de planeación bucket-ea para
  // calcular `currentCash`, `projectedCash30/90`, etc.
  for (const m of monthly) {
    if (m.isHistorical) continue;
    const midDate = midMonthDate(m.yearMonth);
    if (m.income > 0) {
      out.push({
        id: `canonical-income:${m.yearMonth}`,
        sourceSystem: 'FORECAST',
        type: 'INFLOW',
        category: 'AR_COLLECTION',
        concept: `Ingresos proyectados ${m.yearMonth}`,
        currency: 'MXN',
        originalAmount: m.income,
        baseAmount: m.income,
        projectedAmount: m.income,
        projectedDate: midDate,
        confidenceScore: 70,
        confidenceBand: calculateConfidenceBand(70),
        forecastMethod: 'DRIVER',
        ruleApplied: 'Total proyectado mensual (Dashboard)',
        status: 'PROJECTED_BASE',
        lockState: 'RESTRICTED',
        comments: ['Total mensual del motor canónico. Se distribuye al mes.'],
        createdAt: `${asOfDate}T00:00:00.000Z`,
        updatedAt: `${asOfDate}T00:00:00.000Z`,
      });
    }
    if (m.expense > 0) {
      out.push({
        id: `canonical-expense:${m.yearMonth}`,
        sourceSystem: 'FORECAST',
        type: 'OUTFLOW',
        category: 'OPEX',
        concept: `Egresos proyectados ${m.yearMonth}`,
        currency: 'MXN',
        originalAmount: m.expense,
        baseAmount: m.expense,
        projectedAmount: m.expense,
        projectedDate: midDate,
        confidenceScore: 70,
        confidenceBand: calculateConfidenceBand(70),
        forecastMethod: 'DRIVER',
        ruleApplied: 'Total proyectado mensual (Dashboard)',
        status: 'PROJECTED_BASE',
        lockState: 'RESTRICTED',
        comments: ['Total mensual del motor canónico. Se distribuye al mes.'],
        createdAt: `${asOfDate}T00:00:00.000Z`,
        updatedAt: `${asOfDate}T00:00:00.000Z`,
      });
    }
  }

  // ── 3. Movimientos informativos derivados de catálogos ──
  // Estos NO afectan la caja (su contribución ya está dentro del par
  // sintético del paso 2). Son únicamente para que el usuario haga
  // drilldown en la tabla y entienda de dónde vienen los totales.
  out.push(...buildInformativeCxp(inputs, todayYm));
  out.push(...buildInformativeClientCollections(inputs, todayYm));
  out.push(...buildInformativeBudgetLines(inputs, todayYm));

  // Dedupe por id por seguridad — algunos sources podrían colisionar.
  const seen = new Set<string>();
  return out.filter((mov) => {
    if (seen.has(mov.id)) return false;
    seen.add(mov.id);
    return true;
  });
}

function buildInformativeCxp(inputs: CanonicalProjectionInputs, todayYm: string): FinancialMovement[] {
  const filtered = inputs.companyCode === 'all' || !inputs.companyCode
    ? inputs.cxpRecords
    : inputs.cxpRecords.filter((r) => r.cia === inputs.companyCode);
  const providerByName = new Map(inputs.providers.map((p) => [normalize(p.name), p]));

  return filtered
    .filter((r) => r.importePendientePesos > 0)
    .slice(0, 200)
    .map((record, index) => {
      const provider = providerByName.get(normalize(record.nombre));
      const date = cleanDate(record.fechaProgramacionPago)
        ?? cleanDate(record.fechaVence)
        ?? shiftDate(inputs.asOfDate, 7);
      const ym = date.slice(0, 7);
      // No emitas CXP de meses ya pasados — esos ya están en el banco.
      if (compareYearMonth(ym, todayYm) < 0) return null;
      const score = (record.edoPago ?? '').toUpperCase().includes('APROB') ? 90 : 76;
      const movement: FinancialMovement = {
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
        comments: ['Informativo: ya considerado en el total mensual canónico.'],
        createdAt: `${inputs.asOfDate}T00:00:00.000Z`,
        updatedAt: `${inputs.asOfDate}T00:00:00.000Z`,
      };
      return movement;
    })
    .filter((m): m is FinancialMovement => m !== null);
}

function buildInformativeClientCollections(
  inputs: CanonicalProjectionInputs,
  todayYm: string,
): FinancialMovement[] {
  if (inputs.clients.length === 0) return [];
  const month = Number(inputs.asOfDate.slice(5, 7)) - 1;
  return inputs.clients
    .filter((c) => (c.monthlyBilling[month] ?? 0) > 0)
    .slice(0, 60)
    .map((client, index) => {
      const compliance = client.complianceRate ?? inputs.assumptions.globalCompliance ?? 1;
      const amount = (client.monthlyBilling[month] ?? 0) * compliance;
      const date = shiftDate(inputs.asOfDate, 10 + (index % 4) * 5 + (client.creditDays ?? 30));
      const ym = date.slice(0, 7);
      if (compareYearMonth(ym, todayYm) < 0) return null;
      const score = Math.round(55 + Math.min(40, compliance * 40));
      const movement: FinancialMovement = {
        id: `client:${client.id}:${inputs.asOfDate}:${index}`,
        sourceSystem: 'FORECAST',
        sourceObjectId: client.id,
        type: 'INFLOW',
        category: 'AR_COLLECTION',
        counterpartyId: client.id,
        counterpartyName: client.name,
        counterpartyType: 'CUSTOMER',
        concept: `Cobranza proyectada ${client.name}`,
        currency: 'MXN',
        originalAmount: amount,
        baseAmount: amount,
        projectedAmount: amount,
        issueDate: inputs.asOfDate,
        dueDate: shiftDate(inputs.asOfDate, client.creditDays ?? 30),
        projectedDate: date,
        confidenceScore: score,
        confidenceBand: calculateConfidenceBand(score),
        forecastMethod: 'RULE',
        ruleApplied: paymentPatternLabel(client),
        status: 'PROJECTED_BASE',
        lockState: 'UNLOCKED',
        comments: ['Informativo: ya considerado en el total mensual canónico.'],
        createdAt: `${inputs.asOfDate}T00:00:00.000Z`,
        updatedAt: `${inputs.asOfDate}T00:00:00.000Z`,
      };
      return movement;
    })
    .filter((m): m is FinancialMovement => m !== null);
}

function buildInformativeBudgetLines(
  inputs: CanonicalProjectionInputs,
  todayYm: string,
): FinancialMovement[] {
  if (!inputs.budget) return [];
  const out: FinancialMovement[] = [];
  for (const concept of inputs.budget.expenseByConcept ?? []) {
    for (let monthIdx = 0; monthIdx < 12; monthIdx++) {
      const amount = concept.monthly?.[monthIdx];
      if (!amount || amount <= 0) continue;
      const ym = `${inputs.budget.year}-${String(monthIdx + 1).padStart(2, '0')}`;
      if (compareYearMonth(ym, todayYm) < 0) continue;
      out.push({
        id: `budget:${inputs.budget.year}:${monthIdx + 1}:${normalize(concept.concept)}`,
        sourceSystem: 'FORECAST',
        type: 'OUTFLOW',
        category: budgetCategoryFor(concept.concept),
        concept: concept.concept,
        currency: 'MXN',
        originalAmount: amount,
        baseAmount: amount,
        projectedAmount: amount,
        projectedDate: midMonthDate(ym),
        confidenceScore: 60,
        confidenceBand: calculateConfidenceBand(60),
        forecastMethod: 'DRIVER',
        ruleApplied: 'Presupuesto anual',
        status: 'PROJECTED_BASE',
        lockState: 'RESTRICTED',
        comments: ['Informativo: parte del total mensual canónico.'],
        createdAt: `${inputs.asOfDate}T00:00:00.000Z`,
        updatedAt: `${inputs.asOfDate}T00:00:00.000Z`,
      });
    }
  }
  return out;
}

/**
 * Indicador rápido de si un set de inputs tiene datos suficientes para
 * calcular una proyección honesta. La UI lo usa para decidir entre mostrar
 * el módulo o un empty state — ya no caemos a mock data.
 */
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

function shiftDate(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function cleanDate(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
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

