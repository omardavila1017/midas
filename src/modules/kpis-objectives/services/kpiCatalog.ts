import type {
  BankAccountStatement,
  CobranzaPayment,
  CobranzaRecord,
} from '../../../services/jdeTypes';
import type { CXPRecord } from '../../../domain/persistence';
import { isCxpOverdue } from '../../../domain/cxpOverdue';
import {
  currentBankStatements,
  latestStatementDate,
  sumBankStatementBalances,
} from '../../../domain/bankStatements';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import type { FinancialMovement, ForecastRun } from '../../shared-finance/types';
import type { CustomKpi, KpiRow, SystemKpiDescriptor, SystemKpiId } from '../types';

// ─────────────────────────────────────────────────────────────────────────
// Catálogo de KPIs autocalculados.
//
// El módulo toma como fuente preferente el mismo ForecastRun que usa
// Planeación Financiera para ingresos, egresos y caja proyectada. Los datos
// crudos quedan como fallback y para razones de cartera abierta (CXC/CXP).
// ─────────────────────────────────────────────────────────────────────────

export const SYSTEM_KPIS: SystemKpiDescriptor[] = [
  {
    id: 'caja_actual',
    label: 'Caja actual',
    unit: 'MXN',
    periodLabel: 'Hoy',
    description: 'Suma del saldo de cierre de las cuentas bancarias vigentes.',
  },
  {
    id: 'cobranza_ytd',
    label: 'Ingresos YTD',
    unit: 'MXN',
    periodLabel: 'Año en curso',
    description: 'Ingresos del motor de Planeación desde el 1 de enero; fallback a cobranza JDE.',
  },
  {
    id: 'cobranza_mes',
    label: 'Ingresos mes actual',
    unit: 'MXN',
    periodLabel: 'Mes en curso',
    description: 'Ingresos del mes según Planeación Financiera; fallback a pagos recibidos.',
  },
  {
    id: 'gasto_ytd',
    label: 'Gasto YTD',
    unit: 'MXN',
    periodLabel: 'Año en curso',
    description: 'Egresos del motor de Planeación desde el 1 de enero; fallback a cargos bancarios.',
  },
  {
    id: 'gasto_mes',
    label: 'Gasto mes actual',
    unit: 'MXN',
    periodLabel: 'Mes en curso',
    description: 'Egresos del mes según Planeación Financiera; fallback a cargos bancarios.',
  },
  {
    id: 'flujo_neto_mes',
    label: 'Flujo neto mes',
    unit: 'MXN',
    periodLabel: 'Mes en curso',
    description: 'Ingresos menos egresos del mes según Planeación Financiera.',
  },
  {
    id: 'flujo_neto_30d',
    label: 'Flujo neto 30d',
    unit: 'MXN',
    periodLabel: 'Últimos 30 días',
    description: 'Ingresos menos egresos de los últimos 30 días usando la misma base de Planeación.',
  },
  {
    id: 'flujo_neto_ytd',
    label: 'Flujo neto YTD',
    unit: 'MXN',
    periodLabel: 'Año en curso',
    description: 'Ingresos YTD menos egresos YTD según Planeación Financiera.',
  },
  {
    id: 'caja_final_planeacion',
    label: 'Caja final planeación',
    unit: 'MXN',
    periodLabel: 'Escenario activo',
    description: 'Caja final del ForecastRun activo en Planeación Financiera.',
  },
  {
    id: 'deficit_dias_planeacion',
    label: 'Días en déficit planeación',
    unit: 'days',
    periodLabel: 'Escenario activo',
    description: 'Días bajo mínimo de caja calculados por Planeación Financiera.',
  },
  {
    id: 'cxp_pendiente',
    label: 'CXP pendiente',
    unit: 'MXN',
    periodLabel: 'Hoy',
    description: 'Saldo total pendiente en antigüedad de saldos.',
  },
  {
    id: 'cobertura_cxp_caja',
    label: 'Cobertura CXP con caja',
    unit: 'ratio',
    periodLabel: 'Hoy',
    description: 'Caja actual dividida entre CXP pendiente.',
  },
  {
    id: 'liquidez_inmediata',
    label: 'Liquidez inmediata',
    unit: 'ratio',
    periodLabel: 'Hoy',
    description: 'Caja actual dividida entre CXP vencida (capacidad de cubrir lo ya vencido).',
  },
  {
    id: 'cobertura_caja_cxc',
    label: 'Cobertura caja + CXC',
    unit: 'ratio',
    periodLabel: 'Hoy',
    description: 'Caja actual más CXC pendiente divididas entre CXP pendiente.',
  },
  {
    id: 'capital_trabajo_operativo',
    label: 'Capital trabajo operativo',
    unit: 'MXN',
    periodLabel: 'Hoy',
    description: 'Caja actual más CXC pendiente menos CXP pendiente.',
  },
  {
    id: 'cobertura_flujo_30d',
    label: 'Cobertura flujo 30d',
    unit: 'ratio',
    periodLabel: 'Últimos 30 días',
    description: 'Cobranza de los últimos 30 días dividida entre cargos bancarios de los últimos 30 días.',
  },
  {
    id: 'dso_cobranza',
    label: 'DSO cobranza',
    unit: 'days',
    periodLabel: 'Últimos 90 días',
    description: 'CXC pendiente dividida entre cobranza diaria promedio de los últimos 90 días.',
  },
  {
    id: 'dpo_cxp',
    label: 'DPO CXP',
    unit: 'days',
    periodLabel: 'Últimos 90 días',
    description: 'CXP pendiente dividida entre gasto bancario diario promedio de los últimos 90 días.',
  },
  {
    id: 'cxp_vencida',
    label: 'CXP vencida',
    unit: 'MXN',
    periodLabel: 'Hoy',
    description: 'Saldo pendiente con fecha vencida o días vencidos mayores a cero.',
  },
  {
    id: 'pct_cxp_vencida',
    label: '% CXP vencida',
    unit: 'pct',
    periodLabel: 'Hoy',
    description: 'Participación de la CXP vencida sobre el saldo pendiente total.',
  },
  {
    id: 'cxp_por_vencer_30d',
    label: 'CXP por vencer 30d',
    unit: 'MXN',
    periodLabel: 'Próximos 30 días',
    description: 'Saldo CXP pendiente con vencimiento desde hoy y hasta 30 días adelante.',
  },
  {
    id: 'runway_caja_dias',
    label: 'Días de caja',
    unit: 'days',
    periodLabel: 'Últimos 30 días',
    description: 'Caja actual dividida entre el gasto bancario diario promedio de los últimos 30 días.',
  },
  {
    id: 'ticket_promedio_cobranza_mes',
    label: 'Ticket promedio cobranza',
    unit: 'MXN',
    periodLabel: 'Mes en curso',
    description: 'Cobranza del mes dividida entre recibos cobrados del mes.',
  },
  {
    id: 'cobranza_pendiente_aplicar',
    label: 'Cobranza pendiente de aplicar',
    unit: 'MXN',
    periodLabel: 'Hoy',
    description: 'Importe de recibos de cobranza que sigue pendiente de aplicación.',
  },
  {
    id: 'cuentas_bancarias_activas',
    label: 'Cuentas bancarias activas',
    unit: 'count',
    periodLabel: 'Hoy',
    description: 'Cuentas con al menos un movimiento bancario disponible en el set cargado.',
  },
];

export interface KpiInputs {
  bankStatements: BankAccountStatement[];
  cobranzaRecords: CobranzaRecord[];
  cobranzaPayments: CobranzaPayment[];
  cxpRecords: CXPRecord[];
  companyCode?: string;
  planning?: KpiPlanningBasis | null;
  /** ISO YYYY-MM-DD. Se usa como "hoy" para periodos. */
  today: string;
}

export interface KpiPlanningBasis {
  run: ForecastRun | null;
  currentCash: number | null;
}

interface DerivedTotals {
  cobranzaYtd: number;
  cobranzaMes: number;
  cobranzaPrevMes: number;
  cobranza30d: number;
  cobranza90d: number;
  cobranza90dForDso: number;
  ticketCobranzaMes: number;
  ticketCobranzaPrevMes: number;
  gastoYtd: number;
  gastoMes: number;
  gastoPrevMes: number;
  gasto30d: number;
  gasto90d: number;
  cajaActual: number | null;
  cajaPrev: number | null;
  cajaFinalPlaneacion: number | null;
  deficitDiasPlaneacion: number | null;
  activeBankAccounts: number;
  cxcPendiente: number;
  cxpPendiente: number;
  cxpVencida: number;
  cxpPorVencer30d: number;
  cobranzaMesCount: number;
  cobranzaPrevMesCount: number;
  cobranzaPendienteAplicar: number;
  hasBankStatements: boolean;
  hasBankMovements: boolean;
  hasBankBalanceBase: boolean;
  hasCobranzaPayments: boolean;
  hasCobranzaRecords: boolean;
  hasCxpRecords: boolean;
  hasActivity30d: boolean;
  hasFlowBasis: boolean;
  hasPlanningRun: boolean;
}

function computeDerivedTotals(inputs: KpiInputs): DerivedTotals {
  const todayYear = inputs.today.slice(0, 4);
  const todayYm = inputs.today.slice(0, 7);
  const prevYm = previousYearMonth(todayYm);
  const rolling30Start = addDaysISO(inputs.today, -29);
  const rolling90Start = addDaysISO(inputs.today, -89);
  const due30End = addDaysISO(inputs.today, 30);
  const companyCode = inputs.companyCode ?? 'all';
  const scopedBankStatements = filterByCompany(inputs.bankStatements, companyCode, (statement) => statement.cia);
  const scopedCobranzaRecords = filterByCompany(inputs.cobranzaRecords, companyCode, (record) => record.cia);
  const scopedCobranzaPayments = filterByCompany(inputs.cobranzaPayments, companyCode, (record) => record.cia);
  const scopedCxpRecords = filterByCompany(inputs.cxpRecords, companyCode, (record) => record.cia);
  const bankLines = scopedBankStatements.flatMap((statement) => statement.movimientos ?? []);
  const balanceDate = latestStatementDate(scopedBankStatements);
  const currentStatements = currentBankStatements(scopedBankStatements, balanceDate);
  const planningRun = inputs.planning?.run ?? null;
  const hasPlanningRun = Boolean(planningRun && planningRun.movements.length > 0);
  const planningCurrentCash =
    typeof inputs.planning?.currentCash === 'number' && Number.isFinite(inputs.planning.currentCash)
      ? inputs.planning.currentCash
      : null;
  const hasBankBalanceBase = currentStatements.length > 0 || planningCurrentCash !== null;

  let cobranzaYtd = 0;
  let cobranzaMes = 0;
  let cobranzaPrevMes = 0;
  let cobranza30d = 0;
  let cobranza90d = 0;
  let cobranza90dForDso = 0;
  let ticketCobranzaMes = 0;
  let ticketCobranzaPrevMes = 0;
  let cobranzaMesCount = 0;
  let cobranzaPrevMesCount = 0;
  let cobranzaPendienteAplicar = 0;
  let gastoYtd = 0;
  let gastoMes = 0;
  let gastoPrevMes = 0;
  let gasto30d = 0;
  let gasto90d = 0;

  if (hasPlanningRun && planningRun) {
    const movementTotals = totalsFromPlanningMovements(planningRun.movements, {
      today: inputs.today,
      todayYear,
      todayYm,
      prevYm,
      rolling30Start,
      rolling90Start,
    });
    cobranzaYtd = movementTotals.inflowYtd;
    cobranzaMes = movementTotals.inflowMes;
    cobranzaPrevMes = movementTotals.inflowPrevMes;
    cobranza30d = movementTotals.inflow30d;
    cobranza90d = movementTotals.inflow90d;
    cobranza90dForDso = movementTotals.arCollection90d || movementTotals.inflow90d;
    gastoYtd = movementTotals.outflowYtd;
    gastoMes = movementTotals.outflowMes;
    gastoPrevMes = movementTotals.outflowPrevMes;
    gasto30d = movementTotals.outflow30d;
    gasto90d = movementTotals.outflow90d;
  } else {
    for (const pago of scopedCobranzaPayments) {
      const fecha = pago.fechaCobro || pago.fechaContable || '';
      const amount = Number(pago.importeRecibo) || 0;
      if (!fecha) continue;
      if (fecha.slice(0, 4) === todayYear) cobranzaYtd += amount;
      if (fecha.slice(0, 7) === todayYm) {
        cobranzaMes += amount;
        ticketCobranzaMes += amount;
        cobranzaMesCount += 1;
      }
      if (fecha.slice(0, 7) === prevYm) {
        cobranzaPrevMes += amount;
        ticketCobranzaPrevMes += amount;
        cobranzaPrevMesCount += 1;
      }
      if (fecha >= rolling30Start && fecha <= inputs.today) cobranza30d += amount;
      if (fecha >= rolling90Start && fecha <= inputs.today) cobranza90d += amount;
    }
    cobranza90dForDso = cobranza90d;

    for (const line of bankLines) {
      if (line.tipoMovimiento !== 'CARGO') continue;
      const fecha = line.fechaOperacion || line.fechaValor || '';
      if (!fecha) continue;
      const amount = Number(line.importe) || 0;
      if (fecha.slice(0, 4) === todayYear) gastoYtd += amount;
      if (fecha.slice(0, 7) === todayYm) gastoMes += amount;
      if (fecha.slice(0, 7) === prevYm) gastoPrevMes += amount;
      if (fecha >= rolling30Start && fecha <= inputs.today) gasto30d += amount;
      if (fecha >= rolling90Start && fecha <= inputs.today) gasto90d += amount;
    }
  }

  for (const pago of scopedCobranzaPayments) {
    cobranzaPendienteAplicar += Math.max(0, Number(pago.pendienteAplicar) || 0);
    const fecha = pago.fechaCobro || pago.fechaContable || '';
    if (!hasPlanningRun || !fecha) continue;
    const amount = Number(pago.importeRecibo) || 0;
    if (fecha.slice(0, 7) === todayYm) {
      ticketCobranzaMes += amount;
      cobranzaMesCount += 1;
    }
    if (fecha.slice(0, 7) === prevYm) {
      ticketCobranzaPrevMes += amount;
      cobranzaPrevMesCount += 1;
    }
  }

  const cajaActual = planningCurrentCash ?? (currentStatements.length > 0 ? sumBankStatementBalances(currentStatements) : null);
  const cajaPrev = null;
  const cajaFinalPlaneacion = planningRun?.summary.finalCash ?? null;
  const deficitDiasPlaneacion = planningRun?.summary.deficitDays ?? null;
  const activeBankAccounts = currentStatements.length;

  let cxcPendiente = 0;
  for (const record of scopedCobranzaRecords) {
    cxcPendiente += Math.max(0, Number(record.importePendientePesos) || 0);
  }

  let cxpPendiente = 0;
  let cxpVencida = 0;
  let cxpPorVencer30d = 0;
  for (const record of scopedCxpRecords) {
    const pending = Math.max(0, Number(record.importePendientePesos) || 0);
    if (pending <= 0) continue;
    cxpPendiente += pending;
    const dueDate = (record.fechaVence || record.fechaProgramacionPago || '').slice(0, 10);
    const isOverdue = isCxpOverdue(record.diasVencida, dueDate, inputs.today);
    if (isOverdue) {
      cxpVencida += pending;
    } else if (dueDate && dueDate >= inputs.today && dueDate <= due30End) {
      cxpPorVencer30d += pending;
    }
  }

  return {
    cobranzaYtd,
    cobranzaMes,
    cobranzaPrevMes,
    cobranza30d,
    cobranza90d,
    cobranza90dForDso,
    ticketCobranzaMes,
    ticketCobranzaPrevMes,
    gastoYtd,
    gastoMes,
    gastoPrevMes,
    gasto30d,
    gasto90d,
    cajaActual,
    cajaPrev,
    cajaFinalPlaneacion,
    deficitDiasPlaneacion,
    activeBankAccounts,
    cxcPendiente,
    cxpPendiente,
    cxpVencida,
    cxpPorVencer30d,
    cobranzaMesCount,
    cobranzaPrevMesCount,
    cobranzaPendienteAplicar,
    hasBankStatements: scopedBankStatements.length > 0,
    hasBankMovements: bankLines.length > 0,
    hasBankBalanceBase,
    hasCobranzaPayments: scopedCobranzaPayments.length > 0,
    hasCobranzaRecords: scopedCobranzaRecords.length > 0,
    hasCxpRecords: scopedCxpRecords.length > 0,
    hasActivity30d: cobranza30d > 0 || gasto30d > 0,
    hasFlowBasis: hasPlanningRun || scopedCobranzaPayments.length > 0 || bankLines.length > 0,
    hasPlanningRun,
  };
}

function filterByCompany<T>(items: T[], companyCode: string, ciaOf: (item: T) => string | undefined): T[] {
  if (!companyCode || companyCode === 'all') return items;
  return items.filter((item) => ciaOf(item) === companyCode);
}

function totalsFromPlanningMovements(
  movements: FinancialMovement[],
  window: {
    today: string;
    todayYear: string;
    todayYm: string;
    prevYm: string;
    rolling30Start: string;
    rolling90Start: string;
  },
) {
  const totals = {
    inflowYtd: 0,
    inflowMes: 0,
    inflowPrevMes: 0,
    inflow30d: 0,
    inflow90d: 0,
    arCollection90d: 0,
    outflowYtd: 0,
    outflowMes: 0,
    outflowPrevMes: 0,
    outflow30d: 0,
    outflow90d: 0,
  };

  for (const movement of movements) {
    const fecha = effectiveMovementDate(movement);
    if (!fecha || fecha > window.today) continue;
    const amount = effectiveAmount(movement);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const isInflow = movement.type === 'INFLOW';
    const isOutflow = movement.type === 'OUTFLOW';
    if (!isInflow && !isOutflow) continue;

    if (isInflow) {
      if (fecha.slice(0, 4) === window.todayYear) totals.inflowYtd += amount;
      if (fecha.slice(0, 7) === window.todayYm) totals.inflowMes += amount;
      if (fecha.slice(0, 7) === window.prevYm) totals.inflowPrevMes += amount;
      if (fecha >= window.rolling30Start && fecha <= window.today) totals.inflow30d += amount;
      if (fecha >= window.rolling90Start && fecha <= window.today) {
        totals.inflow90d += amount;
        if (movement.category === 'AR_COLLECTION') totals.arCollection90d += amount;
      }
    } else {
      if (fecha.slice(0, 4) === window.todayYear) totals.outflowYtd += amount;
      if (fecha.slice(0, 7) === window.todayYm) totals.outflowMes += amount;
      if (fecha.slice(0, 7) === window.prevYm) totals.outflowPrevMes += amount;
      if (fecha >= window.rolling30Start && fecha <= window.today) totals.outflow30d += amount;
      if (fecha >= window.rolling90Start && fecha <= window.today) totals.outflow90d += amount;
    }
  }

  return totals;
}

function previousYearMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
  const date = new Date(Date.UTC(y, m - 1, 1));
  date.setUTCMonth(date.getUTCMonth() - 1);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}-${mm}`;
}

function addDaysISO(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return day;
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function evaluateSystemKpi(
  id: SystemKpiId,
  totals: DerivedTotals,
): { value: number | null; deltaPrev: number | null; emptyReason?: string } {
  switch (id) {
    case 'caja_actual':
      if (!totals.hasBankBalanceBase) return empty('Sin saldo bancario');
      return {
        value: totals.cajaActual,
        deltaPrev:
          totals.cajaActual !== null && totals.cajaPrev !== null
            ? totals.cajaActual - totals.cajaPrev
            : null,
      };
    case 'cobranza_ytd':
      if (!totals.hasFlowBasis) return empty('Sin base de planeación');
      return { value: totals.cobranzaYtd, deltaPrev: null };
    case 'cobranza_mes':
      if (!totals.hasFlowBasis) return empty('Sin base de planeación');
      return {
        value: totals.cobranzaMes,
        deltaPrev: totals.cobranzaMes - totals.cobranzaPrevMes,
      };
    case 'gasto_ytd':
      if (!totals.hasFlowBasis) return empty('Sin base de planeación');
      return { value: totals.gastoYtd, deltaPrev: null };
    case 'gasto_mes':
      if (!totals.hasFlowBasis) return empty('Sin base de planeación');
      return {
        value: totals.gastoMes,
        deltaPrev: totals.gastoMes - totals.gastoPrevMes,
      };
    case 'flujo_neto_mes':
      if (!totals.hasFlowBasis) return empty('Sin base de planeación');
      return {
        value: totals.cobranzaMes - totals.gastoMes,
        deltaPrev: (totals.cobranzaMes - totals.gastoMes) - (totals.cobranzaPrevMes - totals.gastoPrevMes),
      };
    case 'flujo_neto_30d':
      if (!totals.hasFlowBasis) return empty('Sin base de planeación');
      return { value: totals.cobranza30d - totals.gasto30d, deltaPrev: null };
    case 'flujo_neto_ytd':
      if (!totals.hasFlowBasis) return empty('Sin base de planeación');
      return {
        value: totals.cobranzaYtd - totals.gastoYtd,
        deltaPrev: null,
      };
    case 'caja_final_planeacion':
      if (!totals.hasPlanningRun || totals.cajaFinalPlaneacion === null) return empty('Sin corrida de planeación');
      return { value: totals.cajaFinalPlaneacion, deltaPrev: null };
    case 'deficit_dias_planeacion':
      if (!totals.hasPlanningRun || totals.deficitDiasPlaneacion === null) return empty('Sin corrida de planeación');
      return { value: totals.deficitDiasPlaneacion, deltaPrev: null };
    case 'cxp_pendiente':
      if (!totals.hasCxpRecords) return empty('Sin CXP cargada');
      return { value: totals.cxpPendiente, deltaPrev: null };
    case 'cobertura_cxp_caja':
      if (!totals.hasBankBalanceBase) return empty('Sin saldo bancario');
      if (!totals.hasCxpRecords || totals.cxpPendiente <= 0) return empty('Sin CXP pendiente');
      return {
        value: (totals.cajaActual ?? 0) / totals.cxpPendiente,
        deltaPrev: null,
      };
    case 'liquidez_inmediata':
      // Distinta a cobertura_cxp_caja: mide la caja contra lo YA VENCIDO, no
      // contra todo el pendiente — "¿alcanza para pagar lo que ya debía?".
      if (!totals.hasBankBalanceBase) return empty('Sin saldo bancario');
      if (!totals.hasCxpRecords || totals.cxpVencida <= 0) return empty('Sin CXP vencida');
      return {
        value: (totals.cajaActual ?? 0) / totals.cxpVencida,
        deltaPrev: null,
      };
    case 'cobertura_caja_cxc':
      if (!totals.hasBankBalanceBase) return empty('Sin saldo bancario');
      if (!totals.hasCobranzaRecords) return empty('Sin CXC cargada');
      if (!totals.hasCxpRecords || totals.cxpPendiente <= 0) return empty('Sin CXP pendiente');
      return { value: ((totals.cajaActual ?? 0) + totals.cxcPendiente) / totals.cxpPendiente, deltaPrev: null };
    case 'capital_trabajo_operativo':
      if (!totals.hasBankBalanceBase) return empty('Sin saldo bancario');
      if (!totals.hasCobranzaRecords) return empty('Sin CXC cargada');
      if (!totals.hasCxpRecords) return empty('Sin CXP cargada');
      return { value: (totals.cajaActual ?? 0) + totals.cxcPendiente - totals.cxpPendiente, deltaPrev: null };
    case 'cobertura_flujo_30d':
      if (totals.gasto30d <= 0) return empty('Sin gasto 30d');
      return { value: totals.cobranza30d / totals.gasto30d, deltaPrev: null };
    case 'dso_cobranza':
      if (!totals.hasCobranzaRecords) return empty('Sin CXC cargada');
      if (totals.cobranza90dForDso <= 0) return empty('Sin cobranza 90d');
      return { value: totals.cxcPendiente / (totals.cobranza90dForDso / 90), deltaPrev: null };
    case 'dpo_cxp':
      if (!totals.hasCxpRecords) return empty('Sin CXP cargada');
      if (totals.gasto90d <= 0) return empty('Sin gasto 90d');
      return { value: totals.cxpPendiente / (totals.gasto90d / 90), deltaPrev: null };
    case 'cxp_vencida':
      if (!totals.hasCxpRecords) return empty('Sin CXP cargada');
      return { value: totals.cxpVencida, deltaPrev: null };
    case 'pct_cxp_vencida':
      if (!totals.hasCxpRecords || totals.cxpPendiente <= 0) return empty('Sin CXP pendiente');
      return {
        value: totals.cxpVencida / totals.cxpPendiente,
        deltaPrev: null,
      };
    case 'cxp_por_vencer_30d':
      if (!totals.hasCxpRecords) return empty('Sin CXP cargada');
      return { value: totals.cxpPorVencer30d, deltaPrev: null };
    case 'runway_caja_dias':
      if (!totals.hasBankBalanceBase) return empty('Sin saldo bancario');
      if (totals.gasto30d <= 0) return empty('Sin gasto 30d');
      return { value: (totals.cajaActual ?? 0) / (totals.gasto30d / 30), deltaPrev: null };
    case 'ticket_promedio_cobranza_mes':
      if (!totals.hasCobranzaPayments) return empty('Sin cobranza cargada');
      if (totals.cobranzaMesCount <= 0) return empty('Sin cobranza del mes');
      return {
        value: totals.ticketCobranzaMes / totals.cobranzaMesCount,
        deltaPrev:
          totals.cobranzaPrevMesCount > 0
            ? (totals.ticketCobranzaMes / totals.cobranzaMesCount) - (totals.ticketCobranzaPrevMes / totals.cobranzaPrevMesCount)
            : null,
      };
    case 'cobranza_pendiente_aplicar':
      if (!totals.hasCobranzaPayments) return empty('Sin cobranza cargada');
      return { value: totals.cobranzaPendienteAplicar, deltaPrev: null };
    case 'cuentas_bancarias_activas':
      if (!totals.hasBankStatements) return empty('Sin bancos cargados');
      return { value: totals.activeBankAccounts, deltaPrev: null };
    default:
      return { value: null, deltaPrev: null };
  }
}

function empty(emptyReason: string): { value: null; deltaPrev: null; emptyReason: string } {
  return { value: null, deltaPrev: null, emptyReason };
}

export function buildKpiRows(inputs: KpiInputs, customKpis: CustomKpi[]): KpiRow[] {
  const totals = computeDerivedTotals(inputs);
  const systemRows: KpiRow[] = SYSTEM_KPIS.map((descriptor) => {
    const { value, deltaPrev, emptyReason } = evaluateSystemKpi(descriptor.id, totals);
    return {
      key: systemKpiKey(descriptor.id),
      source: 'system',
      label: descriptor.label,
      unit: descriptor.unit,
      periodLabel: descriptor.periodLabel,
      description: descriptor.description,
      value,
      deltaPrev,
      emptyReason,
    };
  });

  const customRows: KpiRow[] = customKpis.map((kpi) => ({
    key: customKpiKey(kpi.id),
    source: 'custom',
    label: kpi.name,
    unit: kpi.unit,
    periodLabel: kpi.manualValueDate ? `Captura ${kpi.manualValueDate}` : 'Manual',
    description: kpi.description,
    value: typeof kpi.manualValue === 'number' && Number.isFinite(kpi.manualValue)
      ? kpi.manualValue
      : null,
    deltaPrev: null,
    emptyReason:
      typeof kpi.manualValue === 'number' && Number.isFinite(kpi.manualValue)
        ? undefined
        : 'Sin valor manual',
    custom: kpi,
  }));

  return [...systemRows, ...customRows];
}

export function systemKpiKey(id: SystemKpiId): string {
  return `system:${id}`;
}

export function customKpiKey(id: string): string {
  return `custom:${id}`;
}

export function listAvailableKpiKeys(customKpis: CustomKpi[]): { key: string; label: string }[] {
  return [
    ...SYSTEM_KPIS.map((k) => ({ key: systemKpiKey(k.id), label: k.label })),
    ...customKpis.map((k) => ({ key: customKpiKey(k.id), label: k.name })),
  ];
}
