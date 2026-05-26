// KPIs y Objetivos — modelo del módulo.
//
// El módulo NO recomputa proyecciones. Lee datos crudos ya cargados por el
// shell (bancos, cobranza, CXP, nómina) y deriva un puñado de KPIs simples;
// el resto los define el usuario manualmente. Los objetivos se evalúan contra
// estos KPIs cuando es posible y caen a status manual cuando no.

export type SystemKpiId =
  | 'caja_actual'
  | 'cobranza_ytd'
  | 'cxp_pendiente'
  | 'gasto_ytd'
  | 'flujo_neto_ytd'
  | 'cobranza_mes'
  | 'gasto_mes';

export type KpiUnit = 'MXN' | 'count' | 'pct' | 'days';

export interface SystemKpiDescriptor {
  id: SystemKpiId;
  label: string;
  unit: KpiUnit;
  /** Periodo cubierto por el cálculo (texto humano para la columna "Periodo"). */
  periodLabel: string;
  description: string;
}

export interface CustomKpi {
  id: string;
  name: string;
  description?: string;
  unit: KpiUnit;
  /** Valor capturado a mano por el usuario. v1 no soporta fórmulas. */
  manualValue?: number;
  /** Fecha (YYYY-MM-DD) del valor manual — quién pisó esto. */
  manualValueDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KpiRow {
  /** `system:<SystemKpiId>` ó `custom:<id>`. */
  key: string;
  source: 'system' | 'custom';
  label: string;
  unit: KpiUnit;
  periodLabel: string;
  description?: string;
  /** null = no calculable con los datos cargados. */
  value: number | null;
  /** Δ vs. periodo previo cuando aplica. null si no se puede computar. */
  deltaPrev: number | null;
  /** Si es custom, viene la entidad para edición. */
  custom?: CustomKpi;
}

export type ObjectiveKind = 'NUMERIC_MONTHLY' | 'KPI_THRESHOLD' | 'QUALITATIVE';
export type ObjectiveStatus = 'IN_PROGRESS' | 'MET' | 'MISSED';
export type Comparison = 'GTE' | 'LTE' | 'EQ';
export type NumericConcept = 'INFLOW' | 'OUTFLOW' | 'CASH_CLOSE';

export interface Objective {
  id: string;
  name: string;
  description?: string;
  kind: ObjectiveKind;

  // NUMERIC_MONTHLY ----------------------------------------------------------
  numericConcept?: NumericConcept;
  targetYearMonth?: string; // "YYYY-MM"
  targetAmount?: number;
  comparison?: Comparison;

  // KPI_THRESHOLD ------------------------------------------------------------
  /** Llave de la tabla de KPIs: `system:<id>` ó `custom:<id>`. */
  linkedKpiKey?: string;
  threshold?: number;

  // QUALITATIVE --------------------------------------------------------------
  dueDate?: string; // YYYY-MM-DD

  /** Si el usuario fuerza un estado, este valor gana sobre el cálculo. */
  manualStatus?: ObjectiveStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectiveEvaluation {
  status: ObjectiveStatus;
  /** Valor real comparado contra la meta (cuando aplica). */
  actualValue: number | null;
  /** Texto humano que explica el cómputo / por qué fue manual. */
  reason: string;
  /** true si el estado lo decidió el usuario, no la fórmula. */
  manualOverride: boolean;
}
