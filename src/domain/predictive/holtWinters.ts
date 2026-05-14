// ─────────────────────────────────────────────────────────────────────────
// holtWinters — implementación pura de los modelos de suavizado
// exponencial usados por el motor predictivo:
//
//   - Holt-Winters aditivo con estacionalidad (m=12 para meses)
//   - Holt (doble exp.) sin estacionalidad
//   - Single exponential smoothing (sólo nivel)
//   - Naive mean fallback
//
// Cada función devuelve `{ fitted, forecast, residuals, rmse, mape,
// params }` para que el caller pueda calcular bandas y mostrar calidad.
//
// Los parámetros de suavizado (α, β, γ) se eligen por mini grid search
// que minimiza RMSE en el set de entrenamiento. Para series cortas o muy
// ruidosas la grid se mantiene chica (3×3×3) — el tiempo de cómputo
// importa porque esto corre en el render path del Dashboard.
// ─────────────────────────────────────────────────────────────────────────

export interface SmoothingParams {
  alpha: number;
  beta: number;
  gamma: number;
}

export interface ModelOutput {
  /** Ajuste sobre el set de entrenamiento (misma longitud que `series`). */
  fitted: number[];
  /** Predicción a `horizon` pasos hacia adelante. */
  forecast: number[];
  /** Residuales = series[i] - fitted[i]. */
  residuals: number[];
  rmse: number;
  mape: number;
  params: Record<string, number>;
}

const ALPHA_GRID = [0.1, 0.3, 0.5, 0.7, 0.9];
const BETA_GRID = [0.0, 0.1, 0.3, 0.5];
const GAMMA_GRID = [0.1, 0.3, 0.5, 0.7];

/**
 * Holt-Winters aditivo. Asume serie ≥ 2 * period observaciones.
 */
export function holtWintersAdditive(
  series: number[],
  period: number,
  horizon: number,
  fixedParams?: Partial<SmoothingParams>,
): ModelOutput {
  if (series.length < period * 2) {
    throw new Error(`HW seasonal requiere ≥ ${period * 2} obs (got ${series.length})`);
  }
  const params = resolveSeasonalParams(series, period, fixedParams);
  return fitHWAdditive(series, period, horizon, params);
}

/**
 * Holt (doble exponencial) — nivel + tendencia, sin estacionalidad.
 */
export function holtLinear(
  series: number[],
  horizon: number,
  fixedParams?: Partial<Omit<SmoothingParams, 'gamma'>>,
): ModelOutput {
  if (series.length < 3) {
    throw new Error(`Holt requiere ≥ 3 obs (got ${series.length})`);
  }
  const params = resolveNonSeasonalParams(series, fixedParams);
  return fitHolt(series, horizon, params);
}

/**
 * Single exponential smoothing — sólo nivel.
 */
export function singleExpSmoothing(
  series: number[],
  horizon: number,
  alpha = 0.3,
): ModelOutput {
  const a = clamp01(alpha);
  const fitted: number[] = [];
  const residuals: number[] = [];
  let level = series[0] ?? 0;
  for (let i = 0; i < series.length; i++) {
    const f = level;
    fitted.push(f);
    residuals.push(series[i] - f);
    level = a * series[i] + (1 - a) * level;
  }
  const forecast = new Array(horizon).fill(level);
  return {
    fitted,
    forecast,
    residuals,
    rmse: rootMeanSquare(residuals),
    mape: meanAbsPercentError(series, fitted),
    params: { alpha: a },
  };
}

/**
 * Naive: media simple de los últimos `lookback` valores → constante para
 * todo el horizonte. Fallback de último recurso para series muy cortas.
 */
export function naiveMean(
  series: number[],
  horizon: number,
  lookback = 3,
): ModelOutput {
  if (series.length === 0) {
    return {
      fitted: [],
      forecast: new Array(horizon).fill(0),
      residuals: [],
      rmse: 0,
      mape: 0,
      params: { lookback },
    };
  }
  const window = series.slice(Math.max(0, series.length - lookback));
  const mean = window.reduce((s, v) => s + v, 0) / window.length;
  const fitted = series.map(() => mean);
  const residuals = series.map((v, i) => v - fitted[i]);
  return {
    fitted,
    forecast: new Array(horizon).fill(mean),
    residuals,
    rmse: rootMeanSquare(residuals),
    mape: meanAbsPercentError(series, fitted),
    params: { lookback, mean },
  };
}

// ── Internals ────────────────────────────────────────────────────────────

function fitHWAdditive(
  series: number[],
  period: number,
  horizon: number,
  params: SmoothingParams,
): ModelOutput {
  const { alpha, beta, gamma } = params;
  const n = series.length;

  // Inicialización por descomposición clásica:
  //  - level₀ = media del primer ciclo
  //  - trend₀ = (media segundo ciclo - media primero) / period
  //  - seasonal₀..period-1 = obs - level₀
  const firstCycle = series.slice(0, period);
  const secondCycle = series.slice(period, period * 2);
  const meanFirst = mean(firstCycle);
  const meanSecond = mean(secondCycle);
  let level = meanFirst;
  let trend = (meanSecond - meanFirst) / period;
  const seasonal: number[] = new Array(period);
  for (let i = 0; i < period; i++) {
    seasonal[i] = firstCycle[i] - meanFirst;
  }

  const fitted: number[] = new Array(n);
  const residuals: number[] = new Array(n);

  for (let t = 0; t < n; t++) {
    const seasonIdx = t % period;
    const f = level + trend + seasonal[seasonIdx];
    fitted[t] = f;
    residuals[t] = series[t] - f;

    const prevLevel = level;
    level = alpha * (series[t] - seasonal[seasonIdx]) + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    seasonal[seasonIdx] = gamma * (series[t] - prevLevel - trend) + (1 - gamma) * seasonal[seasonIdx];
  }

  const forecast: number[] = new Array(horizon);
  for (let h = 1; h <= horizon; h++) {
    const seasonIdx = (n - 1 + h) % period;
    forecast[h - 1] = level + h * trend + seasonal[seasonIdx];
  }

  return {
    fitted,
    forecast,
    residuals,
    rmse: rootMeanSquare(residuals),
    mape: meanAbsPercentError(series, fitted),
    params: { alpha, beta, gamma },
  };
}

function fitHolt(
  series: number[],
  horizon: number,
  params: Omit<SmoothingParams, 'gamma'>,
): ModelOutput {
  const { alpha, beta } = params;
  const n = series.length;

  let level = series[0];
  let trend = series.length > 1 ? series[1] - series[0] : 0;
  const fitted: number[] = new Array(n);
  const residuals: number[] = new Array(n);

  for (let t = 0; t < n; t++) {
    const f = level + trend;
    fitted[t] = f;
    residuals[t] = series[t] - f;

    const prevLevel = level;
    level = alpha * series[t] + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }

  const forecast: number[] = new Array(horizon);
  for (let h = 1; h <= horizon; h++) {
    forecast[h - 1] = level + h * trend;
  }

  return {
    fitted,
    forecast,
    residuals,
    rmse: rootMeanSquare(residuals),
    mape: meanAbsPercentError(series, fitted),
    params: { alpha, beta },
  };
}

function resolveSeasonalParams(
  series: number[],
  period: number,
  fixed?: Partial<SmoothingParams>,
): SmoothingParams {
  if (fixed?.alpha != null && fixed.beta != null && fixed.gamma != null) {
    return {
      alpha: clamp01(fixed.alpha),
      beta: clamp01(fixed.beta),
      gamma: clamp01(fixed.gamma),
    };
  }
  let best: SmoothingParams = { alpha: 0.3, beta: 0.1, gamma: 0.3 };
  let bestRmse = Infinity;
  for (const alpha of ALPHA_GRID) {
    for (const beta of BETA_GRID) {
      for (const gamma of GAMMA_GRID) {
        const candidate = fitHWAdditive(series, period, 0, { alpha, beta, gamma });
        if (candidate.rmse < bestRmse && Number.isFinite(candidate.rmse)) {
          bestRmse = candidate.rmse;
          best = { alpha, beta, gamma };
        }
      }
    }
  }
  return best;
}

function resolveNonSeasonalParams(
  series: number[],
  fixed?: Partial<Omit<SmoothingParams, 'gamma'>>,
): Omit<SmoothingParams, 'gamma'> {
  if (fixed?.alpha != null && fixed.beta != null) {
    return { alpha: clamp01(fixed.alpha), beta: clamp01(fixed.beta) };
  }
  let best = { alpha: 0.3, beta: 0.1 };
  let bestRmse = Infinity;
  for (const alpha of ALPHA_GRID) {
    for (const beta of BETA_GRID) {
      const candidate = fitHolt(series, 0, { alpha, beta });
      if (candidate.rmse < bestRmse && Number.isFinite(candidate.rmse)) {
        bestRmse = candidate.rmse;
        best = { alpha, beta };
      }
    }
  }
  return best;
}

// ── Math helpers ─────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0.3;
  return Math.max(0, Math.min(1, x));
}

function rootMeanSquare(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sumSq = xs.reduce((s, v) => s + v * v, 0);
  return Math.sqrt(sumSq / xs.length);
}

function meanAbsPercentError(actual: number[], predicted: number[]): number {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < actual.length; i++) {
    if (Math.abs(actual[i]) < 1e-6) continue;
    sum += Math.abs((actual[i] - predicted[i]) / actual[i]);
    count++;
  }
  return count === 0 ? 0 : (sum / count) * 100;
}
