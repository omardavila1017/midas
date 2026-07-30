// ─────────────────────────────────────────────────────────────────────────
// canonicalProjection — API pública y punto único de entrada del motor
// canónico que consumen Proyección Financiera, Planeación Financiera y el
// Dashboard. `buildCanonicalProjection` corre el motor de caja del Dashboard
// (`computeBaseCashFlow`) y luego compone los movimientos a nivel línea con
// los dos motores nombrados:
//
//   • MOTOR 1 — `buildHistoricalReconciledMovements` (≤ hoy) en
//     `historicalReconciledEngine.ts`. La verdad histórica del efectivo
//     (banco + internal-recon + rellenos sin-banco).
//   • MOTOR 2 — `buildShortTermProjectionMovements` (> hoy) en
//     `shortTermProjectionEngine.ts`. Datos reales de corto plazo (Cobranza/
//     CXC + ROL + Viajes Especiales + CXP + OC compras + nómina TRESS).
//
// `buildMovements` orquesta ambos y corre el prorrateo Citi UNA vez sobre la
// lista compuesta. Tipos y helpers transversales viven en
// `canonicalProjectionShared.ts`. Este archivo re-exporta los motores y los
// tipos públicos para no generar churn de imports en los consumidores.
//
// Reglas del módulo:
//
//   1. La trayectoria de caja MENSUAL coincide byte-a-byte con la del
//      Dashboard. Cada movimiento informativo guarda su monto crudo en
//      `baseAmount` y el monto proyectado en `projectedAmount`.
//   2. NUNCA caemos a mock data. Los motores sólo emiten datos reales o
//      proyecciones fechadas por regla real.
// ─────────────────────────────────────────────────────────────────────────

import { computeBaseCashFlow } from '../../../domain/dashboardEngine';
import type { ComputeInputs } from '../../../domain/dashboardEngine';
import { toYearMonth } from '../../../domain/cashFlowEngine';
import {
  buildClientLookup,
  findClientForCobranza,
} from '../../../domain/collectionCalendarEngine';
import { isInternalCounterparty } from '../../../domain/netCashFlowEngine';
import { isPersonName } from '../../../domain/personNameHeuristic';
import { VIAJES_ESPECIALES_GROUP_ID } from '../../../domain/viajesEspecialesCatalog';
import { findBankAccount } from '../../../domain/bankAccountsCatalog';
import { normalizeCia } from '../../../domain/cia';
import { calculateConfidenceBand } from './financialProjectionEngine';
import type { FinancialMovement } from '../types';
import { buildHistoricalReconciledMovements } from './historicalReconciledEngine';
import { buildShortTermProjectionMovements } from './shortTermProjectionEngine';
import {
  cleanDate,
  clientDisplayCounterparty,
  CITI_CLIENT_SUBROLE,
  INCOME_SUBCAT_CITI,
  type BuildArgs,
  type CanonicalProjectionInputs,
  type CanonicalMonthlyPoint,
  type CanonicalProjectionResult,
} from './canonicalProjectionShared';

// Re-export de los motores + tipos públicos para mantener la superficie de
// import estable (consumidores y tests siguen importando desde aquí).
export { buildHistoricalReconciledMovements } from './historicalReconciledEngine';
export { buildShortTermProjectionMovements } from './shortTermProjectionEngine';
export type {
  CanonicalProjectionInputs,
  CanonicalMonthlyPoint,
  CanonicalProjectionResult,
} from './canonicalProjectionShared';

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
    purchaseReceipts: inputs.purchaseReceipts,
    cobranzaRecords: inputs.cobranzaRecords,
    enablePredictive: inputs.enablePredictive !== false,
    reconciledByCompanyMonth: inputs.reconciledByCompanyMonth,
  };
  const { base, predictive } = computeBaseCashFlow(computeInputs);

  const monthly: CanonicalMonthlyPoint[] = base.map((m) => ({
    yearMonth: m.yearMonth,
    isHistorical: m.isHistorical,
    income: m.income,
    expense: m.expense,
    closingCash: m.closingCash,
    actualIncome: m.actualIncome,
    actualExpense: m.actualExpense,
  }));

  const movements = buildMovements({ monthly, inputs });

  // Caja inicial = saldo de apertura real del banco. Derivada del PRIMER mes
  // restando sus brutos que ENCADENAN la caja. Con MOTOR 1, `income/expense`
  // del mes pueden ser los reconciliados (verdad contable), pero la caja se
  // encadenó desde el banco (`actualIncome/actualExpense`); por eso restamos
  // los brutos bancarios reales, no los reportados — así `initialCash` queda
  // anclado al saldo bancario de apertura y la caja de Planeación cuadra.
  const first = base[0];
  const initialCash = base.length > 0
    ? first.closingCash - (first.actualIncome ?? first.income) + (first.actualExpense ?? first.expense)
    : (inputs.startingBalance ?? 0);

  return {
    monthly,
    movements,
    initialCash,
    fromYearMonth: monthly[0]?.yearMonth ?? toYearMonth(inputs.asOfDate),
    toYearMonth: monthly[monthly.length - 1]?.yearMonth ?? toYearMonth(inputs.asOfDate),
    predictive,
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

/**
 * Orquestador: compone MOTOR 1 (histórico reconciliado, ≤ hoy) + MOTOR 2
 * (proyección corto plazo, > hoy) y corre el prorrateo Citi UNA vez sobre la
 * lista compuesta. El prorrateo sólo re-etiqueta líneas históricas `bank:`
 * TRANSFER de la CONCENTRADORA CLIENTES CITI por cliente, así que correrlo
 * sobre la concatenación es equivalente a hacerlo sobre el `out` monolítico
 * previo.
 */
function buildMovements({ monthly, inputs }: BuildArgs): FinancialMovement[] {
  const historical = buildHistoricalReconciledMovements({ monthly, inputs });
  const future = buildShortTermProjectionMovements({ monthly, inputs });
  return prorateCitiConcentradoraByClient([...historical, ...future], inputs);
}

/**
 * Atribución por cliente de los depósitos reales a las concentradoras Citi.
 *
 * Un depósito a la concentradora "CONCENTRADORA CLIENTES CITI" es UN
 * movimiento bancario que agrupa el cobro de muchos clientes; el banco no trae
 * el folio de factura (la conciliación AuxiliarContable solo cruza objeto
 * 1010-1020, sin la línea CXC), así que no se puede amarrar 1:1 a un cliente.
 * El detalle por cliente SÍ vive en la cobranza JDE (`fechaCobro`, `noCliente`).
 *
 * Aquí prorrateamos: por cada (cía, mes), repartimos el TOTAL real depositado a
 * las concentradoras `clientes_citi` que NO cruzó a factura, entre los clientes
 * según su peso en la cobranza del mes que TAMPOCO quedó atribuida por cruce.
 * El total mensual del banco se conserva EXACTO (Σ pesos = 1) — es la verdad
 * del efectivo; solo cambia la atribución por cliente. La cobranza se usa como
 * PESO (ratio), nunca como monto, así que no hay doble conteo.
 *
 * El denominador es la clave: sólo cobranza SIN atribuir. El pool a repartir ya
 * excluye los ABONOs cruzados (quedaron como AR_COLLECTION), así que un
 * denominador con la cobranza completa del mes mezcla dos universos y diluye a
 * todo cliente no cruzado por `pool / cobranzaTotal`. Si un (cía, mes) no tiene
 * cobranza sin atribuir, el depósito amontonado se conserva tal cual (fallback
 * — la fila concentradora sigue ahí; preferible a inventar una atribución).
 *
 * Fecha de las líneas sintéticas: la del depósito más grande del mes (mejor
 * proxy de cuándo entró el grueso del efectivo). Aproximación aceptada para el
 * desglose por cliente; el reparto intra-mes diario es aproximado.
 */
function prorateCitiConcentradoraByClient(
  movements: FinancialMovement[],
  inputs: CanonicalProjectionInputs,
): FinancialMovement[] {
  // La cía se normaliza en AMBOS lados del join (movimiento y cobranza): hoy
  // todas las fuentes ya la emiten con padding a 5 dígitos, pero un mismatch de
  // padding aquí no da error — deja el grupo sin pesos y el mes entero sin
  // desglosar por cliente. Misma clase de bug que causó doble conteo en CXP
  // (mantenimiento 2026-07-21); barato blindarlo en lógica de dinero.
  const groupKeyOf = (m: FinancialMovement): string =>
    `${normalizeCia(m.companyId ?? '')}::${(m.actualDate ?? m.projectedDate ?? '').slice(0, 7)}`;
  const isTarget = (m: FinancialMovement): boolean =>
    m.type === 'INFLOW'
    && m.status === 'REAL'
    && m.category === 'TRANSFER'
    && m.subcategory === INCOME_SUBCAT_CITI
    && findBankAccount(m.bankAccountId)?.subRole === CITI_CLIENT_SUBROLE;

  const targets = movements.filter(isTarget);
  if (targets.length === 0) return movements;

  // 1) Total real depositado + fecha representativa por (cía, mes).
  interface Group { cia: string; ym: string; total: number; repDate: string; repAmount: number; }
  const groups = new Map<string, Group>();
  for (const movement of targets) {
    const date = movement.actualDate ?? movement.projectedDate;
    if (!date) continue;
    const amount = Math.abs(movement.projectedAmount ?? movement.baseAmount ?? 0);
    if (!(amount > 0)) continue;
    const key = groupKeyOf(movement);
    const group = groups.get(key);
    if (group) {
      group.total += amount;
      if (amount > group.repAmount) { group.repAmount = amount; group.repDate = date; }
    } else {
      groups.set(key, { cia: movement.companyId ?? '', ym: date.slice(0, 7), total: amount, repDate: date, repAmount: amount });
    }
  }

  // 2) Cobranza YA atribuida por cruce directo banco↔factura.
  //
  // Ese cobro salió del pool a prorratear: su ABONO quedó como AR_COLLECTION
  // (no TRANSFER), así que `group.total` ya NO lo contiene. Si además siguiera
  // pesando en el reparto, el denominador incluiría clientes que ya cobraron y
  // TODO cliente sin cruzar se diluiría por el factor `pool / cobranzaTotal`
  // — el defecto reportado con 3M (2026-02): un cobro real de $221,201.53 que
  // no cruzó quedaba solo en el pool y se repartía contra los $222M de
  // cobranza del mes, devolviéndole $220.40 (1/1000 de lo suyo) y regalando el
  // resto a clientes que ya tenían su ABONO atribuido (doble conteo).
  const attributedByGroup = new Map<string, Map<string, number>>();
  for (const movement of movements) {
    if (movement.type !== 'INFLOW' || movement.status !== 'REAL') continue;
    if (movement.category !== 'AR_COLLECTION') continue;
    const clientId = movement.counterpartyId;
    if (!clientId) continue;
    const key = groupKeyOf(movement);
    if (!groups.has(key)) continue;
    const amount = Math.abs(movement.projectedAmount ?? movement.baseAmount ?? 0);
    if (!(amount > 0)) continue;
    let byClient = attributedByGroup.get(key);
    if (!byClient) { byClient = new Map(); attributedByGroup.set(key, byClient); }
    byClient.set(clientId, (byClient.get(clientId) ?? 0) + amount);
  }

  // 3) Pesos por cliente desde la cobranza JDE (fechaCobro en ese cía/mes).
  const clientLookup = buildClientLookup(inputs.clients);
  const weightsByGroup = new Map<string, Map<string, { name: string; amount: number }>>();
  for (const rec of inputs.cobranzaRecords ?? []) {
    const cobroDate = cleanDate(rec.fechaCobro);
    if (!cobroDate) continue;
    const key = `${normalizeCia(rec.cia)}::${cobroDate.slice(0, 7)}`;
    if (!groups.has(key)) continue;
    if (isInternalCounterparty(rec.rfc, rec.nombreCliente)) continue;
    const amount = Math.abs(rec.importeBrutoPesos);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const match = findClientForCobranza(rec, clientLookup);
    // Viajes Especiales no son clientes comerciales Citi — fuera del peso.
    if (match?.client.commercialGroupId === VIAJES_ESPECIALES_GROUP_ID) continue;
    const display = match
      ? clientDisplayCounterparty(match.client)
      : { id: rec.noCliente, name: rec.nombreCliente || 'Cliente sin nombre' };
    if (!display.id) continue;
    if (isPersonName(display.name ?? '')) continue;
    let clientWeights = weightsByGroup.get(key);
    if (!clientWeights) { clientWeights = new Map(); weightsByGroup.set(key, clientWeights); }
    const existing = clientWeights.get(display.id);
    if (existing) existing.amount += amount;
    else clientWeights.set(display.id, { name: display.name ?? 'Cliente', amount });
  }

  // 4) Descontar del peso lo ya atribuido por cruce y recalcular el total.
  //
  // Se resta por cliente (no se excluye al cliente entero) para que la
  // cobertura PARCIAL quede bien: un cliente con 3 de 10 facturas cruzadas
  // conserva como peso el remanente sin atribuir. Totalmente cruzado → peso 0
  // (no recibe doble); sin cruzar → peso completo.
  const cobranzaTotalByGroup = new Map<string, number>();
  for (const [key, clientWeights] of weightsByGroup) {
    const attributed = attributedByGroup.get(key);
    let total = 0;
    for (const [clientId, info] of clientWeights) {
      const already = attributed?.get(clientId) ?? 0;
      info.amount = Math.max(0, info.amount - already);
      if (info.amount > 0) total += info.amount;
      else clientWeights.delete(clientId);
    }
    cobranzaTotalByGroup.set(key, total);
  }

  // 5) Emitir líneas por cliente y marcar los grupos prorrateados.
  const proratedGroups = new Set<string>();
  const synthetic: FinancialMovement[] = [];
  for (const [key, group] of groups) {
    const clientWeights = weightsByGroup.get(key);
    const cobranzaTotal = cobranzaTotalByGroup.get(key) ?? 0;
    if (!clientWeights || clientWeights.size === 0 || !(cobranzaTotal > 0)) continue; // fallback: deja el lump
    proratedGroups.add(key);
    for (const [clientId, info] of clientWeights) {
      const amount = group.total * (info.amount / cobranzaTotal);
      if (!(amount > 0)) continue;
      synthetic.push({
        id: `citi-prorrateo:${group.cia}:${clientId}:${group.ym}`,
        sourceSystem: 'BANK',
        type: 'INFLOW',
        category: 'AR_COLLECTION',
        subcategory: INCOME_SUBCAT_CITI,
        companyId: group.cia,
        counterpartyId: clientId,
        counterpartyName: info.name,
        counterpartyType: 'CUSTOMER',
        concept: `Cobro Citi ${info.name} (prorrateo depósito concentradora ${group.ym})`,
        currency: 'MXN',
        originalAmount: amount,
        baseAmount: amount,
        projectedAmount: amount,
        actualDate: group.repDate,
        projectedDate: group.repDate,
        confidenceScore: 100,
        confidenceBand: calculateConfidenceBand(100),
        forecastMethod: 'RULE',
        ruleApplied: 'Prorrateo depósito concentradora Citi por cobranza JDE',
        status: 'REAL',
        lockState: 'LOCKED',
        comments: ['Atribución por cliente del depósito real a la concentradora Citi, prorrateada según la cobranza JDE del periodo. El total mensual del banco se conserva exacto.'],
        createdAt: `${group.repDate}T00:00:00.000Z`,
        updatedAt: `${group.repDate}T00:00:00.000Z`,
      });
    }
  }

  if (proratedGroups.size === 0) return movements;

  // 6) Quitar SOLO los depósitos amontonados de los grupos que sí prorrateamos.
  const dropIds = new Set(
    targets.filter((t) => proratedGroups.has(groupKeyOf(t))).map((t) => t.id),
  );
  const result = movements.filter((m) => !dropIds.has(m.id));
  result.push(...synthetic);
  return result;
}

export function hasSufficientCanonicalData(inputs: CanonicalProjectionInputs): boolean {
  const cobranzaRecords = inputs.cobranzaRecords ?? [];
  const purchaseReceipts = inputs.purchaseReceipts ?? [];
  const payrollCosts = inputs.payrollCosts ?? [];
  if (
    inputs.bankStatements.length === 0
    && inputs.cxpRecords.length === 0
    && cobranzaRecords.length === 0
    && purchaseReceipts.length === 0
    && payrollCosts.length === 0
  ) return false;
  if (
    inputs.bankStatements.length === 0
    && inputs.providers.length === 0
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
