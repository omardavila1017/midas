// ─────────────────────────────────────────────────────────────────────────
// predictive/types — tipos del motor predictivo de caja.
//
// El motor extrapola la trayectoria de ingresos y egresos a partir de
// movimientos bancarios históricos (cobranza matcheada + pagos matcheados
// en bancos). Produce buckets en 4 granularidades: diario, semanal,
// mensual y anual. Cada punto tiene punto-estimado + desviación estándar
// + banda 80% de confianza (que crece con el horizonte).
//
// La intención es que Planeación Financiera, Proyección Financiera y
// Dashboard consuman este resultado sin recalcular nada. El motor se
// integra al `computeBaseCashFlow` como reemplazo de la proyección rule-
// based para el horizonte de futuros meses.
// ─────────────────────────────────────────────────────────────────────────

export type BucketGranularity = 'daily' | 'weekly' | 'monthly' | 'annual';

export type ModelKind =
  /** Holt-Winters con estacionalidad m=12 (≥24 meses histórico). */
  | 'holt-winters-seasonal'
  /** Holt-Winters sin estacionalidad (12–23 meses). */
  | 'holt-winters'
  /** Suavizado exponencial + tendencia lineal (6–11 meses). */
  | 'exp-smoothing-trend'
  /** Media simple de los últimos 3 meses (<6 meses). */
  | 'naive-mean'
  /** No hay datos. Devuelve cero con stdDev = 0. */
  | 'empty';

export interface PredictionPoint {
  /** ISO date inicio del bucket. monthly = YYYY-MM-01, weekly = lunes. */
  date: string;
  bucket: BucketGranularity;
  /** Punto-estimado. Para histórico = valor real observado. */
  expected: number;
  /** Desviación estándar del bucket. Crece con horizonte. 0 si histórico. */
  stdDev: number;
  /** Banda 80% inferior (expected - 1.282 * stdDev). */
  ci80Low: number;
  /** Banda 80% superior (expected + 1.282 * stdDev). */
  ci80High: number;
  /** Banda 95% inferior (expected - 1.96 * stdDev). */
  ci95Low: number;
  /** Banda 95% superior (expected + 1.96 * stdDev). */
  ci95High: number;
  isHistorical: boolean;
  /** Bucket en curso (parcial): real-a-la-fecha + predicción del resto. */
  isPartial: boolean;
  components?: {
    /** Cuanto del bucket es real (días pasados del mes en curso). */
    historical?: number;
    /** Cuanto del bucket es predicho. */
    predicted?: number;
    /** Cuanto del bucket viene de OCs explícitas (tooltip, NO suma extra). */
    fromOCs?: number;
    /** Cuanto del bucket viene de CXC abierta (tooltip, NO suma extra). */
    fromCXC?: number;
  };
}

export interface PredictiveSeries {
  daily: PredictionPoint[];
  weekly: PredictionPoint[];
  monthly: PredictionPoint[];
  annual: PredictionPoint[];
}

export interface ModelFit {
  /** Residuales (observado - ajustado) para los datos de entrenamiento. */
  residuals: number[];
  /** Root mean square error del fit. Base de la stdDev a futuro. */
  rmse: number;
  /** Mean absolute percentage error. Útil para mostrar calidad al user. */
  mape: number;
  /** Parámetros aprendidos (α, β, γ, etc.) — depende del modelo. */
  params?: Record<string, number>;
}

export interface PredictiveSeriesMeta {
  /** Cantidad de meses con datos históricos usados para entrenar. */
  historyMonths: number;
  /** Modelo elegido según disponibilidad. */
  model: ModelKind;
  fit: ModelFit;
  /** Fecha del último observado real (YYYY-MM-DD). */
  lastObservedDate?: string;
}

export interface PredictiveForecastResult {
  income: PredictiveSeries;
  expense: PredictiveSeries;
  /** Net = income - expense, calculado bucket a bucket. */
  net: PredictiveSeries;
  /** ISO date — fecha de corte para histórico vs futuro. */
  asOfDate: string;
  /** Cantidad de meses futuros proyectados (default 12). */
  horizonMonths: number;
  metadata: {
    income: PredictiveSeriesMeta;
    expense: PredictiveSeriesMeta;
  };
}

/**
 * Datos para una serie de overlays (OC, CXC) — no se suman al forecast,
 * sólo se exponen como decomposición/tooltip.
 */
export interface OverlayPoint {
  /** Bucket date (YYYY-MM-DD inicio del bucket). */
  date: string;
  bucket: BucketGranularity;
  /** Importe agregado al bucket. */
  amount: number;
}

export interface PredictiveOverlays {
  /** Compras (OC) futuras programadas. Tooltip sobre egresos. */
  futureOCs: OverlayPoint[];
  /** CXC abierta esperada por cobrar. Tooltip sobre ingresos. */
  openCXC: OverlayPoint[];
}
