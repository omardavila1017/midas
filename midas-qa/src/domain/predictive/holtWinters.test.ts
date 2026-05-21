import { describe, it, expect } from 'vitest';
import {
  holtLinear,
  holtWintersAdditive,
  naiveMean,
  singleExpSmoothing,
} from './holtWinters';

describe('holtWintersAdditive', () => {
  it('extrapola tendencia + estacionalidad mensual', () => {
    // 3 ciclos de 12 meses con tendencia lineal + estacional sinusoidal
    const series: number[] = [];
    for (let t = 0; t < 36; t++) {
      const trend = 100 + t * 5;
      const seasonal = 30 * Math.sin((2 * Math.PI * (t % 12)) / 12);
      series.push(trend + seasonal);
    }
    const out = holtWintersAdditive(series, 12, 12);
    expect(out.forecast).toHaveLength(12);
    // Forecast cercano a la tendencia continuada (~280–340 con estacional ±30)
    for (const v of out.forecast) {
      expect(v).toBeGreaterThan(240);
      expect(v).toBeLessThan(380);
    }
    // RMSE razonable contra la magnitud media
    const meanVal = series.reduce((s, v) => s + v, 0) / series.length;
    expect(out.rmse).toBeLessThan(meanVal * 0.5);
  });

  it('lanza si serie es menor a 2 ciclos', () => {
    const series = new Array(20).fill(100);
    expect(() => holtWintersAdditive(series, 12, 6)).toThrow();
  });
});

describe('holtLinear', () => {
  it('captura tendencia lineal sin estacionalidad', () => {
    const series = Array.from({ length: 12 }, (_, i) => 100 + i * 10);
    const out = holtLinear(series, 6);
    expect(out.forecast).toHaveLength(6);
    // Última obs = 210, tendencia 10 → siguiente debería ser ~220 ± algo
    expect(out.forecast[0]).toBeGreaterThan(210);
    expect(out.forecast[5]).toBeGreaterThan(out.forecast[0]);
  });
});

describe('singleExpSmoothing', () => {
  it('forecast es constante = nivel suavizado', () => {
    const series = [100, 110, 95, 105, 102, 98];
    const out = singleExpSmoothing(series, 5, 0.5);
    expect(out.forecast).toHaveLength(5);
    // todos iguales
    expect(new Set(out.forecast).size).toBe(1);
  });
});

describe('naiveMean', () => {
  it('forecast = media de los últimos N', () => {
    const series = [100, 200, 300, 400, 500];
    const out = naiveMean(series, 3, 3);
    expect(out.forecast).toEqual([400, 400, 400]); // media de 300,400,500
  });

  it('maneja serie vacía', () => {
    const out = naiveMean([], 3);
    expect(out.forecast).toEqual([0, 0, 0]);
  });
});
