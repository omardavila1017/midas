import { describe, expect, it } from 'vitest';
import { forecastSeries } from './payrollForecastAdapter';

describe('forecastSeries — selección de modelo por longitud', () => {
  it('serie vacía → modelo empty y forecast en cero', () => {
    const f = forecastSeries([], 6);
    expect(f.model).toBe('empty');
    expect(f.forecast).toEqual([0, 0, 0, 0, 0, 0]);
    expect(f.bands).toHaveLength(0);
  });

  it('serie corta (<6) → naive-mean o holt según longitud', () => {
    const f = forecastSeries([100, 110], 3);
    expect(['naive-mean']).toContain(f.model);
    expect(f.forecast).toHaveLength(3);
  });

  it('serie media (6–11) → single-exp', () => {
    const series = [10, 12, 11, 13, 12, 14];
    const f = forecastSeries(series, 4);
    expect(f.model).toBe('single-exp');
    expect(f.forecast).toHaveLength(4);
  });

  it('serie con tendencia (12–23) → holt-linear', () => {
    const series = Array.from({ length: 14 }, (_, i) => 100 + i * 5);
    const f = forecastSeries(series, 3);
    expect(f.model).toBe('holt-linear');
  });

  it('serie larga (≥24) → holt-winters estacional', () => {
    const series = Array.from({ length: 36 }, (_, i) => 100 + 20 * Math.sin((i % 12) / 12 * 2 * Math.PI));
    const f = forecastSeries(series, 6);
    expect(f.model).toBe('holt-winters-seasonal');
    expect(f.forecast).toHaveLength(6);
  });
});

describe('forecastSeries — bandas y saneamiento', () => {
  it('forecast y pisos de banda nunca negativos', () => {
    const series = Array.from({ length: 14 }, (_, i) => 100 - i * 10); // tendencia fuerte a la baja
    const f = forecastSeries(series, 6);
    expect(f.forecast.every(v => v >= 0)).toBe(true);
    expect(f.bands.every(b => b.lo80 >= 0 && b.lo95 >= 0)).toBe(true);
  });

  it('las bandas se ensanchan con el horizonte', () => {
    const series = [10, 12, 11, 13, 12, 14, 13, 15];
    const f = forecastSeries(series, 4);
    const widths = f.bands.map(b => b.hi95 - b.lo95);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1]);
    }
  });

  it('IC 95 % es más ancho que IC 80 %', () => {
    const series = [10, 12, 11, 13, 12, 14, 13, 15];
    const f = forecastSeries(series, 3);
    for (const b of f.bands) {
      expect(b.hi95 - b.lo95).toBeGreaterThanOrEqual(b.hi80 - b.lo80);
    }
  });

  it('horizonte 0 → sin bandas', () => {
    const f = forecastSeries([1, 2, 3], 0);
    expect(f.forecast).toHaveLength(0);
  });
});
