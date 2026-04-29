// ─────────────────────────────────────────────────────────────────────────
// Midas types — modelo simplificado post-rewrite.
//
// Principios:
//   - "Base" no es una entidad. Es el set de propuestas con enabled=false.
//   - Una propuesta es sólo un ahorro o un incremento de ingresos, con monto,
//     mes de inicio y frecuencia. Ya no existen "efectos" ni "target ids" ni
//     categorías compuestas.
//   - Un escenario es sólo un snapshot del estado enabled/disabled de las
//     propuestas actuales — funciona como "hot switch" para alternar combos.
//   - Los meses del flujo se computan contra JDE real (Bancos + AntiguedadSaldos)
//     y los futuros usan una proyección simple de ingresos (promedio móvil).
// ─────────────────────────────────────────────────────────────────────────

export type TabId =
  | 'dashboard'
  | 'financialProjection'
  | 'financialPlanning'
  | 'taxes'
  | 'operating'
  | 'flow'
  | 'providers'
  | 'collections'
  | 'clients'
  | 'cxp'
  | 'bancos'
  | 'netflow';

export type ForecastGranularity = 'monthly' | 'weekly' | 'daily';

// ── Propuestas ───────────────────────────────────────────────────────────

export type ProposalKind =
  | 'income_increase'   // suma ingresos
  | 'expense_saving'    // reduce egresos
  | 'new_expense'       // nuevo egreso recurrente: pago de deuda, nueva nómina, renta
  | 'revenue_loss';     // pérdida de ingresos: baja de cliente, reducción de facturación

export type ProposalFrequency =
  | 'one_time'
  | 'monthly'
  | 'quarterly'
  | 'semiannual';

export const PROPOSAL_KIND_LABELS: Record<ProposalKind, string> = {
  income_increase: 'Incremento de ingresos',
  expense_saving: 'Ahorro',
  new_expense: 'Nuevo egreso / Deuda',
  revenue_loss: 'Pérdida de ingresos',
};

export const PROPOSAL_KIND_DESCRIPTIONS: Record<ProposalKind, string> = {
  income_increase: 'Suma ingresos',
  expense_saving: 'Reduce egresos',
  new_expense: 'Agrega egresos (pago de deuda, nueva nómina, renta)',
  revenue_loss: 'Resta ingresos (baja de cliente, caída en ventas)',
};

export const PROPOSAL_FREQUENCY_LABELS: Record<ProposalFrequency, string> = {
  one_time: 'Evento único',
  monthly: 'Mensual',
  quarterly: 'Trimestral',
  semiannual: 'Semestral',
};

export interface Proposal {
  id: string;
  name: string;
  description?: string;
  kind: ProposalKind;
  amount: number;          // pesos, siempre positivo
  startYearMonth: string;  // "YYYY-MM"
  endYearMonth?: string;   // "YYYY-MM" — si está definido, la propuesta deja de aplicar a partir del siguiente mes
  frequency: ProposalFrequency;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── Escenarios ───────────────────────────────────────────────────────────
//
// Un escenario es simplemente un snapshot de {proposalId -> enabled}. Cargar
// un escenario aplica ese snapshot a las propuestas actuales; propuestas que
// no estén en el snapshot quedan con su estado previo.

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  proposalStates: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
}

// ── Flujo de caja ────────────────────────────────────────────────────────

export interface CashFlowMonth {
  yearMonth: string;       // "YYYY-MM"
  isHistorical: boolean;   // true si los datos salen de /Bancos; false si son proyección
  income: number;          // pesos
  expense: number;         // pesos, positivo (entrada)
  closingCash: number;     // caja final base — sin propuestas
}

// ── Overrides editables de flujo (tabla ↔ chart) ─────────────────────────
//
// Permite al usuario sobreescribir el ingreso o egreso de un mes futuro desde
// la tabla de flujo. La clave es el yearMonth; los valores undefined indican
// que no hay override y el motor debe calcularlo.
export type CashFlowOverrides = Record<string, { income?: number; expense?: number }>;

export interface ProposalDelta {
  proposalId: string;
  proposalName: string;
  deltaIncome: number;     // aporte del mes (puede ser 0)
  deltaExpense: number;    // aporte del mes (puede ser 0)
}

export interface EvaluatedMonth {
  yearMonth: string;
  isHistorical: boolean;
  baseIncome: number;
  baseExpense: number;
  baseClosingCash: number;
  forecastIncome: number;
  forecastExpense: number;
  forecastClosingCash: number;
  proposalDeltas: ProposalDelta[];
}

export interface EvaluatedCashFlow {
  months: EvaluatedMonth[];
  proposals: Proposal[];         // las propuestas usadas en la evaluación
  totalBaseClosingCash: number;  // último mes
  totalForecastClosingCash: number;
}

// ── Constantes UI ────────────────────────────────────────────────────────

export const MONTHS = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
];

export const MONTHS_FULL = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];
