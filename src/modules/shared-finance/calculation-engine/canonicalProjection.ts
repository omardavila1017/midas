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
 * Tolerancia de la atribución 1:1 depósito ↔ cobranza, en pesos. Al centavo a
 * propósito: un depósito que ES el pago de un cliente coincide exacto.
 * Aflojarla inventaría atribuciones — en lógica de dinero preferimos no
 * atribuir y caer al reparto por peso.
 */
const CITI_DEPOSIT_MATCH_TOLERANCE = 0.01;

/**
 * Piso de `pool / cobranza sin atribuir` para repartir el remanente por peso.
 *
 * Las dos poblaciones NO son la misma: hay cobranza del mes sin pierna bancaria
 * en la concentradora (compensaciones, depósito en otro banco, cruce fechado en
 * otro mes, cobro que aún no cae). Cuando eso pasa el denominador es mucho
 * mayor que el pool y el reparto proporcional le devuelve a CADA cliente una
 * fracción arbitraria de lo suyo — el defecto reportado con 3M en 2026-02:
 * $221,201.53 salieron como $220.41, factor 1/1000, y el factor cambia mes a
 * mes (por eso el error era errático). Por debajo de este piso NO se reparte:
 * el depósito se conserva como fila sin desglosar, que es dato incompleto pero
 * no dato falso.
 */
const CITI_MIN_PRORRATEO_RATIO = 0.5;

/** Contraparte de la fila que absorbe el excedente no atribuible del depósito. */
const CITI_UNIDENTIFIED_NAME = 'Cobranza Citi por identificar';

/** Cómo se resolvió un (cía, mes) del prorrateo. Sólo diagnóstico. */
type CitiAttributionMode = 'exacto' | 'remanente-cubierto' | 'prorrateo' | 'sin-desglosar';

interface CitiAttributionDiagnostic {
  cia: string;
  ym: string;
  /** Σ depósitos sin cruzar de la concentradora (el pool). */
  depositTotal: number;
  /** Σ atribuido 1:1 por importe exacto. */
  matchedByAmount: number;
  matchedDeposits: number;
  /** Pool que quedó tras (A). */
  leftoverPool: number;
  /** Cobranza sin atribuir que quedó tras (A). */
  leftoverExpected: number;
  /** `leftoverPool / leftoverExpected` — 1 = poblaciones equivalentes. */
  ratio: number | null;
  mode: CitiAttributionMode;
  clients: number;
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
 * La atribución va en TRES pasos, del más exacto al más aproximado. El total
 * mensual del banco se conserva EXACTO en todos ellos — es la verdad del
 * efectivo; sólo cambia a quién se le atribuye. La cobranza se usa como
 * IDENTIDAD o como PESO, nunca como monto, así que no hay doble conteo.
 *
 *   A) 1:1 por IMPORTE (exacto). Un depósito cuyo importe coincide al centavo
 *      con la cobranza sin atribuir de UN solo cliente ES el pago de ese
 *      cliente. Se le acredita completo, con su propia fecha. No depende del
 *      folio ni del recibo, así que sobrevive a los defectos de cruce (p.ej.
 *      el prefijo de 10 dígitos de `No_Recibo`) — es el paso que hace que el
 *      caso 3M salga exacto pase lo que pase aguas arriba.
 *   B) Remanente con caja suficiente (`pool >= cobranza sin atribuir`): cada
 *      cliente recibe EXACTAMENTE lo suyo y el excedente del depósito queda en
 *      una sola fila "por identificar". Nunca se infla a un cliente por encima
 *      de lo que realmente cobró.
 *   C) Remanente con caja insuficiente: reparto proporcional por peso. Sólo se
 *      aplica si las dos poblaciones se corresponden razonablemente
 *      (`pool / cobranza >= CITI_MIN_PRORRATEO_RATIO`); si no, NO se reparte y
 *      el depósito se queda como fila sin desglosar (ver la constante).
 *
 * Fecha de las líneas sintéticas: la del propio depósito en (A); la del
 * depósito más grande del mes en (B)/(C) — mejor proxy de cuándo entró el
 * grueso del efectivo. El reparto intra-mes diario es aproximado.
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

  // 1) Depósitos individuales + total + fecha representativa por (cía, mes).
  //
  // Los depósitos se conservan UNO POR UNO (antes sólo se acumulaba el total):
  // el importe de un depósito es la señal que permite acreditarlo completo a su
  // cliente en el paso (A) en vez de disolverlo en un promedio ponderado.
  interface Deposit { movement: FinancialMovement; amount: number; date: string; }
  interface Group { cia: string; ym: string; total: number; repDate: string; repAmount: number; deposits: Deposit[]; }
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
      group.deposits.push({ movement, amount, date });
      if (amount > group.repAmount) { group.repAmount = amount; group.repDate = date; }
    } else {
      // La cía del grupo se guarda NORMALIZADA, igual que la llave del join:
      // se emite en `companyId` y en el `id` de las líneas sintéticas, y un
      // valor sin padding ahí las separaría del resto de la cía (el filtro por
      // `companyId` de las propuestas —financialProjectionEngine— compara por
      // igualdad exacta). Normalizar sólo la llave dejaba el blindaje a medias.
      groups.set(key, {
        cia: normalizeCia(movement.companyId ?? ''),
        ym: date.slice(0, 7),
        total: amount,
        repDate: date,
        repAmount: amount,
        deposits: [{ movement, amount, date }],
      });
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

  // 4) Descontar de la cobranza esperada lo ya atribuido por cruce directo.
  //
  // Se resta por cliente (no se excluye al cliente entero) para que la
  // cobertura PARCIAL quede bien: un cliente con 3 de 10 facturas cruzadas
  // conserva como pendiente el remanente sin atribuir. Totalmente cruzado → 0
  // (no recibe doble); sin cruzar → su cobranza completa.
  for (const [key, clientWeights] of weightsByGroup) {
    const attributed = attributedByGroup.get(key);
    for (const [clientId, info] of clientWeights) {
      const already = attributed?.get(clientId) ?? 0;
      info.amount = Math.max(0, info.amount - already);
      if (!(info.amount > 0)) clientWeights.delete(clientId);
    }
  }

  // 5) Emitir líneas por cliente en tres pasos (ver el encabezado). `dropIds`
  //    acumula SÓLO los depósitos efectivamente atribuidos: lo que no se
  //    atribuye se conserva tal cual, así el total bancario nunca cambia.
  const dropIds = new Set<string>();
  const synthetic: FinancialMovement[] = [];
  const diagnostics: CitiAttributionDiagnostic[] = [];

  const citiLine = (args: {
    id: string; cia: string; date: string;
    clientId?: string; name: string; amount: number;
    concept: string; rule: string; comment: string;
  }): FinancialMovement => ({
    id: args.id,
    sourceSystem: 'BANK',
    type: 'INFLOW',
    category: 'AR_COLLECTION',
    subcategory: INCOME_SUBCAT_CITI,
    companyId: args.cia,
    counterpartyId: args.clientId,
    counterpartyName: args.name,
    counterpartyType: args.clientId ? 'CUSTOMER' : 'BANK',
    concept: args.concept,
    currency: 'MXN',
    originalAmount: args.amount,
    baseAmount: args.amount,
    projectedAmount: args.amount,
    actualDate: args.date,
    projectedDate: args.date,
    confidenceScore: 100,
    confidenceBand: calculateConfidenceBand(100),
    forecastMethod: 'RULE',
    ruleApplied: args.rule,
    status: 'REAL',
    lockState: 'LOCKED',
    comments: [args.comment],
    createdAt: `${args.date}T00:00:00.000Z`,
    updatedAt: `${args.date}T00:00:00.000Z`,
  });

  for (const [key, group] of groups) {
    const clientWeights = weightsByGroup.get(key);
    if (!clientWeights || clientWeights.size === 0) continue; // fallback: deja el lump

    // (A) 1:1 por importe exacto y ÚNICO. Dos clientes con el mismo importe
    // pendiente son ambiguos → no se atribuye ninguno (cae al remanente).
    //
    // Índice por centavos para que la búsqueda sea O(1): un mes puede traer
    // miles de clientes × cientos de depósitos, y esto corre en el main thread
    // en cada recómputo del motor.
    const centsKey = (amount: number) => Math.round(amount * 100);
    const byCents = new Map<number, string[]>();
    for (const [clientId, info] of clientWeights) {
      const cents = centsKey(info.amount);
      const bucket = byCents.get(cents);
      if (bucket) bucket.push(clientId);
      else byCents.set(cents, [clientId]);
    }
    const candidatesFor = (amount: number): string[] => {
      const cents = centsKey(amount);
      const tolerance = Math.round(CITI_DEPOSIT_MATCH_TOLERANCE * 100);
      const out: string[] = [];
      for (let delta = -tolerance; delta <= tolerance; delta++) {
        for (const clientId of byCents.get(cents + delta) ?? []) {
          // Un cliente ya consumido por otro depósito sale de `clientWeights`.
          if (clientWeights.has(clientId)) out.push(clientId);
        }
      }
      return out;
    };

    const leftoverDeposits: Deposit[] = [];
    let matchedByAmount = 0;
    let matchedDeposits = 0;
    for (const deposit of [...group.deposits].sort((a, b) => b.amount - a.amount)) {
      const candidates = candidatesFor(deposit.amount);
      if (candidates.length !== 1) { leftoverDeposits.push(deposit); continue; }
      const clientId = candidates[0];
      const info = clientWeights.get(clientId)!;
      synthetic.push(citiLine({
        // El id del depósito hace única la línea aunque el mismo cliente
        // reciba varios depósitos identificados en el mes.
        id: `citi-prorrateo:${group.cia}:${clientId}:${deposit.movement.id}`,
        cia: group.cia,
        date: deposit.date,
        clientId,
        name: info.name,
        amount: deposit.amount,
        concept: `Cobro Citi ${info.name} (depósito concentradora ${deposit.date})`,
        rule: 'Depósito concentradora Citi identificado por importe exacto de la cobranza JDE',
        comment: 'El importe del depósito coincide al centavo con la cobranza sin atribuir de un solo cliente, así que se le acredita completo. No depende del folio ni del recibo.',
      }));
      clientWeights.delete(clientId);
      dropIds.add(deposit.movement.id);
      matchedByAmount += deposit.amount;
      matchedDeposits++;
    }

    const leftoverPool = leftoverDeposits.reduce((sum, d) => sum + d.amount, 0);
    let leftoverExpected = 0;
    for (const info of clientWeights.values()) leftoverExpected += info.amount;
    const ratio = leftoverExpected > 0 ? leftoverPool / leftoverExpected : null;
    // Arranca en 'sin-desglosar' y sólo sube si el remanente SE reparte. Un
    // periodo con matches 1:1 pero con pool sobrante NO es 'exacto': parte del
    // depósito se quedó sin atribuir, que es justo lo que el aviso tiene que
    // levantar. `matchedDeposits`/`matchedByAmount` conservan lo que sí se
    // atribuyó, así que no se pierde información.
    let mode: CitiAttributionMode = 'sin-desglosar';
    const excess = leftoverPool - leftoverExpected;

    if (leftoverPool > 0 && leftoverExpected > 0) {
      if (excess > 0.005) {
        // (B) La caja alcanza: cada cliente recibe EXACTAMENTE lo suyo y el
        // excedente va a una sola fila por identificar. Escalar hacia arriba
        // inflaría clientes por encima de lo que cobraron (el defecto espejo
        // del prorrateo diluido).
        mode = 'remanente-cubierto';
        for (const [clientId, info] of clientWeights) {
          synthetic.push(citiLine({
            id: `citi-prorrateo:${group.cia}:${clientId}:${group.ym}`,
            cia: group.cia,
            date: group.repDate,
            clientId,
            name: info.name,
            amount: info.amount,
            concept: `Cobro Citi ${info.name} (depósito concentradora ${group.ym})`,
            rule: 'Atribución del depósito concentradora Citi por la cobranza JDE sin atribuir',
            comment: 'El depósito del mes alcanza para cubrir la cobranza sin atribuir, así que cada cliente recibe su importe real. El excedente queda en la fila por identificar.',
          }));
        }
        synthetic.push(citiLine({
          id: `citi-prorrateo:${group.cia}:sin-identificar:${group.ym}`,
          cia: group.cia,
          date: group.repDate,
          name: CITI_UNIDENTIFIED_NAME,
          amount: excess,
          concept: `${CITI_UNIDENTIFIED_NAME} (depósito concentradora ${group.ym})`,
          rule: 'Excedente del depósito concentradora Citi sin cobranza JDE que lo explique',
          comment: 'Parte del depósito real a la concentradora que ninguna cobranza del periodo explica. Se conserva sin atribuir para no inflar a ningún cliente; el total bancario del mes queda exacto.',
        }));
        for (const deposit of leftoverDeposits) dropIds.add(deposit.movement.id);
      } else if (ratio !== null && ratio >= CITI_MIN_PRORRATEO_RATIO) {
        // (C) Reparto proporcional. Σ = pool exacto (cuadre Planeación ↔ banco).
        mode = 'prorrateo';
        for (const [clientId, info] of clientWeights) {
          const amount = leftoverPool * (info.amount / leftoverExpected);
          if (!(amount > 0)) continue;
          synthetic.push(citiLine({
            id: `citi-prorrateo:${group.cia}:${clientId}:${group.ym}`,
            cia: group.cia,
            date: group.repDate,
            clientId,
            name: info.name,
            amount,
            concept: `Cobro Citi ${info.name} (prorrateo depósito concentradora ${group.ym})`,
            rule: 'Prorrateo depósito concentradora Citi por cobranza JDE',
            comment: 'Atribución por cliente del depósito real a la concentradora Citi, prorrateada según la cobranza JDE sin atribuir del periodo. El total mensual del banco se conserva exacto.',
          }));
        }
        for (const deposit of leftoverDeposits) dropIds.add(deposit.movement.id);
      }
      // Fuera del piso: NO se reparte. Los depósitos del remanente se quedan
      // como fila sin desglosar (dato incompleto, nunca dato falso).
    }
    // Sin remanente que repartir, el pool quedó atribuido 1:1 al centavo.
    if (mode === 'sin-desglosar' && matchedDeposits > 0 && !(leftoverPool > 0)) mode = 'exacto';

    diagnostics.push({
      cia: group.cia,
      ym: group.ym,
      depositTotal: group.total,
      matchedByAmount,
      matchedDeposits,
      leftoverPool,
      leftoverExpected,
      ratio,
      mode,
      clients: clientWeights.size + matchedDeposits,
    });
  }

  publishCitiAttributionDiagnostics(diagnostics);
  if (dropIds.size === 0 && synthetic.length === 0) return movements;

  // 6) Quitar SÓLO los depósitos que quedaron atribuidos.
  const result = movements.filter((m) => !dropIds.has(m.id));
  result.push(...synthetic);
  return result;
}

/**
 * Publica el diagnóstico del prorrateo Citi en `window.__midas__.citiProrrateo`
 * y avisa en consola de los (cía, mes) que quedaron SIN desglosar. Esto es lo
 * que faltaba cuando el defecto de 3M pasó meses sin detectarse: el reparto
 * fallaba en silencio y la fila se veía plausible. Best-effort: en el worker
 * (sin `window`) no hace nada.
 */
function publishCitiAttributionDiagnostics(diagnostics: CitiAttributionDiagnostic[]): void {
  if (diagnostics.length === 0) return;
  const undistributed = diagnostics.filter((d) => d.mode === 'sin-desglosar' && d.leftoverPool > 0);
  if (undistributed.length > 0) {
    console.warn(
      `[citi-prorrateo] ${undistributed.length} periodo(s) con depósito sin desglosar por cliente: la cobranza sin atribuir no corresponde al depósito (no la hay, o el ratio quedó bajo ${CITI_MIN_PRORRATEO_RATIO}). Detalle: window.__midas__.citiProrrateo`,
      undistributed.map((d) => `${d.cia}/${d.ym} pool=${Math.round(d.leftoverPool)} cobranza=${Math.round(d.leftoverExpected)} ratio=${d.ratio === null ? 'n/a' : d.ratio.toFixed(4)}`),
    );
  }
  try {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __midas__?: Record<string, unknown> };
    w.__midas__ = { ...(w.__midas__ ?? {}), citiProrrateo: diagnostics };
  } catch {
    /* diagnóstico best-effort */
  }
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
