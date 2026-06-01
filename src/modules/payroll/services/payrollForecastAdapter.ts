/**
 * Adaptador de forecast de Nómina.
 *
 * Alimenta una serie mensual de nómina (total de empresa o un concepto) a los
 * modelos puros de suavizado exponencial de `domain/predictive/holtWinters`.
 * El motor `predictiveEngine.ts` NO se reutiliza tal cual: está acoplado a
 * banco/cobranza/OC. Aquí se replica solo la regla de selección de modelo por
 * longitud de historia y las constantes de banda (z80/z95), como indica el
 * plan del módulo.
 *
 * Selección por longitud de la serie:
 *   ≥ 24  → Holt-Winters estacional aditivo (m = 12, estacionalidad anual)
 *   ≥ 12  → Holt lineal (nivel + tendencia)
 *   ≥ 6   → suavizado exponencial simple (sólo nivel)
 *   ≥ 1   → media naive de los últimos meses
 *   0     → forecast en cero
 *
 * Defensivo: si un modelo lanza (serie corta/ruidosa), degrada al siguiente
 * más simple en vez de romper el render.
 */

import {
  holtWintersAdditive,
  holtLinear,
  singleExpSmoothing,
  naiveMean,
  type ModelOutput,
} from '../../../domain/predictive/holtWinters';

export type ForecastModel =
  | 'holt-winters-seasonal'
  | 'holt-linear'
  | 'single-exp'
  | 'naive-mean'
  | 'empty';

export const FORECAST_MODEL_LABELS: Record<ForecastModel, string> = {
  'holt-winters-seasonal': 'Holt-Winters estacional (m=12)',
  'holt-linear': 'Holt lineal (nivel + tendencia)',
  'single-exp': 'Suavizado exponencial simple',
  'naive-mean': 'Media de últimos meses',
  empty: 'Sin historia suficiente',
};

const Z80 = 1.2816;
const Z95 = 1.96;

export interface ForecastBandPoint {
  /** Paso del horizonte (1-based). */
  step: number;
  expected: number;
  lo80: number;
  hi80: number;
  lo95: number;
  hi95: number;
}

export interface PayrollForecast {
  model: ForecastModel;
  /** Serie histórica usada (densa, alineada a meses). */
  history: number[];
  /** Valores esperados del horizonte. */
  forecast: number[];
  /** Bandas de confianza por paso. */
  bands: ForecastBandPoint[];
  /** Error porcentual medio absoluto del ajuste (0 si no aplica). */
  mape: number;
  rmse: number;
}

const SEASONAL_PERIOD = 12;

/** Elige y ajusta el modelo según la longitud, degradando ante errores. */
function fitWithFallback(series: number[], horizon: number): { model: ForecastModel; output: ModelOutput } {
  const n = series.length;

  const tryFit = (
    model: ForecastModel,
    fn: () => ModelOutput,
  ): { model: ForecastModel; output: ModelOutput } | null => {
    try {
      const output = fn();
      // Rechaza ajustes degenerados (NaN/Inf) para que el fallback aplique.
      if (output.forecast.some(v => !Number.isFinite(v))) return null;
      return { model, output };
    } catch {
      return null;
    }
  };

  if (n >= SEASONAL_PERIOD * 2) {
    const hit = tryFit('holt-winters-seasonal', () => holtWintersAdditive(series, SEASONAL_PERIOD, horizon));
    if (hit) return hit;
  }
  if (n >= 12) {
    const hit = tryFit('holt-linear', () => holtLinear(series, horizon));
    if (hit) return hit;
  }
  if (n >= 6) {
    const hit = tryFit('single-exp', () => singleExpSmoothing(series, horizon));
    if (hit) return hit;
  }
  if (n >= 3) {
    const hit = tryFit('holt-linear', () => holtLinear(series, horizon));
    if (hit) return hit;
  }
  return { model: 'naive-mean', output: naiveMean(series, horizon) };
}

/**
 * Genera el forecast de una serie mensual de nómina.
 *
 * @param series  Serie histórica densa (un valor por mes, en orden cronológico).
 * @param horizon Meses a proyectar hacia adelante.
 */
export function forecastSeries(series: number[], horizon: number): PayrollForecast {
  const clean = series.map(v => (Number.isFinite(v) ? v : 0));

  if (clean.length === 0 || horizon <= 0) {
    return {
      model: 'empty',
      history: clean,
      forecast: new Array(Math.max(0, horizon)).fill(0),
      bands: [],
      mape: 0,
      rmse: 0,
    };
  }

  const { model, output } = fitWithFallback(clean, horizon);

  // Banda creciente con el horizonte: σ_h = rmse · √h. La nómina no puede ser
  // negativa, así que el piso de cada banda se recorta a 0.
  const bands: ForecastBandPoint[] = output.forecast.map((expected, i) => {
    const h = i + 1;
    const sigma = output.rmse * Math.sqrt(h);
    return {
      step: h,
      expected,
      lo80: Math.max(0, expected - Z80 * sigma),
      hi80: expected + Z80 * sigma,
      lo95: Math.max(0, expected - Z95 * sigma),
      hi95: expected + Z95 * sigma,
    };
  });

  return {
    model,
    history: clean,
    forecast: output.forecast.map(v => Math.max(0, v)),
    bands,
    mape: output.mape,
    rmse: output.rmse,
  };
}
