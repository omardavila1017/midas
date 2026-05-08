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
import { isNonOperatingDay } from '../../../domain/bankHolidays';
import {
  buildClientLookup,
  clientRuleLabel,
  findClientForCobranza,
  resolveCobranzaRuleDate,
  type CollectionCalendarClientMatch,
} from '../../../domain/collectionCalendarEngine';
import {
  buildOwnAccountDetector,
  buildOwnAccountsIndex,
  buildPairMatchedKeys,
  classifyMovement,
} from '../../../domain/netCashFlowEngine';
import type { Budget } from '../../../domain/budget';
import type { CXPRecord } from '../../../domain/persistence';
import type { Client, Provider, CashFlowAssumptions } from '../../../domain/types';
import type { BankAccountStatement } from '../../../services/jde';
import type { CobranzaRecord } from '../../../services/jdeTypes';
import type { RealReconciliationResult } from '../../../domain/realReconciliationEngine';
import { enrichFromCatalog } from '../../../domain/providerCatalog';
import { calculateConfidenceBand } from './financialProjectionEngine';
import type {
  FinancialMovement,
  FinancialMovementCategory,
  FinancialTaxRate,
  PayrollCostRecord,
  PurchaseReceiptRecord,
} from '../types';
import {
  buildPayrollCostMovements,
  buildPurchaseReceiptMovements,
} from '../sourceRecords';

const DAY_MS = 86_400_000;

export interface CanonicalProjectionInputs {
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
   * cobro pendiente — el dinero ya está en los movimientos bancarios
   * históricos. Sin esto la suma anual queda doblada.
   */
  cobranzaReconciliation?: RealReconciliationResult;
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
  const inflowContext = buildInflowContext(inputs);

  // Mismo contexto de clasificación que `buildHistoricalMonths` del
  // Dashboard. Sin esto los traspasos internos (TRASPASO REF, RFCs del
  // grupo, pares CARGO/ABONO simétricos) se emitían como FinancialMovement
  // y la suma de movements[] no empataba con monthly[] — la gráfica de
  // Caja proyectada inflaba ingresos y egresos por igual.
  const ownAccountDetector = buildOwnAccountDetector(
    buildOwnAccountsIndex(inputs.bankStatements),
  );
  const pairedKeys = buildPairMatchedKeys(inputs.bankStatements);

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
      // Filtra traspasos internos antes de emitir el FinancialMovement —
      // mismo criterio que el Dashboard. Movimientos clasificados como
      // 'internal' nunca llegan a la tabla, gráfica ni drilldowns.
      if (
        classifyMovement(
          line,
          { ownAccountDetector, pairedKeys },
          statement.cia,
          statement.cuenta,
        ).kind === 'internal'
      ) continue;
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
    const inflowLines = collectInflowLines(month, inputs, todayYm, inflowContext);
    out.push(...balanceInflowMonth({
      lines: inflowLines,
      target: month.income,
      ym: month.yearMonth,
      asOfDate: inputs.asOfDate,
      fallbackCategory: 'AR_COLLECTION',
      fallbackConcept: `Cobranza proyectada ${month.yearMonth}`,
      fallbackRule: 'Total proyectado mensual (Dashboard)',
    }));

    const outflowLines = collectOutflowLines(month, inputs, todayYm);
    out.push(...balanceOutflowMonth({
      lines: outflowLines,
      target: month.expense,
      ym: month.yearMonth,
      asOfDate: inputs.asOfDate,
      fallbackCategory: 'OPEX',
      fallbackConcept: `Egresos proyectados ${month.yearMonth}`,
      fallbackRule: 'Total proyectado mensual (Dashboard)',
    }));
  }

  // 3) Mes en curso (histórico parcial). Días pasados ya están como
  //    REAL desde el banco; el resto del mes se escala al presupuesto
  //    para que la proyección empate con el chart "Flujo mensual" del
  //    Dashboard, que muestra `proyectado = budget(mes) - real(mes)`.
  //    Sin escalar (emitRawLines crudo), el catálogo CXC/CXP suele
  //    sumar muchísimo menos que el budget y el usuario ve un mes en
  //    curso enano respecto al Dashboard.
  const currentYm = todayYm;
  const currentHistorical = monthly.find((m) => m.isHistorical && m.yearMonth === currentYm);
  if (currentHistorical) {
    const monthIndex = Number(currentYm.slice(5, 7)) - 1;
    const budgetIncome = inputs.budget?.incomeTotal?.[monthIndex] ?? 0;
    const budgetExpense = inputs.budget?.expenseTotal?.[monthIndex] ?? 0;
    const remainingIncome = Math.max(0, budgetIncome - currentHistorical.income);
    const remainingExpense = Math.max(0, budgetExpense - currentHistorical.expense);

    const inflowLines = collectInflowLines(currentHistorical, inputs, todayYm, inflowContext)
      .filter((line) => line.date >= inputs.asOfDate);
    if (remainingIncome > 0) {
      out.push(...balanceInflowMonth({
        lines: inflowLines,
        target: remainingIncome,
        ym: currentYm,
        asOfDate: inputs.asOfDate,
        fallbackCategory: 'AR_COLLECTION',
        fallbackConcept: `Cobranza proyectada ${currentYm} (resto del mes)`,
        fallbackRule: 'Presupuesto del mes en curso menos cobranza real',
      }));
    } else {
      out.push(...emitRawLines(inflowLines, 'INFLOW', inputs.asOfDate));
    }

    const outflowLines = collectOutflowLines(currentHistorical, inputs, todayYm)
      .filter((line) => line.date >= inputs.asOfDate);
    if (remainingExpense > 0) {
      out.push(...balanceMonth({
        lines: outflowLines,
        target: remainingExpense,
        ym: currentYm,
        type: 'OUTFLOW',
        asOfDate: inputs.asOfDate,
        fallbackCategory: 'OPEX',
        fallbackConcept: `Egresos proyectados ${currentYm} (resto del mes)`,
        fallbackRule: 'Presupuesto del mes en curso menos egresos reales',
      }));
    } else {
      out.push(...emitRawLines(outflowLines, 'OUTFLOW', inputs.asOfDate));
    }
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
    subcategory: line.subcategory,
    companyId: line.companyId,
    counterpartyId: line.counterpartyId,
    counterpartyName: line.counterpartyName,
    counterpartyType: line.counterpartyType,
    providerCategory: line.providerCategory,
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
    ...scaleTaxMeta(line, line.amount),
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
  subcategory?: string;
  providerCategory?: string;
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
  taxBaseAmount?: number;
  taxAmount?: number;
  amountLocked?: boolean;
}

interface InflowContext {
  cxcRecords: CobranzaRecord[];
  cxcCoverageByClientMonth: Map<string, Set<string>>;
  clientMatchByFactura: Map<string, CollectionCalendarClientMatch | null>;
}

function buildInflowContext(inputs: CanonicalProjectionInputs): InflowContext {
  const clientLookup = buildClientLookup(inputs.clients);
  const cxcRecords = filterCobranzaByCompany(inputs.cobranzaRecords ?? [], inputs.companyCode);
  const cxcCoverageByClientMonth = new Map<string, Set<string>>();
  const clientMatchByFactura = new Map<string, CollectionCalendarClientMatch | null>();

  for (const record of cxcRecords) {
    const match = findClientForCobranza(record, clientLookup);
    clientMatchByFactura.set(cxcFacturaKey(record), match);
    if (match && record.fechaFactura) {
      addCoveredMonth(cxcCoverageByClientMonth, match.client.id, record.fechaFactura.slice(0, 7));
    }
  }

  return {
    cxcRecords,
    cxcCoverageByClientMonth,
    clientMatchByFactura,
  };
}

/**
 * Inflows: primero mete facturas CXC abiertas de JDE a valor nominal y
 * luego completa el resto del mes con `projectClientMonth` para clientes.
 * Cada evento tiene fecha real que respeta:
 *   - frecuencia (semanal, quincenal, mensual, contado)
 *   - días de crédito del cliente
 *   - patrón de pago (DOM, DOW, etc.) o factoraje
 *
 * Las facturas CXC emitidas bloquean su monto y cubren el ciclo del cliente
 * para no duplicar la misma venta como forecast genérico.
 * Esto produce muchos puntos en distintos días → la vista semanal/diaria
 * se ve poblada en lugar de un solo bloque a mediados de mes.
 */
function collectInflowLines(
  month: CanonicalMonthlyPoint,
  inputs: CanonicalProjectionInputs,
  _todayYm: string,
  context: InflowContext,
): RawLine[] {
  const [year, mNum] = month.yearMonth.split('-').map(Number);
  const targetMonthIdx = mNum - 1;
  const lines: RawLine[] = collectCxcInflowLines(month, inputs, context);

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
    const coveredMonths = context.cxcCoverageByClientMonth.get(client.id);
    let evIdx = 0;
    for (const scan of monthsToScan) {
      const invoiceYm = `${scan.year}-${String(scan.monthIdx + 1).padStart(2, '0')}`;
      if (coveredMonths?.has(invoiceYm)) continue;
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
        const taxRate = client.ivaRate ?? 16;
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
          taxTreatment: 'IVA_CAUSED',
          taxRate,
          taxBaseAmount: event.amount,
          taxAmount: event.amount * (taxRate / 100),
          comment: `Evento proyectado por collectionEngine. Lag teórico ${event.lagDays} días.`,
        });
      }
    }
  }

  return lines;
}

function collectCxcInflowLines(
  month: CanonicalMonthlyPoint,
  inputs: CanonicalProjectionInputs,
  context: InflowContext,
): RawLine[] {
  if (context.cxcRecords.length === 0) return [];
  const lines: RawLine[] = [];
  const seen = new Set<string>();
  // Facturas que el reconciliation engine ya cruzó al céntimo con un
  // ABONO bancario: el dinero ya está en los movimientos históricos del
  // banco. Si las re-proyectamos, queda doblada. Sólo las descartamos
  // cuando el cruce fue automático (status='cobrada-banco'); facturas en
  // revisión manual o sin cruce siguen como pendiente proyectada.
  const cobradaBancoKeys = buildCobradaBancoKeySet(inputs.cobranzaReconciliation);

  for (const record of context.cxcRecords) {
    if (record.importePendientePesos <= 0) continue;
    const key = cxcFacturaKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    if (cobradaBancoKeys.has(key)) continue;

    const clientMatch = context.clientMatchByFactura.get(key) ?? null;
    const resolved = clientMatch
      ? resolveCobranzaRuleDate(record, clientMatch.client, inputs.assumptions)
      : null;
    const rawDate = resolved?.calendarDate
      ?? cleanDate(record.fechaVence)
      ?? cleanDate(record.fechaFactura)
      ?? inputs.asOfDate;
    const dateInfo = moveOpenReceivableIntoProjection(rawDate, inputs.asOfDate);
    if (dateInfo.date.slice(0, 7) !== month.yearMonth) continue;

    const taxMeta = cxcTaxMeta(record, clientMatch?.client);
    const confidenceScore = clientMatch
      ? Math.round(Math.min(92, 72 + clientMatch.confidence * 18))
      : 62;
    const dateReason = resolved
      ? resolved.reason
      : record.fechaVence
        ? 'Sin regla confiable; se usa vencimiento JDE.'
        : 'Sin regla confiable; se usa fecha de factura JDE.';

    lines.push({
      id: `cxc:${record.cia}:${record.noCliente}:${record.noFactura}`,
      amount: record.importePendientePesos,
      date: dateInfo.date,
      concept: `Factura CXC ${record.noFactura || 'sin folio'} · ${record.nombreCliente || 'Cliente sin nombre'}`,
      category: 'AR_COLLECTION',
      companyId: record.cia,
      counterpartyId: clientMatch?.client.id ?? record.noCliente,
      counterpartyName: record.nombreCliente || clientMatch?.client.name,
      counterpartyType: 'CUSTOMER',
      ruleApplied: clientMatch ? clientRuleLabel(clientMatch.client) : 'Fecha vencimiento JDE',
      sourceSystem: 'JDE',
      sourceObjectId: record.noFactura,
      issueDate: cleanDate(record.fechaFactura),
      dueDate: cleanDate(record.fechaVence),
      forecastMethod: 'RULE',
      confidenceScore,
      lockState: 'RESTRICTED',
      taxTreatment: 'IVA_CAUSED',
      taxRate: taxMeta.taxRate,
      taxBaseAmount: taxMeta.taxBaseAmount,
      taxAmount: taxMeta.taxAmount,
      comment: [
        'Factura CXC abierta en JDE; se proyecta sólo el saldo pendiente.',
        dateReason,
        dateInfo.moved ? 'La fecha esperada ya venció; se agenda al siguiente día operativo de la proyección.' : '',
      ].filter(Boolean).join(' '),
      amountLocked: true,
    });
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
  const providerByName = new Map(inputs.providers.map((p) => [supplierLookupKey(p.name), p]));
  const providerByJde = new Map<string, Provider>();
  for (const provider of inputs.providers) {
    const jdeKey = providerJdeKey(provider.numProveedorJDE);
    if (jdeKey) providerByJde.set(jdeKey, provider);
  }
  const filteredCxp = inputs.companyCode === 'all' || !inputs.companyCode
    ? inputs.cxpRecords
    : inputs.cxpRecords.filter((r) => r.cia === inputs.companyCode);

  // 1) CXP abierta de JDE. Si ya venció, se trae al día operativo actual
  // para que el scheduler decida si se paga hoy, se recorre o queda pendiente.
  filteredCxp.forEach((record, index) => {
    if (record.importePendientePesos <= 0) return;
    const scheduledDate = cleanDate(record.fechaProgramacionPago)
      ?? cleanDate(record.fechaVence)
      ?? cleanDate(record.fechaFactura)
      ?? inputs.asOfDate;
    const dueDate = cleanDate(record.fechaVence);
    const rawDate = dueDate && scheduledDate < dueDate ? dueDate : scheduledDate;
    const dateInfo = moveOpenPayableIntoProjection(rawDate, inputs.asOfDate);
    if (dateInfo.date.slice(0, 7) !== month.yearMonth) return;
    if (compareYearMonth(dateInfo.date.slice(0, 7), todayYm) < 0) return;
    const provider = (record.noProveedor ? providerByJde.get(providerJdeKey(record.noProveedor)) : undefined)
      ?? providerByName.get(supplierLookupKey(record.nombre));
    const catalog = enrichFromCatalog({
      supplier: record.nombre,
      classification: record.clasificacionProveedor || record.clasifica,
    });
    const providerType = provider?.type
      || catalog.providerType
      || record.clasificacionProveedor
      || record.clasifica
      || 'Sin clasificar';
    const score = provider?.score != null
      ? Math.max(0, Math.min(100, Math.round(provider.score)))
      : (record.edoPago ?? '').toUpperCase().includes('APROB')
        ? 90
        : 76;
    const taxBreakdown = taxBreakdownFromCxp(record);
    lines.push({
      id: `cxp:${record.cia}:${record.noProveedor}:${record.noFactura}:${index}`,
      amount: record.importePendientePesos,
      date: dateInfo.date,
      concept: `Factura ${record.noFactura || 'sin folio'} · ${record.nombre}`,
      category: 'AP_PAYMENT',
      subcategory: providerType,
      providerCategory: providerType,
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
      taxTreatment: taxBreakdown.taxRate ? 'IVA_CREDITABLE' : 'UNCLASSIFIED',
      taxRate: taxBreakdown.taxRate,
      taxBaseAmount: taxBreakdown.taxBaseAmount,
      taxAmount: taxBreakdown.taxAmount,
      comment: [
        'Factura abierta en JDE.',
        dateInfo.moved ? `Fecha original ${rawDate}; se agenda desde ${dateInfo.date} para decisión diaria.` : '',
      ].filter(Boolean).join(' '),
      amountLocked: true,
    });
  });

  // 2) Compras activas sin CXP matcheada. Son compromisos tempranos: se
  // emiten como locked para no perderlos al balancear contra budget/baseline.
  for (const movement of buildPurchaseReceiptMovements({
    purchaseReceipts: inputs.purchaseReceipts ?? [],
    cxpRecords: inputs.cxpRecords,
    companyCode: inputs.companyCode,
    asOfDate: inputs.asOfDate,
  })) {
    if (movement.projectedDate.slice(0, 7) !== month.yearMonth) continue;
    lines.push({
      id: movement.id,
      amount: movement.projectedAmount,
      date: movement.projectedDate,
      concept: movement.concept,
      category: movement.category,
      subcategory: movement.subcategory,
      providerCategory: movement.providerCategory,
      counterpartyId: movement.counterpartyId,
      counterpartyName: movement.counterpartyName,
      counterpartyType: movement.counterpartyType,
      ruleApplied: movement.ruleApplied ?? 'Recibo de compras',
      sourceSystem: movement.sourceSystem,
      sourceObjectId: movement.sourceObjectId,
      companyId: movement.companyId,
      issueDate: movement.issueDate,
      dueDate: movement.dueDate,
      forecastMethod: movement.forecastMethod,
      confidenceScore: movement.confidenceScore,
      lockState: movement.lockState,
      taxTreatment: movement.taxTreatment,
      taxRate: movement.taxRate,
      taxBaseAmount: movement.taxBaseAmount,
      taxAmount: movement.taxAmount,
      comment: movement.comments?.join(' ') ?? 'Compromiso temprano desde Recibo de Compras.',
      amountLocked: true,
    });
  }

  // 3) Nómina TRESS. No genera IVA; sí alimenta ISN/IMSS en el módulo fiscal.
  for (const movement of buildPayrollCostMovements({
    payrollCosts: inputs.payrollCosts ?? [],
    companyCode: inputs.companyCode,
    asOfDate: inputs.asOfDate,
  })) {
    if (movement.projectedDate.slice(0, 7) !== month.yearMonth) continue;
    lines.push({
      id: movement.id,
      amount: movement.projectedAmount,
      date: movement.projectedDate,
      concept: movement.concept,
      category: movement.category,
      subcategory: movement.subcategory,
      counterpartyName: movement.counterpartyName,
      counterpartyType: movement.counterpartyType,
      ruleApplied: movement.ruleApplied ?? 'TRESS',
      sourceSystem: movement.sourceSystem,
      sourceObjectId: movement.sourceObjectId,
      companyId: movement.companyId,
      issueDate: movement.issueDate,
      dueDate: movement.dueDate,
      forecastMethod: movement.forecastMethod,
      confidenceScore: movement.confidenceScore,
      lockState: movement.lockState,
      taxTreatment: movement.taxTreatment,
      taxRate: movement.taxRate,
      taxBaseAmount: movement.taxBaseAmount,
      taxAmount: movement.taxAmount,
      comment: movement.comments?.join(' ') ?? 'Costo de nómina desde TRESS.',
      amountLocked: true,
    });
  }

  // 4) Líneas del presupuesto que aplican a este mes. Las distribuimos
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
        const category = budgetCategoryFor(concept.concept);
        const taxMeta = budgetTaxMeta(concept.concept, amount);
        conceptIdx++;
        lines.push({
          id: `budget:${inputs.budget.year}:${monthIdx + 1}:${normalize(concept.concept)}`,
          amount,
          date: dateForDayOfMonth(month.yearMonth, typicalDay),
          concept: concept.concept,
          category,
          ruleApplied: 'Presupuesto anual',
          sourceSystem: 'FORECAST',
          forecastMethod: 'DRIVER',
          confidenceScore: 60,
          lockState: 'RESTRICTED',
          taxTreatment: taxMeta ? 'IVA_CREDITABLE' : category === 'PAYROLL' || category === 'TAX' || category === 'DEBT'
            ? 'IVA_EXEMPT'
            : 'UNCLASSIFIED',
          taxRate: taxMeta?.taxRate,
          taxBaseAmount: taxMeta?.taxBaseAmount,
          taxAmount: taxMeta?.taxAmount,
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

function balanceInflowMonth({
  lines,
  target,
  ym,
  asOfDate,
  fallbackCategory,
  fallbackConcept,
  fallbackRule,
}: Omit<BalanceArgs, 'type'>): FinancialMovement[] {
  const locked = lines.filter((line) => line.amountLocked);
  const flexible = lines.filter((line) => !line.amountLocked);
  const lockedSum = locked.reduce((sum, line) => sum + line.amount, 0);
  const out = emitRawLines(locked, 'INFLOW', asOfDate);
  const remainingTarget = Math.max(0, target - lockedSum);

  out.push(...balanceMonth({
    lines: flexible,
    target: remainingTarget,
    ym,
    type: 'INFLOW',
    asOfDate,
    fallbackCategory,
    fallbackConcept,
    fallbackRule,
  }));
  return out;
}

function balanceOutflowMonth({
  lines,
  target,
  ym,
  asOfDate,
  fallbackCategory,
  fallbackConcept,
  fallbackRule,
}: Omit<BalanceArgs, 'type'>): FinancialMovement[] {
  const locked = lines.filter((line) => line.amountLocked);
  const flexible = lines.filter((line) => !line.amountLocked);
  const lockedSum = locked.reduce((sum, line) => sum + line.amount, 0);
  const out = emitRawLines(locked, 'OUTFLOW', asOfDate);
  const remainingTarget = Math.max(0, target - lockedSum);

  out.push(...balanceMonth({
    lines: flexible,
    target: remainingTarget,
    ym,
    type: 'OUTFLOW',
    asOfDate,
    fallbackCategory,
    fallbackConcept,
    fallbackRule,
  }));
  return out;
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
    const fallbackTaxMeta = fallbackCategory === 'OPEX' || fallbackCategory === 'CAPEX' || fallbackCategory === 'AP_PAYMENT'
      ? grossToIvaTaxMeta(target, 16)
      : undefined;
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
      taxTreatment: fallbackTaxMeta
        ? 'IVA_CREDITABLE'
        : fallbackCategory === 'AR_COLLECTION'
          ? 'UNCLASSIFIED'
          : fallbackCategory === 'PAYROLL' || fallbackCategory === 'TAX' || fallbackCategory === 'DEBT'
            ? 'IVA_EXEMPT'
            : 'UNCLASSIFIED',
      taxRate: fallbackTaxMeta?.taxRate,
      taxBaseAmount: fallbackTaxMeta?.taxBaseAmount,
      taxAmount: fallbackTaxMeta?.taxAmount,
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
      subcategory: line.subcategory,
      companyId: line.companyId,
      counterpartyId: line.counterpartyId,
      counterpartyName: line.counterpartyName,
      counterpartyType: line.counterpartyType,
      providerCategory: line.providerCategory,
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
      ...scaleTaxMeta(line, scaled),
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
  const cobranzaRecords = inputs.cobranzaRecords ?? [];
  const purchaseReceipts = inputs.purchaseReceipts ?? [];
  const payrollCosts = inputs.payrollCosts ?? [];
  if (inputs.bankStatements.length === 0 && cobranzaRecords.length === 0 && purchaseReceipts.length === 0 && payrollCosts.length === 0) return false;
  if (
    inputs.budget === null
    && inputs.clients.length === 0
    && inputs.cxpRecords.length === 0
    && cobranzaRecords.length === 0
    && purchaseReceipts.length === 0
    && payrollCosts.length === 0
  ) {
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
  if (upper.includes('NOMINA') || upper.includes('NÓMINA') || upper.includes('SUELDOS') || upper.includes('FINIQUITO')) {
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

function filterCobranzaByCompany(records: CobranzaRecord[], companyCode: string): CobranzaRecord[] {
  if (companyCode === 'all' || !companyCode) return records;
  return records.filter((record) => record.cia === companyCode);
}

function cxcFacturaKey(record: CobranzaRecord): string {
  return `${record.cia}::${record.noFactura}`;
}

/**
 * Set de facturas que el reconciliation engine ya cruzó automáticamente
 * con un ABONO bancario. Sólo el estado 'cobrada-banco' bloquea la
 * proyección. 'cobrada-jde-sin-banco' o 'pendiente' pasan derecho:
 * el cobro aún no aparece en el banco, así que la CXC pendiente sigue
 * siendo el mejor estimado para la trayectoria de caja.
 */
function buildCobradaBancoKeySet(
  reconciliation: RealReconciliationResult | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!reconciliation) return out;
  for (const match of reconciliation.matches) {
    if (match.status !== 'cobrada-banco') continue;
    out.add(`${match.cia}::${match.noFactura}`);
  }
  return out;
}

function addCoveredMonth(map: Map<string, Set<string>>, clientId: string, yearMonth: string): void {
  const set = map.get(clientId) ?? new Set<string>();
  set.add(yearMonth);
  map.set(clientId, set);
}

function moveOpenReceivableIntoProjection(
  rawDate: string,
  asOfDate: string,
): { date: string; moved: boolean } {
  const safeDate = cleanDate(rawDate) ?? asOfDate;
  if (safeDate > asOfDate) return { date: safeDate, moved: false };

  let next = parseIsoDate(asOfDate);
  next = new Date(next.getTime() + DAY_MS);
  while (isNonOperatingDay(next)) next = new Date(next.getTime() + DAY_MS);
  return { date: dateToIso(next), moved: true };
}

function moveOpenPayableIntoProjection(
  rawDate: string,
  asOfDate: string,
): { date: string; moved: boolean } {
  const safeDate = cleanDate(rawDate) ?? asOfDate;
  if (safeDate >= asOfDate) return { date: safeDate, moved: false };

  let next = parseIsoDate(asOfDate);
  while (isNonOperatingDay(next)) next = new Date(next.getTime() + DAY_MS);
  return { date: dateToIso(next), moved: true };
}

function parseIsoDate(value: string): Date {
  const safe = cleanDate(value) ?? new Date().toISOString().slice(0, 10);
  const [year, month, day] = safe.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateToIso(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

function supplierLookupKey(value: string | undefined): string {
  if (!value) return '';
  return value
    .toUpperCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function providerJdeKey(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  const numeric = trimmed.replace(/\D/g, '');
  if (numeric) return String(Number(numeric));
  return supplierLookupKey(trimmed);
}

function cxcTaxMeta(
  record: CobranzaRecord,
  client?: Client,
): { taxRate: FinancialTaxRate; taxBaseAmount: number; taxAmount: number } {
  const rate = client?.ivaRate === 8 ? 8 : 16;
  return grossToIvaTaxMeta(record.importePendientePesos, rate);
}

function taxBreakdownFromCxp(record: CXPRecord): {
  taxRate?: FinancialTaxRate;
  taxBaseAmount?: number;
  taxAmount?: number;
} {
  const gross = positiveNumber(record.importeBrutoPesos);
  const pending = positiveNumber(record.importePendientePesos);
  const subtotal = positiveNumber(record.importeSubtotalPesos);
  const tax = positiveNumber(record.importeImpuestosPesos);
  if (pending <= 0) return {};
  if (gross <= 0 || subtotal <= 0 || tax <= 0) return grossToIvaTaxMeta(pending, 16);
  const scale = Math.min(1, pending / gross);
  const taxBaseAmount = subtotal * scale;
  const taxAmount = tax * scale;
  const taxRate = taxRateFromAmounts(taxBaseAmount, taxAmount);
  return taxRate ? { taxRate, taxBaseAmount, taxAmount } : grossToIvaTaxMeta(pending, 16);
}

function taxRateFromAmounts(base: number, taxAmount: number): FinancialTaxRate | undefined {
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(taxAmount) || taxAmount <= 0) return undefined;
  const pct = Math.round((taxAmount / base) * 100);
  if (Math.abs(pct - 16) <= 1) return 16;
  if (Math.abs(pct - 8) <= 1) return 8;
  return undefined;
}

function budgetTaxMeta(
  concept: string,
  amount: number,
): { taxRate: FinancialTaxRate; taxBaseAmount: number; taxAmount: number } | undefined {
  const category = budgetCategoryFor(concept);
  if (category !== 'OPEX' && category !== 'CAPEX') return undefined;
  return grossToIvaTaxMeta(amount, 16);
}

function grossToIvaTaxMeta(
  amount: number,
  rate: 8 | 16,
): { taxRate: FinancialTaxRate; taxBaseAmount: number; taxAmount: number } {
  const taxBaseAmount = amount / (1 + rate / 100);
  return {
    taxRate: rate,
    taxBaseAmount,
    taxAmount: amount - taxBaseAmount,
  };
}

function scaleTaxMeta(
  line: Pick<RawLine, 'amount' | 'taxBaseAmount' | 'taxAmount'>,
  projectedAmount: number,
): Pick<FinancialMovement, 'taxBaseAmount' | 'taxAmount'> {
  if (line.taxBaseAmount == null || line.taxAmount == null || line.amount <= 0) return {};
  const scale = projectedAmount / line.amount;
  return {
    taxBaseAmount: line.taxBaseAmount * scale,
    taxAmount: line.taxAmount * scale,
  };
}

function positiveNumber(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
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
  if (upper.includes('NOMINA') || upper.includes('NÓMINA') || upper.includes('SUELDOS') || upper.includes('FINIQUITO')) return 'PAYROLL';
  if (upper.includes('IMPUESTO') || upper.includes('ISR') || upper.includes('IVA') || upper.includes('IMSS')) return 'TAX';
  if (upper.includes('DEUDA') || upper.includes('PRESTAMO') || upper.includes('CREDITO') || upper.includes('PASIVO')) return 'DEBT';
  if (upper.includes('CAPEX') || upper.includes('INVERSION')) return 'CAPEX';
  return 'OPEX';
}
