// ─────────────────────────────────────────────────────────────────────────
// Midas types — modelo simplificado.
//
// Los meses del flujo se computan contra JDE real (Bancos + AntiguedadSaldos)
// y los futuros usan una proyección simple (presupuesto + promedio móvil).
// Los escenarios y simulaciones de "qué pasaría si" viven completos dentro
// del módulo de Planeación Financiera (`src/modules/financial-planning`),
// no aquí.
// ─────────────────────────────────────────────────────────────────────────

export type TabId =
  | 'dashboard'
  | 'financialProjection'
  | 'financialPlanning'
  | 'taxes'
  | 'payroll'
  | 'operating'
  | 'providers'
  | 'collections'
  | 'fideicomiso'
  | 'clients'
  | 'cxp'
  | 'bancos'
  | 'netflow';

export type ForecastGranularity = 'monthly' | 'weekly' | 'daily';

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

// ── Constantes UI ────────────────────────────────────────────────────────

export const MONTHS = [
  'Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun',
  'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic',
];

export const MONTHS_FULL = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];
