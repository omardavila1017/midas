// KPIs y Objetivos — modelo del módulo.
//
// El módulo usa el mismo motor de Planeación Financiera cuando el shell entrega
// esa base; sólo cae a datos crudos para KPIs puntuales sin equivalente en el
// forecast. Los objetivos se evalúan contra estos KPIs cuando es posible y caen
// a status manual cuando no.

export type SystemKpiId =
  | 'caja_actual'
  | 'cobranza_ytd'
  | 'cxp_pendiente'
  | 'gasto_ytd'
  | 'flujo_neto_ytd'
  | 'caja_final_planeacion'
  | 'deficit_dias_planeacion'
  | 'cobranza_mes'
  | 'gasto_mes'
  | 'flujo_neto_mes'
  | 'flujo_neto_30d'
  | 'cobertura_cxp_caja'
  | 'liquidez_inmediata'
  | 'cobertura_caja_cxc'
  | 'capital_trabajo_operativo'
  | 'cobertura_flujo_30d'
  | 'dso_cobranza'
  | 'dpo_cxp'
  | 'cxp_vencida'
  | 'pct_cxp_vencida'
  | 'cxp_por_vencer_30d'
  | 'runway_caja_dias'
  | 'ticket_promedio_cobranza_mes'
  | 'cobranza_pendiente_aplicar'
  | 'cuentas_bancarias_activas';

export type KpiUnit = 'MXN' | 'count' | 'pct' | 'days' | 'ratio';

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
  /** Explica por qué el valor no es calculable con la base cargada. */
  emptyReason?: string;
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
